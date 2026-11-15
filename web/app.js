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
  { id: 'other', name: 'その他' },
];
const partName = (id) => (PARTS.find((p) => p.id === id) || PARTS[6]).name;

// 記録タイプ: weight=重量×回数 / body=回数のみ（自重） / time=秒数
const KINDS = { weight: '重量 × 回数', body: '回数のみ（自重）', time: '時間（秒）' };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function seedExercises() {
  const E = (name, part, kind, weight, reps, step = 2.5) =>
    ({ id: uid(), name, part, kind, step, defWeight: weight, defReps: reps, archived: false });
  return [
    E('ベンチプレス', 'chest', 'weight', 40, 10),
    E('ダンベルプレス', 'chest', 'weight', 14, 10, 2),
    E('腕立て伏せ', 'chest', 'body', 0, 15),
    E('デッドリフト', 'back', 'weight', 60, 5),
    E('ラットプルダウン', 'back', 'weight', 35, 10),
    E('懸垂', 'back', 'body', 0, 8),
    E('スクワット', 'legs', 'weight', 50, 8),
    E('レッグプレス', 'legs', 'weight', 80, 10, 5),
    E('ブルガリアンスクワット', 'legs', 'body', 0, 10),
    E('ショルダープレス', 'shoulders', 'weight', 20, 10),
    E('サイドレイズ', 'shoulders', 'weight', 5, 15, 1),
    E('アームカール', 'arms', 'weight', 10, 12, 1),
    E('トライセプスプレスダウン', 'arms', 'weight', 20, 12),
    E('クランチ', 'abs', 'body', 0, 20),
    E('プランク', 'abs', 'time', 0, 60),
  ];
}

function defaultState() {
  return {
    version: 1,
    exercises: seedExercises(),
    sets: [], // { id, exId, date:'YYYY-MM-DD', ts, weight, reps }  ※time タイプは reps に秒数
    settings: { restSec: 90, restAuto: true, sound: true },
  };
}

// 外部から来たデータ（読み込み・インポート）を安全な形に整える
function normalize(raw) {
  if (!raw || !Array.isArray(raw.exercises) || !Array.isArray(raw.sets)) return null;
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const exercises = raw.exercises.filter((e) => e && e.id && e.name).map((e) => ({
    id: String(e.id),
    name: String(e.name).slice(0, 40),
    part: PARTS.some((p) => p.id === e.part) ? e.part : 'other',
    kind: KINDS[e.kind] ? e.kind : 'weight',
    step: num(e.step, 2.5) > 0 ? num(e.step, 2.5) : 2.5,
    defWeight: Math.max(0, num(e.defWeight)),
    defReps: Math.max(1, num(e.defReps, 10)),
    archived: !!e.archived,
  }));
  const ids = new Set(exercises.map((e) => e.id));
  const sets = raw.sets
    .filter((s) => s && ids.has(String(s.exId)) && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
    .map((s) => ({
      id: String(s.id || uid()), exId: String(s.exId), date: s.date, ts: num(s.ts, Date.now()),
      weight: Math.max(0, num(s.weight)), reps: Math.max(0, num(s.reps)),
    }));
  const st = raw.settings || {};
  return {
    version: 1, exercises, sets,
    settings: {
      restSec: Math.min(600, Math.max(10, num(st.restSec, 90))),
      restAuto: st.restAuto !== false,
      sound: st.sound !== false,
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
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (_) { toast('保存に失敗しました（端末の空き容量を確認してください）'); }
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
const score = (ex, s) => (ex.kind === 'weight' ? est1RM(s.weight, s.reps) : s.reps);
const scoreLabel = (ex) => (ex.kind === 'weight' ? '推定1RM' : ex.kind === 'time' ? '最長時間' : '最高回数');
const scoreUnit = (ex) => (ex.kind === 'weight' ? 'kg' : ex.kind === 'time' ? '秒' : '回');
const volume = (ex, s) => (ex && ex.kind === 'weight' ? s.weight * s.reps : 0);

function fmtSet(ex, s) {
  if (ex.kind === 'weight') return `${fmtNum(s.weight)}kg × ${s.reps}`;
  if (ex.kind === 'time') return `${s.reps}秒`;
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
function beep() {
  if (!state.settings.sound || !audioCtx) return;
  [0, 0.22, 0.44].forEach((t, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = i === 2 ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t);
    g.gain.exponentialRampToValueAtTime(0.3, audioCtx.currentTime + t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.18);
    o.connect(g).connect(audioCtx.destination);
    o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.2);
  });
}
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

/* ───────────── 4. 画面 ───────────── */

const ui = {
  tab: 'log',
  date: today(),      // 記録対象の日（通常は今日）
  part: 'all',        // 記録タブの部位フィルタ
  exId: null,         // 入力中の種目
  weight: 0, reps: 0, // 入力中の値
  month: today().slice(0, 7), day: today(), // 履歴タブ
  statMode: 'volume', statEx: null, pick: null, // 分析タブ
};

const TABS = [['log', '記録'], ['history', '履歴'], ['stats', '分析'], ['menu', 'メニュー']];

function render() {
  const y = window.scrollY;
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
}

function recordSet() {
  const ex = exById(ui.exId);
  if (!ex) return;
  unlockAudio();
  const reps = Math.round(ui.reps), weight = ex.kind === 'weight' ? ui.weight : 0;
  if (!(reps > 0)) return toast(ex.kind === 'time' ? '秒数を入力してください' : '回数を入力してください');
  const s = { id: uid(), exId: ex.id, date: ui.date, ts: Date.now(), weight, reps };
  const prior = setsOf(ex.id);
  const best = prior.length ? Math.max(...prior.map((p) => score(ex, p))) : null;
  state.sets.push(s);
  save();
  if (best != null && score(ex, s) > best + 1e-9) {
    toast(`自己ベスト更新！ ${scoreLabel(ex)} ${fmtNum(score(ex, s))}${scoreUnit(ex)}`, 'pr');
  } else toast(`${fmtSet(ex, s)} を記録しました`);
  if (state.settings.restAuto && ui.date === today()) startRest(state.settings.restSec);
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

  return h('section', { class: 'panel' },
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
    ex.kind === 'time'
      ? stepper('時間', '秒', () => ui.reps, 5, 0, (v) => { ui.reps = v; }, [30, 45, 60, 90, 120])
      : stepper('回数', '回', () => ui.reps, 1, 0, (v) => { ui.reps = v; }, [5, 8, 10, 12, 15, 20]),

    h('button', { type: 'button', class: 'btn primary big', onclick: recordSet },
      `${todays.length + 1}セット目を記録`),

    todays.length > 0 && h('div', { class: 'today-sets' },
      h('div', { class: 'eyebrow' }, ui.date === today() ? '今日のセット' : `${md(ui.date)} のセット`),
      h('ol', { class: 'setlist' }, todays.map((s, i) => h('li', {},
        h('span', { class: 'set-no' }, i + 1),
        h('span', { class: 'set-v' }, fmtSet(ex, s)),
        h('button', {
          type: 'button', class: 'icon-btn small', 'aria-label': `${i + 1}セット目を削除`,
          onclick: () => { state.sets = state.sets.filter((x) => x.id !== s.id); save(); toast('削除しました'); render(); },
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
  openDialog(`${ex.name} を編集`,
    [ex.kind === 'weight' && field('重量 (kg)', w, (v) => { w = v; }, true),
      field(ex.kind === 'time' ? '時間 (秒)' : '回数', r, (v) => { r = v; })],
    [{ label: '削除', kind: 'danger', run: () => { state.sets = state.sets.filter((x) => x.id !== s.id); save(); render(); } },
      { label: 'キャンセル' },
      { label: '保存', kind: 'primary', run: () => {
        if (!(r > 0)) { toast('1以上の数を入力してください'); return false; }
        s.weight = Math.max(0, w); s.reps = Math.round(r); save(); render();
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
          : tile('累計', fmtNum(exSets.reduce((a, s) => a + s.reps, 0)), scoreUnit(ex)),
        tile('実施日数', allPts.length, '日')),
      line(pts, scoreUnit(ex), 'ex:' + ex.id),
      h('p', { class: 'hint' }, `各日のベスト（${scoreLabel(ex)}）の推移。` +
        (ex.kind === 'weight' ? '推定1RM＝重量×(1＋回数÷30)。' : '') + (allPts.length > 20 ? '直近20回分を表示。' : ''))));
}

/* ── メニュータブ（メニュー管理＋設定） ── */

function exerciseDialog(ex) {
  const isNew = !ex;
  const d = ex ? { ...ex } : { name: '', part: 'chest', kind: 'weight', step: 2.5, defWeight: 20, defReps: 10 };
  const body = h('div', {});
  const draw = () => setKids(body,
    h('label', { class: 'field' }, h('span', {}, 'メニュー名'),
      h('input', { type: 'text', value: d.name, maxLength: 40, placeholder: '例: インクラインベンチプレス', oninput: (e) => { d.name = e.target.value; } })),
    h('div', { class: 'field' }, h('span', {}, '部位'),
      h('div', { class: 'chips' }, PARTS.map((p) => h('button', {
        type: 'button', class: 'chip' + (d.part === p.id ? ' on' : ''), onclick: () => { d.part = p.id; draw(); },
      }, partDot(p.id), p.name)))),
    h('label', { class: 'field' }, h('span', {}, '記録のしかた'),
      h('select', { class: 'select wide', onchange: (e) => { d.kind = e.target.value; if (d.kind === 'time' && isNew) d.defReps = 60; draw(); } },
        Object.entries(KINDS).map(([k, v]) => h('option', { value: k, selected: d.kind === k }, v)))),
    d.kind === 'weight' && h('div', { class: 'field-row' },
      h('label', { class: 'field' }, h('span', {}, '最初の重量 (kg)'),
        h('input', { type: 'number', inputMode: 'decimal', step: 'any', min: '0', value: String(d.defWeight), oninput: (e) => { d.defWeight = parseFloat(e.target.value) || 0; } })),
      h('label', { class: 'field' }, h('span', {}, '＋−の刻み (kg)'),
        h('select', { class: 'select wide', onchange: (e) => { d.step = parseFloat(e.target.value); } },
          [0.5, 1, 2, 2.5, 5, 10].map((v) => h('option', { value: String(v), selected: d.step === v }, v))))),
    h('label', { class: 'field' }, h('span', {}, d.kind === 'time' ? '最初の秒数' : '最初の回数'),
      h('input', { type: 'number', inputMode: 'numeric', min: '1', value: String(d.defReps), oninput: (e) => { d.defReps = parseInt(e.target.value, 10) || 0; } })));
  draw();

  const n = ex ? state.sets.filter((s) => s.exId === ex.id).length : 0;
  openDialog(isNew ? 'メニューを追加' : 'メニューを編集', body, [
    !isNew && { label: '削除', kind: 'danger', run: () => {
      // openDialog の後始末（close）より後に確認ダイアログを開く
      setTimeout(() => confirmDialog(`「${ex.name}」を削除`,
        n ? `このメニューの記録 ${n}セット分も一緒に削除されます。元に戻せません。` : 'このメニューを削除します。',
        '削除する', () => {
          state.exercises = state.exercises.filter((e) => e.id !== ex.id);
          state.sets = state.sets.filter((s) => s.exId !== ex.id);
          save(); toast('削除しました'); render();
        }), 0);
    } },
    { label: 'キャンセル' },
    { label: '保存', kind: 'primary', run: () => {
      d.name = d.name.trim();
      if (!d.name) { toast('メニュー名を入力してください'); return false; }
      if (!(d.defReps > 0)) { toast('1以上の数を入力してください'); return false; }
      if (isNew) state.exercises.push({ ...d, id: uid(), archived: false });
      else Object.assign(ex, d);
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
  const rows = [['日付', 'メニュー', '部位', '重量(kg)', '回数', '秒数'].join(',')];
  for (const s of [...state.sets].sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts)) {
    const ex = exById(s.exId); if (!ex) continue;
    rows.push([s.date, q(ex.name), partName(ex.part), ex.kind === 'weight' ? s.weight : '',
      ex.kind === 'time' ? '' : s.reps, ex.kind === 'time' ? s.reps : ''].join(','));
  }
  download(`kintore-log-${today()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv'); // BOM 付き＝Excel で文字化けしない
}
function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let next = null;
    try { next = normalize(JSON.parse(reader.result)); } catch (_) { /* 下で案内 */ }
    if (!next) return toast('このファイルは読み込めませんでした');
    confirmDialog('バックアップから復元',
      `メニュー ${next.exercises.length}件・記録 ${next.sets.length}セットを読み込みます。いまのデータは置き換えられます。`,
      '置き換える', () => { state = next; save(); toast('復元しました'); render(); });
  };
  reader.readAsText(file);
}

function viewMenu() {
  const st = state.settings;
  const toggle = (label, sub, key) => h('label', { class: 'row' },
    h('span', {}, h('b', {}, label), sub && h('small', {}, sub)),
    h('input', { type: 'checkbox', class: 'switch', checked: st[key], onchange: (e) => { st[key] = e.target.checked; save(); render(); } }));
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
              h('small', {}, ex.kind === 'weight' ? `重量×回数・${ex.step}kg刻み` : KINDS[ex.kind])),
            h('input', {
              type: 'checkbox', class: 'switch', checked: !ex.archived, 'aria-label': `${ex.name}を記録画面に表示`,
              onchange: (e) => { ex.archived = !e.target.checked; save(); render(); },
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
            type: 'button', class: 'chip' + (st.restSec === s ? ' on' : ''), onclick: () => { st.restSec = s; save(); render(); },
          }, s < 120 ? `${s}秒` : `${s / 60}分`)))),
        toggle('終了を音で知らせる', '消音モード中は鳴りません', 'sound')),
      h('section', { class: 'card list' },
        h('div', { class: 'eyebrow' }, 'データ'),
        h('p', { class: 'hint' }, '記録はこの端末の中だけに保存されます。機種変更や iPhone ⇄ iPad の引っ越しは、バックアップを書き出して読み込んでください。'),
        h('div', { class: 'btn-col' },
          h('button', { type: 'button', class: 'btn', onclick: () => download(`kintore-log-${today()}.json`, JSON.stringify(state, null, 2), 'application/json') }, 'バックアップを書き出す'),
          h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, 'バックアップから復元'), fileInput,
          h('button', { type: 'button', class: 'btn', onclick: exportCsv }, 'CSV で書き出す（Excel 用）'),
          h('button', {
            type: 'button', class: 'btn danger-text',
            onclick: () => confirmDialog('すべてのデータを削除', 'メニューと記録をすべて消して、初期状態に戻します。元に戻せません。', '削除する',
              () => { state = defaultState(); save(); toast('初期状態に戻しました'); render(); }),
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
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// 端末がデータを勝手に消さないようお願いする（対応ブラウザのみ）
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
