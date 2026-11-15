/* 筋トレログ — メニューを選んで回数を記録するだけのシンプルな記録アプリ
 *
 * 構成（上から順に）
 *   1. データ（保存・読み込み・初期メニュー）
 *   2. 計算（日付、ボリューム、自己ベストなど）
 *   3. 画面部品（DOM を作る小道具、トースト、ダイアログ、休憩タイマー）
 *   4. 各タブの画面（記録 / 履歴 / 分析 / メニュー）
 *
 * データはすべて端末内（localStorage）に保存され、外部には送信しません。
 */
'use strict';

/* ───────────── 1. データ ───────────── */

const STORE_KEY = 'kintore-log.v1';

// 部位。color は styles.css の --p-◯◯ と対応
const PARTS = [
  { id: 'chest', name: '胸' },
  { id: 'back', name: '背中' },
  { id: 'legs', name: '脚' },
  { id: 'shoulders', name: '肩' },
  { id: 'arms', name: '腕' },
  { id: 'abs', name: '腹' },
  { id: 'hiit', name: 'HIIT' },
  { id: 'cardio', name: '有酸素' },
  { id: 'other', name: 'その他' },
];
const partName = (id) => (PARTS.find((p) => p.id === id) || PARTS[PARTS.length - 1]).name;

// 記録タイプ: weight=重量×回数 / body=回数のみ（自重） / time=秒数
//   hiit=HIIT（本数・高強度の秒数・インターバルの秒数を決めてタイマーで実施）
//   cardio=距離×時間（ランニングなど）
const KINDS = {
  weight: '重量 × 回数', body: '回数のみ（自重）', time: '時間（秒）',
  hiit: 'HIIT（タイマー）', cardio: '距離 × 時間（ランニングなど）',
};
const DATA_VERSION = 3; // データの形の版。2 で HIIT・有酸素、3 で HIIT の開始前の準備時間を追加

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 最初から入っているメニュー。id を固定しているので、どの端末でも「同じメニュー」として同期できる
function seedExercises() {
  const E = (key, name, part, kind, weight, reps, step = 2.5) =>
    ({ id: 'seed-' + key, name, part, kind, step, defWeight: weight, defReps: reps, archived: false, rest: 10, prep: 10, u: 0 });
  return [
    E('bench-press', 'ベンチプレス', 'chest', 'weight', 40, 10),
    E('dumbbell-press', 'ダンベルプレス', 'chest', 'weight', 14, 10, 2),
    E('push-up', '腕立て伏せ', 'chest', 'body', 0, 15),
    E('deadlift', 'デッドリフト', 'back', 'weight', 60, 5),
    E('lat-pulldown', 'ラットプルダウン', 'back', 'weight', 35, 10),
    E('pull-up', '懸垂', 'back', 'body', 0, 8),
    E('squat', 'スクワット', 'legs', 'weight', 50, 8),
    E('leg-press', 'レッグプレス', 'legs', 'weight', 80, 10, 5),
    E('bulgarian-squat', 'ブルガリアンスクワット', 'legs', 'body', 0, 10),
    E('shoulder-press', 'ショルダープレス', 'shoulders', 'weight', 20, 10),
    E('side-raise', 'サイドレイズ', 'shoulders', 'weight', 5, 15, 1),
    E('arm-curl', 'アームカール', 'arms', 'weight', 10, 12, 1),
    E('triceps-pressdown', 'トライセプスプレスダウン', 'arms', 'weight', 20, 12),
    E('crunch', 'クランチ', 'abs', 'body', 0, 20),
    E('plank', 'プランク', 'abs', 'time', 0, 60),
    // HIIT: 本数, 高強度の秒数, インターバルの秒数
    { ...E('hiit-tabata', 'タバタ式（20秒×8本）', 'hiit', 'hiit', 20, 8), rest: 10 },
    { ...E('hiit-30-30', 'HIIT 30-30', 'hiit', 'hiit', 30, 10), rest: 30 },
    // 有酸素: 距離(km), 時間(秒), 距離の刻み
    E('running', 'ランニング', 'cardio', 'cardio', 5, 1800, 0.5),
    E('walking', 'ウォーキング', 'cardio', 'cardio', 3, 1800, 0.5),
  ];
}

/* データの形
 *   exercises: メニュー。u は最終更新時刻（ミリ秒）
 *   sets:      記録。{ id, exId, date:'YYYY-MM-DD', ts, weight, reps, u }
 *              weight / reps の意味は記録タイプで変わる:
 *                weight … 重量(kg) / 回数      body … (未使用) / 回数     time … (未使用) / 秒数
 *                hiit   … 高強度の秒数 / やった本数      cardio … 距離(km) / 時間(秒)
 *   deleted:   削除した記録・メニューの id と削除時刻。同期のとき「他の端末でも消す」ために残す
 *   epoch:     「全削除」「バックアップから復元」をした時刻。新しいほうが丸ごと優先される
 */
function defaultState() {
  return {
    version: DATA_VERSION,
    epoch: 0,
    exercises: seedExercises(),
    sets: [],
    deleted: { sets: {}, exercises: {} },
    settings: { restSec: 90, restAuto: true, sound: true, u: 0 },
  };
}

// 外部から来たデータ（読み込み・インポート）を安全な形に整える
function normalize(raw) {
  if (!raw || !Array.isArray(raw.exercises) || !Array.isArray(raw.sets)) return null;
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const del = raw.deleted || {};
  const exercises = raw.exercises.filter((e) => e && e.id && e.name).map((e) => ({
    id: String(e.id),
    name: String(e.name).slice(0, 40),
    part: PARTS.some((p) => p.id === e.part) ? e.part : 'other',
    kind: KINDS[e.kind] ? e.kind : 'weight',
    step: num(e.step, 2.5) > 0 ? num(e.step, 2.5) : 2.5,
    defWeight: Math.max(0, num(e.defWeight)),
    defReps: Math.max(1, num(e.defReps, 10)),
    archived: !!e.archived,
    rest: Math.max(0, num(e.rest, 10)), // HIIT のインターバル秒数
    prep: Math.min(600, Math.max(0, num(e.prep, 10))), // HIIT の開始前の準備秒数
    u: num(e.u),
  }));
  // 古い版のデータには、あとから追加した初期メニュー（HIIT・有酸素）を足す。自分で消したものは足さない
  if (num(raw.version, 1) < 2) {
    for (const e of seedExercises().filter((x) => x.kind === 'hiit' || x.kind === 'cardio')) {
      if (!exercises.some((x) => x.id === e.id) && !(del.exercises || {})[e.id]) exercises.push({ rest: 10, ...e });
    }
  }
  const ids = new Set(exercises.map((e) => e.id));
  const sets = raw.sets
    .filter((s) => s && ids.has(String(s.exId)) && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
    .map((s) => ({
      id: String(s.id || uid()), exId: String(s.exId), date: s.date, ts: num(s.ts, Date.now()),
      weight: Math.max(0, num(s.weight)), reps: Math.max(0, num(s.reps)), u: num(s.u, num(s.ts)),
    }))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  const tomb = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {})
    .map(([k, v]) => [k, num(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const st = raw.settings || {};
  return {
    version: DATA_VERSION, epoch: num(raw.epoch), exercises, sets,
    deleted: { sets: tomb(del.sets), exercises: tomb(del.exercises) },
    settings: {
      restSec: Math.min(600, Math.max(10, num(st.restSec, 90))),
      restAuto: st.restAuto !== false,
      sound: st.sound !== false,
      u: num(st.u),
    },
  };
}

function load() {
  try {
    const s = normalize(JSON.parse(localStorage.getItem(STORE_KEY)));
    if (s) return s;
  } catch (_) { /* 壊れていたら初期状態から */ }
  return defaultState();
}

let state = load();
function save(fromSync) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (_) { toast('保存に失敗しました（端末の空き容量を確認してください）'); }
  if (!fromSync) scheduleSync(); // 変更があったら少し待ってから他の端末へ送る
}

// 削除は「消した」という印（deleted）を残す。そうしないと同期で他の端末から復活してしまう
function removeSet(id) {
  state.sets = state.sets.filter((x) => x.id !== id);
  state.deleted.sets[id] = Date.now();
}
function removeExercise(id) {
  for (const s of state.sets) if (s.exId === id) state.deleted.sets[s.id] = Date.now();
  state.sets = state.sets.filter((s) => s.exId !== id);
  state.exercises = state.exercises.filter((e) => e.id !== id);
  state.deleted.exercises[id] = Date.now();
}

/* ───────────── 2. 計算 ───────────── */

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const md = (s) => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const mdw = (s) => { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; };
// その日を含む週の月曜日
const weekStart = (s) => { const d = parseYmd(s); return addDays(s, -((d.getDay() + 6) % 7)); };

const fmtNum = (n) => (Math.round(n * 10) / 10).toLocaleString('ja-JP');
const exById = (id) => state.exercises.find((e) => e.id === id);
const setsOf = (exId) => state.sets.filter((s) => s.exId === exId).sort((a, b) => a.ts - b.ts);
const setsOn = (date) => state.sets.filter((s) => s.date === date).sort((a, b) => a.ts - b.ts);

// 推定1RM（Epley式）: 1回だけ挙げられる重さの目安
const est1RM = (w, r) => (r <= 1 ? w : w * (1 + r / 30));
// その種目での「強さ」の指標（グラフや自己ベスト判定に使う）
// 距離を使わない有酸素メニュー（最初の距離が 0）は、時間で比べる
const timeOnly = (ex) => ex.kind === 'cardio' && !(ex.defWeight > 0);
// その種目での「強さ」の指標（グラフや自己ベスト判定に使う）
function score(ex, s) {
  if (ex.kind === 'weight') return est1RM(s.weight, s.reps);
  if (ex.kind === 'hiit') return s.reps * s.weight;            // 高強度の合計秒数
  if (ex.kind === 'cardio') return timeOnly(ex) ? s.reps / 60 : s.weight; // 分 または km
  return s.reps;
}
const scoreLabel = (ex) => ({ weight: '推定1RM', time: '最長時間', hiit: '高強度の合計', cardio: timeOnly(ex) ? '最長時間' : '最長距離' }[ex.kind] || '最高回数');
const scoreUnit = (ex) => ({ weight: 'kg', time: '秒', hiit: '秒', cardio: timeOnly(ex) ? '分' : 'km' }[ex.kind] || '回');
const volume = (ex, s) => (ex && ex.kind === 'weight' ? s.weight * s.reps : 0);
const fmtMin = (sec) => `${fmtNum(sec / 60)}分`;
// 1km あたりのペース（例: 5'36"/km）
function pace(km, sec) {
  if (!(km > 0) || !(sec > 0)) return '';
  const p = Math.round(sec / km);
  return `${Math.floor(p / 60)}'${pad2(p % 60)}"/km`;
}

function fmtSet(ex, s) {
  if (ex.kind === 'weight') return `${fmtNum(s.weight)}kg × ${s.reps}`;
  if (ex.kind === 'time') return `${s.reps}秒`;
  if (ex.kind === 'hiit') return `${s.reps}本 × ${fmtNum(s.weight)}秒`;
  if (ex.kind === 'cardio') return s.weight > 0 ? `${fmtNum(s.weight)}km・${fmtMin(s.reps)}` : fmtMin(s.reps);
  return `${s.reps}回`;
}

// 指定日より前で、いちばん最近その種目をやった日のセット一覧
function lastSession(exId, beforeDate) {
  const prev = setsOf(exId).filter((s) => s.date < beforeDate);
  if (!prev.length) return null;
  const date = prev[prev.length - 1].date;
  return { date, sets: prev.filter((s) => s.date === date) };
}

function workoutDates() { return [...new Set(state.sets.map((s) => s.date))].sort(); }

// 「週に1回以上トレーニングした週」が何週続いているか
function weekStreak() {
  const weeks = new Set(state.sets.map((s) => weekStart(s.date)));
  let w = weekStart(today());
  if (!weeks.has(w)) w = addDays(w, -7); // 今週まだでも、先週までの継続は途切れていない扱い
  let n = 0;
  while (weeks.has(w)) { n++; w = addDays(w, -7); }
  return n;
}

/* ───────────── 3. 画面部品 ───────────── */

// DOM 要素を作る小道具。h('div', {class:'x', onclick:fn}, 子要素...)
// 文字列は必ずテキストとして入るので、メニュー名に記号が入っても安全。
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v; // アプリ内に書いた固定のアイコン用。ユーザー入力には使わない
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICON = {
  log: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5v11M17.5 6.5v11M3 9.5v5M21 9.5v5M6.5 12h11"/></svg>',
  history: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  stats: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chevL: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  chevR: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  trophy: '<svg viewBox="0 0 24 24"><path d="M8 4h8v5a4 4 0 01-8 0V4zM8 6H4.5a3.5 3.5 0 003.7 3.5M16 6h3.5a3.5 3.5 0 01-3.7 3.5M12 13v4M8.5 20h7M10 17h4"/></svg>',
};
// 配列や false を含んでいてもそのまま中身を差し替えられるようにする
const setKids = (el, ...kids) => el.replaceChildren(...h('div', {}, ...kids).childNodes);
const icon = (name) => h('span', { class: 'ic', html: ICON[name], 'aria-hidden': 'true' });
const partDot = (part) => h('i', { class: 'dot', style: `background:var(--p-${part})` });

let toastTimer;
function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.replaceChildren(kind === 'pr' ? icon('trophy') : '', msg);
  el.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, kind === 'pr' ? 3600 : 2200);
}

// ダイアログ。actions: [{label, kind:'primary'|'danger'|'', run:()=>false で閉じない}]
function openDialog(title, body, actions) {
  const dlg = document.getElementById('dlg');
  const close = () => dlg.close();
  dlg.replaceChildren(
    h('form', { method: 'dialog', class: 'dlg', onsubmit: (e) => e.preventDefault() },
      h('h2', {}, title),
      h('div', { class: 'dlg-body' }, body),
      h('div', { class: 'dlg-actions' },
        actions.map((a) => h('button', {
          type: 'button', class: 'btn ' + (a.kind || ''),
          onclick: () => { if (a.run && a.run() === false) return; close(); },
        }, a.label)))));
  dlg.onclick = (e) => { if (e.target === dlg) close(); }; // 外側タップで閉じる
  if (!dlg.open) dlg.showModal();
}
const confirmDialog = (title, text, okLabel, run) => openDialog(title, h('p', {}, text), [
  { label: 'キャンセル' }, { label: okLabel, kind: 'danger', run },
]);

/* 休憩タイマー（セット間インターバル）。終了時刻を持つので、画面を離れて戻ってもずれない */
const rest = { end: 0, total: 0, tick: null };
let audioCtx = null;

function unlockAudio() { // iOS は「タップ中」に一度音の準備をしないと鳴らせない
  if (!state.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) { audioCtx = null; }
}
// 音を鳴らす。notes = [[開始(秒後), 高さ(Hz), 長さ(秒)], ...]
function tones(notes) {
  if (!state.settings.sound || !audioCtx) return;
  for (const [t, freq, dur = 0.18] of notes) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
    g.gain.exponentialRampToValueAtTime(0.3, audioCtx.currentTime + t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + dur + 0.02);
  }
}
const beep = () => tones([[0, 880], [0.22, 880], [0.44, 1320]]);
function startRest(sec) {
  rest.total = sec; rest.end = Date.now() + sec * 1000;
  clearInterval(rest.tick);
  rest.tick = setInterval(drawRest, 250);
  drawRest();
}
function stopRest() { clearInterval(rest.tick); rest.end = 0; document.getElementById('rest').hidden = true; }
function drawRest() {
  const el = document.getElementById('rest');
  const left = Math.ceil((rest.end - Date.now()) / 1000);
  if (left <= 0) {
    if (rest.end && Date.now() - rest.end < 3000) { beep(); toast('休憩おわり。次のセットへ！'); }
    return stopRest();
  }
  el.hidden = false;
  el.style.setProperty('--pct', `${Math.max(0, Math.min(100, (left / rest.total) * 100))}%`);
  const time = `${Math.floor(left / 60)}:${pad2(left % 60)}`;
  if (!el.firstChild) {
    el.append(
      h('span', { class: 'rest-label' }, '休憩'),
      h('strong', { class: 'rest-time' }, time),
      h('button', { class: 'chip', type: 'button', onclick: () => { rest.end += 30000; rest.total += 30; drawRest(); } }, '+30秒'),
      h('button', { class: 'chip', type: 'button', onclick: stopRest }, 'スキップ'));
  } else el.querySelector('.rest-time').textContent = time;
}

/* ───────────── HIIT タイマー ─────────────
 * 準備(5秒) →［高強度 → インターバル］× 本数 → 完了。
 * 「この時刻に終わる」という終了時刻で管理するので、画面を離れて戻ってもずれない。
 */
const hiit = { on: false };
let wakeLock = null;
const fmtDur = (sec) => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`; };
const hiitTotal = (rounds, work, restSec) => rounds * work + Math.max(0, rounds - 1) * restSec;

async function keepAwake() { // タイマー中は画面が消えないようにする（対応端末のみ）
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { /* 非対応なら何もしない */ }
}

function startHiit() {
  const ex = exById(ui.exId);
  if (!ex) return;
  const rounds = Math.round(ui.reps), work = Math.round(ui.weight), restSec = Math.round(ui.interval || 0), prep = Math.max(0, Math.round(ui.prep || 0));
  if (!(rounds > 0 && work > 0)) return toast('本数と高強度の秒数を入力してください');
  unlockAudio(); stopRest();
  Object.assign(hiit, {
    on: true, exId: ex.id, name: ex.name, date: ui.date, rounds, work, rest: restSec,
    phase: 'ready', dur: prep, end: Date.now() + prep * 1000, done: 0, paused: false, left: 0, lastSec: -1, startedAt: Date.now(),
  });
  keepAwake();
  buildHiit();
  clearInterval(hiit.tick);
  hiit.tick = setInterval(tickHiit, 100);
  tickHiit(); // 準備 0 秒ならすぐ 1 本目に入る
}

function setPhase(phase, dur, from) { hiit.phase = phase; hiit.dur = dur; hiit.end = from + dur * 1000; hiit.lastSec = -1; }
// 次の段階へ。from は「前の段階が終わった時刻」
function advanceHiit(from) {
  if (hiit.phase === 'ready' || hiit.phase === 'rest') return setPhase('work', hiit.work, from);
  hiit.done++; // 高強度を1本やり終えた
  if (hiit.done >= hiit.rounds) return finishHiit();
  if (hiit.rest > 0) return setPhase('rest', hiit.rest, from);
  return setPhase('work', hiit.work, from);
}
function cueHiit() {
  if (hiit.phase === 'work') tones([[0, 1320, 0.4]]);
  else if (hiit.phase === 'rest') tones([[0, 520, 0.4]]);
  else if (hiit.phase === 'done') tones([[0, 880], [0.2, 1100], [0.4, 1320, 0.5]]);
}
function finishHiit() {
  hiit.phase = 'done'; hiit.elapsed = Math.round((Date.now() - hiit.startedAt) / 1000);
  clearInterval(hiit.tick);
}
// いまの段階のあとに残っている時間（秒）
function hiitRemaining(leftSec) {
  const toGo = hiit.rounds - hiit.done; // まだ終わっていない高強度の本数（実行中を含む）
  if (hiit.phase === 'ready') return leftSec + hiitTotal(hiit.rounds, hiit.work, hiit.rest);
  if (hiit.phase === 'work') return leftSec + (toGo - 1) * (hiit.work + hiit.rest);
  return leftSec + toGo * hiit.work + (toGo - 1) * hiit.rest;
}

function tickHiit() {
  if (!hiit.on || hiit.paused || hiit.phase === 'done') return;
  const before = hiit.phase + hiit.done;
  let guard = 0;
  while (hiit.phase !== 'done' && Date.now() >= hiit.end && guard++ < 1000) advanceHiit(hiit.end);
  if (hiit.phase + hiit.done !== before) { cueHiit(); buildHiit(); }
  if (hiit.phase === 'done') return;
  const leftMs = hiit.end - Date.now(), sec = Math.ceil(leftMs / 1000);
  if (sec !== hiit.lastSec) {
    hiit.lastSec = sec;
    if (sec <= 3 && sec >= 1) tones([[0, 700, 0.1]]); // 3・2・1 のカウント
    document.getElementById('hiit-num').textContent = sec >= 60 ? fmtDur(sec) : sec;
    document.getElementById('hiit-left').textContent = `残り ${fmtDur(hiitRemaining(sec))}`;
  }
  document.getElementById('hiit-bar').style.width = `${Math.min(100, (1 - leftMs / (hiit.dur * 1000)) * 100)}%`;
}

function buildHiit() {
  const el = document.getElementById('hiit');
  el.hidden = false;
  el.className = `ph-${hiit.phase}` + (hiit.paused ? ' paused' : '');
  if (hiit.phase === 'done') {
    const full = hiit.done >= hiit.rounds;
    return setKids(el,
      h('div', { class: 'hiit-main' },
        h('div', { class: 'hiit-trophy' }, icon('trophy')),
        h('div', { class: 'hiit-title' }, full ? 'おつかれさま！' : '途中で終了'),
        h('div', { class: 'hiit-sum' }, `${hiit.done}本 × ${hiit.work}秒`),
        h('div', { class: 'hiit-sub' }, `高強度 合計 ${fmtDur(hiit.done * hiit.work)}・所要 ${fmtDur(hiit.elapsed)}`)),
      h('div', { class: 'hiit-ctrl col' },
        h('button', { type: 'button', class: 'btn primary big', onclick: () => closeHiit(true) }, '記録して閉じる'),
        h('button', { type: 'button', class: 'btn ghost wide', onclick: () => closeHiit(false) }, '記録しない')));
  }
  const label = { ready: ['READY', '準備'], work: ['HIGH', '全力！'], rest: ['REST', '休憩'] }[hiit.phase];
  const round = Math.min(hiit.rounds, hiit.done + 1);
  const next = hiit.phase === 'work'
    ? (hiit.done + 1 >= hiit.rounds ? '次: 完了' : hiit.rest > 0 ? `次: 休憩 ${hiit.rest}秒` : `次: 高強度 ${hiit.work}秒`)
    : `次: 高強度 ${hiit.work}秒`;
  setKids(el,
    h('div', { class: 'hiit-top' },
      h('span', { class: 'hiit-name' }, hiit.name),
      h('button', { type: 'button', class: 'btn ghost', onclick: stopHiit }, '終了')),
    h('div', { class: 'hiit-main' },
      h('div', { class: 'hiit-label' }, label[0], h('small', {}, label[1])),
      h('div', { id: 'hiit-num', class: 'hiit-num' }, ''),
      h('div', { class: 'hiit-round' }, hiit.phase === 'ready' ? `全 ${hiit.rounds} 本` : `${round} / ${hiit.rounds} 本目`),
      h('div', { class: 'hiit-track' }, h('i', { id: 'hiit-bar' })),
      h('div', { class: 'hiit-next' }, h('span', {}, next), h('span', { id: 'hiit-left' }, ''))),
    h('div', { class: 'hiit-ctrl' },
      h('button', { type: 'button', class: 'btn', onclick: pauseHiit }, hiit.paused ? '再開' : '一時停止'),
      h('button', { type: 'button', class: 'btn', onclick: () => { if (hiit.paused) pauseHiit(); hiit.end = Date.now(); tickHiit(); } }, 'スキップ')));
  hiit.lastSec = -1;
  if (hiit.paused) { // 止めている間も数字を出しておく
    const sec = Math.ceil(hiit.left / 1000);
    document.getElementById('hiit-num').textContent = sec >= 60 ? fmtDur(sec) : sec;
    document.getElementById('hiit-left').textContent = `残り ${fmtDur(hiitRemaining(sec))}`;
    document.getElementById('hiit-bar').style.width = `${(1 - hiit.left / (hiit.dur * 1000)) * 100}%`;
  }
}

function pauseHiit() {
  if (hiit.paused) { hiit.paused = false; hiit.end = Date.now() + hiit.left; } else { hiit.paused = true; hiit.left = Math.max(0, hiit.end - Date.now()); }
  buildHiit();
}
function stopHiit() {
  if (hiit.done > 0) { finishHiit(); buildHiit(); } else closeHiit(false); // 1本もやっていなければそのまま閉じる
}
function closeHiit(record) {
  clearInterval(hiit.tick);
  hiit.on = false;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  document.getElementById('hiit').hidden = true;
  if (record && hiit.done > 0 && exById(hiit.exId)) {
    const now = Date.now();
    state.sets.push({ id: uid(), exId: hiit.exId, date: hiit.date, ts: now, weight: hiit.work, reps: hiit.done, u: now });
    save();
    toast(`${hiit.done}本 × ${hiit.work}秒 を記録しました`);
  }
  render();
}

/* ───────────── 端末間の同期（GitHub Gist） ─────────────
 * しくみ
 *   ・自分の GitHub アカウントの「非公開 Gist」（小さなファイル置き場）に、記録データを1ファイルで置く
 *   ・各端末は「Gist を読む → 手元のデータと混ぜる（マージ）→ 違いがあれば書き戻す」を行う
 *   ・混ぜ方は記録1件ごと。両方の端末で別々に記録しても、どちらも残る
 * トークン（合言葉）はこの端末の中にだけ保存し、バックアップや Gist には含めない。
 */
const SYNC_KEY = 'kintore-log.sync';
const SYNC_FILE = 'kintore-log.json';
const GH_API = 'https://api.github.com';

function loadSyncCfg() {
  try { const c = JSON.parse(localStorage.getItem(SYNC_KEY)); if (c && c.token) return c; } catch (_) { /* 未設定 */ }
  return null;
}
let syncCfg = loadSyncCfg(); // { token, gistId, last }
function saveSyncCfg() {
  if (syncCfg) localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));
  else localStorage.removeItem(SYNC_KEY);
}
const sync = { busy: false, again: false, timer: null, error: '', status: 0 };

// 2つのデータを混ぜる。a=この端末、b=保管場所。どちらの端末で実行しても同じ結果になるように作る
function mergeData(a, b) {
  // 「全削除」や「復元」をした側（epoch が新しい側）は、混ぜずに丸ごと優先
  if (a.epoch !== b.epoch) return normalize(a.epoch > b.epoch ? a : b);
  const newer = (m1, m2) => {
    const out = { ...m1 };
    for (const [k, v] of Object.entries(m2)) out[k] = Math.max(out[k] || 0, v);
    return out;
  };
  const deleted = { sets: newer(a.deleted.sets, b.deleted.sets), exercises: newer(a.deleted.exercises, b.deleted.exercises) };
  // id ごとに、更新時刻（u）が新しいほうを採用。並び順は保管場所の順を先に
  const pick = (listB, listA, tomb) => {
    const map = new Map();
    for (const item of [...listB, ...listA]) {
      const cur = map.get(item.id);
      if (!cur || item.u > cur.u) map.set(item.id, item);
    }
    for (const id of Object.keys(tomb)) map.delete(id);
    return map;
  };
  const exMap = pick(b.exercises, a.exercises, deleted.exercises);
  // 別々の端末で同じ名前のメニューを作っていたら、1つにまとめる
  const remap = {}, byName = new Map();
  for (const e of [...exMap.values()]) {
    const key = `${e.name}|${e.part}|${e.kind}`;
    if (byName.has(key)) { remap[e.id] = byName.get(key); exMap.delete(e.id); } else byName.set(key, e.id);
  }
  const sets = [...pick(b.sets, a.sets, deleted.sets).values()].map((s) => (remap[s.exId] ? { ...s, exId: remap[s.exId] } : s));
  return normalize({
    version: DATA_VERSION, epoch: a.epoch, exercises: [...exMap.values()], sets, deleted,
    settings: a.settings.u >= b.settings.u ? a.settings : b.settings,
  });
}

async function gh(method, path, body) {
  const res = await fetch(GH_API + path, {
    method, cache: 'no-store',
    headers: {
      Authorization: `Bearer ${syncCfg.token}`, Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// 保管場所のデータを読む。まだ無ければ null
async function readRemote() {
  if (!syncCfg.gistId) {
    const list = await gh('GET', '/gists?per_page=100');
    const hit = list.find((g) => g.files && g.files[SYNC_FILE]);
    if (!hit) return null;
    syncCfg.gistId = hit.id; saveSyncCfg();
  }
  let gist;
  try { gist = await gh('GET', `/gists/${syncCfg.gistId}`); } catch (e) {
    if (e.status !== 404) throw e;
    syncCfg.gistId = null; saveSyncCfg(); // 保管場所が消されていた → 探し直す
    return readRemote();
  }
  const f = gist.files[SYNC_FILE];
  if (!f) return null;
  const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  let raw;
  try { raw = JSON.parse(text); } catch (_) { return null; }
  if (raw && raw.version > DATA_VERSION) { // 他の端末のほうがアプリが新しい。古いアプリで上書きして壊さないよう止める
    const e = new Error('app too old'); e.old = true; throw e;
  }
  return normalize(raw);
}

async function writeRemote(content) {
  const files = { [SYNC_FILE]: { content } };
  if (syncCfg.gistId) return gh('PATCH', `/gists/${syncCfg.gistId}`, { files });
  const gist = await gh('POST', '/gists', { description: '筋トレログ 同期データ（アプリが自動で更新します）', public: false, files });
  syncCfg.gistId = gist.id; saveSyncCfg();
  return gist;
}

function syncStatusText() {
  if (sync.busy) return '同期中…';
  if (sync.error) return sync.error;
  if (!syncCfg.last) return 'まだ同期していません';
  const d = new Date(syncCfg.last);
  const day = ymd(d) === today() ? '今日' : `${d.getMonth() + 1}/${d.getDate()}`;
  return `最終同期: ${day} ${d.getHours()}:${pad2(d.getMinutes())}`;
}
function drawSyncStatus() {
  const el = document.getElementById('sync-status');
  if (el && syncCfg) { el.textContent = syncStatusText(); el.classList.toggle('err', !!sync.error && !sync.busy); }
}

async function syncNow(manual) {
  if (!syncCfg) return;
  if (sync.busy) { sync.again = true; return; }
  clearTimeout(sync.timer);
  sync.busy = true; drawSyncStatus();
  try {
    const before = JSON.stringify(state);
    const remote = await readRemote();
    const merged = remote ? mergeData(normalize(state), remote) : normalize(state);
    const text = JSON.stringify(merged);
    if (!remote || text !== JSON.stringify(remote)) await writeRemote(text);
    if (JSON.stringify(state) !== before || document.getElementById('dlg').open) {
      sync.again = true; // 通信中に記録された／編集画面が開いている → 画面は触らず、あとでもう一度
    } else if (text !== JSON.stringify(normalize(state))) {
      state = merged; save(true); render(); // 他の端末の変更を取り込む
    }
    syncCfg.last = Date.now(); saveSyncCfg();
    sync.error = ''; sync.status = 200;
    if (manual) toast('同期しました');
  } catch (e) {
    sync.status = e.status || 0;
    sync.error = e.old ? 'アプリが古いため同期を止めています。アプリを閉じて開き直してください'
      : e.status === 401 ? 'トークンが無効です。作り直して設定し直してください'
      : e.status === 403 || e.status === 404 ? 'トークンに Gist の権限がありません'
        : e.status ? `同期に失敗しました（${e.status}）` : 'オフライン（つながったら自動で同期します）';
    if (manual) toast(sync.error);
  } finally {
    sync.busy = false; drawSyncStatus();
    if (sync.again) { sync.again = false; sync.timer = setTimeout(() => syncNow(), 4000); }
  }
}
function scheduleSync() {
  if (!syncCfg) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow(), 2500);
}

async function connectSync(token) {
  token = token.trim();
  if (!token) return toast('トークンを貼り付けてください');
  syncCfg = { token, gistId: null, last: 0 };
  render();
  await syncNow(true);
  if (sync.error && sync.status) { syncCfg = null; sync.error = ''; } // 認証エラーなら設定を取り消す（オフラインなら残す）
  saveSyncCfg(); render();
}

/* ───────────── 4. 画面 ───────────── */

const ui = {
  tab: 'log',
  date: today(),      // 記録対象の日（通常は今日）
  interval: 10,       // HIIT のインターバル秒数（入力中）
  prep: 10,           // HIIT の開始前の準備秒数（入力中）
  part: 'all',        // 記録タブの部位フィルタ
  exId: null,         // 入力中の種目
  weight: 0, reps: 0, // 入力中の値
  month: today().slice(0, 7), day: today(), // 履歴タブ
  statMode: 'volume', statEx: null, pick: null, // 分析タブ
};

const TABS = [['log', '記録'], ['history', '履歴'], ['stats', '分析'], ['menu', 'メニュー']];

function render() {
  const y = window.scrollY;
  if (ui.exId && !exById(ui.exId)) ui.exId = null; // 同期で消えたメニューを開いたままにしない
  setKids(document.getElementById('nav'),
    h('div', { class: 'brand' }, h('img', { src: 'icons/icon-192.png', alt: '' })),
    TABS.map(([id, label]) => h('button', {
      type: 'button', class: 'tab' + (ui.tab === id ? ' on' : ''),
      'aria-current': ui.tab === id ? 'page' : null,
      onclick: () => { ui.tab = id; ui.exId = null; ui.pick = null; render(); window.scrollTo(0, 0); },
    }, icon(id), h('span', {}, label))));
  const view = { log: viewLog, history: viewHistory, stats: viewStats, menu: viewMenu }[ui.tab]();
  document.getElementById('view').replaceChildren(view);
  document.body.classList.toggle('sheet-open', ui.tab === 'log' && !!ui.exId);
  window.scrollTo(0, y);
}

/* ── 記録タブ ── */

function selectExercise(ex) {
  ui.exId = ex.id;
  const todays = setsOf(ex.id).filter((s) => s.date === ui.date);
  const last = lastSession(ex.id, ui.date);
  // 初期値: 今日すでにやっていれば直前のセット、なければ前回の1セット目、それもなければメニューの既定値
  const base = todays[todays.length - 1] || (last && last.sets[0]);
  ui.weight = base ? base.weight : ex.defWeight;
  ui.reps = base ? base.reps : ex.defReps;
  if (ex.kind === 'hiit') { // HIIT は毎回メニューで決めた内容から始める
    ui.weight = ex.defWeight; ui.reps = ex.defReps; ui.interval = ex.rest; ui.prep = ex.prep;
  }
}

function recordSet() {
  const ex = exById(ui.exId);
  if (!ex) return;
  unlockAudio();
  const reps = Math.round(ui.reps), weight = ['weight', 'hiit', 'cardio'].includes(ex.kind) ? ui.weight : 0;
  if (!(reps > 0)) return toast({ time: '秒数', cardio: '時間', hiit: '本数' }[ex.kind] ? `${{ time: '秒数', cardio: '時間', hiit: '本数' }[ex.kind]}を入力してください` : '回数を入力してください');
  if (ex.kind === 'hiit' && !(weight > 0)) return toast('高強度の秒数を入力してください');
  const now = Date.now();
  const s = { id: uid(), exId: ex.id, date: ui.date, ts: now, weight, reps, u: now };
  const prior = setsOf(ex.id);
  const best = prior.length ? Math.max(...prior.map((p) => score(ex, p))) : null;
  state.sets.push(s);
  save();
  if (best != null && score(ex, s) > best + 1e-9) {
    toast(`自己ベスト更新！ ${scoreLabel(ex)} ${fmtNum(score(ex, s))}${scoreUnit(ex)}`, 'pr');
  } else toast(`${fmtSet(ex, s)} を記録しました`);
  // セット間の休憩タイマーは筋トレ系だけ（HIIT・有酸素では出さない）
  if (state.settings.restAuto && ui.date === today() && !['hiit', 'cardio'].includes(ex.kind)) startRest(state.settings.restSec);
  render();
}

function stepper(label, unit, get, step, min, set, quick) {
  const clamp = (v) => Math.max(min, Math.round(v * 100) / 100);
  const input = h('input', {
    type: 'number', inputMode: step % 1 ? 'decimal' : 'numeric', value: String(get()), min: String(min),
    step: 'any', 'aria-label': label,
    onfocus: (e) => e.target.select(),
    // 入力中は画面を作り直さない（直後の「記録」ボタンのタップを取りこぼさないため）
    oninput: (e) => set(clamp(parseFloat(e.target.value) || 0)),
  });
  const bump = (d) => () => { set(clamp(get() + d)); render(); };
  return h('div', { class: 'stepper' },
    h('div', { class: 'stepper-label' }, label),
    h('div', { class: 'stepper-row' },
      h('button', { type: 'button', class: 'round', onclick: bump(-step), 'aria-label': `${label}を減らす` }, '−'),
      h('label', { class: 'stepper-value' }, input, h('span', {}, unit)),
      h('button', { type: 'button', class: 'round', onclick: bump(step), 'aria-label': `${label}を増やす` }, '+')),
    quick && h('div', { class: 'chips center' }, quick.map((q) => h('button', {
      type: 'button', class: 'chip' + (q === get() ? ' on' : ''), onclick: () => { set(q); render(); },
    }, q))));
}

function inputPanel() {
  const ex = exById(ui.exId);
  if (!ex) {
    return h('section', { class: 'panel empty' },
      h('div', { class: 'empty-art' }, icon('log')),
      h('p', {}, '左のメニューから種目を選ぶと、', h('br'), 'ここで回数を記録できます'));
  }
  const todays = setsOf(ex.id).filter((s) => s.date === ui.date);
  const last = lastSession(ex.id, ui.date);
  const all = setsOf(ex.id);
  const best = all.length ? Math.max(...all.map((s) => score(ex, s))) : null;

  return h('section', { class: `panel k-${ex.kind}` },
    h('header', { class: 'panel-head' },
      h('div', {},
        h('div', { class: 'eyebrow' }, partDot(ex.part), partName(ex.part)),
        h('h2', {}, ex.name)),
      h('button', { type: 'button', class: 'icon-btn sheet-close', 'aria-label': '閉じる', onclick: () => { ui.exId = null; render(); } }, icon('close'))),

    h('div', { class: 'refs' },
      h('div', { class: 'ref' },
        h('span', { class: 'ref-k' }, last ? `前回 ${md(last.date)}` : '前回'),
        h('span', { class: 'ref-v' }, last ? last.sets.map((s) => fmtSet(ex, s)).join(' / ') : 'はじめての記録です')),
      best != null && h('div', { class: 'ref' },
        h('span', { class: 'ref-k' }, '自己ベスト'),
        h('span', { class: 'ref-v' }, `${scoreLabel(ex)} ${fmtNum(best)}${scoreUnit(ex)}`))),

    ex.kind === 'weight' && stepper('重量', 'kg', () => ui.weight, ex.step, 0, (v) => { ui.weight = v; }),
    ex.kind === 'hiit' && [
      stepper('本数（セット数）', '本', () => ui.reps, 1, 1, (v) => { ui.reps = v; }, [6, 8, 10, 12]),
      stepper('高強度', '秒', () => ui.weight, 5, 5, (v) => { ui.weight = v; }, [20, 30, 40, 45, 60]),
      stepper('インターバル（休憩）', '秒', () => ui.interval, 5, 0, (v) => { ui.interval = v; }, [10, 15, 20, 30, 60]),
      stepper('開始前の準備', '秒', () => ui.prep, 5, 0, (v) => { ui.prep = v; }, [0, 5, 10, 15, 30]),
      h('p', { class: 'calc' }, `合計 ${fmtDur(ui.prep + hiitTotal(ui.reps, ui.weight, ui.interval))}（準備 ${ui.prep}秒＋高強度 ${fmtDur(ui.reps * ui.weight)}＋休憩 ${fmtDur(Math.max(0, ui.reps - 1) * ui.interval)}）`),
    ],
    ex.kind === 'cardio' && [
      stepper('距離', 'km', () => ui.weight, ex.step, 0, (v) => { ui.weight = v; }),
      stepper('時間', '分', () => Math.round(ui.reps / 6) / 10, 1, 0, (v) => { ui.reps = v * 60; }, [15, 20, 30, 45, 60]),
      pace(ui.weight, ui.reps) && h('p', { class: 'calc' }, `ペース ${pace(ui.weight, ui.reps)}`),
    ],
    ex.kind === 'time' && stepper('時間', '秒', () => ui.reps, 5, 0, (v) => { ui.reps = v; }, [30, 45, 60, 90, 120]),
    (ex.kind === 'weight' || ex.kind === 'body') && stepper('回数', '回', () => ui.reps, 1, 0, (v) => { ui.reps = v; }, [5, 8, 10, 12, 15, 20]),

    ex.kind === 'hiit'
      ? [h('button', { type: 'button', class: 'btn primary big', onclick: startHiit }, 'タイマーをスタート'),
        h('button', { type: 'button', class: 'btn ghost wide', onclick: recordSet }, 'タイマーを使わずに記録だけする')]
      : h('button', { type: 'button', class: 'btn primary big', onclick: recordSet },
        ex.kind === 'cardio' ? '記録する' : `${todays.length + 1}セット目を記録`),

    todays.length > 0 && h('div', { class: 'today-sets' },
      h('div', { class: 'eyebrow' }, ui.date === today() ? '今日の記録' : `${md(ui.date)} の記録`),
      h('ol', { class: 'setlist' }, todays.map((s, i) => h('li', {},
        h('span', { class: 'set-no' }, i + 1),
        h('span', { class: 'set-v' }, fmtSet(ex, s)),
        h('button', {
          type: 'button', class: 'icon-btn small', 'aria-label': `${i + 1}件目を削除`,
          onclick: () => { removeSet(s.id); save(); toast('削除しました'); render(); },
        }, icon('close')))))));
}

function viewLog() {
  const isToday = ui.date === today();
  const daySets = setsOn(ui.date);
  const dayVol = daySets.reduce((a, s) => a + volume(exById(s.exId), s), 0);
  const active = state.exercises.filter((e) => !e.archived);
  const usedParts = PARTS.filter((p) => active.some((e) => e.part === p.id));
  const list = active.filter((e) => ui.part === 'all' || e.part === ui.part);

  const dateInput = h('input', {
    type: 'date', class: 'date-input', value: ui.date, max: today(), 'aria-label': '記録する日',
    onchange: (e) => { if (e.target.value) { ui.date = e.target.value; ui.exId = null; render(); } },
  });

  return h('div', { class: 'log-layout' },
    h('div', { class: 'col-main' },
      h('header', { class: 'page-head' },
        h('div', {},
          h('div', { class: 'eyebrow' }, isToday ? 'TODAY' : '過去の日付に記録中'),
          h('h1', {}, mdw(ui.date))),
        h('label', { class: 'btn ghost date-btn' }, isToday ? '日付を変更' : '変更', dateInput),
        !isToday && h('button', { type: 'button', class: 'btn ghost', onclick: () => { ui.date = today(); ui.exId = null; render(); } }, '今日に戻る')),

      h('div', { class: 'tiles three' },
        tile('種目', new Set(daySets.map((s) => s.exId)).size, ''),
        tile('セット', daySets.length, ''),
        tile('ボリューム', fmtNum(dayVol), 'kg')),

      h('div', { class: 'chips scroll', role: 'tablist', 'aria-label': '部位で絞り込み' },
        [{ id: 'all', name: 'すべて' }, ...usedParts].map((p) => h('button', {
          type: 'button', class: 'chip' + (ui.part === p.id ? ' on' : ''),
          onclick: () => { ui.part = p.id; render(); },
        }, p.id !== 'all' && partDot(p.id), p.name))),

      list.length === 0
        ? h('p', { class: 'muted pad' }, 'メニューがありません。「メニュー」タブから追加してください。')
        : h('div', { class: 'ex-grid' }, list.map((ex) => {
          const n = daySets.filter((s) => s.exId === ex.id).length;
          const last = lastSession(ex.id, ui.date);
          return h('button', {
            type: 'button', class: 'ex-card' + (ui.exId === ex.id ? ' on' : '') + (n ? ' done' : ''),
            onclick: () => { selectExercise(ex); render(); },
          },
            h('span', { class: 'eyebrow' }, partDot(ex.part), partName(ex.part)),
            h('span', { class: 'ex-name' }, ex.name),
            h('span', { class: 'ex-sub' }, last ? `前回 ${md(last.date)}・${fmtSet(ex, last.sets[0])}` : '記録なし'),
            n > 0 && h('span', { class: 'badge' }, `${n}セット`));
        }))),

    h('div', { class: 'sheet', onclick: (e) => { if (e.target === e.currentTarget) { ui.exId = null; render(); } } },
      inputPanel()));
}

function tile(label, value, unit, sub) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-k' }, label),
    h('div', { class: 'tile-v' }, value, unit && h('small', {}, unit)),
    sub && h('div', { class: 'tile-sub' }, sub));
}

/* ── 履歴タブ ── */

function editSetDialog(ex, s) {
  let w = s.weight, r = s.reps;
  const field = (label, val, set, dec) => h('label', { class: 'field' }, h('span', {}, label),
    h('input', { type: 'number', inputMode: dec ? 'decimal' : 'numeric', step: 'any', min: '0', value: String(val), oninput: (e) => set(parseFloat(e.target.value) || 0) }));
  const fields = {
    weight: [field('重量 (kg)', w, (v) => { w = v; }, true), field('回数', r, (v) => { r = v; })],
    hiit: [field('本数', r, (v) => { r = v; }), field('高強度 (秒)', w, (v) => { w = v; })],
    cardio: [field('距離 (km)', w, (v) => { w = v; }, true), field('時間 (分)', Math.round(r / 6) / 10, (v) => { r = v * 60; }, true)],
    time: [field('時間 (秒)', r, (v) => { r = v; })],
    body: [field('回数', r, (v) => { r = v; })],
  };
  openDialog(`${ex.name} を編集`, fields[ex.kind],
    [{ label: '削除', kind: 'danger', run: () => { removeSet(s.id); save(); render(); } },
      { label: 'キャンセル' },
      { label: '保存', kind: 'primary', run: () => {
        if (!(r > 0)) { toast('1以上の数を入力してください'); return false; }
        s.weight = Math.max(0, w); s.reps = Math.round(r); s.u = Date.now(); save(); render();
      } }]);
}

function dayDetail(date) {
  const sets = setsOn(date);
  const groups = [];
  for (const s of sets) {
    let g = groups.find((x) => x.ex.id === s.exId);
    if (!g) { const ex = exById(s.exId); if (!ex) continue; groups.push(g = { ex, sets: [] }); }
    g.sets.push(s);
  }
  const vol = sets.reduce((a, s) => a + volume(exById(s.exId), s), 0);
  return h('section', { class: 'card' },
    h('header', { class: 'card-head' },
      h('div', {}, h('h2', {}, mdw(date)),
        h('div', { class: 'muted' }, sets.length ? `${groups.length}種目・${sets.length}セット・${fmtNum(vol)}kg` : '記録はありません')),
      date <= today() && h('button', { type: 'button', class: 'btn ghost', onclick: () => { ui.tab = 'log'; ui.date = date; ui.exId = null; render(); } }, icon('plus'), '追加')),
    groups.map((g) => h('div', { class: 'day-ex' },
      h('div', { class: 'day-ex-name' }, partDot(g.ex.part), g.ex.name),
      h('div', { class: 'chips' }, g.sets.map((s) => h('button', {
        type: 'button', class: 'chip set', onclick: () => editSetDialog(g.ex, s),
      }, fmtSet(g.ex, s)))))),
    sets.length > 0 && h('p', { class: 'hint' }, 'セットをタップすると修正・削除できます'));
}

function viewHistory() {
  const [y, m] = ui.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const counts = {};
  for (const s of state.sets) if (s.date.startsWith(ui.month)) counts[s.date] = (counts[s.date] || 0) + 1;
  const max = Math.max(1, ...Object.values(counts));
  const shift = (n) => () => { const d = new Date(y, m - 1 + n, 1); ui.month = ymd(d).slice(0, 7); render(); };
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(h('span', {}));
  for (let d = 1; d <= days; d++) {
    const date = `${ui.month}-${pad2(d)}`;
    const c = counts[date] || 0;
    const lvl = c ? Math.min(3, Math.ceil((c / max) * 3)) : 0; // セット数の多さを3段階の濃さで
    cells.push(h('button', {
      type: 'button',
      class: `cal-day lv${lvl}` + (date === ui.day ? ' on' : '') + (date === today() ? ' today' : ''),
      'aria-label': `${mdw(date)} ${c}セット`,
      onclick: () => { ui.day = date; render(); },
    }, d));
  }
  const monthDays = Object.keys(counts).length;

  return h('div', { class: 'two-col' },
    h('div', {},
      h('header', { class: 'page-head' }, h('div', {}, h('div', { class: 'eyebrow' }, 'HISTORY'), h('h1', {}, '履歴'))),
      h('section', { class: 'card' },
        h('header', { class: 'card-head' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': '前の月', onclick: shift(-1) }, icon('chevL')),
          h('div', { class: 'cal-title' }, h('h2', {}, `${y}年${m}月`), h('div', { class: 'muted' }, `トレーニング ${monthDays}日`)),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': '次の月', disabled: ui.month >= today().slice(0, 7), onclick: shift(1) }, icon('chevR'))),
        h('div', { class: 'cal' }, WD.map((w) => h('span', { class: 'cal-wd' }, w)), cells))),
    h('div', { class: 'col-side' }, dayDetail(ui.day)));
}

/* ── 分析タブ ── */

// 棒グラフ（1系列）。タップ／ホバーした棒の値を上の読み取り欄に表示する
function columns(data, unit, key) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const sel = ui.pick && ui.pick.key === key ? ui.pick.i : data.length - 1;
  const pick = (i) => () => { if (!(ui.pick && ui.pick.key === key && ui.pick.i === i)) { ui.pick = { key, i }; render(); } };
  return h('div', { class: 'chart' },
    h('div', { class: 'readout' }, h('span', {}, data[sel].tip), h('strong', {}, fmtNum(data[sel].value), h('small', {}, unit))),
    h('div', { class: 'cols' }, data.map((d, i) => h('button', {
      type: 'button', class: 'col' + (i === sel ? ' on' : ''), 'aria-label': `${d.tip} ${fmtNum(d.value)}${unit}`,
      onclick: pick(i), onpointerenter: (e) => { if (e.pointerType === 'mouse') pick(i)(); },
    }, h('i', { style: `height:${d.value ? Math.max(3, (d.value / max) * 100) : 0}%` })))),
    h('div', { class: 'cols-x' }, data.map((d) => h('span', {}, d.label))));
}

// 折れ線グラフ（1系列）。点をタップ／ホバーすると値を表示
function line(points, unit, key) {
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  const padV = (hi - lo) * 0.15; lo = Math.max(0, lo - padV); hi += padV;
  const X = (i) => (points.length === 1 ? 50 : (i / (points.length - 1)) * 100);
  const Y = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
  const sel = ui.pick && ui.pick.key === key ? ui.pick.i : points.length - 1;
  const pick = (i) => () => { if (!(ui.pick && ui.pick.key === key && ui.pick.i === i)) { ui.pick = { key, i }; render(); } };
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(2)},${Y(p.value).toFixed(2)}`).join(' ');
  return h('div', { class: 'chart' },
    h('div', { class: 'readout' }, h('span', {}, points[sel].tip), h('strong', {}, fmtNum(points[sel].value), h('small', {}, unit))),
    h('div', { class: 'line' },
      h('div', { class: 'line-y' }, h('span', {}, fmtNum(hi)), h('span', {}, fmtNum((hi + lo) / 2)), h('span', {}, fmtNum(lo))),
      h('div', { class: 'line-plot' },
        h('div', { html: `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${path}"/></svg>` }),
        points.map((p, i) => h('button', {
          type: 'button', class: 'pt' + (i === sel ? ' on' : ''), style: `left:${X(i)}%;top:${Y(p.value)}%`,
          'aria-label': `${p.tip} ${fmtNum(p.value)}${unit}`,
          onclick: pick(i), onpointerenter: (e) => { if (e.pointerType === 'mouse') pick(i)(); },
        })))),
    h('div', { class: 'line-x' }, h('span', {}, points[0].label), points.length > 1 && h('span', {}, points[points.length - 1].label)));
}

function seg(options, value, onPick) {
  return h('div', { class: 'seg' }, options.map(([id, label]) => h('button', {
    type: 'button', class: id === value ? 'on' : '', onclick: () => { onPick(id); ui.pick = null; render(); },
  }, label)));
}

function viewStats() {
  if (!state.sets.length) {
    return h('div', {},
      h('header', { class: 'page-head' }, h('div', {}, h('div', { class: 'eyebrow' }, 'STATS'), h('h1', {}, '分析'))),
      h('section', { class: 'card empty' }, h('div', { class: 'empty-art' }, icon('stats')),
        h('p', {}, '記録がたまると、ここに成長の推移が表示されます')));
  }
  const t = today(), w0 = weekStart(t);
  const inWeek = (start) => state.sets.filter((s) => s.date >= start && s.date < addDays(start, 7));
  const vol = (sets) => sets.reduce((a, s) => a + volume(exById(s.exId), s), 0);
  const thisW = inWeek(w0), lastW = inWeek(addDays(w0, -7));
  const dv = vol(thisW) - vol(lastW);

  // 直近8週
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const start = addDays(w0, -7 * i), sets = inWeek(start);
    weeks.push({
      label: md(start), tip: `${md(start)}〜${md(addDays(start, 6))}`,
      value: ui.statMode === 'volume' ? vol(sets) : ui.statMode === 'sets' ? sets.length : new Set(sets.map((s) => s.date)).size,
    });
  }
  const modeUnit = { volume: 'kg', sets: 'セット', days: '日' }[ui.statMode];

  // 直近4週の部位バランス（セット数）
  const from = addDays(t, -27);
  const byPart = PARTS.map((p) => ({
    p, n: state.sets.filter((s) => s.date >= from && (exById(s.exId) || {}).part === p.id).length,
  })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const maxPart = Math.max(1, ...byPart.map((x) => x.n));

  // 種目別の推移
  const withData = state.exercises.filter((e) => state.sets.some((s) => s.exId === e.id));
  const ex = withData.find((e) => e.id === ui.statEx) || withData[0];
  const byDay = {};
  for (const s of setsOf(ex.id)) byDay[s.date] = Math.max(byDay[s.date] || 0, score(ex, s));
  const allPts = Object.keys(byDay).sort().map((d) => ({ label: md(d), tip: mdw(d), value: byDay[d] }));
  const pts = allPts.slice(-20);
  const exSets = setsOf(ex.id);

  return h('div', {},
    h('header', { class: 'page-head' }, h('div', {}, h('div', { class: 'eyebrow' }, 'STATS'), h('h1', {}, '分析'))),
    h('div', { class: 'tiles four' },
      tile('今週のトレ日数', new Set(thisW.map((s) => s.date)).size, '日'),
      tile('今週のボリューム', fmtNum(vol(thisW)), 'kg',
        vol(lastW) > 0 ? `先週比 ${dv >= 0 ? '+' : '−'}${fmtNum(Math.abs(dv))}kg` : null),
      tile('継続', weekStreak(), '週連続'),
      tile('累計トレ日数', workoutDates().length, '日')),

    h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('header', { class: 'card-head' }, h('h2', {}, '週ごとの推移'),
          seg([['volume', 'ボリューム'], ['sets', 'セット数'], ['days', '日数']], ui.statMode, (v) => { ui.statMode = v; })),
        columns(weeks, modeUnit, 'weeks'),
        h('p', { class: 'hint' }, '直近8週（月曜はじまり）。ボリューム＝重量×回数の合計')),

      h('section', { class: 'card' },
        h('header', { class: 'card-head' }, h('h2', {}, '部位バランス'), h('span', { class: 'muted' }, '直近4週のセット数')),
        byPart.length === 0 ? h('p', { class: 'muted' }, '直近4週の記録がありません')
          : h('div', { class: 'bars' }, byPart.map((x) => h('div', { class: 'bar-row' },
            h('span', { class: 'bar-k' }, x.p.name),
            h('span', { class: 'bar-track' }, h('i', { style: `width:${(x.n / maxPart) * 100}%;background:var(--p-${x.p.id})` })),
            h('span', { class: 'bar-v' }, x.n)))))),

    h('section', { class: 'card' },
      h('header', { class: 'card-head' }, h('h2', {}, '種目別の伸び'),
        h('select', { class: 'select', 'aria-label': '種目', onchange: (e) => { ui.statEx = e.target.value; ui.pick = null; render(); } },
          withData.map((e) => h('option', { value: e.id, selected: e.id === ex.id }, e.name)))),
      h('div', { class: 'tiles three flat' },
        tile(scoreLabel(ex), fmtNum(Math.max(...exSets.map((s) => score(ex, s)))), scoreUnit(ex)),
        ex.kind === 'weight'
          ? tile('最大重量', fmtNum(Math.max(...exSets.map((s) => s.weight))), 'kg')
          : ex.kind === 'hiit' ? tile('累計本数', fmtNum(exSets.reduce((a, s) => a + s.reps, 0)), '本')
            : ex.kind === 'cardio' && !timeOnly(ex) ? tile('累計距離', fmtNum(exSets.reduce((a, s) => a + s.weight, 0)), 'km')
              : tile('累計', fmtNum(exSets.reduce((a, s) => a + score(ex, s), 0)), scoreUnit(ex)),
        tile('実施日数', allPts.length, '日')),
      line(pts, scoreUnit(ex), 'ex:' + ex.id),
      h('p', { class: 'hint' }, `各日のベスト（${scoreLabel(ex)}）の推移。` +
        (ex.kind === 'weight' ? '推定1RM＝重量×(1＋回数÷30)。' : '') + (allPts.length > 20 ? '直近20回分を表示。' : ''))));
}

/* ── メニュータブ（メニュー管理＋設定） ── */

function exerciseDialog(ex) {
  const isNew = !ex;
  const d = ex ? { ...ex } : { name: '', part: 'chest', kind: 'weight', step: 2.5, defWeight: 20, defReps: 10, rest: 10, prep: 10 };
  const numField = (label, val, set, dec) => h('label', { class: 'field' }, h('span', {}, label),
    h('input', { type: 'number', inputMode: dec ? 'decimal' : 'numeric', step: 'any', min: '0', value: String(val), oninput: (e) => set(parseFloat(e.target.value) || 0) }));
  // 記録のしかたを変えたら、その方式に合う初期値に入れ替える
  const setKind = (k) => {
    if (k === d.kind) return;
    d.kind = k;
    Object.assign(d, { weight: { step: 2.5, defWeight: 20, defReps: 10 }, body: { defWeight: 0, defReps: 10 }, time: { defWeight: 0, defReps: 60 },
      hiit: { defWeight: 20, defReps: 8, rest: 10 }, cardio: { step: 0.5, defWeight: 5, defReps: 1800 } }[k]);
  };
  const body = h('div', {});
  const draw = () => setKids(body,
    h('label', { class: 'field' }, h('span', {}, 'メニュー名'),
      h('input', { type: 'text', value: d.name, maxLength: 40, placeholder: '例: インクラインベンチプレス', oninput: (e) => { d.name = e.target.value; } })),
    h('div', { class: 'field' }, h('span', {}, 'カテゴリ'),
      h('div', { class: 'chips' }, PARTS.map((p) => h('button', {
        type: 'button', class: 'chip' + (d.part === p.id ? ' on' : ''), onclick: () => {
          d.part = p.id;
          if (isNew) { // カテゴリに合う記録方式を自動で選ぶ
            if (p.id === 'hiit') setKind('hiit');
            else if (p.id === 'cardio') setKind('cardio');
            else if (d.kind === 'hiit' || d.kind === 'cardio') setKind('weight');
          }
          draw();
        },
      }, partDot(p.id), p.name)))),
    h('label', { class: 'field' }, h('span', {}, '記録のしかた'),
      h('select', { class: 'select wide', onchange: (e) => { setKind(e.target.value); draw(); } },
        Object.entries(KINDS).map(([k, v]) => h('option', { value: k, selected: d.kind === k }, v)))),
    d.kind === 'weight' && h('div', { class: 'field-row' },
      h('label', { class: 'field' }, h('span', {}, '最初の重量 (kg)'),
        h('input', { type: 'number', inputMode: 'decimal', step: 'any', min: '0', value: String(d.defWeight), oninput: (e) => { d.defWeight = parseFloat(e.target.value) || 0; } })),
      h('label', { class: 'field' }, h('span', {}, '＋−の刻み (kg)'),
        h('select', { class: 'select wide', onchange: (e) => { d.step = parseFloat(e.target.value); } },
          [0.5, 1, 2, 2.5, 5, 10].map((v) => h('option', { value: String(v), selected: d.step === v }, v))))),
    d.kind === 'hiit' && [
      h('div', { class: 'field-row' },
        numField('本数', d.defReps, (v) => { d.defReps = Math.round(v); }),
        numField('高強度 (秒)', d.defWeight, (v) => { d.defWeight = Math.round(v); })),
      h('div', { class: 'field-row' },
        numField('インターバル (秒)', d.rest, (v) => { d.rest = Math.round(v); }),
        numField('開始前の準備 (秒)', d.prep, (v) => { d.prep = Math.round(v); })),
      h('p', { class: 'hint' }, '例: タバタ式は 8本・高強度20秒・インターバル10秒。開始前の準備は、スタートを押してから1本目が始まるまでの時間です。実施するときにも調整できます。')],
    d.kind === 'cardio' && [
      h('div', { class: 'field-row' },
        numField('最初の距離 (km)', d.defWeight, (v) => { d.defWeight = v; }, true),
        numField('最初の時間 (分)', Math.round(d.defReps / 6) / 10, (v) => { d.defReps = Math.round(v * 60); }, true)),
      h('p', { class: 'hint' }, '距離を 0 にすると、時間だけを記録するメニューになります（バイクなど）。')],
    (d.kind === 'weight' || d.kind === 'body' || d.kind === 'time') && h('label', { class: 'field' }, h('span', {}, d.kind === 'time' ? '最初の秒数' : '最初の回数'),
      h('input', { type: 'number', inputMode: 'numeric', min: '1', value: String(d.defReps), oninput: (e) => { d.defReps = parseInt(e.target.value, 10) || 0; } })));
  draw();

  const n = ex ? state.sets.filter((s) => s.exId === ex.id).length : 0;
  openDialog(isNew ? 'メニューを追加' : 'メニューを編集', body, [
    !isNew && { label: '削除', kind: 'danger', run: () => {
      // openDialog の後始末（close）より後に確認ダイアログを開く
      setTimeout(() => confirmDialog(`「${ex.name}」を削除`,
        n ? `このメニューの記録 ${n}セット分も一緒に削除されます。元に戻せません。` : 'このメニューを削除します。',
        '削除する', () => {
          removeExercise(ex.id);
          save(); toast('削除しました'); render();
        }), 0);
    } },
    { label: 'キャンセル' },
    { label: '保存', kind: 'primary', run: () => {
      d.name = d.name.trim();
      if (!d.name) { toast('メニュー名を入力してください'); return false; }
      if (!(d.defReps > 0) || (d.kind === 'hiit' && !(d.defWeight > 0))) { toast('1以上の数を入力してください'); return false; }
      if (isNew) state.exercises.push({ ...d, id: uid(), archived: false, u: Date.now() });
      else Object.assign(ex, d, { u: Date.now() });
      save(); toast(isNew ? '追加しました' : '保存しました'); render();
    } },
  ].filter(Boolean));
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCsv() {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['日付', 'メニュー', 'カテゴリ', '重量(kg)', '回数・本数', '時間(秒)', '距離(km)'].join(',')];
  for (const s of [...state.sets].sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts)) {
    const ex = exById(s.exId); if (!ex) continue;
    const k = ex.kind;
    rows.push([s.date, q(ex.name), partName(ex.part),
      k === 'weight' ? s.weight : '',
      k === 'time' || k === 'cardio' ? '' : s.reps,
      k === 'time' || k === 'cardio' ? s.reps : k === 'hiit' ? s.reps * s.weight : '',
      k === 'cardio' ? s.weight : ''].join(','));
  }
  download(`kintore-log-${today()}.csv`, '\uFEFF' + rows.join('\r\n'), 'text/csv'); // BOM 付き＝Excel で文字化けしない
}
function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let next = null;
    try { next = normalize(JSON.parse(reader.result)); } catch (_) { /* 下で案内 */ }
    if (!next) return toast('このファイルは読み込めませんでした');
    confirmDialog('バックアップから復元',
      `メニュー ${next.exercises.length}件・記録 ${next.sets.length}セットを読み込みます。いまのデータは置き換えられます。`,
      '置き換える', () => { next.epoch = Date.now(); state = next; save(); toast('復元しました'); render(); });
  };
  reader.readAsText(file);
}

function syncCard() {
  if (syncCfg) {
    return h('section', { class: 'card list' },
      h('div', { class: 'eyebrow' }, '端末間の同期'),
      h('div', { class: 'row' },
        h('span', {}, h('b', {}, 'GitHub と同期中'), h('small', { id: 'sync-status', class: sync.error ? 'err' : '' }, syncStatusText())),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => syncNow(true) }, '今すぐ同期')),
      h('p', { class: 'hint' }, 'アプリを開いたときと記録したときに自動で同期します。もう一台でも同じトークンを設定してください。'),
      h('div', { class: 'btn-col' },
        h('button', {
          type: 'button', class: 'btn danger-text',
          onclick: () => confirmDialog('同期をやめる', 'この端末からトークンを消します。記録はこの端末にも GitHub にも残ります。', 'やめる',
            () => { clearTimeout(sync.timer); syncCfg = null; sync.error = ''; saveSyncCfg(); render(); }),
        }, 'この端末の同期をやめる')));
  }
  const input = h('input', { type: 'password', placeholder: 'ghp_… または github_pat_…', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, 'aria-label': 'GitHub トークン' });
  return h('section', { class: 'card list' },
    h('div', { class: 'eyebrow' }, '端末間の同期'),
    h('p', { class: 'hint' }, 'iPhone と iPad で同じ記録を使えます。データは自分の GitHub アカウントの非公開 Gist に保管します。'),
    h('ol', { class: 'steps' },
      h('li', {}, h('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=kintore-log', target: '_blank', rel: 'noopener' }, 'GitHub のトークン作成ページ'), 'を開く（gist だけにチェック）'),
      h('li', {}, '「Generate token」で出てきた文字列をコピー'),
      h('li', {}, '下に貼り付けて「同期を始める」。もう一台でも同じ文字列を貼る')),
    h('label', { class: 'field' }, input),
    h('div', { class: 'btn-col' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => connectSync(input.value) }, '同期を始める')));
}

function viewMenu() {
  const st = state.settings;
  const toggle = (label, sub, key) => h('label', { class: 'row' },
    h('span', {}, h('b', {}, label), sub && h('small', {}, sub)),
    h('input', { type: 'checkbox', class: 'switch', checked: st[key], onchange: (e) => { st[key] = e.target.checked; st.u = Date.now(); save(); render(); } }));
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; } });

  return h('div', { class: 'two-col' },
    h('div', {},
      h('header', { class: 'page-head' },
        h('div', {}, h('div', { class: 'eyebrow' }, 'MENU'), h('h1', {}, 'メニュー')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => exerciseDialog(null) }, icon('plus'), '追加')),
      PARTS.map((p) => {
        const list = state.exercises.filter((e) => e.part === p.id);
        if (!list.length) return null;
        return h('section', { class: 'card list' },
          h('div', { class: 'eyebrow' }, partDot(p.id), p.name),
          list.map((ex) => h('div', { class: 'row' + (ex.archived ? ' off' : '') },
            h('button', { type: 'button', class: 'row-main', onclick: () => exerciseDialog(ex) },
              h('b', {}, ex.name),
              h('small', {}, ex.kind === 'weight' ? `重量×回数・${ex.step}kg刻み`
                : ex.kind === 'hiit' ? `${ex.defReps}本・高強度${ex.defWeight}秒／休憩${ex.rest}秒` : KINDS[ex.kind])),
            h('input', {
              type: 'checkbox', class: 'switch', checked: !ex.archived, 'aria-label': `${ex.name}を記録画面に表示`,
              onchange: (e) => { ex.archived = !e.target.checked; ex.u = Date.now(); save(); render(); },
            }))));
      }),
      h('p', { class: 'hint pad' }, 'スイッチを切ると、記録は残したまま記録画面から隠せます')),

    h('div', { class: 'col-side' },
      h('header', { class: 'page-head sub' }, h('div', {}, h('div', { class: 'eyebrow' }, 'SETTINGS'), h('h1', {}, '設定'))),
      h('section', { class: 'card list' },
        h('div', { class: 'eyebrow' }, '休憩タイマー'),
        toggle('記録したら自動でスタート', 'セット間の休憩をカウントダウン', 'restAuto'),
        h('div', { class: 'row' }, h('span', {}, h('b', {}, '休憩時間')),
          h('div', { class: 'chips' }, [60, 90, 120, 180].map((s) => h('button', {
            type: 'button', class: 'chip' + (st.restSec === s ? ' on' : ''), onclick: () => { st.restSec = s; st.u = Date.now(); save(); render(); },
          }, s < 120 ? `${s}秒` : `${s / 60}分`)))),
        toggle('終了を音で知らせる', '消音モード中は鳴りません', 'sound')),
      syncCard(),
      h('section', { class: 'card list' },
        h('div', { class: 'eyebrow' }, 'データ'),
        h('p', { class: 'hint' }, '万一に備えて、ときどきバックアップを書き出しておくと安心です。'),
        h('div', { class: 'btn-col' },
          h('button', { type: 'button', class: 'btn', onclick: () => download(`kintore-log-${today()}.json`, JSON.stringify(state, null, 2), 'application/json') }, 'バックアップを書き出す'),
          h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, 'バックアップから復元'), fileInput,
          h('button', { type: 'button', class: 'btn', onclick: exportCsv }, 'CSV で書き出す（Excel 用）'),
          h('button', {
            type: 'button', class: 'btn danger-text',
            onclick: () => confirmDialog('すべてのデータを削除', 'メニューと記録をすべて消して、初期状態に戻します。元に戻せません。', '削除する',
              () => { state = defaultState(); state.epoch = Date.now(); save(); toast('初期状態に戻しました'); render(); }),
          }, 'すべてのデータを削除')))));
}

/* ───────────── 起動 ───────────── */

render();
// 日付をまたいでアプリに戻ってきたら「今日」を更新する
let lastDay = today();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (today() !== lastDay) { if (ui.date === lastDay) ui.date = today(); lastDay = today(); render(); }
  if (rest.end) drawRest();
  if (hiit.on) { keepAwake(); tickHiit(); }
});
// 同期のタイミング: 起動時／アプリに戻ったとき／アプリを離れるとき（送り残しを出さない）／電波が戻ったとき
document.addEventListener('visibilitychange', () => {
  if (!syncCfg) return;
  if (!document.hidden) syncNow();
  else if (sync.timer) syncNow();
});
window.addEventListener('online', () => syncNow());
if (syncCfg) syncNow();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// 端末がデータを勝手に消さないようお願いする（対応ブラウザのみ）
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
