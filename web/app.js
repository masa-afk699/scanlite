// ScanLite: すべての処理をブラウザー内で行う。撮影画像・PDF・OCR結果はネットワークに送らない。
import { processImage, decode, drawRotated, detectPage, FULL_FRAME } from './scan.js';

const DB_NAME = 'scanlite-local', STORE = 'pages';
// 新しく取り込んだページの標準設定
const DEFAULTS = { rotation: 0, filter: 'color', crop: 'auto', deskew: true, fingers: true, denoise: true };
const FILTERS = { color: 'カラー補正', bw: '白黒', none: '補正なし' };
const MODE_TEXT = {
  book: { title: '本をスキャン', help: '影や明るさのムラを補正して、紙を白く整えます。' },
  document: { title: '書類をスキャン', help: '複数枚を撮影して、1つのPDFにまとめられます。' },
};

let mode = 'book', pages = [], thumbUrls = [];
const $ = s => document.querySelector(s);

// ---------- IndexedDB ----------
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(kind, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, kind).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
// 並び順は created（同値ならid）で決める。旧形式（blobのみ）のデータもそのまま読める
const allPages = async () => (await tx('readonly', s => s.getAll())).sort((a, b) => (a.created - b.created) || (a.id - b.id));
const putPage = p => tx('readwrite', s => s.put(p));
const addPage = p => tx('readwrite', s => s.add(p));
const removePage = id => tx('readwrite', s => s.delete(id));
const clearPages = () => tx('readwrite', s => s.clear());

// ---------- 画面 ----------
function setBusy(text) {
  const el = $('#busy');
  el.hidden = !text;
  el.textContent = text || '';
}

async function refresh() {
  pages = await allPages();
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = [];
  $('#count').textContent = `${pages.length} ページ`;
  $('#pdf-button').disabled = !pages.length;
  $('#clear-button').disabled = !pages.length;
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
    label.textContent = `${index + 1}　${p.mode === 'book' ? '本' : '書類'}`;
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
      button('OCR', () => recognize(p)),
      button('削除', async () => { await removePage(p.id); await refresh(); }, 'danger'),
    );
    card.append(img, meta, tools);
    root.append(card);
  });
}

const optionsOf = p => ({
  rotation: p.rotation || 0, filter: p.filter || 'none', crop: p.crop || 'none',
  deskew: !!p.deskew, fingers: !!p.fingers, denoise: p.denoise !== false,
});

async function reprocess(page, change) {
  if (!page.original) page.original = page.blob;
  Object.assign(page, change);
  setBusy('画像を補正しています…');
  try {
    Object.assign(page, await processImage(page.original, optionsOf(page)));
    await putPage(page);
  } finally { setBusy(''); }
  await refresh();
}

// 並び順は created で管理する（IDは変えない）
async function move(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= pages.length) return;
  const a = pages[index], b = pages[j];
  [a.created, b.created] = [b.created, a.created];
  await putPage(a); await putPage(b);
  await refresh();
}

async function ingest(files) {
  const list = [...files].filter(f => f.type.startsWith('image/'));
  for (let i = 0; i < list.length; i++) {
    setBusy(`画像を補正しています… ${i + 1}/${list.length}`);
    try {
      const result = await processImage(list[i], DEFAULTS);
      await addPage({ original: list[i], ...DEFAULTS, ...result, mode, created: Date.now() + i });
    } catch (e) {
      alert('画像を読み込めませんでした');
    }
  }
  setBusy('');
  await refresh();
}

$('#camera-input').addEventListener('change', e => { ingest(e.target.files); e.target.value = ''; });
$('#file-input').addEventListener('change', e => { ingest(e.target.files); e.target.value = ''; });
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  document.querySelectorAll('.mode').forEach(x => x.classList.toggle('active', x === b));
  $('#mode-title').textContent = MODE_TEXT[mode].title;
  $('#mode-help').textContent = MODE_TEXT[mode].help;
}));
$('#clear-button').onclick = async () => {
  if (confirm('保存したページをすべて削除しますか？')) { await clearPages(); await refresh(); }
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
    rotation, crop: full ? 'none' : corners,
    deskew: $('#opt-deskew').checked, fingers: $('#opt-fingers').checked, denoise: $('#opt-denoise').checked,
    filter: $('#opt-filter').value,
  });
};
$('#edit-dialog').addEventListener('close', () => { if (edit) { edit.bitmap.close?.(); edit = null; } });

// ---------- PDF生成（ライブラリなし・端末内） ----------
async function buildPdf(list) {
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let offset = 0;
  const push = d => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); offset += b.length; };
  const obj = (id, write) => { offsets[id] = offset; push(`${id} 0 obj\n`); write(); push('\nendobj\n'); };
  push('%PDF-1.4\n%âãÏÓ\n');
  const pageIds = list.map((_, i) => 3 + i * 3);
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${list.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`));
  for (let i = 0; i < list.length; i++) {
    const p = list[i], id = pageIds[i];
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    const k = 842 / Math.max(p.width, p.height); // 長辺をA4長辺（842pt）に合わせる
    const W = (p.width * k).toFixed(2), H = (p.height * k).toFixed(2);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(id, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
    obj(id + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(id + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      push(bytes);
      push('\nendstream');
    });
  }
  const size = 3 + list.length * 3;
  const xref = offset;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

let pdfUrl = null;
$('#pdf-button').onclick = async () => {
  if (!pages.length) return;
  setBusy('PDFを作成しています…');
  try {
    const blob = await buildPdf(pages);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const name = `ScanLite_${stamp}.pdf`;
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(blob);
    const link = $('#pdf-download');
    link.href = pdfUrl;
    link.download = name;
    $('#pdf-info').textContent = `${pages.length}ページ・${(blob.size / 1024 / 1024).toFixed(1)}MB`;
    const file = new File([blob], name, { type: 'application/pdf' });
    const share = $('#pdf-share');
    share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    share.onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
    $('#pdf-dialog').showModal();
  } catch (e) {
    alert('PDFを作成できませんでした');
  } finally { setBusy(''); }
};

// ---------- 日本語OCR（tesseract.jsを同梱し、端末内で実行） ----------
let ocrWorker = null;
async function getOcrWorker(onProgress) {
  if (ocrWorker) return ocrWorker;
  const base = new URL('vendor/tesseract/', location.href).href;
  const { createWorker } = (await import('./vendor/tesseract/tesseract.esm.min.js')).default;
  ocrWorker = await createWorker('jpn', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'core/',
    langPath: base + 'lang',
    workerBlobURL: false,
    gzip: true,
    logger: m => onProgress(m),
  });
  return ocrWorker;
}

let ocrProgress = () => {};
async function recognize(page) {
  $('#text-dialog').showModal();
  $('#ocr-status').textContent = '日本語OCRを準備しています（端末内で処理します）';
  $('#ocr-result').value = '';
  ocrProgress = m => {
    if (m.status === 'recognizing text') $('#ocr-status').textContent = `文字を認識しています… ${Math.round((m.progress || 0) * 100)}%`;
  };
  try {
    const worker = await getOcrWorker(m => ocrProgress(m));
    const result = await worker.recognize(page.blob);
    // 日本語の文字間に入る余分な空白を取り除く
    $('#ocr-result').value = result.data.text.replace(/(?<=[\u3000-\u9fff\uff00-\uffef]) +(?=[\u3000-\u9fff\uff00-\uffef])/g, '');
    $('#ocr-status').textContent = '認識しました';
  } catch (e) {
    console.error(e);
    ocrWorker = null;
    $('#ocr-status').textContent = 'OCRを開始できませんでした。';
  }
}
$('#ocr-copy').onclick = () => navigator.clipboard?.writeText($('#ocr-result').value).catch(() => {});

// ---------- 起動 ----------
async function start() {
  // 旧バージョンで保存したページ（サイズ情報なし）を補正なしで変換しておく
  for (const p of await allPages()) {
    if (p.width) continue;
    try {
      p.original = p.blob;
      Object.assign(p, { rotation: 0, filter: 'none', crop: 'none', deskew: false, fingers: false, denoise: false });
      Object.assign(p, await processImage(p.original, optionsOf(p)));
      await putPage(p);
    } catch {}
  }
  await refresh();
  // ブラウザーが空き容量不足でデータを消さないよう永続化を依頼
  navigator.storage?.persist?.().catch(() => {});
}
start();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
