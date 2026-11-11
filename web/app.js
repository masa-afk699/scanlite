// ScanLite: すべての処理をブラウザー内で行う。撮影画像・PDF・OCR結果はネットワークに送らない。
import { processImage as processHere, processSpread as spreadHere, finishHalf as finishHere, decode, drawRotated, detectPage, FULL_FRAME, recompress, limitOriginal as limitHere, cropTop, orientCandidates, linesVertical } from './scan.js';
import * as db from './db.js';
import { buildPdf } from './pdf.js';
import { recognize, textLines, warmUp } from './ocr.js';
import { createCamera } from './camera.js';
import * as save from './save.js';

// 新しく取り込んだページの標準設定
const DEFAULTS = { rotation: 0, filter: 'color', crop: 'auto', half: null, deskew: true, fingers: true, denoise: true, evenColor: true, moire: false };
// PC・スマホの画面を撮るとき: 紙向けの補正は使わず、モアレ除去と画面向けの色補正にする
const SCREEN_DEFAULTS = { ...DEFAULTS, filter: 'screen', deskew: false, fingers: false, denoise: false, evenColor: false, moire: true };
const FILTERS = { color: 'カラー', gray: 'グレースケール', bw: '白黒', screen: '画面向け', none: '補正なし' };
const defaultsFor = m => m === 'screen'
  ? { ...SCREEN_DEFAULTS, ...prefs.get('defaults.screen', {}) }
  : { ...DEFAULTS, ...prefs.get('defaults', {}) };
const QUALITY = { high: { side: 2400, q: 0.86 }, normal: { side: 1600, q: 0.75 }, small: { side: 1100, q: 0.6 } };
const MODE_TEXT = {
  book: { title: '本をスキャン', help: 'ページをめくって手を止めると、自動で撮影します。' },
  document: { title: '書類をスキャン', help: '紙を置き換えて手を止めると、自動で撮影します。' },
  screen: { title: '画面をスキャン', help: 'PCやスマホの画面の四隅を見つけて、縞模様（モアレ）と色かぶりを抑えます。' },
};

// ---------- 画像補正のワーカー（別スレッド。端末のコア数に応じて最大2つ） ----------
const SCAN_POOL = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 2));
const scanWorkers = [];
let scanSeq = 0, scanBroken = typeof OffscreenCanvas === 'undefined';
function newScanWorker() {
  const w = new Worker(new URL('./scan-worker.js', import.meta.url), { type: 'module' });
  w.jobs = new Map();
  w.onmessage = ({ data: { id, result, error, second } }) => {
    const job = w.jobs.get(id); if (!job) return;
    if (second !== undefined) return job.onSecond?.(second, w);
    w.jobs.delete(id);
    error ? job.reject(new Error(error)) : job.resolve(result);
  };
  w.onerror = e => { scanBroken = true; for (const j of w.jobs.values()) j.reject(new Error(e.message || 'worker error')); w.jobs.clear(); };
  return w;
}
function scanWorker(busy = null) {
  // いちばん空いているワーカーを使う（busy は今まさに使っているワーカー。なるべく避ける）
  if (scanWorkers.length < SCAN_POOL) scanWorkers.push(newScanWorker());
  const load = w => w.jobs.size + (w === busy ? 1 : 0);
  return scanWorkers.reduce((a, b) => (load(b) < load(a) ? b : a));
}
// 撮影直後の下準備（向きの見当・保存用の大きさへの縮小）は、補正中のワーカーの後ろで待たないよう、
// 専用のワーカーで行う（補正している間に次の写真の下準備が進む）
let prepWorker = null;
async function inWorker(op, blob, opts, here, extra = {}, onSecond = null, busy = null, prep = false) {
  if (!scanBroken) {
    try {
      const w = prep ? (prepWorker = prepWorker || newScanWorker()) : scanWorker(busy);
      return await new Promise((resolve, reject) => {
        const id = ++scanSeq;
        w.jobs.set(id, { resolve, reject, onSecond });
        w.postMessage({ id, op, blob, opts, ...extra }, extra.image ? [extra.image] : []);
      });
    } catch (e) {
      // ワーカー自体が動かないときだけ、画面のスレッドで処理する
      if (!scanBroken) throw e;
      console.error('scan worker failed, using main thread', e);
    }
  }
  return here();
}
const processImage = (blob, opts) => inWorker('process', blob, opts, () => processHere(blob, opts));
const limitOriginal = blob => inWorker('limit', blob, null, () => limitHere(blob), {}, null, null, true);
// 見開きの左右のページ（同じ写真・同じ設定）をまとめて補正する。範囲・台形・紙の反りの補正は1回だけ行い、
// のどで切り分けたあとの仕上げは、左右を2つのワーカーで同時に行う。返り値: [1ページ目, 2ページ目] の Promise
function processSpread(blob, optsA, optsB) {
  let secondDone;
  const second = new Promise((resolve, reject) => { secondDone = { resolve, reject }; });
  const pass = SCAN_POOL > 1;
  const onSecond = (half, busy) => {
    // 左右で範囲を別々に求めるときは、2ページ目を最初から補正する
    const job = half ? inWorker('finish', null, optsB, () => finishHere(half.image, optsB, half.state), { image: half.image, state: half.state }, null, busy)
      : inWorker('process', blob, optsB, () => processHere(blob, optsB), {}, null, busy);
    job.then(secondDone.resolve, secondDone.reject);
  };
  const first = inWorker('spread', blob, optsA, () => spreadHere(blob, optsA, optsB), { optsB, pass }, pass ? onSecond : null)
    .then(r => { if (r.second) secondDone.resolve(r.second); return r.first; });
  first.catch(e => secondDone.reject(e));
  return [first, second];
}

// 横倒しに写った写真の向きを決める（同じ写真から作る左右のページで1回だけ）。
// 文字を読んで確かさの高い向きを選び、決めきれないときはスマホの傾き（撮影時）を使う。
// 向きの判定は文字の行の検出といっしょに行う（前の写真と同じ向きと仮定して行を検出し、その行を
// 向きを変えて読み比べる。仮定が外れたときだけ検出し直す）。求めた行は ensureLines で使う
const rotationCache = new Map();
let lastTurn = null;
const tiltTurn = p => (typeof p.tilt === 'number' && Math.abs(p.tilt) > 1.5 ? (p.tilt > 0 ? 270 : 90) : null);
function decideRotation(p, blob = p.original) {
  const key = p.capture;
  if (!rotationCache.has(key)) {
    rotationCache.set(key, (async () => {
      const split = !!p.half;
      const g = await inWorker('orient', blob, { split }, () => orientCandidates(blob, split), {}, null, null, true);
      if (!g.need) return 0;
      const turns = [0, 90, 270], guess = lastTurn ?? tiltTurn(p) ?? 90;
      const r = await textLines(blob, guess, turns);
      if (r && r.scores) {
        const s = r.scores, best = s.indexOf(Math.max(...s)), other = Math.max(...s.filter((_, i) => i !== best));
        if (s[best] - other > 0.02) {
          // この向きの文字の行はもう求めてあるので、覚えておく
          if (r.rotation === turns[best]) rememberLines(p, r.rotation, Promise.resolve(r.lines));
          lastTurn = turns[best];
          return turns[best];
        }
      }
      // 文字で決めきれないときは、撮影時のスマホの傾き（横持ちの向き）で決める
      const turn = tiltTurn(p) ?? 0;
      if (r && r.rotation === turn) rememberLines(p, turn, Promise.resolve(r.lines));
      return turn;
    })().catch(e => { console.error(e); return 0; }));
    if (rotationCache.size > 50) rotationCache.delete(rotationCache.keys().next().value);
  }
  return rotationCache.get(key);
}

// 写真の中の文字の行を調べておく（ページの端が写っていないときに、行の並びから範囲とゆがみを求めるため）
const linesCache = new Map();
const linesKey = (p, rotation) => (p.capture ?? p.id) + ':' + rotation;
function rememberLines(p, rotation, lines) {
  linesCache.set(linesKey(p, rotation), lines);
  if (linesCache.size > 50) linesCache.delete(linesCache.keys().next().value);
}
async function ensureLines(p, blob = p.original) {
  if (p.crop !== 'auto' || p.mode === 'screen') return;
  if (p.lines && p.linesRotation === (p.rotation || 0)) return;
  const key = linesKey(p, p.rotation || 0);
  if (!linesCache.has(key)) rememberLines(p, p.rotation || 0, textLines(blob, p.rotation || 0));
  p.lines = await linesCache.get(key);
  p.linesRotation = p.rotation || 0;
}

const $ = s => document.querySelector(s);
let docs = [], docId = null, pages = [], thumbUrls = [];

// ---------- ちょっとした設定の記憶（この端末のブラウザー内だけ） ----------
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('scanlite.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('scanlite.' + k, JSON.stringify(v)); } catch {} },
};
let mode = prefs.get('mode', 'book');

// ---------- 処理待ちの表示 ----------
let pending = 0;
function setBusy(text) {
  const el = $('#busy');
  el.hidden = !text;
  el.textContent = text || '';
}
const showPending = () => setBusy(pending ? `画像を補正しています…（残り ${pending} 枚）` : '');

// ---------- フォルダと文書 ----------
// フォルダは文書をまとめる入れ物。表示中のフォルダ: 'all'（すべて）/ 'none'（フォルダなし）/ フォルダのid
let folders = [], folderView = prefs.get('folder', 'all');
const folderName = id => folders.find(f => f.id === id)?.name;
const inFolder = (d, view) => view === 'all' || (view === 'none' ? !folderName(d.folderId) : d.folderId === view);
// 文書がないフォルダを表示したときは、そのフォルダに新しい文書を1つ用意する
async function ensureDocIn(view) {
  if (docs.some(d => inFolder(d, view))) return;
  const doc = { name: defaultDocName(), created: Date.now() };
  if (typeof view === 'number') doc.folderId = view;
  await db.addDoc(doc);
  docs = await db.allDocs();
}
async function loadDocs() {
  folders = await db.allFolders();
  if (typeof folderView === 'number' && !folderName(folderView)) folderView = 'all';
  docs = await db.allDocs();
  await ensureDocIn(folderView);
  const shown = docs.filter(d => inFolder(d, folderView));
  if (!shown.some(d => d.id === docId)) docId = prefs.get('doc', null);
  if (!shown.some(d => d.id === docId)) docId = shown[shown.length - 1].id;
  prefs.set('doc', docId);
  prefs.set('folder', folderView);
  const fsel = $('#folder-select');
  fsel.replaceChildren(
    new Option(`📁 すべて（${docs.length}）`, 'all', false, folderView === 'all'),
    ...folders.map(f => new Option(`📁 ${f.name}（${docs.filter(d => d.folderId === f.id).length}）`, f.id, false, f.id === folderView)),
    new Option(`📁 フォルダなし（${docs.filter(d => !folderName(d.folderId)).length}）`, 'none', false, folderView === 'none'),
  );
  $('#folder-rename').hidden = $('#folder-delete').hidden = typeof folderView !== 'number';
  const sel = $('#doc-select');
  const opt = d => new Option(d.name, d.id, false, d.id === docId);
  if (folderView === 'all' && folders.length) {
    // すべて表示のときはフォルダごとにまとめて並べる
    const groups = [...folders.map(f => [f.name, docs.filter(d => d.folderId === f.id)]), ['フォルダなし', docs.filter(d => !folderName(d.folderId))]];
    sel.replaceChildren(...groups.filter(([, list]) => list.length).map(([label, list]) => {
      const g = document.createElement('optgroup'); g.label = label; g.append(...list.map(opt)); return g;
    }));
  } else sel.replaceChildren(...shown.map(opt));
}
const currentDoc = () => docs.find(d => d.id === docId);
function defaultDocName() {
  const d = new Date();
  return `スキャン ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// 「フォルダ › 文書」の表示
const destLabel = doc => (folderName(doc?.folderId) ? `${folderName(doc.folderId)} › ` : '') + (doc?.name || '');
async function newFolder() {
  const name = prompt('新しいフォルダの名前（例: 本のタイトル、授業名）', '');
  if (!name || !name.trim()) return null;
  return db.addFolder({ name: name.trim(), created: Date.now() });
}
async function newDocIn(folderId, ask = true) {
  let name = defaultDocName();
  if (ask) { name = prompt('新しい文書の名前', name); if (name === null) return null; }
  const doc = { name: name.trim() || defaultDocName(), created: Date.now() };
  if (folderId != null) doc.folderId = folderId;
  return db.addDoc(doc);
}

$('#folder-select').onchange = async e => {
  const v = e.target.value;
  folderView = v === 'all' || v === 'none' ? v : Number(v);
  docId = null;
  await refresh();
};
$('#folder-new').onclick = async () => {
  const id = await newFolder();
  if (id == null) return;
  folderView = id; docId = null;
  await refresh();
};
$('#folder-rename').onclick = async () => {
  const f = folders.find(x => x.id === folderView);
  const name = f && prompt('フォルダの名前', f.name);
  if (!name || !name.trim()) return;
  f.name = name.trim();
  await db.putFolder(f);
  await refresh();
};
$('#folder-delete').onclick = async () => {
  const f = folders.find(x => x.id === folderView);
  if (!f) return;
  const n = docs.filter(d => d.folderId === f.id).length;
  if (!confirm(`フォルダ「${f.name}」を削除しますか？\n中の文書（${n}件）とページは消さずに「フォルダなし」に移します。`)) return;
  await db.removeFolder(f.id);
  folderView = 'all';
  await refresh();
};

$('#doc-select').onchange = async e => { docId = Number(e.target.value); prefs.set('doc', docId); await refresh(); };
$('#doc-new').onclick = async () => {
  const id = await newDocIn(typeof folderView === 'number' ? folderView : null);
  if (id == null) return;
  docId = id;
  await refresh();
};
$('#doc-rename').onclick = async () => {
  const doc = currentDoc();
  const name = prompt('文書の名前', doc.name);
  if (!name || !name.trim()) return;
  doc.name = name.trim();
  await db.putDoc(doc);
  await refresh();
};
$('#doc-move').onclick = () => openDest('move');
$('#doc-delete').onclick = async () => {
  const doc = currentDoc();
  if (!confirm(`「${doc.name}」とそのページ（${pages.length}枚）を削除しますか？`)) return;
  await db.removeDoc(doc.id);
  docId = null;
  await refresh();
};

// ---------- 保存先を選ぶ画面（撮影中の保存先の切り替え・文書の移動） ----------
// kind: 'camera' = フォルダと文書を選んで、以後の撮影をそこに保存 / 'move' = 今の文書を別のフォルダへ移す
let dest = null;
function openDest(kind) {
  dest = { kind, folder: currentDoc()?.folderId ?? null };
  if (!folderName(dest.folder)) dest.folder = null;
  $('#dest-title').textContent = kind === 'move' ? '文書をフォルダに移す' : '保存先を選ぶ';
  $('#dest-note').textContent = kind === 'move'
    ? `「${currentDoc().name}」を入れるフォルダを選んでください。`
    : 'これから撮るページの保存先です。撮影の途中でも切り替えられます。';
  $('#dest-docs-area').hidden = kind === 'move';
  drawDest();
  $('#dest-dialog').showModal();
}
function drawDest() {
  const item = (text, on, fn, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = text; b.className = cls + (on ? ' on' : ''); b.onclick = fn;
    if (on) b.setAttribute('aria-current', 'true');
    return b;
  };
  const pick = async folder => {
    if (dest.kind === 'move') {
      const doc = currentDoc();
      if (folder == null) delete doc.folderId; else doc.folderId = folder;
      await db.putDoc(doc);
      // 移した先のフォルダを表示する（すべて表示中ならそのまま）
      if (folderView !== 'all') folderView = folder ?? 'none';
      $('#dest-dialog').close();
      await refresh();
      return;
    }
    dest.folder = folder;
    drawDest();
  };
  $('#dest-folders').replaceChildren(
    ...folders.map(f => item(f.name, dest.folder === f.id, () => pick(f.id))),
    item('フォルダなし', dest.folder == null, () => pick(null)),
    item('＋ 新しいフォルダ', false, async () => { const id = await newFolder(); if (id == null) return; folders = await db.allFolders(); await pick(id); }, 'add'),
  );
  if (dest.kind === 'move') return;
  const choose = async id => {
    docId = id;
    // 撮影画面で選んだ保存先を、ホーム画面の表示にも合わせる
    if (folderView !== 'all') folderView = dest.folder ?? 'none';
    $('#dest-dialog').close();
    await refresh();
    syncCameraBar();
    $('#camera-status').textContent = `「${destLabel(currentDoc())}」に保存します`;
  };
  const list = docs.filter(d => (dest.folder == null ? !folderName(d.folderId) : d.folderId === dest.folder)).reverse();
  $('#dest-docs').replaceChildren(
    item('＋ 新しい文書', false, async () => { const id = await newDocIn(dest.folder); if (id != null) await choose(id); }, 'add'),
    ...list.map(d => item(d.name, d.id === docId, () => choose(d.id))),
  );
}

// ---------- ページ一覧 ----------
const ready = p => !p.waiting && !p.failed;

async function refresh() {
  await loadDocs();
  pages = await db.pagesOf(docId);
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = [];
  const done = pages.filter(ready).length;
  $('#count').textContent = `${done} ページ` + (done < pages.length ? `（処理中 ${pages.length - done}）` : '');
  $('#pdf-button').disabled = !done;
  $('#batch-button').disabled = !done;
  const root = $('#pages');
  const frag = document.createDocumentFragment();
  // 文字で探す: 読み取り済みの文字に含まれるページだけを出す
  const query = $('#search').value.trim();
  const norm = t => (t || '').replace(/\s+/g, '').toLowerCase();
  const q = norm(query);
  let hits = 0, unread = 0;
  pages.forEach((p, index) => {
    let snippet = null;
    if (q) {
      if (!ready(p)) return;
      if (!(p.ocr && p.ocr.width === p.width)) { unread++; return; }
      const flat = p.ocr.text.replace(/\s+/g, ''), at = norm(flat).indexOf(q);
      if (at < 0) return;
      hits++;
      snippet = { before: flat.slice(Math.max(0, at - 20), at), hit: flat.slice(at, at + q.length), after: flat.slice(at + q.length, at + q.length + 40) };
    }
    const card = document.createElement('article');
    card.className = 'page-card';
    card.dataset.id = p.id;
    card.classList.toggle('selected', selected.has(p.id));
    const check = document.createElement('span');
    check.className = 'page-check';
    check.setAttribute('aria-hidden', 'true');
    const label = document.createElement('div');
    label.className = 'page-meta';
    label.textContent = `${index + 1}` + (p.half ? (p.half === 'right' ? '　右' : '　左') : '') + (p.ocr ? '　文字✓' : '') + (ready(p) ? '　' + (FILTERS[p.filter || 'none'] || '') : '');
    if (!ready(p)) {
      const ph = document.createElement('div');
      ph.className = 'page-placeholder';
      ph.textContent = p.failed ? '読み込めませんでした（長押しで選んで削除）' : '補正待ち…';
      card.append(ph, label, check);
    } else {
      const img = document.createElement('img');
      const url = URL.createObjectURL(p.thumb || p.blob);
      thumbUrls.push(url);
      img.src = url;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      img.alt = `${index + 1}ページ目`;
      card.append(img, label, check);
    }
    if (snippet) {
      const sn = document.createElement('p');
      sn.className = 'page-snippet';
      const mark = document.createElement('mark'); mark.textContent = snippet.hit;
      sn.append('…' + snippet.before, mark, snippet.after + '…');
      sn.dataset.text = '1';
      card.append(sn);
    }
    frag.append(card);
  });
  const note = $('#search-note');
  note.hidden = !q;
  if (q) note.textContent = `「${query}」が見つかったページ: ${hits}` + (unread ? `　（文字を読み取っていない ${unread} ページは対象外です。「まとめて設定」でOCRを「する」にすると探せます）` : '');
  $('#text-export').disabled = !done;
  root.replaceChildren(frag);
  // 消えたページは選択からも外す
  for (const id of [...selected]) if (!pages.some(p => p.id === id)) selected.delete(id);
  $('#pages-hint').hidden = !pages.length || selecting();
  showSelection();
  showStorage();
}

// 処理中は一覧の作り直しを間引く（大量撮影でも重くならないように）
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => { refreshTimer = null; await refresh(); }, 600);
}

// 端末の保存容量の目安
async function showStorage() {
  const el = $('#storage');
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const mb = v => v > 1e9 ? `${(v / 1e9).toFixed(1)}GB` : `${Math.round(v / 1e6)}MB`;
    el.textContent = `この端末に保存中 ${mb(usage)}（使える目安 あと ${mb(Math.max(0, quota - usage))}）`;
    el.hidden = false;
  } catch { el.hidden = true; }
}

const optionsOf = p => ({
  rotation: p.rotation || 0, filter: p.filter || 'none', crop: p.crop || 'none', half: p.half || null, perPage: !!p.perPage,
  deskew: !!p.deskew, fingers: !!p.fingers, denoise: p.denoise !== false, evenColor: p.evenColor !== false,
  moire: !!p.moire, subject: p.mode === 'screen' ? 'screen' : 'paper', lines: p.lines || null,
});

async function reprocess(page, change, { quiet = false } = {}) {
  if (!page.original) page.original = page.blob;
  Object.assign(page, change);
  setBusy('画像を補正しています…');
  try {
    await ensureLines(page);
    Object.assign(page, await processImage(page.original, optionsOf(page)));
    page.rev = (page.rev || 0) + 1;
    delete page.ocr; // 画像が変わったのでOCR結果は作り直す
    await db.putPage(page);
  } finally { if (!quiet) showPending(); }
  if (!quiet) { await refresh(); runBackgroundOcr(); }
}

// ---------- ページの選択（長押しで選び、選んだページだけを編集する） ----------
// 一覧のページには編集ボタンを置かない（うっかり押さないように）。
// 長押しで選択を始め、選択中はタップで選ぶ・外す。編集は画面下のバーから行う。
const selected = new Set();
let selectMode = false;
const selecting = () => selectMode;
const selectedPages = () => pages.filter(p => selected.has(p.id));

function startSelect(id) {
  if (!selectMode) {
    selectMode = true;
    // スマホの「戻る」で選択をやめられるように
    try { history.pushState({ scanliteSelect: true }, ''); } catch {}
  }
  selected.add(id);
  navigator.vibrate?.(25);
  paintSelection();
}
function endSelect({ fromHistory = false } = {}) {
  if (!selectMode) return;
  selectMode = false;
  selected.clear();
  paintSelection();
  if (!fromHistory && history.state?.scanliteSelect) history.back();
}
window.addEventListener('popstate', () => { if (selectMode) endSelect({ fromHistory: true }); });
function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  if (!selected.size) endSelect(); else paintSelection();
}
// 一覧を作り直さずに、選択の見た目とバーだけを更新する
function paintSelection() {
  document.querySelectorAll('#pages .page-card').forEach(c => c.classList.toggle('selected', selected.has(Number(c.dataset.id))));
  $('#pages-hint').hidden = !pages.length || selectMode;
  showSelection();
}
function showSelection() {
  const bar = $('#select-bar');
  bar.hidden = !selectMode;
  document.body.classList.toggle('selecting', selectMode);
  if (!selectMode) return;
  const list = selectedPages(), usable = list.filter(ready);
  $('#select-count').textContent = `${list.length}枚を選択中`;
  $('#select-all').textContent = list.length === pages.length ? '全部はずす' : '全部選ぶ';
  $('#sel-edit').disabled = !usable.length;
  $('#sel-rotate').disabled = !usable.length;
  $('#sel-settings').disabled = !usable.length;
  $('#sel-copy').disabled = !usable.length;
  const allReady = usable.length === list.length && list.length > 0;
  const first = pages.findIndex(p => selected.has(p.id)), last = pages.length - 1 - [...pages].reverse().findIndex(p => selected.has(p.id));
  $('#sel-up').disabled = !allReady || first <= 0 || list.length === pages.length;
  $('#sel-down').disabled = !allReady || last >= pages.length - 1 || list.length === pages.length;
  $('#sel-delete').disabled = !list.length;
}

// 長押しの判定（指を少し動かしたらスクロールとみなしてやめる）
{
  const root = $('#pages');
  let timer = null, start = null, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  root.addEventListener('pointerdown', e => {
    const card = e.target.closest('.page-card');
    if (!card || (e.pointerType === 'mouse' && e.button !== 0)) return;
    fired = false;
    start = [e.clientX, e.clientY];
    cancel();
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      const id = Number(card.dataset.id);
      if (selectMode) toggleSelect(id); else startSelect(id);
    }, 450);
  });
  root.addEventListener('pointermove', e => { if (timer && start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) cancel(); });
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('scroll', cancel, { passive: true });
  // 長押しで出る「画像を保存」などのメニューを出さない
  root.addEventListener('contextmenu', e => { if (e.target.closest('.page-card')) e.preventDefault(); });
  root.addEventListener('click', e => {
    const card = e.target.closest('.page-card');
    if (!card) return;
    if (fired) { fired = false; return; } // 長押しの直後のクリックは無視
    const id = Number(card.dataset.id), page = pages.find(p => p.id === id);
    if (!page) return;
    if (selectMode) { toggleSelect(id); return; }
    if (ready(page)) openViewer(id, e.target.closest('.page-snippet') ? 'text' : 'after');
  });
}

$('#select-done').onclick = () => endSelect();
$('#select-all').onclick = () => {
  if (selected.size === pages.length) { endSelect(); return; }
  pages.forEach(p => selected.add(p.id));
  paintSelection();
};

// 選んだページを前後へ動かす（並び順は created で管理する。IDは変えない）
async function moveSelected(delta) {
  const order = [...pages], times = order.map(p => p.created);
  const idx = order.map((_, i) => i);
  if (delta < 0) idx.forEach(i => { if (i > 0 && selected.has(order[i].id) && !selected.has(order[i - 1].id)) [order[i - 1], order[i]] = [order[i], order[i - 1]]; });
  else idx.reverse().forEach(i => { if (i < order.length - 1 && selected.has(order[i].id) && !selected.has(order[i + 1].id)) [order[i + 1], order[i]] = [order[i], order[i + 1]]; });
  for (let i = 0; i < order.length; i++) {
    if (order[i].created === times[i]) continue;
    order[i].created = times[i];
    await db.putPage(order[i]);
  }
  await refresh();
}
$('#sel-up').onclick = () => moveSelected(-1);
$('#sel-down').onclick = () => moveSelected(1);

// 選んだページの補正後の画像を、Claude などほかのアプリに貼る・渡す。
// 1枚ならクリップボードにコピー（貼り付けで使える）。複数ならスマホの共有画面で渡す先のアプリを選ぶ。
// どちらも本人が操作したときだけ、本人が選んだ先に画像が渡る（アプリから勝手に送ることはない）
async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return new Promise(r => c.toBlob(r, 'image/png'));
}
async function copyImage(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
  try {
    // クリップボードに入れられる画像は PNG だけ。変換が終わるのを待つ Promise ごと渡す（押した操作のうちに書き込むため）
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng(blob) })]);
    return true;
  } catch { return false; }
}
$('#sel-copy').onclick = async () => {
  const list = selectedPages().filter(ready);
  if (!list.length) return;
  const base = (currentDoc()?.name || 'scan').replace(/[\\/:*?"<>|]/g, '_');
  const files = list.map((p, i) => {
    const n = pages.indexOf(p) + 1;
    const ext = (p.blob.type || '').includes('png') ? 'png' : 'jpg';
    return new File([p.blob], `${base}-p${n}.${ext}`, { type: p.blob.type || 'image/jpeg' });
  });
  if (list.length === 1 && await copyImage(list[0].blob)) {
    $('#select-count').textContent = 'コピーしました。貼りたい所で長押し→貼り付け';
    setTimeout(showSelection, 3500);
    return;
  }
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); } catch {}
    return;
  }
  alert(list.length > 1
    ? 'このブラウザーでは複数の画像をまとめて渡せません。1枚ずつ選んでコピーしてください。'
    : 'このブラウザーでは画像をコピーできませんでした。');
};

$('#sel-delete').onclick = async () => {
  const list = selectedPages();
  if (!list.length || !confirm(`選んだ ${list.length} ページを削除しますか？（元に戻せません）`)) return;
  for (const p of list) await db.removePage(p.id);
  endSelect();
  await refresh();
};

// 選んだページを順番に「範囲・補正」で直す
let editQueue = [];
$('#sel-edit').onclick = () => {
  editQueue = selectedPages().filter(ready).map(p => p.id);
  openNextEdit();
};
async function openNextEdit() {
  while (editQueue.length) {
    const page = await db.getPage(editQueue.shift());
    if (page && ready(page)) { await openEditor(page, editQueue.length); return; }
  }
}

$('#sel-rotate').onclick = async () => {
  const list = selectedPages().filter(ready);
  await eachInLanes(list, p => reprocess(p, { rotation: ((p.rotation || 0) + 90) % 360, crop: 'auto' }, { quiet: true }), '回転しています');
  await refresh();
  runBackgroundOcr();
};

// ワーカーの数だけ同時に処理する
async function eachInLanes(list, fn, text) {
  let next = 0, done = 0;
  const lane = async () => {
    while (next < list.length) {
      const p = list[next++];
      await fn(p);
      done++;
      if (text) setBusy(`${text}… ${done}/${list.length}`);
    }
  };
  if (text) setBusy(`${text}… 0/${list.length}`);
  try { await Promise.all(Array.from({ length: scanBroken ? 1 : SCAN_POOL }, lane)); }
  finally { showPending(); }
}

// ---------- 取り込み（撮影・写真選択） ----------
// 撮影中も次々に追加できるよう、補正は順番待ちで1枚ずつ行う
// 撮った写真はまず「補正待ち」としてすぐ端末に保存し、順番に補正する。
// 大量に撮ってもメモリに溜めず、アプリを閉じても次回の起動で続きから処理する
let seq = 0;
async function enqueue(blobs, extra = {}) {
  const target = docId, split = mode !== 'screen' && $('#opt-split').checked;
  const halves = split ? ($('#opt-order').value === 'rtl' ? ['right', 'left'] : ['left', 'right']) : [null];
  for (const blob of blobs) {
    if (blob.type && !blob.type.startsWith('image/')) continue;
    const created = Date.now() + (seq++ % 1000) / 1000;
    for (let i = 0; i < halves.length; i++) {
      await db.addPage({
        original: blob, ...defaultsFor(mode), half: halves[i], wantOcr: prefs.get('autoOcr', false),
        mode, docId: target, created: created + i / 2000, waiting: true,
        capture: created, autoRotate: mode !== 'screen', tilt: extra.tilt ?? null,
      });
    }
    pending++;
    showPending();
  }
  scheduleRefresh();
  processWaiting();
}

// 元写真を保存用の大きさにする（同じ写真から作る左右のページで1回だけ）
const sizedCache = new Map();
function sizedOriginal(p) {
  if (p.capture == null) return limitOriginal(p.original);
  if (!sizedCache.has(p.capture)) {
    sizedCache.set(p.capture, limitOriginal(p.original).catch(e => { sizedCache.delete(p.capture); throw e; }));
    if (sizedCache.size > 20) sizedCache.delete(sizedCache.keys().next().value);
  }
  return sizedCache.get(p.capture);
}
// 補正の下準備: 元写真の大きさ・向き・文字の行（どれも撮影ごとに1回だけ求め、結果を覚えておく）
async function preparePage(p) {
  // 向きの判定と文字の行の検出は、保存用の大きさにする前の写真からすぐに始める（行の位置は割合なので
  // 大きさによらない）。縮小はその間に別に進める
  const raw = p.original, turn = p.autoRotate ? decideRotation(p, raw) : null, sized = p.sized ? null : sizedOriginal(p);
  if (turn) { p.rotation = await turn; p.autoRotate = false; }
  const lines = ensureLines(p, raw);
  if (sized) { p.original = await sized; p.sized = true; }
  await lines;
}

let working = false;
async function processOne(p, ready = preparePage(p), run = () => processImage(p.original, optionsOf(p))) {
  try {
    await ready;
    // 見開きの順番: 横書きの本は左ページから、縦書きの本は右ページから（文字の向きで自動で決める）
    if (p.half && p.capture != null && p.lines) {
      const v = linesVertical(p.lines);
      if (v !== null) p.created = p.capture + ((p.half === 'left') === !v ? 0 : 1) / 2000;
    }
    Object.assign(p, await run());
  } catch (e) {
    console.error(e);
    p.failed = true;
  }
  p.waiting = false;
  // 処理中に削除されたページは保存し直さない
  if (await db.getPage(p.id)) await db.putPage(p);
  scheduleRefresh();
}
async function processWaiting() {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const waiting = (await db.allPages()).filter(p => p.waiting);
      pending = waiting.length;
      showPending();
      if (!waiting.length) break;
      // 撮った順に、ワーカーの数だけ同時に補正する
      // 見開きの左右のページ（同じ写真）は、共通の処理を1回にするため2枚まとめて補正する
      const head = waiting[0], mate = head.half && head.capture != null && waiting.find(p => p !== head && p.capture === head.capture && p.half && p.half !== head.half);
      const batch = mate ? [head, mate] : waiting.slice(0, scanBroken ? 1 : SCAN_POOL), ready = batch.map(p => preparePage(p));
      // 今の写真の下準備が済んだら、補正している間に次の写真の下準備（向き・文字の行の検出）を始めておく。
      // 文字の検出は補正とは別のスレッドで動くので、その分だけ待ち時間が減る
      const next = waiting.find(p => !batch.some(b => b.id === p.id || (b.capture != null && b.capture === p.capture)));
      if (next) Promise.allSettled(ready).then(() => preparePage({ ...next })).catch(e => console.error(e));
      if (mate) {
        let jobs = null;
        const both = Promise.all(ready);
        const run = i => async () => {
          await both;
          const [a, b] = batch.map(optionsOf);
          // 設定が左右で違う（half 以外）ときは、別々に補正する
          if (JSON.stringify({ ...a, half: 0 }) !== JSON.stringify({ ...b, half: 0 })) return processImage(batch[i].original, [a, b][i]);
          jobs = jobs || processSpread(batch[0].original, a, b);
          return jobs[i];
        };
        await Promise.all(batch.map((p, i) => processOne(p, ready[i], run(i))));
      } else await Promise.all(batch.map((p, i) => processOne(p, ready[i])));
    }
  } finally {
    working = false;
    pending = 0;
    showPending();
    scheduleRefresh();
    runBackgroundOcr();
  }
}

$('#camera-input').addEventListener('change', e => { enqueue([...e.target.files]); e.target.value = ''; });
$('#file-input').addEventListener('change', e => { enqueue([...e.target.files]); e.target.value = ''; });

function applyMode() {
  document.querySelectorAll('.mode').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
  $('#mode-title').textContent = MODE_TEXT[mode].title;
  $('#mode-help').textContent = MODE_TEXT[mode].help;
  $('#spread-options').hidden = mode === 'screen';
}
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; prefs.set('mode', mode); applyMode(); }));
$('#opt-split').checked = prefs.get('split', false);
$('#opt-order').value = prefs.get('order', 'rtl');
$('#opt-split').onchange = e => prefs.set('split', e.target.checked);
$('#opt-order').onchange = e => prefs.set('order', e.target.value);

// ---------- 連続撮影 ----------
const camera = createCamera({
  dialog: $('#camera-dialog'), video: $('#camera-video'), status: $('#camera-status'),
  shutter: $('#camera-shutter'), autoToggle: $('#camera-auto'), counter: $('#camera-count'),
  onCapture: (blob, info) => enqueue([blob], info),
  paused: () => $('#dest-dialog').open,
  guide: $('#camera-guide'), torch: $('#camera-torch'),
  subject: () => (mode === 'screen' ? 'screen' : 'paper'),
  split: () => mode !== 'screen' && $('#opt-split').checked,
});
$('#camera-auto').checked = prefs.get('autoShutter', true);
$('#camera-auto').addEventListener('change', e => prefs.set('autoShutter', e.target.checked));
// 撮影中でも見開き（2ページ同時）に切り替えられるボタン。今のモードも表示して取り違えを防ぐ
function syncCameraBar() {
  $('#camera-mode').textContent = { book: '本', document: '書類', screen: '画面' }[mode];
  $('#camera-pages').hidden = mode === 'screen';
  $('#camera-dest-name').textContent = destLabel(currentDoc());
  const two = $('#opt-split').checked;
  document.querySelectorAll('#camera-pages button').forEach(b => b.setAttribute('aria-checked', String((b.dataset.pages === '2') === two)));
  // 見開き（2ページ）のときは、右手の親指で押せるようにシャッターを画面の右側に置く
  $('#camera-dialog').classList.toggle('one-hand', mode !== 'screen' && two);
}
// 撮影中でも「1ページ」「2ページ（見開き）」をいつでも切り替えられる
document.querySelectorAll('#camera-pages button').forEach(b => b.onclick = () => {
  const on = b.dataset.pages === '2';
  $('#opt-split').checked = on;
  prefs.set('split', on);
  syncCameraBar();
  $('#camera-status').textContent = on ? '本の綴じ目（のど）を中央の点線に合わせてください。左右2ページに分けて保存します' : '1ページずつ保存します';
  camera.redraw();
});
$('#camera-button').onclick = () => {
  if (!navigator.mediaDevices?.getUserMedia) { $('#camera-input').click(); return; }
  syncCameraBar();
  camera.open();
  if (mode !== 'screen') warmUp(); // 撮影を始める前にOCRの準備をしておく（向きの判定・文字の行の検出に使う）
};
$('#camera-dest').onclick = () => openDest('camera');

// ---------- 範囲・補正の調整画面 ----------
let edit = null;
const editCanvas = $('#edit-canvas');

async function openEditor(page, remaining = 0) {
  const index = pages.findIndex(x => x.id === page.id);
  $('#edit-title').textContent = '範囲と補正' + (index >= 0 ? `（${index + 1}ページ目）` : '');
  $('#edit-apply').textContent = remaining ? `この設定で補正して次へ（残り ${remaining}）` : 'この設定で補正';
  const bitmap = await decode(page.original || page.blob);
  const corners = Array.isArray(page.crop) ? page.crop : page.crop === 'auto' ? (page.corners || FULL_FRAME) : FULL_FRAME;
  edit = { page, bitmap, rotation: page.rotation || 0, corners: corners.map(c => [...c]), drag: -1 };
  $('#opt-deskew').checked = !!page.deskew;
  $('#opt-fingers').checked = !!page.fingers;
  $('#opt-denoise').checked = page.denoise !== false;
  $('#opt-even').checked = page.evenColor !== false;
  $('#opt-moire').checked = !!page.moire;
  $('#opt-half').value = page.half || '';
  const sel = $('#opt-filter');
  sel.replaceChildren(...Object.entries(FILTERS).map(([v, t]) => new Option(t, v, false, v === (page.filter || 'none'))));
  renderEditBase();
  $('#edit-dialog').showModal();
}

function renderEditBase() {
  edit.base = drawRotated(edit.bitmap, edit.rotation, 1200);
  editCanvas.width = edit.base.width;
  editCanvas.height = edit.base.height;
  drawEditor();
}

function drawEditor() {
  const c = editCanvas.getContext('2d'), W = editCanvas.width, H = editCanvas.height;
  const q = edit.corners.map(([x, y]) => [x * W, y * H]);
  c.drawImage(edit.base, 0, 0);
  c.save();
  c.beginPath(); c.rect(0, 0, W, H);
  c.moveTo(...q[0]); q.slice(1).forEach(p => c.lineTo(...p)); c.closePath();
  c.fillStyle = 'rgba(10,20,16,.55)'; c.fill('evenodd');
  c.beginPath(); c.moveTo(...q[0]); q.slice(1).forEach(p => c.lineTo(...p)); c.closePath();
  c.lineWidth = Math.max(2, W / 250); c.strokeStyle = '#b8ed71'; c.stroke();
  const r = Math.max(10, Math.min(W, H) / 28);
  q.forEach(([x, y], i) => {
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = i === edit.drag ? '#b8ed71' : 'rgba(184,237,113,.35)'; c.fill();
    c.lineWidth = Math.max(2, W / 300); c.strokeStyle = '#fff'; c.stroke();
  });
  c.restore();
}

function canvasPoint(e) {
  const rect = editCanvas.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))];
}
editCanvas.addEventListener('pointerdown', e => {
  if (!edit) return;
  const [x, y] = canvasPoint(e), rect = editCanvas.getBoundingClientRect();
  let best = -1, bestD = Infinity;
  edit.corners.forEach(([cx, cy], i) => {
    const d = Math.hypot((cx - x) * rect.width, (cy - y) * rect.height);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (bestD > 60) return;
  edit.drag = best;
  editCanvas.setPointerCapture(e.pointerId);
  drawEditor();
});
editCanvas.addEventListener('pointermove', e => {
  if (!edit || edit.drag < 0) return;
  edit.corners[edit.drag] = canvasPoint(e);
  drawEditor();
});
const endDrag = () => { if (edit && edit.drag >= 0) { edit.drag = -1; drawEditor(); } };
editCanvas.addEventListener('pointerup', endDrag);
editCanvas.addEventListener('pointercancel', endDrag);

$('#edit-rotate').onclick = () => {
  edit.rotation = (edit.rotation + 270) % 360;
  edit.base = drawRotated(edit.bitmap, edit.rotation, 1200);
  edit.corners = detectPage(edit.base, optionsOf(edit.page).subject) || FULL_FRAME;
  renderEditBase();
};
$('#edit-auto').onclick = () => { edit.corners = detectPage(edit.base, optionsOf(edit.page).subject) || FULL_FRAME; drawEditor(); };
$('#edit-full').onclick = () => { edit.corners = FULL_FRAME.map(c => [...c]); drawEditor(); };
$('#edit-apply').onclick = async () => {
  const { page, rotation, corners, bitmap } = edit;
  const change = {
    rotation, half: $('#opt-half').value || null,
    deskew: $('#opt-deskew').checked, fingers: $('#opt-fingers').checked, denoise: $('#opt-denoise').checked,
    evenColor: $('#opt-even').checked, moire: $('#opt-moire').checked, filter: $('#opt-filter').value,
  };
  $('#edit-dialog').close();
  bitmap.close?.();
  edit = null;
  const full = corners.every((c, i) => Math.abs(c[0] - FULL_FRAME[i][0]) < 0.002 && Math.abs(c[1] - FULL_FRAME[i][1]) < 0.002);
  change.crop = full ? 'none' : corners;
  // 補正は裏で進め、選んだページが残っていればすぐ次のページを開く
  editJobs.push(reprocess(page, change, { quiet: true }).catch(e => console.error(e)));
  await openNextEdit();
  if (!$('#edit-dialog').open) finishEdits();
};
let editJobs = [];
async function finishEdits() {
  if (!editJobs.length) return;
  const jobs = editJobs;
  editJobs = [];
  await Promise.all(jobs);
  showPending();
  await refresh();
  runBackgroundOcr();
}
// ×や「戻る」で閉じたときは、残りのページの編集をやめる
$('#edit-dialog .close').addEventListener('click', () => { editQueue = []; });
$('#edit-dialog').addEventListener('cancel', () => { editQueue = []; });
$('#edit-dialog').addEventListener('close', () => {
  if (edit) { edit.bitmap.close?.(); edit = null; }
  if (!editQueue.length) setTimeout(() => { if (!$('#edit-dialog').open) finishEdits(); }, 0);
});

// ---------- まとめて設定 ----------
document.querySelectorAll('select.tri').forEach(sel => {
  sel.replaceChildren(new Option('そのまま', ''), new Option('する', '1'), new Option('しない', '0'));
});
// targets: null なら文書の全ページ、配列なら選んだページだけ
let batchTargets = null;
function openBatch(targets) {
  batchTargets = targets;
  document.querySelectorAll('#batch-dialog select').forEach(sel => { sel.value = ''; });
  $('#batch-apply').disabled = false;
  $('#batch-title').textContent = targets ? '選んだページの設定' : 'まとめて設定';
  $('#batch-note').textContent = targets
    ? `選んだ ${targets.length} ページに同じ設定をかけます。「そのまま」の項目は変えません。`
    : 'この文書の全ページに同じ設定をかけます。次から撮るページにも使います。「そのまま」の項目は変えません。';
  $('#batch-apply').textContent = targets ? `選んだ ${targets.length} ページに適用` : '全ページに適用';
  $('#batch-dialog').showModal();
}
$('#batch-button').onclick = () => openBatch(null);
$('#sel-settings').onclick = () => openBatch(selectedPages().filter(ready));
$('#batch-apply').onclick = async () => {
  const tri = id => ({ '': undefined, '1': true, '0': false })[$(id).value];
  const change = {};
  if ($('#batch-filter').value) change.filter = $('#batch-filter').value;
  for (const [id, key] of [['#batch-even', 'evenColor'], ['#batch-deskew', 'deskew'], ['#batch-denoise', 'denoise'], ['#batch-fingers', 'fingers'], ['#batch-moire', 'moire']]) {
    const v = tri(id); if (v !== undefined) change[key] = v;
  }
  const crop = tri('#batch-crop');
  if (crop !== undefined) change.crop = crop ? 'auto' : 'none';
  const ocr = tri('#batch-ocr');
  if (!batchTargets) {
    // 全ページに適用したときは、次から撮るページにも同じ設定を使う
    const key = mode === 'screen' ? 'defaults.screen' : 'defaults';
    prefs.set(key, { ...prefs.get(key, {}), ...change });
    if (ocr !== undefined) prefs.set('autoOcr', ocr);
  }
  const btn = $('#batch-apply');
  btn.disabled = true;
  const needImage = Object.keys(change).length > 0;
  const list = batchTargets || pages.filter(ready);
  let done = 0;
  if (needImage) btn.textContent = `補正しています… 0/${list.length}`;
  await eachInLanes(list, async p => {
    if (ocr !== undefined) p.wantOcr = ocr;
    if (needImage) await reprocess(p, change, { quiet: true });
    else await db.putPage(p);
    if (needImage) btn.textContent = `補正しています… ${++done}/${list.length}`;
  });
  $('#batch-dialog').close();
  await refresh();
  runBackgroundOcr();
};

// ---------- 裏で進めるOCR ----------
let ocrRunning = false;
async function runBackgroundOcr() {
  if (ocrRunning || pending) return;
  ocrRunning = true;
  try {
    for (;;) {
      const todo = (await db.allPages()).filter(p => ready(p) && p.wantOcr && !(p.ocr && p.ocr.width === p.width));
      if (!todo.length || pending) break;
      setBusy(`文字認識を裏で進めています…（残り ${todo.length} ページ）`);
      // ワーカーの数だけ並行して処理する
      await Promise.all(todo.slice(0, 2).map(p => ocrPage(p, () => {}).catch(async e => { console.error(e); const f = await db.getPage(p.id); if (f) { f.wantOcr = false; await db.putPage(f); } })));
      await refresh();
    }
  } finally {
    ocrRunning = false;
    showPending();
  }
}

// ---------- OCR ----------
// 結果はページに保存して、PDFの文字検索にも使い回す
async function ocrPage(page, onProgress) {
  if (page.ocr && page.ocr.width === page.width) return page.ocr;
  const rev = page.rev || 0;
  const r = await recognize(page.blob, onProgress);
  const ocr = { text: r.text, lines: r.lines, width: page.width, height: page.height };
  page.ocr = ocr;
  // 認識中にページが補正し直されていたら保存しない（最新の内容を上書きしないため）
  const fresh = await db.getPage(page.id);
  if (fresh && (fresh.rev || 0) === rev) { fresh.ocr = ocr; await db.putPage(fresh); }
  return ocr;
}

// ---------- ページの確認（補正後・元の写真・OCRの文字） ----------
const viewer = { id: null, tab: 'after', url: null, job: 0 };
const readyPages = () => pages.filter(ready);

function openViewer(id, tab) {
  viewer.id = id;
  $('#view-dialog').showModal();
  showViewer(tab);
}

async function showViewer(tab = viewer.tab) {
  viewer.tab = tab;
  const list = readyPages(), index = list.findIndex(p => p.id === viewer.id);
  if (index < 0) { $('#view-dialog').close(); return; }
  const page = await db.getPage(viewer.id) || list[index];
  const job = ++viewer.job;
  $('#view-title').textContent = `${index + 1} / ${list.length}`;
  $('#view-prev').disabled = index === 0;
  $('#view-next').disabled = index === list.length - 1;
  for (const b of document.querySelectorAll('.view-tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  const text = tab === 'text';
  $('#view-image').hidden = text; $('#view-hint').hidden = text; $('#view-text').hidden = !text;
  if (!text) {
    if (viewer.url) URL.revokeObjectURL(viewer.url);
    viewer.url = URL.createObjectURL(tab === 'before' ? (page.original || page.blob) : page.blob);
    $('#view-img').src = viewer.url;
    $('#view-img').alt = tab === 'before' ? '元の写真' : '補正後の画像';
    $('#view-image').classList.remove('zoom');
    return;
  }
  const has = page.ocr && page.ocr.width === page.width;
  $('#ocr-result').value = has ? page.ocr.text : '';
  $('#ocr-save').disabled = true;
  $('#ocr-run').textContent = has ? '読み直す' : '読み取る';
  $('#ocr-status').textContent = has ? (page.ocr.edited ? '修正済みの文字です' : '認識した文字です') : 'まだ文字を読み取っていません。';
  if (!has) runViewerOcr(page, job);
}

async function runViewerOcr(page, job, force = false) {
  const status = $('#ocr-status');
  status.textContent = '文字を読み取っています（端末内で処理します）…';
  try {
    if (force) delete page.ocr;
    const r = await ocrPage(page, p => { if (job === viewer.job) status.textContent = `文字を読み取っています… ${Math.round(p * 100)}%`; });
    if (job !== viewer.job) return;
    $('#ocr-result').value = r.text;
    $('#ocr-run').textContent = '読み直す';
    $('#ocr-save').disabled = true;
    status.textContent = '読み取りました。誤りは書き換えて保存できます。';
    scheduleRefresh();
  } catch (e) {
    console.error(e);
    if (job === viewer.job) status.textContent = '文字を読み取れませんでした。';
  }
}

async function stepViewer(d) {
  const list = readyPages(), index = list.findIndex(p => p.id === viewer.id);
  const next = list[index + d];
  if (next) { viewer.id = next.id; await showViewer(); }
}

$('#view-prev').onclick = () => stepViewer(-1);
$('#view-next').onclick = () => stepViewer(1);
for (const b of document.querySelectorAll('.view-tabs button')) b.onclick = () => showViewer(b.dataset.tab);
$('#view-image').ondblclick = () => $('#view-image').classList.toggle('zoom');
// 左右にスワイプしてページを移る（拡大中は除く）
{
  let sx = null, sy = 0;
  const area = $('#view-image');
  area.addEventListener('touchstart', e => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } else sx = null; }, { passive: true });
  area.addEventListener('touchend', e => {
    if (sx === null || area.classList.contains('zoom') || (window.visualViewport && visualViewport.scale > 1.05)) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepViewer(dx < 0 ? 1 : -1);
  }, { passive: true });
}
$('#view-dialog').addEventListener('close', () => { viewer.job++; if (viewer.url) { URL.revokeObjectURL(viewer.url); viewer.url = null; } $('#view-img').removeAttribute('src'); });
$('#view-edit').onclick = async () => {
  const page = await db.getPage(viewer.id);
  $('#view-dialog').close();
  if (page) openEditor(page);
};
$('#ocr-run').onclick = async () => { const page = await db.getPage(viewer.id); if (page) runViewerOcr(page, viewer.job, true); };
$('#ocr-result').addEventListener('input', () => { $('#ocr-save').disabled = false; });
$('#ocr-save').onclick = async () => {
  const page = await db.getPage(viewer.id);
  if (!page || !page.ocr) return;
  const text = $('#ocr-result').value;
  const rows = text.split('\n');
  // 行の数が同じなら、各行の位置はそのままに文字だけ差し替える（PDFの検索文字にも反映）
  if (rows.length === page.ocr.lines.length) page.ocr.lines = page.ocr.lines.map((l, i) => ({ ...l, text: rows[i].trim() }));
  page.ocr = { ...page.ocr, text, edited: true };
  await db.putPage(page);
  $('#ocr-save').disabled = true;
  $('#ocr-status').textContent = rows.length === page.ocr.lines.length ? '保存しました（PDFの文字検索にも使います）' : '保存しました（行の数が変わったため、PDFの文字検索は元の認識結果を使います）';
};
$('#ocr-copy').onclick = () => navigator.clipboard?.writeText($('#ocr-result').value).catch(() => {});

// ---------- 文字で探す ----------
{
  let t = null;
  $('#search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 250); });
}

// ---------- 文字の書き出し（文書全体のOCR結果を .txt で保存） ----------
$('#text-export').onclick = async () => {
  const btn = $('#text-export'), list = pages.filter(ready);
  if (!list.length) return;
  btn.disabled = true;
  try {
    let done = 0;
    const out = [];
    for (const p of list) {
      setBusy(`文字を読み取っています… ${done + 1}/${list.length}`);
      const r = await ocrPage(p, () => {});
      out.push(`--- ${++done}ページ ---\n${r.text.trim()}`);
    }
    setBusy('');
    const doc = currentDoc();
    const name = `${cleanName(doc.name) || 'scan'}.txt`;
    const blob = new Blob([out.join('\n\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const file = new File([blob], name, { type: 'text/plain' });
    // 共有できる端末では共有シート、そうでなければダウンロード
    if (navigator.canShare && navigator.canShare({ files: [file] }) && confirm('文字を書き出しました。他のアプリに渡しますか？（キャンセルでスマホに保存）')) {
      await navigator.share({ files: [file], title: name }).catch(() => {});
    } else {
      const a = document.createElement('a'), url = URL.createObjectURL(blob);
      a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    scheduleRefresh();
  } catch (e) {
    console.error(e);
    setBusy('文字を書き出せませんでした。');
  } finally { btn.disabled = false; }
};

// ---------- 撮り直し・回転（確認画面から） ----------
$('#view-retake').onclick = () => $('#retake-input').click();
$('#retake-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  const page = file && await db.getPage(viewer.id);
  if (!page) return;
  $('#view-dialog').close();
  page.original = await limitOriginal(file);
  page.sized = true;
  page.crop = 'auto';
  await reprocess(page, {});
  openViewer(page.id, 'after');
});
$('#view-rotate').onclick = async () => {
  const page = await db.getPage(viewer.id);
  if (!page) return;
  await reprocess(page, { rotation: ((page.rotation || 0) + 90) % 360, crop: 'auto' });
  showViewer('after');
};

// ---------- PDF ----------
let pdfUrl = null;
// ファイル名に使えない文字を除く
const cleanName = t => t.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

// 1ページ目の題名らしい行（上の方にある、いちばん大きな文字の行）を探す
async function guessTitle(page) {
  let lines, H;
  if (page.ocr && page.ocr.width === page.width) { lines = page.ocr.lines; H = page.height; }
  else {
    const top = await cropTop(page.blob, 0.4);
    lines = (await recognize(top.blob)).lines;
    H = top.height;
  }
  let best = null, bestScore = 0;
  for (const l of lines) {
    const text = cleanName(l.text);
    const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    if (letters < 2 || l.bbox.y0 > H * 0.4) continue;
    const h = l.bbox.y1 - l.bbox.y0;
    const score = h * (1 - (l.bbox.y0 / H) * 0.8) * Math.min(1, letters / 4);
    if (score > bestScore) { bestScore = score; best = text; }
  }
  return best;
}

let nameEdited = false, titleJob = 0;
$('#pdf-name').addEventListener('input', () => { nameEdited = true; $('#pdf-name-note').textContent = ''; });

$('#pdf-button').onclick = () => {
  const usable = pages.filter(ready);
  if (!usable.length) return;
  const doc = currentDoc();
  nameEdited = false;
  $('#pdf-name').value = doc.name;
  $('#pdf-name-note').textContent = '1ページ目の題名を読み取っています…';
  const job = ++titleJob;
  guessTitle(usable[0]).then(title => {
    if (job !== titleJob || nameEdited) return;
    if (title) { $('#pdf-name').value = title; $('#pdf-name-note').textContent = '1ページ目の題名から付けました。自由に変えられます。'; }
    else $('#pdf-name-note').textContent = '題名を読み取れなかったので、文書名にしました。';
  }).catch(() => { if (job === titleJob) $('#pdf-name-note').textContent = ''; });
  const q = prefs.get('quality', 'high');
  document.querySelectorAll('input[name=quality]').forEach(r => { r.checked = r.value === q; });
  $('#pdf-ocr').checked = prefs.get('searchable', false);
  $('#pdf-setup').hidden = false;
  $('#pdf-result').hidden = true;
  $('#pdf-make').disabled = false;
  $('#pdf-make').textContent = '作成する';
  const ocrDone = usable.filter(p => p.ocr && p.ocr.width === p.width).length;
  $('#pdf-ocr-note').textContent = ocrDone === usable.length ? '全ページの文字認識が済んでいます' : `未処理の ${usable.length - ocrDone} ページを端末内でOCRします（並行処理）`;
  showSaveTarget();
  $('#pdf-dialog').showModal();
};

$('#pdf-make').onclick = async () => {
  const quality = document.querySelector('input[name=quality]:checked').value;
  const searchable = $('#pdf-ocr').checked;
  prefs.set('quality', quality); prefs.set('searchable', searchable);
  const btn = $('#pdf-make');
  btn.disabled = true;
  const t0 = performance.now();
  try {
    titleJob++; // 題名の読み取りが後から名前を書き換えないように
    const list = pages.filter(ready);
    // 1) OCR（済んでいるページは保存済みの結果を使う。残りは並行処理）
    if (searchable) {
      let done = list.filter(p => p.ocr && p.ocr.width === p.width).length;
      btn.textContent = `文字を認識しています… ${done}/${list.length}`;
      await Promise.all(list.map(async p => {
        if (p.ocr && p.ocr.width === p.width) return;
        p.wantOcr = true;
        try { await ocrPage(p, () => {}); } catch (e) { console.error(e); }
        btn.textContent = `文字を認識しています… ${++done}/${list.length}`;
      }));
    }
    // 2) 画質に合わせて縮小（3枚ずつ並行）
    const { side, q } = QUALITY[quality];
    const images = new Array(list.length);
    let next = 0, made = 0;
    await Promise.all([0, 1, 2].map(async () => {
      while (next < list.length) {
        const i = next++, p = list[i];
        images[i] = quality === 'high' ? { blob: p.blob, width: p.width, height: p.height } : await recompress(p.blob, side, q);
        btn.textContent = `PDFを作成しています… ${++made}/${list.length}`;
      }
    }));
    const doc = currentDoc();
    const title = cleanName($('#pdf-name').value.replace(/\.pdf$/i, '')) || doc.name;
    // 文書名が自動の名前のままなら、PDFの名前に合わせる
    if (/^スキャン \d/.test(doc.name) && title !== doc.name) { doc.name = title; await db.putDoc(doc); }
    const blob = await buildPdf(images.map((img, i) => ({ ...img, ocr: searchable ? list[i].ocr : null })), title);
    const name = `${title}.pdf`;
    console.log('pdf ms', Math.round(performance.now() - t0));
    await showPdfResult(blob, name, searchable);
    await refresh();
  } catch (e) {
    console.error(e);
    alert('PDFを作成できませんでした');
    btn.disabled = false;
    btn.textContent = '作成する';
  }
};

let lastPdf = null;
async function showPdfResult(blob, name, searchable) {
  lastPdf = { blob, name };
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(blob);
  const link = $('#pdf-download');
  link.href = pdfUrl;
  link.download = name;
  $('#pdf-info').textContent = `${name}　${pages.filter(ready).length}ページ・${(blob.size / 1024 / 1024).toFixed(1)}MB` + (searchable ? '・文字検索できます' : '');
  const folder = await save.getFolder();
  $('#pdf-save-folder').hidden = !folder;
  $('#pdf-save-folder').textContent = folder ? `「${folder.name}」に保存` : '';
  link.className = folder ? 'text-button link-button' : 'dark-button link-button';
  link.textContent = folder ? 'ダウンロードフォルダに保存' : 'スマホに保存';
  $('#pdf-save-as').hidden = !save.canPickFile;
  $('#pdf-saved').hidden = true;
  const file = new File([blob], name, { type: 'application/pdf' });
  const share = $('#pdf-share');
  share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  share.onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
  $('#pdf-setup').hidden = true;
  $('#pdf-result').hidden = false;
}
const saved = text => { const el = $('#pdf-saved'); el.textContent = text; el.hidden = false; };
$('#pdf-save-folder').onclick = async () => {
  try { saved(`「${await save.saveToFolder(lastPdf.blob, lastPdf.name)}」を保存しました`); }
  catch (e) { console.error(e); saved('保存できませんでした。フォルダを選び直してください。'); }
};
$('#pdf-save-as').onclick = async () => {
  try { saved(`「${await save.saveAs(lastPdf.blob, lastPdf.name)}」を保存しました`); }
  catch (e) { if (e.name !== 'AbortError') saved('保存できませんでした。'); }
};

// 保存先の設定
async function showSaveTarget() {
  const folder = await save.getFolder();
  $('#save-target-name').textContent = folder ? `フォルダ「${folder.name}」` : 'ダウンロード（標準）';
  $('#save-folder-buttons').hidden = !save.canPickFolder;
  $('#save-reset').hidden = !folder;
  $('#save-android-note').hidden = save.canPickFolder;
}
$('#save-choose').onclick = async () => {
  try { await save.chooseFolder(); } catch (e) { if (e.name !== 'AbortError') alert('フォルダを選べませんでした'); }
  await showSaveTarget();
};
$('#save-reset').onclick = async () => { await save.clearFolder(); await showSaveTarget(); };

// ---------- 起動 ----------
async function start() {
  applyMode();
  await loadDocs();
  // 以前のバージョンのページ: 文書に入れ、サイズ情報がなければ補正なしで変換する
  for (const p of await db.allPages()) {
    if (p.docId && p.width) continue;
    try {
      if (!p.docId) p.docId = docId;
      if (!p.width) {
        p.original = p.blob;
        Object.assign(p, { rotation: 0, filter: 'none', crop: 'none', deskew: false, fingers: false, denoise: false });
        Object.assign(p, await processImage(p.original, optionsOf(p)));
      }
      await db.putPage(p);
    } catch {}
  }
  await refresh();
  processWaiting(); // 前回の続き（補正待ちのページ）があれば処理する
  runBackgroundOcr();
  // ブラウザーが空き容量不足でデータを消さないよう永続化を依頼
  navigator.storage?.persist?.().catch(() => {});
}
start();
// 新しい版が届いたら自動で読み込み直す（古い版のまま動き続けないように）
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return; // 初回インストール時は読み込み直さない
    reloaded = true;
    // 撮影中や確認画面を開いている間は待ってから読み込み直す
    const go = () => { if (document.querySelector('dialog[open]')) setTimeout(go, 1500); else location.reload(); };
    go();
  });
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.update().catch(() => {});
    // アプリに戻ってきたときも更新を確認する
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
