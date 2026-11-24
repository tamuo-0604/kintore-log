import Foundation
import HealthKit

/// Apple の「ヘルスケア」App との連携。
///
/// 読み込み: 体重・体脂肪率・ウエスト・身長（体組成計のアプリなど、ほかのアプリが書き込んだもの）
///   - その日の記録がまだないときだけ、新しく作る
///   - その日の記録はあるが体脂肪率やウエストが空のときは、そこだけ埋める
///   - このアプリで入力した値は上書きしない。アプリで削除した日は取り込み直さない
/// 書き出し: このアプリで記録した体重・体脂肪率・ウエスト・身長と、HIIT・有酸素のワークアウト
///   - 1 日 1 件の「同期 ID」を付けて保存するので、修正すると上書きされ、二重にならない
///
/// 連携のオン・オフは端末ごとの設定（UserDefaults）。ヘルスケアの許可も端末ごとのため。
final class HealthSync: ObservableObject {
    static let shared = HealthSync()

    @Published var enabled: Bool {
        didSet { UserDefaults.standard.set(enabled, forKey: "healthEnabled") }
    }
    @Published var busy = false
    @Published var status = ""

    /// 取り込んだデータを入れる先。アプリ起動時に RootView が設定する
    weak var store: Store?

    let available = HKHealthStore.isHealthDataAvailable()
    private let health = HKHealthStore()

    private let weightType = HKQuantityType(.bodyMass)
    private let fatType = HKQuantityType(.bodyFatPercentage)
    private let waistType = HKQuantityType(.waistCircumference)
    private let heightType = HKQuantityType(.height)
    private let runDistance = HKQuantityType(.distanceWalkingRunning)
    private let bikeDistance = HKQuantityType(.distanceCycling)
    private let kg = HKUnit.gramUnit(with: .kilo)
    private let cm = HKUnit.meterUnit(with: .centi)

    private init() {
        enabled = UserDefaults.standard.bool(forKey: "healthEnabled")
    }

    // MARK: オン・オフ

    /// 許可を求める画面を出し、終わったら読み込みと書き出しを行う。
    /// （許可の画面で「オフ」を選ばれても、プライバシー保護のためアプリ側からは区別できない）
    func turnOn() {
        guard available else { status = "この端末ではヘルスケアを使えません"; return }
        let share: Set<HKSampleType> = [weightType, fatType, waistType, heightType,
                                        HKObjectType.workoutType(), runDistance, bikeDistance]
        let read: Set<HKObjectType> = [weightType, fatType, waistType, heightType]
        health.requestAuthorization(toShare: share, read: read) { ok, _ in
            DispatchQueue.main.async {
                guard ok else {
                    self.enabled = false
                    self.status = "許可の画面を開けませんでした"
                    return
                }
                self.enabled = true
                self.exportAll()
                self.importNow()
            }
        }
    }

    func turnOff() {
        enabled = false
        status = "連携をオフにしました。ヘルスケアに保存済みのデータはそのまま残ります"
    }

    // MARK: 読み込み

    /// ヘルスケアから読み込んで、からだの記録に取り込む
    func importNow() {
        guard enabled, available, !busy, store != nil else { return }
        busy = true
        status = "ヘルスケアから読み込み中…"
        let since = Calendar.current.date(byAdding: .day, value: -400, to: Date())
        let box = ValueBox()
        let group = DispatchGroup()
        let targets: [(HKQuantityType, HKUnit, Date?)] = [
            (weightType, kg, since), (fatType, .percent(), since), (waistType, cm, since),
            (heightType, cm, nil), // 身長はめったに測らないので、期間を区切らない
        ]
        for (type, unit, start) in targets {
            group.enter()
            let predicate = HKQuery.predicateForSamples(withStart: start, end: nil)
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit,
                                      sortDescriptors: [sort]) { _, samples, _ in
                var byDay: [String: Double] = [:]
                for case let sample as HKQuantitySample in samples ?? [] {
                    // このアプリ自身が書き込んだものは読み込まない（行ったり来たりを防ぐ）
                    if sample.sourceRevision.source.bundleIdentifier == Bundle.main.bundleIdentifier { continue }
                    byDay[Day.string(sample.endDate)] = sample.quantity.doubleValue(for: unit) // 古い順なので、その日の最後の値が残る
                }
                box.set(type.identifier, byDay)
                group.leave()
            }
            health.execute(query)
        }
        group.notify(queue: .main) { self.merge(box.values) }
    }

    private func merge(_ values: [String: [String: Double]]) {
        busy = false
        guard let store else { return }
        let weights = values[weightType.identifier] ?? [:]
        let fats = (values[fatType.identifier] ?? [:]).mapValues { $0 * 100 } // ヘルスケアは 0〜1、アプリは %
        let waists = values[waistType.identifier] ?? [:]
        let heights = values[heightType.identifier] ?? [:]
        let r1 = { (v: Double) in (v * 10).rounded() / 10 }
        let okFat = { (v: Double) in v > 0 && v <= 70 }
        let okWaist = { (v: Double) in v > 0 && v <= 250 }

        var d = store.data
        var list = d.body ?? []
        let deleted = d.deleted?.body ?? [:]
        var added = 0, filled = 0

        for (date, w) in weights where w >= 20 && w <= 300 && date <= Day.today {
            let id = "b-" + date
            if deleted[id] != nil || list.contains(where: { $0.id == id }) { continue }
            let fat = fats[date].flatMap { okFat($0) ? r1($0) : nil } ?? 0
            let waist = waists[date].flatMap { okWaist($0) ? r1($0) : nil } ?? 0
            list.append(BodyRecord(id: id, date: date, weight: (w * 100).rounded() / 100, fat: fat,
                                   u: Store.nowMs, muscle: 0, waist: waist))
            added += 1
        }
        for i in list.indices {
            let date = list[i].date
            var changed = false
            if list[i].fat == 0, let f = fats[date], okFat(f) { list[i].fat = r1(f); changed = true }
            if (list[i].waist ?? 0) == 0, let w = waists[date], okWaist(w) { list[i].waist = r1(w); changed = true }
            if changed { list[i].u = Store.nowMs; filled += 1 }
        }
        var heightSet = false
        if (d.settings.height ?? 0) == 0, let latest = heights.keys.max(), let h = heights[latest], h >= 100, h <= 250 {
            d.settings.height = r1(h)
            d.settings.u = Store.nowMs
            heightSet = true
        }

        if added > 0 || filled > 0 || heightSet {
            d.body = list.sorted { $0.date < $1.date }
            store.data = d
        }
        var parts: [String] = []
        if added > 0 { parts.append("新しい記録 \(added)件") }
        if filled > 0 { parts.append("項目の補完 \(filled)件") }
        if heightSet { parts.append("身長") }
        let time = Date().formatted(date: .omitted, time: .shortened)
        status = parts.isEmpty
            ? "\(time) 読み込み完了（新しいデータはありませんでした）"
            : "\(time) 取り込み: " + parts.joined(separator: "・")
    }

    // MARK: 書き出し（からだの記録）

    /// アプリにある記録をすべてヘルスケアへ書き出す（連携をオンにしたとき）。同期 ID 付きなので何度行っても二重にならない
    func exportAll() {
        guard let store else { return }
        for r in store.bodyRecords { exportBody(r) }
        if let h = store.data.settings.height, h > 0 { exportHeight(h) }
    }

    func exportBody(_ r: BodyRecord) {
        guard enabled, available else { return }
        // 今日の記録は今の時刻、過去の日は正午の記録として保存する
        let when = r.date == Day.today ? Date() : Day.date(r.date).addingTimeInterval(12 * 3600)
        let version = r.u ?? Store.nowMs
        put(weightType, kg, r.weight, id: "kintore.weight.\(r.date)", version: version, at: when)
        put(fatType, .percent(), r.fat / 100, id: "kintore.fat.\(r.date)", version: version, at: when)
        put(waistType, cm, r.waist ?? 0, id: "kintore.waist.\(r.date)", version: version, at: when)
    }

    /// アプリで削除した日の記録を、ヘルスケアからも消す（このアプリが書き込んだものだけ）
    func removeBody(date: String) {
        guard enabled, available else { return }
        remove(weightType, id: "kintore.weight.\(date)")
        remove(fatType, id: "kintore.fat.\(date)")
        remove(waistType, id: "kintore.waist.\(date)")
    }

    func exportHeight(_ value: Double) {
        guard enabled, available else { return }
        put(heightType, cm, value, id: "kintore.height", version: Store.nowMs, at: Date())
    }

    /// 同期 ID 付きで保存する。同じ ID の古いものは、ヘルスケアが自動で置き換える。値が 0 なら消す
    private func put(_ type: HKQuantityType, _ unit: HKUnit, _ value: Double, id: String, version: Double, at when: Date) {
        guard value > 0 else { remove(type, id: id); return }
        let metadata: [String: Any] = [
            HKMetadataKeySyncIdentifier: id,
            HKMetadataKeySyncVersion: NSNumber(value: Int64(version)),
        ]
        let sample = HKQuantitySample(type: type, quantity: HKQuantity(unit: unit, doubleValue: value),
                                      start: when, end: when, metadata: metadata)
        health.save(sample) { _, _ in }
    }

    private func remove(_ type: HKQuantityType, id: String) {
        let predicate = HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeySyncIdentifier, allowedValues: [id])
        health.deleteObjects(of: type, predicate: predicate) { _, _, _ in }
    }

    // MARK: 書き出し（ワークアウト）

    /// HIIT と有酸素を、終わった時刻から逆算した時間帯のワークアウトとして保存する
    func recordWorkout(_ ex: Exercise, _ s: WorkoutSet) {
        guard enabled, available else { return }
        let end = Date()
        switch ex.kind {
        case "hiit":
            // 本数 × 高強度 ＋ 間のインターバル（準備時間は含めない）
            let seconds = s.reps * s.weight + max(0, s.reps - 1) * (ex.rest ?? 10)
            saveWorkout(.highIntensityIntervalTraining, start: end.addingTimeInterval(-seconds), end: end, km: 0, distance: nil)
        case "cardio":
            let (type, distance) = activity(for: ex.name)
            saveWorkout(type, start: end.addingTimeInterval(-s.reps), end: end, km: s.weight, distance: distance)
        default:
            break // 筋トレはセットごとの時間がわからないので保存しない
        }
    }

    /// メニュー名から運動の種類を推定する
    private func activity(for name: String) -> (HKWorkoutActivityType, HKQuantityType?) {
        let has = { (words: [String]) in words.contains { name.contains($0) } }
        if has(["ウォーキング", "ウォーク", "散歩", "歩"]) { return (.walking, runDistance) }
        if has(["バイク", "自転車", "サイクリング"]) { return (.cycling, bikeDistance) }
        if has(["ラン", "ジョギング", "ジョグ", "走"]) { return (.running, runDistance) }
        if has(["水泳", "スイム"]) { return (.swimming, nil) }
        return (.mixedCardio, nil)
    }

    private func saveWorkout(_ type: HKWorkoutActivityType, start: Date, end: Date, km: Double, distance: HKQuantityType?) {
        guard end > start else { return }
        let config = HKWorkoutConfiguration()
        config.activityType = type
        let builder = HKWorkoutBuilder(healthStore: health, configuration: config, device: .local())
        builder.beginCollection(withStart: start) { ok, _ in
            guard ok else { return }
            let finish = {
                builder.endCollection(withEnd: end) { ok, _ in
                    guard ok else { return }
                    builder.finishWorkout { _, _ in }
                }
            }
            if km > 0, let distance {
                let sample = HKQuantitySample(type: distance, quantity: HKQuantity(unit: .meterUnit(with: .kilo), doubleValue: km),
                                              start: start, end: end)
                builder.add([sample]) { _, _ in finish() }
            } else {
                finish()
            }
        }
    }
}

/// 複数の読み込みの結果を、別々のスレッドから安全に集めるための入れ物
private final class ValueBox {
    private let lock = NSLock()
    private var storage: [String: [String: Double]] = [:]

    func set(_ key: String, _ value: [String: Double]) {
        lock.lock(); storage[key] = value; lock.unlock()
    }

    var values: [String: [String: Double]] {
        lock.lock(); defer { lock.unlock() }
        return storage
    }
}
