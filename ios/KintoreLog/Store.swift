import Foundation
import SwiftUI

// データの形は PWA 版（web/app.js）と完全に同じ。
// そのため PWA の「バックアップを書き出す」で作った JSON をそのまま読み込めます。

struct Exercise: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var part: String      // chest / back / legs / shoulders / arms / abs / other
    var kind: String      // weight=重量×回数 / body=回数のみ / time=秒数 / hiit=HIIT / cardio=距離×時間
    var step: Double
    var defWeight: Double
    var defReps: Double
    var archived: Bool
    var u: Double? = nil  // 最終更新時刻（ミリ秒）。同期で「新しいほう」を選ぶのに使う
    var rest: Double? = nil // HIIT のインターバル秒数
    var prep: Double? = nil // HIIT の開始前の準備秒数
}

struct WorkoutSet: Codable, Identifiable, Hashable {
    var id: String
    var exId: String
    var date: String      // "YYYY-MM-DD"
    var ts: Double        // 記録時刻（ミリ秒）
    // weight / reps の意味は記録タイプで変わる（PWA 版と同じ）:
    //   weight … 重量(kg) / 回数    time … (未使用) / 秒数
    //   hiit … 高強度の秒数 / やった本数    cardio … 距離(km) / 時間(秒)
    var weight: Double
    var reps: Double
    var u: Double? = nil
}

struct AppSettings: Codable, Hashable {
    var restSec: Double
    var restAuto: Bool
    var sound: Bool
    var u: Double? = nil
    var loud: Bool? = nil     // PWA 版の設定（ネイティブ版では使わないが、消さずに保持する）
    var height: Double? = nil // 身長(cm)
}

/// からだの記録（1日1件）。id は "b-日付"
struct BodyRecord: Codable, Identifiable, Hashable {
    var id: String
    var date: String
    var weight: Double       // 体重(kg)
    var fat: Double          // 体脂肪率(%)。未入力は 0
    var u: Double? = nil
}

/// 削除した記録・メニューの id と削除時刻。同期で他の端末からも消すための印
struct Tombstones: Codable, Hashable {
    var sets: [String: Double] = [:]
    var exercises: [String: Double] = [:]
    var body: [String: Double]? = nil
}

struct AppData: Codable {
    var version: Int
    var exercises: [Exercise]
    var sets: [WorkoutSet]
    var settings: AppSettings
    var epoch: Double? = nil        // 「全削除」「復元」をした時刻
    var deleted: Tombstones? = nil
    var body: [BodyRecord]? = nil
}

struct BodyPart: Identifiable, Hashable {
    let id: String
    let name: String
    let color: Color
}

let bodyParts: [BodyPart] = [
    BodyPart(id: "chest", name: "胸", color: Color(red: 0.22, green: 0.53, blue: 0.90)),
    BodyPart(id: "back", name: "背中", color: Color(red: 0.85, green: 0.35, blue: 0.15)),
    BodyPart(id: "legs", name: "脚", color: Color(red: 0.10, green: 0.62, blue: 0.44)),
    BodyPart(id: "shoulders", name: "肩", color: Color(red: 0.79, green: 0.52, blue: 0.0)),
    BodyPart(id: "arms", name: "腕", color: Color(red: 0.84, green: 0.32, blue: 0.51)),
    BodyPart(id: "abs", name: "腹", color: Color(red: 0.05, green: 0.64, blue: 0.05)),
    BodyPart(id: "hiit", name: "HIIT", color: Color(red: 0.90, green: 0.40, blue: 0.40)),
    BodyPart(id: "cardio", name: "有酸素", color: Color(red: 0.56, green: 0.52, blue: 0.91)),
    BodyPart(id: "other", name: "その他", color: Color(red: 0.48, green: 0.51, blue: 0.47)),
]

func bodyPart(_ id: String) -> BodyPart {
    bodyParts.first(where: { $0.id == id }) ?? bodyParts[bodyParts.count - 1]
}

struct RecordKind: Identifiable, Hashable {
    let id: String
    let name: String
}

let kindNames: [RecordKind] = [
    RecordKind(id: "weight", name: "重量 × 回数"),
    RecordKind(id: "body", name: "回数のみ（自重）"),
    RecordKind(id: "time", name: "時間（秒）"),
    RecordKind(id: "hiit", name: "HIIT"),
    RecordKind(id: "cardio", name: "距離 × 時間（ランニングなど）"),
]

// MARK: - 日付の小道具

enum Day {
    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2 // 月曜はじまり
        return c
    }()

    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let labelFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.dateFormat = "M月d日（E）"
        return f
    }()

    static func string(_ date: Date) -> String { formatter.string(from: date) }
    static func date(_ s: String) -> Date { formatter.date(from: s) ?? Date() }
    static var today: String { string(Date()) }
    static func label(_ s: String) -> String { labelFormatter.string(from: date(s)) }

    static func short(_ s: String) -> String {
        let c = calendar.dateComponents([.month, .day], from: date(s))
        return "\(c.month ?? 0)/\(c.day ?? 0)"
    }

    static func add(_ s: String, _ days: Int) -> String {
        string(calendar.date(byAdding: .day, value: days, to: date(s)) ?? date(s))
    }

    /// その日を含む週の月曜日
    static func weekStart(_ s: String) -> String {
        let weekday = calendar.component(.weekday, from: date(s)) // 日=1 … 土=7
        return add(s, -((weekday + 5) % 7))
    }
}

func formatNumber(_ v: Double) -> String {
    let r = (v * 10).rounded() / 10
    return r == r.rounded() ? String(Int(r)) : String(r)
}

// MARK: - Store（データの置き場所）

final class Store: ObservableObject {
    @Published var data: AppData { didSet { save() } }
    @Published var restEnd: Date?   // 休憩タイマーの終了時刻

    private let fileURL: URL

    init() {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = dir.appendingPathComponent("kintore-log.json")
        if let raw = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode(AppData.self, from: raw) {
            data = decoded
        } else {
            data = Store.defaultData()
        }
    }

    private func save() {
        if let raw = try? JSONEncoder().encode(data) {
            try? raw.write(to: fileURL, options: .atomic)
        }
    }

    static func newID() -> String { UUID().uuidString.lowercased() }
    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    static func defaultData() -> AppData {
        // id は PWA 版と同じ固定値。どの端末でも「同じメニュー」として扱える
        func e(_ key: String, _ name: String, _ part: String, _ kind: String, _ w: Double, _ r: Double, _ step: Double = 2.5) -> Exercise {
            Exercise(id: "seed-" + key, name: name, part: part, kind: kind, step: step, defWeight: w, defReps: r, archived: false, u: 0, rest: 10, prep: 10)
        }
        var hiit3030 = e("hiit-30-30", "HIIT 30-30", "hiit", "hiit", 30, 10)
        hiit3030.rest = 30
        return AppData(
            version: 1,
            exercises: [
                e("bench-press", "ベンチプレス", "chest", "weight", 40, 10),
                e("dumbbell-press", "ダンベルプレス", "chest", "weight", 14, 10, 2),
                e("push-up", "腕立て伏せ", "chest", "body", 0, 15),
                e("deadlift", "デッドリフト", "back", "weight", 60, 5),
                e("lat-pulldown", "ラットプルダウン", "back", "weight", 35, 10),
                e("pull-up", "懸垂", "back", "body", 0, 8),
                e("squat", "スクワット", "legs", "weight", 50, 8),
                e("leg-press", "レッグプレス", "legs", "weight", 80, 10, 5),
                e("bulgarian-squat", "ブルガリアンスクワット", "legs", "body", 0, 10),
                e("shoulder-press", "ショルダープレス", "shoulders", "weight", 20, 10),
                e("side-raise", "サイドレイズ", "shoulders", "weight", 5, 15, 1),
                e("arm-curl", "アームカール", "arms", "weight", 10, 12, 1),
                e("triceps-pressdown", "トライセプスプレスダウン", "arms", "weight", 20, 12),
                e("crunch", "クランチ", "abs", "body", 0, 20),
                e("plank", "プランク", "abs", "time", 0, 60),
                e("hiit-tabata", "タバタ式（20秒×8本）", "hiit", "hiit", 20, 8),
                hiit3030,
                e("running", "ランニング", "cardio", "cardio", 5, 1800, 0.5),
                e("walking", "ウォーキング", "cardio", "cardio", 3, 1800, 0.5),
            ],
            sets: [],
            settings: AppSettings(restSec: 90, restAuto: true, sound: true, u: 0),
            epoch: 0,
            deleted: Tombstones()
        )
    }

    // MARK: 参照

    func exercise(_ id: String) -> Exercise? { data.exercises.first(where: { $0.id == id }) }

    func sets(of exId: String) -> [WorkoutSet] {
        data.sets.filter { $0.exId == exId }.sorted { $0.ts < $1.ts }
    }

    func sets(on date: String) -> [WorkoutSet] {
        data.sets.filter { $0.date == date }.sorted { $0.ts < $1.ts }
    }

    /// 指定日より前で、いちばん最近その種目をやった日のセット
    func lastSession(_ exId: String, before date: String) -> (date: String, sets: [WorkoutSet])? {
        let prev = sets(of: exId).filter { $0.date < date }
        guard let last = prev.last else { return nil }
        return (last.date, prev.filter { $0.date == last.date })
    }

    /// 強さの指標。重量種目は推定1RM（Epley式）、それ以外は回数／秒数
    func score(_ ex: Exercise, _ s: WorkoutSet) -> Double {
        switch ex.kind {
        case "weight": return s.reps <= 1 ? s.weight : s.weight * (1 + s.reps / 30)
        case "hiit": return s.reps * s.weight                       // 高強度の合計秒数
        case "cardio": return ex.defWeight > 0 ? s.weight : s.reps / 60 // km または 分
        default: return s.reps
        }
    }

    func scoreLabel(_ ex: Exercise) -> String {
        switch ex.kind {
        case "weight": return "推定1RM"
        case "time": return "最長時間"
        case "hiit": return "高強度の合計"
        case "cardio": return ex.defWeight > 0 ? "最長距離" : "最長時間"
        default: return "最高回数"
        }
    }

    func unit(_ ex: Exercise) -> String {
        switch ex.kind {
        case "weight": return "kg"
        case "time", "hiit": return "秒"
        case "cardio": return ex.defWeight > 0 ? "km" : "分"
        default: return "回"
        }
    }

    func volume(_ s: WorkoutSet) -> Double {
        guard let ex = exercise(s.exId), ex.kind == "weight" else { return 0 }
        return s.weight * s.reps
    }

    func text(_ ex: Exercise, _ s: WorkoutSet) -> String {
        switch ex.kind {
        case "weight": return "\(formatNumber(s.weight))kg × \(Int(s.reps))"
        case "time": return "\(Int(s.reps))秒"
        case "hiit": return "\(Int(s.reps))本 × \(formatNumber(s.weight))秒"
        case "cardio":
            let minutes = "\(formatNumber(s.reps / 60))分"
            return s.weight > 0 ? "\(formatNumber(s.weight))km・\(minutes)" : minutes
        default: return "\(Int(s.reps))回"
        }
    }

    func best(_ ex: Exercise) -> Double? {
        sets(of: ex.id).map { score(ex, $0) }.max()
    }

    /// 週に1回以上トレーニングした週が何週続いているか
    var weekStreak: Int {
        let weeks = Set(data.sets.map { Day.weekStart($0.date) })
        var w = Day.weekStart(Day.today)
        if !weeks.contains(w) { w = Day.add(w, -7) }
        var n = 0
        while weeks.contains(w) { n += 1; w = Day.add(w, -7) }
        return n
    }

    // MARK: 変更

    /// セットを記録する。自己ベスト更新なら true を返す
    @discardableResult
    func addSet(_ ex: Exercise, date: String, weight: Double, reps: Double) -> Bool {
        let previousBest = best(ex)
        let now = Store.nowMs
        let s = WorkoutSet(id: Store.newID(), exId: ex.id, date: date, ts: now,
                           weight: ["weight", "hiit", "cardio"].contains(ex.kind) ? weight : 0, reps: reps.rounded(), u: now)
        data.sets.append(s)
        // セット間の休憩タイマーは筋トレ系だけ
        if data.settings.restAuto && date == Day.today && ex.kind != "hiit" && ex.kind != "cardio" {
            restEnd = Date().addingTimeInterval(data.settings.restSec)
        }
        if let b = previousBest { return score(ex, s) > b + 1e-9 }
        return false
    }

    func deleteSet(_ id: String) {
        var d = data
        d.sets.removeAll { $0.id == id }
        var tomb = d.deleted ?? Tombstones()
        tomb.sets[id] = Store.nowMs
        d.deleted = tomb
        data = d
    }

    func saveExercise(_ ex: Exercise) {
        var e = ex
        e.u = Store.nowMs
        if let i = data.exercises.firstIndex(where: { $0.id == e.id }) { data.exercises[i] = e }
        else { data.exercises.append(e) }
    }

    func deleteExercise(_ id: String) {
        var d = data
        var tomb = d.deleted ?? Tombstones()
        for s in d.sets where s.exId == id { tomb.sets[s.id] = Store.nowMs }
        tomb.exercises[id] = Store.nowMs
        d.deleted = tomb
        d.sets.removeAll { $0.exId == id }
        d.exercises.removeAll { $0.id == id }
        data = d
    }

    func touchSettings() { data.settings.u = Store.nowMs }

    // MARK: からだの記録

    var bodyRecords: [BodyRecord] { (data.body ?? []).sorted { $0.date < $1.date } }

    /// その日の記録を保存する（同じ日があれば上書き）
    func saveBody(date: String, weight: Double, fat: Double) {
        var d = data
        var list = d.body ?? []
        let id = "b-" + date
        list.removeAll { $0.id == id }
        list.append(BodyRecord(id: id, date: date, weight: (weight * 100).rounded() / 100, fat: (fat * 10).rounded() / 10, u: Store.nowMs))
        d.body = list.sorted { $0.date < $1.date }
        data = d
    }

    func deleteBody(_ id: String) {
        var d = data
        d.body = (d.body ?? []).filter { $0.id != id }
        var tomb = d.deleted ?? Tombstones()
        var bodyTomb = tomb.body ?? [:]
        bodyTomb[id] = Store.nowMs
        tomb.body = bodyTomb
        d.deleted = tomb
        data = d
    }

    func setHeight(_ cm: Double) {
        var d = data
        d.settings.height = (cm * 10).rounded() / 10
        d.settings.u = Store.nowMs
        data = d
    }

    // MARK: バックアップ

    func exportData() -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted]
        return (try? enc.encode(data)) ?? Data()
    }

    /// PWA 版／ネイティブ版どちらのバックアップでも読み込める
    func importData(_ raw: Data) -> Bool {
        guard let decoded = try? JSONDecoder().decode(AppData.self, from: raw) else { return false }
        var d = decoded
        d.epoch = Store.nowMs // 復元は「丸ごと置き換え」として扱う（PWA 版と同じ）
        data = d
        return true
    }
}
