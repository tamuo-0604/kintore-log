import SwiftUI
import AVFoundation
import UIKit

// HIIT タイマー。準備(5秒) →［高強度 → インターバル］× 本数 → 完了。
// 「この時刻に終わる」という終了時刻で管理するので、アプリを離れて戻ってもずれない。

/// 合図の音を鳴らす係。音声ファイルを持たず、その場で「ピッ」という音を作る。
/// 再生カテゴリを .playback にしているので、消音モードでも鳴る。音楽アプリの再生は止めない。
final class TonePlayer {
    private var players: [AVAudioPlayer] = []

    func activate() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, options: [.mixWithOthers])
        try? session.setActive(true)
    }

    func play(_ frequency: Double, _ duration: Double) {
        guard let player = try? AVAudioPlayer(data: TonePlayer.wav(frequency: frequency, duration: duration)) else { return }
        player.volume = 0.7
        player.play()
        players.removeAll { !$0.isPlaying }
        players.append(player)
    }

    /// 指定した高さ・長さの音を WAV 形式のデータとして作る
    static func wav(frequency: Double, duration: Double) -> Data {
        let rate = 44100.0
        let count = Int(rate * duration)
        var data = Data()
        func put32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func put16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); put32(UInt32(36 + count * 2))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); put32(16)
        put16(1); put16(1); put32(44100); put32(88200); put16(2); put16(16)
        data.append(contentsOf: Array("data".utf8)); put32(UInt32(count * 2))
        for i in 0..<count {
            let t = Double(i) / rate
            let envelope = min(1, t / 0.01) * min(1, max(0, duration - t) / 0.03) // 出だしと終わりをなめらかに
            let sample = sin(2 * Double.pi * frequency * t) * envelope * 0.8
            put16(UInt16(bitPattern: Int16(sample * 32767)))
        }
        return data
    }
}

final class HiitTimer: ObservableObject {
    enum Phase { case ready, work, rest, done }

    let rounds: Int
    let work: Int
    let rest: Int

    @Published var phase: Phase = .ready
    @Published var done = 0            // やり終えた高強度の本数
    @Published var paused = false
    @Published var secondsLeft = 5
    @Published var progress = 0.0      // いまの段階の進み具合（0〜1）
    private(set) var elapsed = 0       // 開始から完了までの秒数

    private var end = Date().addingTimeInterval(5)
    private var duration = 5.0
    private var pausedLeft = 0.0
    private var lastSecond = -1
    private let startedAt = Date()
    private let tone = TonePlayer()

    init(rounds: Int, work: Int, rest: Int) {
        self.rounds = max(1, rounds)
        self.work = max(1, work)
        self.rest = max(0, rest)
        tone.activate()
    }

    /// 全体の残り時間（秒）
    var remaining: Int {
        let toGo = rounds - done // まだ終わっていない本数（実行中を含む）
        switch phase {
        case .ready: return secondsLeft + rounds * work + (rounds - 1) * rest
        case .work: return secondsLeft + (toGo - 1) * (work + rest)
        case .rest: return secondsLeft + toGo * work + (toGo - 1) * rest
        case .done: return 0
        }
    }

    var nextText: String {
        if phase == .work {
            if done + 1 >= rounds { return "次: 完了" }
            return rest > 0 ? "次: 休憩 \(rest)秒" : "次: 高強度 \(work)秒"
        }
        return "次: 高強度 \(work)秒"
    }

    /// 0.1 秒ごとに呼ばれる
    func tick() {
        guard !paused, phase != .done else { return }
        let now = Date()
        var changed = false
        var loops = 0
        while phase != .done && now >= end && loops < 1000 { // 離れていた間のぶんもまとめて進める
            advance(from: end)
            changed = true
            loops += 1
        }
        if changed { cue() }
        guard phase != .done else { return }
        let left = end.timeIntervalSince(now)
        let second = Int(left.rounded(.up))
        if second != lastSecond {
            lastSecond = second
            secondsLeft = second
            if !changed && second >= 1 && second <= 3 { tone.play(700, 0.1) } // 3・2・1 のカウント
        }
        progress = min(1, max(0, 1 - left / duration))
    }

    private func setPhase(_ next: Phase, _ seconds: Int, from: Date) {
        phase = next
        duration = Double(seconds)
        end = from.addingTimeInterval(duration)
        lastSecond = -1
    }

    private func advance(from: Date) {
        if phase == .ready || phase == .rest { return setPhase(.work, work, from: from) }
        done += 1
        if done >= rounds { return finish() }
        if rest > 0 { return setPhase(.rest, rest, from: from) }
        setPhase(.work, work, from: from)
    }

    private func finish() {
        phase = .done
        elapsed = Int(Date().timeIntervalSince(startedAt))
    }

    /// 段階が変わったときの合図（音と振動）
    private func cue() {
        switch phase {
        case .work:
            tone.play(1320, 0.4)
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case .rest:
            tone.play(520, 0.4)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .done:
            tone.play(1320, 0.6)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .ready:
            break
        }
    }

    func togglePause() {
        if paused {
            paused = false
            end = Date().addingTimeInterval(pausedLeft)
        } else {
            paused = true
            pausedLeft = max(0, end.timeIntervalSinceNow)
        }
    }

    func skip() {
        if paused { paused = false }
        end = Date()
        tick()
    }

    /// 途中で終了する（やり終えた本数はそのまま残る）
    func stop() {
        guard phase != .done else { return }
        finish()
    }
}

struct HiitTimerView: View {
    let name: String
    /// 閉じるときに呼ばれる。記録する場合はやり終えた本数、記録しない場合は nil
    let onClose: (Int?) -> Void

    @StateObject private var timer: HiitTimer
    private let ticker = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    init(name: String, rounds: Int, work: Int, rest: Int, onClose: @escaping (Int?) -> Void) {
        self.name = name
        self.onClose = onClose
        _timer = StateObject(wrappedValue: HiitTimer(rounds: rounds, work: work, rest: rest))
    }

    private var background: Color {
        switch timer.phase {
        case .work: return Color.accentColor
        case .rest: return Color(red: 0.12, green: 0.22, blue: 0.36)
        default: return Color(.systemBackground)
        }
    }

    private var foreground: Color {
        switch timer.phase {
        case .work: return Color(.systemBackground)
        case .rest: return .white
        default: return .primary
        }
    }

    var body: some View {
        ZStack {
            background.ignoresSafeArea()
            if timer.phase == .done { finished } else { running }
        }
        .foregroundStyle(foreground)
        .animation(.easeInOut(duration: 0.25), value: timer.phase)
        .onReceive(ticker) { _ in timer.tick() }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }   // タイマー中は画面を消さない
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private var running: some View {
        VStack(spacing: 0) {
            HStack {
                Text(name).font(.subheadline.bold()).opacity(0.8)
                Spacer()
                Button("終了") {
                    if timer.done > 0 { timer.stop() } else { onClose(nil) } // 1本もやっていなければそのまま閉じる
                }
                .font(.subheadline.bold())
                .padding(.horizontal, 14).padding(.vertical, 8)
                .overlay(Capsule().stroke(foreground.opacity(0.6)))
            }
            Spacer()
            Text(label.0).font(.title.weight(.heavy)).tracking(6)
            Text(label.1).font(.subheadline.bold()).opacity(0.75)
            Text(timer.secondsLeft >= 60 ? clock(timer.secondsLeft) : "\(timer.secondsLeft)")
                .font(.system(size: 220, weight: .heavy).monospacedDigit())
                .minimumScaleFactor(0.3)
                .lineLimit(1)
                .opacity(timer.paused ? 0.45 : 1)
            Text(timer.phase == .ready ? "全 \(timer.rounds) 本" : "\(min(timer.rounds, timer.done + 1)) / \(timer.rounds) 本目")
                .font(.title3.weight(.heavy).monospacedDigit())
            ProgressView(value: timer.progress)
                .tint(foreground)
                .frame(maxWidth: 520)
                .padding(.top, 22)
            HStack {
                Text(timer.nextText)
                Spacer()
                Text("残り \(clock(timer.remaining))").monospacedDigit()
            }
            .font(.footnote.bold())
            .opacity(0.8)
            .frame(maxWidth: 520)
            .padding(.top, 8)
            Spacer()
            HStack(spacing: 12) {
                control(timer.paused ? "再開" : "一時停止") { timer.togglePause() }
                control("スキップ") { timer.skip() }
            }
        }
        .padding(20)
    }

    private var finished: some View {
        VStack(spacing: 8) {
            Spacer()
            Image(systemName: "trophy.fill")
                .font(.system(size: 40))
                .frame(width: 84, height: 84)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 28))
                .foregroundStyle(Color(.systemBackground))
                .padding(.bottom, 10)
            Text(timer.done >= timer.rounds ? "おつかれさま！" : "途中で終了").font(.largeTitle.weight(.heavy))
            Text("\(timer.done)本 × \(timer.work)秒").font(.system(size: 44, weight: .heavy).monospacedDigit())
            Text("高強度 合計 \(clock(timer.done * timer.work))・所要 \(clock(timer.elapsed))")
                .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            Spacer()
            Button { onClose(timer.done) } label: {
                Text("記録して閉じる").font(.title3.bold())
                    .frame(maxWidth: 420, minHeight: 60)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18))
                    .foregroundStyle(Color(.systemBackground))
            }
            .buttonStyle(.plain)
            Button("記録しない") { onClose(nil) }
                .font(.headline)
                .frame(maxWidth: 420, minHeight: 50)
        }
        .padding(20)
    }

    private var label: (String, String) {
        switch timer.phase {
        case .work: return ("HIGH", "全力！")
        case .rest: return ("REST", "休憩")
        default: return ("READY", "準備")
        }
    }

    private func control(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.headline)
                .frame(maxWidth: 250, minHeight: 58)
                .background(foreground.opacity(0.14), in: RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
    }

    private func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", max(0, seconds) / 60, max(0, seconds) % 60)
    }
}
