import SwiftUI
import Charts

/// からだタブ：体重・体脂肪率・身長の記録と推移
struct BodyView: View {
    @EnvironmentObject var store: Store
    @State private var editing: BodyDraft?
    @State private var editingHeight = false
    @State private var heightText = ""

    private var records: [BodyRecord] { store.bodyRecords }
    private var height: Double { store.data.settings.height ?? 0 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    tiles
                    if records.isEmpty {
                        ContentUnavailableView("まだ記録がありません", systemImage: "figure",
                                               description: Text("右上の＋から体重を記録すると、推移のグラフが表示されます"))
                            .padding(.top, 30)
                    } else {
                        chart
                        history
                    }
                }
                .padding(16)
                .padding(.bottom, 80)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("からだ")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        let today = records.first(where: { $0.date == Day.today })
                        editing = BodyDraft(original: today, date: Date(),
                                            weight: today?.weight ?? records.last?.weight ?? 60, fat: today?.fat ?? 0)
                    } label: {
                        Label("記録", systemImage: "plus")
                    }
                }
            }
            .sheet(item: $editing) { draft in BodyEditor(draft: draft) }
            .alert("身長 (cm)", isPresented: $editingHeight) {
                TextField("例: 170", text: $heightText).keyboardType(.decimalPad)
                Button("保存") {
                    if let v = Double(heightText), v >= 100, v <= 250 { store.setHeight(v) }
                }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("BMI と標準体重の計算に使います（100〜250）")
            }
        }
    }

    private var tiles: some View {
        let last = records.last
        let m2 = height > 0 ? (height / 100) * (height / 100) : 0
        let lastFat = records.last(where: { $0.fat > 0 })
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
            Tile(label: "体重", value: last.map { formatNumber($0.weight) } ?? "—", unit: last == nil ? "" : "kg")
            Tile(label: "BMI", value: (last != nil && m2 > 0) ? formatNumber(last!.weight / m2) : "—")
            Tile(label: "体脂肪率", value: lastFat.map { formatNumber($0.fat) } ?? "—", unit: lastFat == nil ? "" : "%")
            Button {
                heightText = height > 0 ? formatNumber(height) : ""
                editingHeight = true
            } label: {
                Tile(label: "身長（タップで変更）", value: height > 0 ? formatNumber(height) : "—", unit: height > 0 ? "cm" : "")
            }
            .buttonStyle(.plain)
        }
    }

    private var chart: some View {
        let points = Array(records.suffix(90))
        return VStack(alignment: .leading, spacing: 12) {
            Text("体重の推移").font(.headline)
            Chart(points) { r in
                LineMark(x: .value("日付", Day.date(r.date)), y: .value("kg", r.weight))
                    .foregroundStyle(Color.accentColor)
                if points.count <= 40 {
                    PointMark(x: .value("日付", Day.date(r.date)), y: .value("kg", r.weight))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .chartYScale(domain: .automatic(includesZero: false))
            .frame(height: 200)
            Text("直近 \(points.count) 件").font(.caption).foregroundStyle(.secondary)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("記録").font(.caption.bold()).foregroundStyle(.secondary).padding(.bottom, 4)
            ForEach(Array(records.reversed().prefix(60))) { r in
                Button {
                    editing = BodyDraft(original: r, date: Day.date(r.date), weight: r.weight, fat: r.fat)
                } label: {
                    HStack {
                        Text(Day.label(r.date)).fontWeight(.semibold)
                        Spacer()
                        Text("\(formatNumber(r.weight))kg").fontWeight(.bold).monospacedDigit()
                        if r.fat > 0 {
                            Text("\(formatNumber(r.fat))%").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Divider()
            }
            Text("タップすると修正・削除できます").font(.caption).foregroundStyle(.secondary).padding(.top, 10)
        }
        .padding(18)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }
}

/// 入力中の値。original があれば「修正」、なければ「新規」
struct BodyDraft: Identifiable {
    let id = UUID()
    var original: BodyRecord?
    var date: Date
    var weight: Double
    var fat: Double
}

struct BodyEditor: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State var draft: BodyDraft

    private var valid: Bool { draft.weight >= 20 && draft.weight <= 300 && draft.fat >= 0 && draft.fat <= 70 }

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("日付", selection: $draft.date, in: ...Date(), displayedComponents: .date)
                LabeledContent("体重 (kg)") {
                    TextField("例: 65.5", value: $draft.weight, format: .number)
                        .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                }
                LabeledContent("体脂肪率 (%)") {
                    TextField("0 で未入力", value: $draft.fat, format: .number)
                        .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                }
                if let original = draft.original {
                    Section {
                        Button("この記録を削除", role: .destructive) {
                            store.deleteBody(original.id)
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(draft.original == nil ? "からだを記録" : "記録を修正")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let date = Day.string(draft.date)
                        if let original = draft.original, original.date != date { store.deleteBody(original.id) }
                        store.saveBody(date: date, weight: draft.weight, fat: draft.fat)
                        dismiss()
                    }
                    .disabled(!valid)
                }
            }
        }
    }
}
