import SwiftUI

@main
struct KintoreLogApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: Store
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            LogView().tabItem { Label("記録", systemImage: "dumbbell.fill") }
            HistoryView().tabItem { Label("履歴", systemImage: "calendar") }
            StatsView().tabItem { Label("分析", systemImage: "chart.bar.fill") }
            BodyView().tabItem { Label("からだ", systemImage: "figure") }
            MenuView().tabItem { Label("メニュー", systemImage: "list.bullet") }
        }
        .safeAreaInset(edge: .bottom) { RestTimerBar().padding(.bottom, 56) }
        // アプリを開いたとき・戻ってきたときに、ヘルスケアの新しいデータを読み込む（連携オンのときだけ）
        .onAppear {
            HealthSync.shared.store = store
            HealthSync.shared.importNow()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { HealthSync.shared.importNow() }
        }
    }
}

/// 休憩タイマー。終了時刻を見て毎秒描き直すだけなので、アプリを離れて戻ってもずれない
struct RestTimerBar: View {
    @EnvironmentObject var store: Store

    var body: some View {
        if let end = store.restEnd {
            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                let left = Int(end.timeIntervalSince(context.date).rounded(.up))
                if left > 0 {
                    HStack(spacing: 12) {
                        Text("休憩").font(.caption.bold()).foregroundStyle(.secondary)
                        Text(String(format: "%d:%02d", left / 60, left % 60))
                            .font(.title2.bold().monospacedDigit())
                        Button("+30秒") { store.restEnd = end.addingTimeInterval(30) }
                            .buttonStyle(.bordered)
                        Button("スキップ") { store.restEnd = nil }
                            .buttonStyle(.bordered)
                    }
                    .padding(.vertical, 8)
                    .padding(.horizontal, 16)
                    .background(.regularMaterial, in: Capsule())
                    .shadow(radius: 8, y: 4)
                } else {
                    Color.clear.frame(height: 0)
                        .onAppear { store.restEnd = nil }
                }
            }
        }
    }
}

// MARK: - 共通部品

struct Tile: View {
    let label: String
    let value: String
    var unit: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value).font(.title2.weight(.heavy).monospacedDigit())
                Text(unit).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }
}

struct PartLabel: View {
    let part: String

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(bodyPart(part).color).frame(width: 8, height: 8)
            Text(bodyPart(part).name).font(.caption.bold()).foregroundStyle(.secondary)
        }
    }
}
