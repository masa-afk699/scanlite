// ScanLite: すべての処理をブラウザー内で行う。撮影画像・PDF・OCR結果はネットワークに送らない。
const DB_NAME = 'scanlite-local', STORE = 'pages';
const MAX_SIDE = 2400;          // 保存・PDF用の最大辺（px）
const JPEG_QUALITY = 0.86;
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

// ---------- 画像補正（vFlat風の照明ムラ補正） ----------
async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { return await createImageBitmap(blob); }
}

function drawRotated(bitmap, rotation) {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const swap = rotation % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w; canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, ctx };
}

// 紙の明るさ（背景）を推定する。縮小→最大値フィルターで文字を消す→ぼかし→拡大。
function estimateBackground(canvas) {
  const W = canvas.width, H = canvas.height;
  const k = 64 / Math.max(W, H);
  const sw = Math.max(4, Math.round(W * k)), sh = Math.max(4, Math.round(H * k));
  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, sw, sh);
  let img = sctx.getImageData(0, 0, sw, sh);
  const filter = (src, radius, op) => {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) for (let c = 0; c < 3; c++) {
      let acc = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const yy = Math.min(sh - 1, Math.max(0, y + dy)), xx = Math.min(sw - 1, Math.max(0, x + dx));
        const v = src[(yy * sw + xx) * 4 + c];
        if (op === 'max') { if (v > acc) acc = v; } else { acc += v; n++; }
      }
      out[(y * sw + x) * 4 + c] = op === 'max' ? acc : acc / n;
      out[(y * sw + x) * 4 + 3] = 255;
    }
    return out;
  };
  let data = filter(img.data, 2, 'max');
  data = filter(data, 2, 'mean');
  img = new ImageData(data, sw, sh);
  sctx.putImageData(img, 0, 0);
  const big = document.createElement('canvas');
  big.width = W; big.height = H;
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, W, H);
  return bctx.getImageData(0, 0, W, H).data;
}

function enhance(canvas, ctx, filter) {
  if (filter === 'none') return;
  const W = canvas.width, H = canvas.height;
  const bg = estimateBackground(canvas);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const lut = new Uint8ClampedArray(256);
  const gamma = filter === 'bw' ? 1.8 : 1.35;
  for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, gamma);
  for (let i = 0; i < d.length; i += 4) {
    let r = Math.min(255, d[i] * 250 / Math.max(bg[i], 1));
    let g = Math.min(255, d[i + 1] * 250 / Math.max(bg[i + 1], 1));
    let b = Math.min(255, d[i + 2] * 250 / Math.max(bg[i + 2], 1));
    if (filter === 'bw') {
      const y = lut[Math.round(0.299 * r + 0.587 * g + 0.114 * b)];
      d[i] = d[i + 1] = d[i + 2] = y;
    } else {
      d[i] = lut[r | 0]; d[i + 1] = lut[g | 0]; d[i + 2] = lut[b | 0];
    }
  }
  ctx.putImageData(img, 0, 0);
}

async function processImage(original, rotation, filter) {
  const bitmap = await decode(original);
  const { canvas, ctx } = drawRotated(bitmap, rotation);
  bitmap.close?.();
  enhance(canvas, ctx, filter);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  return { blob, width: canvas.width, height: canvas.height };
}

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
      button('↺ 回転', () => reprocess(p, { rotation: ((p.rotation || 0) + 270) % 360 })),
      button('◀ 前へ', () => move(index, -1)),
      button('OCR', () => recognize(p)),
      button('削除', async () => { await removePage(p.id); await refresh(); }, 'danger'),
    );
    card.append(img, meta, tools);
    root.append(card);
  });
}

async function reprocess(page, change) {
  Object.assign(page, change);
  setBusy('画像を補正しています…');
  try {
    Object.assign(page, await processImage(page.original || page.blob, page.rotation || 0, page.filter || 'none'));
    if (!page.original) page.original = page.blob;
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
    const filter = 'color';
    try {
      const result = await processImage(list[i], 0, filter);
      await addPage({ original: list[i], ...result, rotation: 0, filter, mode, created: Date.now() + i });
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
    try { p.original = p.blob; Object.assign(p, await processImage(p.blob, 0, 'none'), { rotation: 0, filter: 'none' }); await putPage(p); } catch {}
  }
  await refresh();
  // ブラウザーが空き容量不足でデータを消さないよう永続化を依頼
  navigator.storage?.persist?.().catch(() => {});
}
start();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
