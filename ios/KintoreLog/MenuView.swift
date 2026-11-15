import SwiftUI
import UniformTypeIdentifiers

/// メニュータブ：メニューの追加・編集と、設定・バックアップ
struct MenuView: View {
    @EnvironmentObject var store: Store
    @State private var editing: Exercise?
    @State private var exporting = false
    @State private var importing = false
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(bodyParts) { p in
                    let list = store.data.exercises.filter { $0.part == p.id }
                    if !list.isEmpty {
                        Section {
                            ForEach(list) { ex in
                                Button { editing = ex } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(ex.name).foregroundStyle(Color.primary)
                                            Text(kindNames.first(where: { $0.id == ex.kind })?.name ?? "")
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        if ex.archived {
                                            Text("非表示").font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                        } header: {
                            PartLabel(part: p.id)
                        }
                    }
                }

                Section("休憩タイマー") {
                    Toggle("記録したら自動でスタート", isOn: $store.data.settings.restAuto)
                        .onChange(of: store.data.settings.restAuto) { store.touchSettings() }
                    Picker("休憩時間", selection: $store.data.settings.restSec) {
                        Text("60秒").tag(60.0)
                        Text("90秒").tag(90.0)
                        Text("2分").tag(120.0)
                        Text("3分").tag(180.0)
                    }
                    .onChange(of: store.data.settings.restSec) { store.touchSettings() }
                }

                Section {
                    Button("バックアップを書き出す") { exporting = true }
                    Button("バックアップから復元") { importing = true }
                } header: {
                    Text("データ")
                } footer: {
                    Text("ネイティブ版は端末間の自動同期にまだ対応していません。Web 版（PWA）のバックアップはそのまま読み込めます。")
                }
            }
            .navigationTitle("メニュー")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        editing = Exercise(id: Store.newID(), name: "", part: "chest", kind: "weight",
                                           step: 2.5, defWeight: 20, defReps: 10, archived: false)
                    } label: {
                        Label("追加", systemImage: "plus")
                    }
                }
            }
            .sheet(item: $editing) { ex in
                ExerciseEditor(draft: ex, isNew: store.exercise(ex.id) == nil)
            }
            .fileExporter(isPresented: $exporting, document: BackupDocument(data: store.exportData()),
                          contentType: .json, defaultFilename: "kintore-log-\(Day.today)") { _ in }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                guard case .success(let url) = result else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let raw = try? Data(contentsOf: url), store.importData(raw) {
                    notice = "復元しました"
                } else {
                    notice = "このファイルは読み込めませんでした"
                }
            }
            .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
                Button("OK", role: .cancel) {}
            }
        }
    }
}

struct ExerciseEditor: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State var draft: Exercise
    let isNew: Bool
    @State private var confirmingDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section("メニュー名") {
                    TextField("例: インクラインベンチプレス", text: $draft.name)
                }
                Section {
                    Picker("部位", selection: $draft.part) {
                        ForEach(bodyParts) { p in Text(p.name).tag(p.id) }
                    }
                    Picker("記録のしかた", selection: $draft.kind) {
                        ForEach(kindNames) { k in Text(k.name).tag(k.id) }
                    }
                }
                Section("最初の値") {
                    if draft.kind == "weight" {
                        LabeledContent("重量 (kg)") {
                            TextField("0", value: $draft.defWeight, format: .number)
                                .keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                        }
                        Picker("＋−の刻み (kg)", selection: $draft.step) {
                            ForEach([0.5, 1, 2, 2.5, 5, 10], id: \.self) { v in Text(formatNumber(v)).tag(v) }
                        }
                    }
                    LabeledContent(draft.kind == "time" ? "秒数" : "回数") {
                        TextField("0", value: $draft.defReps, format: .number)
                            .keyboardType(.numberPad).multilineTextAlignment(.trailing)
                    }
                }
                if !isNew {
                    Section {
                        Toggle("記録画面に表示", isOn: Binding(get: { !draft.archived }, set: { draft.archived = !$0 }))
                        Button("このメニューを削除", role: .destructive) { confirmingDelete = true }
                    } footer: {
                        Text("削除すると、このメニューの記録も一緒に消えます。隠すだけなら「記録画面に表示」をオフに。")
                    }
                }
            }
            .navigationTitle(isNew ? "メニューを追加" : "メニューを編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        draft.name = draft.name.trimmingCharacters(in: .whitespaces)
                        store.saveExercise(draft)
                        dismiss()
                    }
                    .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty || draft.defReps <= 0)
                }
            }
            .confirmationDialog("「\(draft.name)」を削除しますか？", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("削除する", role: .destructive) {
                    store.deleteExercise(draft.id)
                    dismiss()
                }
            }
        }
    }
}

struct BackupDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
