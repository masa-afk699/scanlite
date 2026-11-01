// ScanLite: すべての処理をブラウザー内で行う。撮影画像・PDF・OCR結果はネットワークに送らない。
import { processImage, decode, drawRotated, detectPage, FULL_FRAME, recompress } from './scan.js';
import * as db from './db.js';
import { buildPdf } from './pdf.js';
import { recognize } from './ocr.js';
import { createCamera } from './camera.js';
import * as save from './save.js';

// 新しく取り込んだページの標準設定
const DEFAULTS = { rotation: 0, filter: 'color', crop: 'auto', half: null, deskew: true, fingers: true, denoise: true, evenColor: true };
const FILTERS = { color: 'カラー', gray: 'グレースケール', bw: '白黒', none: '補正なし' };
const QUALITY = { high: { side: 2400, q: 0.86 }, normal: { side: 1600, q: 0.75 }, small: { side: 1100, q: 0.6 } };
const MODE_TEXT = {
  book: { title: '本をスキャン', help: 'ページをめくって手を止めると、自動で撮影します。' },
  document: { title: '書類をスキャン', help: '紙を置き換えて手を止めると、自動で撮影します。' },
};

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

// ---------- 文書 ----------
async function loadDocs() {
  docs = await db.allDocs();
  if (!docs.length) {
    await db.addDoc({ name: defaultDocName(), created: Date.now() });
    docs = await db.allDocs();
  }
  if (!docs.some(d => d.id === docId)) docId = prefs.get('doc', null);
  if (!docs.some(d => d.id === docId)) docId = docs[docs.length - 1].id;
  prefs.set('doc', docId);
  const sel = $('#doc-select');
  sel.replaceChildren(...docs.map(d => new Option(d.name, d.id, false, d.id === docId)));
}
const currentDoc = () => docs.find(d => d.id === docId);
function defaultDocName() {
  const d = new Date();
  return `スキャン ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

$('#doc-select').onchange = async e => { docId = Number(e.target.value); prefs.set('doc', docId); await refresh(); };
$('#doc-new').onclick = async () => {
  const name = prompt('新しい文書の名前', defaultDocName());
  if (name === null) return;
  docId = await db.addDoc({ name: name.trim() || defaultDocName(), created: Date.now() });
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
$('#doc-delete').onclick = async () => {
  const doc = currentDoc();
  if (!confirm(`「${doc.name}」とそのページ（${pages.length}枚）を削除しますか？`)) return;
  await db.removeDoc(doc.id);
  docId = null;
  await refresh();
};

// ---------- ページ一覧 ----------
async function refresh() {
  await loadDocs();
  pages = await db.pagesOf(docId);
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = [];
  $('#count').textContent = `${pages.length} ページ`;
  $('#pdf-button').disabled = !pages.length;
  $('#batch-button').disabled = !pages.length;
  const root = $('#pages');
  root.replaceChildren();
  pages.forEach((p, index) => {
    const card = document.createElement('article');
    card.className = 'page-card';
    const img = document.createElement('img');
    const url = URL.createObjectURL(p.blob);
    thumbUrls.push(url);
    img.src = url;
    img.alt = `${index + 1}ページ目`;
    const meta = document.createElement('div');
    meta.className = 'page-meta';
    const label = document.createElement('span');
    label.textContent = `${index + 1}` + (p.half ? (p.half === 'right' ? '　右' : '　左') : '') + (p.ocr ? '　文字✓' : '');
    const select = document.createElement('select');
    select.setAttribute('aria-label', '補正');
    for (const [value, text] of Object.entries(FILTERS)) select.add(new Option(text, value, false, value === (p.filter || 'none')));
    select.onchange = () => reprocess(p, { filter: select.value });
    meta.append(label, select);
    const tools = document.createElement('div');
    tools.className = 'page-tools';
    const button = (text, fn, cls) => { const b = document.createElement('button'); b.textContent = text; b.onclick = fn; if (cls) b.className = cls; return b; };
    tools.append(
      button('範囲・補正', () => openEditor(p)),
      button('◀ 前へ', () => move(index, -1)),
      button('OCR', () => showOcr(p)),
      button('削除', async () => { await db.removePage(p.id); await refresh(); }, 'danger'),
    );
    card.append(img, meta, tools);
    root.append(card);
  });
}

const optionsOf = p => ({
  rotation: p.rotation || 0, filter: p.filter || 'none', crop: p.crop || 'none', half: p.half || null,
  deskew: !!p.deskew, fingers: !!p.fingers, denoise: p.denoise !== false, evenColor: p.evenColor !== false,
});

async function reprocess(page, change, { quiet = false } = {}) {
  if (!page.original) page.original = page.blob;
  Object.assign(page, change);
  setBusy('画像を補正しています…');
  try {
    Object.assign(page, await processImage(page.original, optionsOf(page)));
    page.rev = (page.rev || 0) + 1;
    delete page.ocr; // 画像が変わったのでOCR結果は作り直す
    await db.putPage(page);
  } finally { if (!quiet) showPending(); }
  if (!quiet) { await refresh(); runBackgroundOcr(); }
}

// 並び順は created で管理する（IDは変えない）
async function move(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= pages.length) return;
  const a = pages[index], b = pages[j];
  [a.created, b.created] = [b.created, a.created];
  await db.putPage(a); await db.putPage(b);
  await refresh();
}

// ---------- 取り込み（撮影・写真選択） ----------
// 撮影中も次々に追加できるよう、補正は順番待ちで1枚ずつ行う
let queue = Promise.resolve();
function enqueue(blobs) {
  const target = docId, split = mode === 'book' && $('#opt-split').checked;
  const halves = split ? ($('#opt-order').value === 'rtl' ? ['right', 'left'] : ['left', 'right']) : [null];
  for (const blob of blobs) {
    if (blob.type && !blob.type.startsWith('image/')) continue;
    pending++;
    showPending();
    const created = Date.now();
    queue = queue.then(async () => {
      try {
        for (let i = 0; i < halves.length; i++) {
          const opts = { ...DEFAULTS, ...prefs.get('defaults', {}), half: halves[i] };
          const result = await processImage(blob, opts);
          await db.addPage({ original: blob, ...opts, ...result, wantOcr: prefs.get('autoOcr', false), mode, docId: target, created: created + i / 10 });
        }
      } catch (e) {
        console.error(e);
        alert('画像を読み込めませんでした');
      }
      pending--;
      showPending();
      await refresh();
      if (!pending) runBackgroundOcr();
    });
  }
}

$('#camera-input').addEventListener('change', e => { enqueue([...e.target.files]); e.target.value = ''; });
$('#file-input').addEventListener('change', e => { enqueue([...e.target.files]); e.target.value = ''; });

function applyMode() {
  document.querySelectorAll('.mode').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
  $('#mode-title').textContent = MODE_TEXT[mode].title;
  $('#mode-help').textContent = MODE_TEXT[mode].help;
  $('#spread-options').hidden = mode !== 'book';
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
  onCapture: blob => enqueue([blob]),
});
$('#camera-auto').checked = prefs.get('autoShutter', true);
$('#camera-auto').addEventListener('change', e => prefs.set('autoShutter', e.target.checked));
$('#camera-button').onclick = () => {
  if (!navigator.mediaDevices?.getUserMedia) { $('#camera-input').click(); return; }
  camera.open();
};

// ---------- 範囲・補正の調整画面 ----------
let edit = null;
const editCanvas = $('#edit-canvas');

async function openEditor(page) {
  const bitmap = await decode(page.original || page.blob);
  const corners = Array.isArray(page.crop) ? page.crop : page.crop === 'auto' ? (page.corners || FULL_FRAME) : FULL_FRAME;
  edit = { page, bitmap, rotation: page.rotation || 0, corners: corners.map(c => [...c]), drag: -1 };
  $('#opt-deskew').checked = !!page.deskew;
  $('#opt-fingers').checked = !!page.fingers;
  $('#opt-denoise').checked = page.denoise !== false;
  $('#opt-even').checked = page.evenColor !== false;
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
  edit.corners = detectPage(edit.base) || FULL_FRAME;
  renderEditBase();
};
$('#edit-auto').onclick = () => { edit.corners = detectPage(edit.base) || FULL_FRAME; drawEditor(); };
$('#edit-full').onclick = () => { edit.corners = FULL_FRAME.map(c => [...c]); drawEditor(); };
$('#edit-apply').onclick = async () => {
  const { page, rotation, corners, bitmap } = edit;
  $('#edit-dialog').close();
  bitmap.close?.();
  edit = null;
  const full = corners.every((c, i) => Math.abs(c[0] - FULL_FRAME[i][0]) < 0.002 && Math.abs(c[1] - FULL_FRAME[i][1]) < 0.002);
  await reprocess(page, {
    rotation, crop: full ? 'none' : corners, half: $('#opt-half').value || null,
    deskew: $('#opt-deskew').checked, fingers: $('#opt-fingers').checked, denoise: $('#opt-denoise').checked,
    evenColor: $('#opt-even').checked, filter: $('#opt-filter').value,
  });
};
$('#edit-dialog').addEventListener('close', () => { if (edit) { edit.bitmap.close?.(); edit = null; } });

// ---------- まとめて設定 ----------
document.querySelectorAll('select.tri').forEach(sel => {
  sel.replaceChildren(new Option('そのまま', ''), new Option('する', '1'), new Option('しない', '0'));
});
$('#batch-button').onclick = () => {
  document.querySelectorAll('#batch-dialog select').forEach(sel => { sel.value = ''; });
  $('#batch-apply').disabled = false;
  $('#batch-apply').textContent = '全ページに適用';
  $('#batch-dialog').showModal();
};
$('#batch-apply').onclick = async () => {
  const tri = id => ({ '': undefined, '1': true, '0': false })[$(id).value];
  const change = {};
  if ($('#batch-filter').value) change.filter = $('#batch-filter').value;
  for (const [id, key] of [['#batch-even', 'evenColor'], ['#batch-deskew', 'deskew'], ['#batch-denoise', 'denoise'], ['#batch-fingers', 'fingers']]) {
    const v = tri(id); if (v !== undefined) change[key] = v;
  }
  const crop = tri('#batch-crop');
  if (crop !== undefined) change.crop = crop ? 'auto' : 'none';
  const ocr = tri('#batch-ocr');
  // 次から撮るページにも同じ設定を使う
  prefs.set('defaults', { ...prefs.get('defaults', {}), ...change });
  if (ocr !== undefined) prefs.set('autoOcr', ocr);
  const btn = $('#batch-apply');
  btn.disabled = true;
  const needImage = Object.keys(change).length > 0;
  const list = [...pages];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (ocr !== undefined) p.wantOcr = ocr;
    if (needImage) {
      btn.textContent = `補正しています… ${i + 1}/${list.length}`;
      await reprocess(p, change, { quiet: true });
    } else {
      await db.putPage(p);
    }
  }
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
      const todo = (await db.allPages()).filter(p => p.wantOcr && !(p.ocr && p.ocr.width === p.width));
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

async function showOcr(page) {
  $('#text-dialog').showModal();
  $('#ocr-status').textContent = '日本語OCRを準備しています（端末内で処理します）';
  $('#ocr-result').value = '';
  try {
    const r = await ocrPage(page, p => { $('#ocr-status').textContent = `文字を認識しています… ${Math.round(p * 100)}%`; });
    $('#ocr-result').value = r.text;
    $('#ocr-status').textContent = '認識しました';
    await refresh();
  } catch (e) {
    console.error(e);
    $('#ocr-status').textContent = 'OCRを開始できませんでした。';
  }
}
$('#ocr-copy').onclick = () => navigator.clipboard?.writeText($('#ocr-result').value).catch(() => {});

// ---------- PDF ----------
let pdfUrl = null;
$('#pdf-button').onclick = () => {
  if (!pages.length) return;
  const q = prefs.get('quality', 'high');
  document.querySelectorAll('input[name=quality]').forEach(r => { r.checked = r.value === q; });
  $('#pdf-ocr').checked = prefs.get('searchable', false);
  $('#pdf-setup').hidden = false;
  $('#pdf-result').hidden = true;
  $('#pdf-make').disabled = false;
  $('#pdf-make').textContent = '作成する';
  const ready = pages.filter(p => p.ocr && p.ocr.width === p.width).length;
  $('#pdf-ocr-note').textContent = ready === pages.length ? '全ページの文字認識が済んでいます' : `未処理の ${pages.length - ready} ページを端末内でOCRします（並行処理）`;
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
    const list = [...pages];
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
    const blob = await buildPdf(images.map((img, i) => ({ ...img, ocr: searchable ? list[i].ocr : null })), doc.name);
    const name = `${doc.name.replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
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
  $('#pdf-info').textContent = `${name}　${pages.length}ページ・${(blob.size / 1024 / 1024).toFixed(1)}MB` + (searchable ? '・文字検索できます' : '');
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
  runBackgroundOcr();
  // ブラウザーが空き容量不足でデータを消さないよう永続化を依頼
  navigator.storage?.persist?.().catch(() => {});
}
start();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
