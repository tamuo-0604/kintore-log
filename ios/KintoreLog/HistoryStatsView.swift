import SwiftUI
import Charts

/// 履歴タブ：日付ごとの記録一覧（左スワイプで削除）
struct HistoryView: View {
    @EnvironmentObject var store: Store

    private var dates: [String] {
        Array(Set(store.data.sets.map { $0.date })).sorted(by: >)
    }

    var body: some View {
        NavigationStack {
            Group {
                if dates.isEmpty {
                    ContentUnavailableView("まだ記録がありません", systemImage: "calendar",
                                           description: Text("記録タブからトレーニングを記録しましょう"))
                } else {
                    List {
                        ForEach(dates, id: \.self) { date in
                            let sets = store.sets(on: date)
                            Section {
                                ForEach(sets) { s in
                                    if let ex = store.exercise(s.exId) {
                                        HStack {
                                            Circle().fill(bodyPart(ex.part).color).frame(width: 8, height: 8)
                                            Text(ex.name)
                                            Spacer()
                                            Text(store.text(ex, s)).monospacedDigit().foregroundStyle(.secondary)
                                        }
                                    }
                                }
                                .onDelete { offsets in
                                    for i in offsets { store.deleteSet(sets[i].id) }
                                }
                            } header: {
                                Text("\(Day.label(date))・\(sets.count)セット・\(formatNumber(sets.reduce(0) { $0 + store.volume($1) }))kg")
                            }
                        }
                    }
                }
            }
            .navigationTitle("履歴")
        }
    }
}

/// 分析タブ：週ごとのボリュームと、種目別の伸び
struct StatsView: View {
    @EnvironmentObject var store: Store
    @State private var exerciseID = ""

    private struct Point: Identifiable {
        let id: String
        let label: String
        let value: Double
    }

    private func sets(inWeek start: String) -> [WorkoutSet] {
        let end = Day.add(start, 7)
        return store.data.sets.filter { $0.date >= start && $0.date < end }
    }

    private var weeks: [Point] {
        let w0 = Day.weekStart(Day.today)
        return (0..<8).reversed().map { i in
            let start = Day.add(w0, -7 * i)
            return Point(id: start, label: Day.short(start),
                         value: sets(inWeek: start).reduce(0) { $0 + store.volume($1) })
        }
    }

    private var exercisesWithData: [Exercise] {
        store.data.exercises.filter { ex in store.data.sets.contains { $0.exId == ex.id } }
    }

    private func progress(_ ex: Exercise) -> [Point] {
        var bestByDay: [String: Double] = [:]
        for s in store.sets(of: ex.id) {
            bestByDay[s.date] = max(bestByDay[s.date] ?? 0, store.score(ex, s))
        }
        return bestByDay.keys.sorted().suffix(20).map {
            Point(id: $0, label: Day.short($0), value: bestByDay[$0] ?? 0)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if store.data.sets.isEmpty {
                    ContentUnavailableView("記録がたまると表示されます", systemImage: "chart.bar")
                        .padding(.top, 80)
                } else {
                    content
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("分析")
        }
    }

    private var content: some View {
        let thisWeek = sets(inWeek: Day.weekStart(Day.today))
        let ex = exercisesWithData.first(where: { $0.id == exerciseID }) ?? exercisesWithData.first
        return VStack(alignment: .leading, spacing: 14) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
                Tile(label: "今週のトレ日数", value: "\(Set(thisWeek.map { $0.date }).count)", unit: "日")
                Tile(label: "今週のボリューム", value: formatNumber(thisWeek.reduce(0) { $0 + store.volume($1) }), unit: "kg")
                Tile(label: "継続", value: "\(store.weekStreak)", unit: "週連続")
                Tile(label: "累計トレ日数", value: "\(Set(store.data.sets.map { $0.date }).count)", unit: "日")
            }

            card("週ごとのボリューム", "直近8週（月曜はじまり）・重量×回数の合計") {
                Chart(weeks) { w in
                    BarMark(x: .value("週", w.label), y: .value("kg", w.value), width: .fixed(22))
                        .cornerRadius(4)
                        .foregroundStyle(Color.accentColor)
                }
                .frame(height: 180)
            }

            if let ex {
                card("種目別の伸び", "各日のベスト（\(store.scoreLabel(ex))・\(store.unit(ex))）") {
                    Picker("種目", selection: Binding(get: { ex.id }, set: { exerciseID = $0 })) {
                        ForEach(exercisesWithData) { e in Text(e.name).tag(e.id) }
                    }
                    .pickerStyle(.menu)
                    Chart(progress(ex)) { p in
                        LineMark(x: .value("日付", p.label), y: .value("値", p.value))
                            .foregroundStyle(Color.accentColor)
                        PointMark(x: .value("日付", p.label), y: .value("値", p.value))
                            .foregroundStyle(Color.accentColor)
                    }
                    .chartYScale(domain: .automatic(includesZero: false))
                    .frame(height: 200)
                }
            }
        }
        .padding(16)
        .padding(.bottom, 80)
    }

    private func card<Content: View>(_ title: String, _ note: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            content()
            Text(note).font(.caption).foregroundStyle(.secondary)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }
}
