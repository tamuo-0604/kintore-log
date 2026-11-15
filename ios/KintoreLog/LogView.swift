import SwiftUI

/// 記録タブ：メニューを選ぶ → 回数を入れて記録
struct LogView: View {
    @EnvironmentObject var store: Store
    @State private var date = Day.today
    @State private var partFilter = "all"
    @State private var selected: Exercise?

    private var daySets: [WorkoutSet] { store.sets(on: date) }

    private var exercises: [Exercise] {
        store.data.exercises.filter { !$0.archived && (partFilter == "all" || $0.part == partFilter) }
    }

    private var usedParts: [BodyPart] {
        bodyParts.filter { p in store.data.exercises.contains { !$0.archived && $0.part == p.id } }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 10) {
                        Tile(label: "種目", value: "\(Set(daySets.map { $0.exId }).count)")
                        Tile(label: "セット", value: "\(daySets.count)")
                        Tile(label: "ボリューム", value: formatNumber(daySets.reduce(0) { $0 + store.volume($1) }), unit: "kg")
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            filterChip("all", "すべて", nil)
                            ForEach(usedParts) { p in filterChip(p.id, p.name, p.color) }
                        }
                    }

                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 158), spacing: 10)], spacing: 10) {
                        ForEach(exercises) { ex in
                            Button { selected = ex } label: { card(ex) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 80)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(date == Day.today ? "今日" : Day.label(date))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    DatePicker("記録する日", selection: Binding(
                        get: { Day.date(date) },
                        set: { date = Day.string($0) }
                    ), in: ...Date(), displayedComponents: .date)
                    .labelsHidden()
                }
            }
            .sheet(item: $selected) { ex in
                SetInputView(exerciseID: ex.id, date: date)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    private func filterChip(_ id: String, _ name: String, _ color: Color?) -> some View {
        let on = partFilter == id
        return Button { partFilter = id } label: {
            HStack(spacing: 6) {
                if let color { Circle().fill(color).frame(width: 8, height: 8) }
                Text(name).font(.subheadline.weight(.semibold))
            }
            .padding(.horizontal, 14)
            .frame(height: 38)
            .foregroundStyle(on ? Color(.systemBackground) : Color.primary)
            .background(on ? Color.primary : Color(.secondarySystemGroupedBackground), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func card(_ ex: Exercise) -> some View {
        let count = daySets.filter { $0.exId == ex.id }.count
        let last = store.lastSession(ex.id, before: date)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                PartLabel(part: ex.part)
                Spacer()
                if count > 0 {
                    Text("\(count)セット")
                        .font(.caption2.weight(.heavy))
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Color.accentColor, in: Capsule())
                        .foregroundStyle(Color(.systemBackground))
                }
            }
            Text(ex.name).font(.headline).multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            Group {
                if let last, let first = last.sets.first {
                    Text("前回 \(Day.short(last.date))・\(store.text(ex, first))")
                } else {
                    Text("記録なし")
                }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 108, alignment: .topLeading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }
}

/// 入力シート：重量と回数を＋−で決めて「記録」
struct SetInputView: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let exerciseID: String
    let date: String

    @State private var weight: Double = 0
    @State private var reps: Double = 0
    @State private var loaded = false
    @State private var recordCount = 0
    @State private var message: String?

    var body: some View {
        if let ex = store.exercise(exerciseID) {
            content(ex)
        } else {
            Text("メニューが見つかりません")
        }
    }

    private func content(_ ex: Exercise) -> some View {
        let todays = store.sets(of: ex.id).filter { $0.date == date }
        let last = store.lastSession(ex.id, before: date)
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        PartLabel(part: ex.part)
                        Text(ex.name).font(.title.weight(.heavy))
                    }
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark.circle.fill").font(.title).foregroundStyle(.tertiary)
                    }
                    .accessibilityLabel("閉じる")
                }

                VStack(alignment: .leading, spacing: 6) {
                    reference(last.map { "前回 \(Day.short($0.date))" } ?? "前回",
                              last.map { $0.sets.map { s in store.text(ex, s) }.joined(separator: " / ") } ?? "はじめての記録です")
                    if let best = store.best(ex) {
                        reference("自己ベスト", "\(store.scoreLabel(ex)) \(formatNumber(best))\(store.unit(ex))")
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14))

                if ex.kind == "weight" {
                    NumberStepper(label: "重量", unit: "kg", value: $weight, step: ex.step)
                }
                if ex.kind == "time" {
                    NumberStepper(label: "時間", unit: "秒", value: $reps, step: 5, quick: [30, 45, 60, 90, 120])
                } else {
                    NumberStepper(label: "回数", unit: "回", value: $reps, step: 1, quick: [5, 8, 10, 12, 15, 20])
                }

                Button {
                    guard reps > 0 else { return }
                    let isBest = store.addSet(ex, date: date, weight: weight, reps: reps)
                    message = isBest ? "🏆 自己ベスト更新！" : nil
                    recordCount += 1
                } label: {
                    Text("\(todays.count + 1)セット目を記録")
                        .font(.title3.bold())
                        .frame(maxWidth: .infinity, minHeight: 60)
                        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18))
                        .foregroundStyle(Color(.systemBackground))
                }
                .buttonStyle(.plain)
                .sensoryFeedback(.success, trigger: recordCount)

                if let message {
                    Text(message).font(.headline).frame(maxWidth: .infinity)
                }

                if !todays.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(date == Day.today ? "今日のセット" : "\(Day.short(date)) のセット")
                            .font(.caption.bold()).foregroundStyle(.secondary)
                        ForEach(Array(todays.enumerated()), id: \.element.id) { index, s in
                            HStack {
                                Text("\(index + 1)").font(.caption.weight(.heavy))
                                    .frame(width: 26, height: 26)
                                    .background(Color.accentColor.opacity(0.25), in: Circle())
                                Text(store.text(ex, s)).font(.body.weight(.bold).monospacedDigit())
                                Spacer()
                                Button { store.deleteSet(s.id) } label: {
                                    Image(systemName: "xmark").foregroundStyle(.secondary)
                                }
                                .accessibilityLabel("\(index + 1)セット目を削除")
                            }
                            .padding(.vertical, 8)
                            Divider()
                        }
                    }
                }
            }
            .padding(20)
            .padding(.bottom, 80)
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            // 初期値：今日の直前のセット → 前回の1セット目 → メニューの既定値
            let base = todays.last ?? last?.sets.first
            weight = base?.weight ?? ex.defWeight
            reps = base?.reps ?? ex.defReps
        }
    }

    private func reference(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(key).foregroundStyle(.secondary).frame(width: 76, alignment: .leading)
            Text(value).monospacedDigit()
        }
        .font(.footnote.weight(.semibold))
    }
}

struct NumberStepper: View {
    let label: String
    let unit: String
    @Binding var value: Double
    let step: Double
    var quick: [Double] = []

    var body: some View {
        VStack(spacing: 8) {
            Text(label).font(.caption.bold()).foregroundStyle(.secondary)
            HStack(spacing: 14) {
                round("minus") { value = max(0, value - step) }
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    TextField(label, value: $value, format: .number)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .font(.system(size: 52, weight: .heavy).monospacedDigit())
                        .minimumScaleFactor(0.5)
                    Text(unit).font(.headline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: 200)
                round("plus") { value += step }
            }
            if !quick.isEmpty {
                HStack(spacing: 8) {
                    ForEach(quick, id: \.self) { q in
                        Button { value = q } label: {
                            Text(formatNumber(q))
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .padding(.horizontal, 12)
                                .frame(height: 38)
                                .foregroundStyle(q == value ? Color(.systemBackground) : Color.primary)
                                .background(q == value ? Color.primary : Color(.tertiarySystemFill), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func round(_ symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.title2.weight(.semibold))
                .frame(width: 60, height: 60)
                .background(Color(.tertiarySystemFill), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(symbol == "plus" ? "\(label)を増やす" : "\(label)を減らす")
    }
}
