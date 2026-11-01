// 日本語OCR。すべて端末内（Web Worker）で動く。
// 通常は高精度な PaddleOCR（ONNX Runtime Web）を使い、動かない端末では同梱の tesseract.js で読む。
const POOL = Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
const idle = [], waiting = [];
let created = 0, mod = null;

async function newWorker() {
  const base = new URL('vendor/tesseract/', location.href).href;
  mod = mod || (await import('./vendor/tesseract/tesseract.esm.min.js')).default;
  let w = null;
  w = await mod.createWorker('jpn', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'core/',
    langPath: base + 'lang',
    workerBlobURL: false,
    gzip: true,
    logger: m => w && w._progress && w._progress(m),
  });
  return w;
}

async function acquire() {
  if (idle.length) return idle.pop();
  if (created < POOL) {
    created++;
    try { return await newWorker(); } catch (e) { created--; throw e; }
  }
  return new Promise(r => waiting.push(r));
}
function release(w) {
  const next = waiting.shift();
  if (next) next(w); else idle.push(w);
}

// 日本語の文字間に入る余分な空白を取り除く
const CJK = '[\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef]';
export const tidy = t => t
  .replace(new RegExp(`(?<=${CJK}) +(?=${CJK})`, 'g'), '')
  // 「第 3 回」のように数字の前後に入る空白も取る
  .replace(new RegExp(`(?<=${CJK}) +(?=[0-9０-９])|(?<=[0-9０-９]) +(?=${CJK})`, 'g'), '');

// ---------- 高精度OCR（PaddleOCR、Web Workerで実行） ----------
let paddle = null, paddleFailed = false, seq = 0;
const jobs = new Map();
function paddleWorker() {
  if (paddle) return paddle;
  paddle = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
  paddle.onmessage = e => {
    const { id, progress, result, error } = e.data, job = jobs.get(id);
    if (!job) return;
    if (progress !== undefined) return job.onProgress(progress);
    jobs.delete(id);
    if (error) job.reject(new Error(error)); else job.resolve(result);
  };
  paddle.onerror = e => {
    for (const job of jobs.values()) job.reject(new Error(e.message || 'OCR worker error'));
    jobs.clear(); paddle = null;
  };
  return paddle;
}
function recognizePaddle(blob, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject, onProgress });
    paddleWorker().postMessage({ id, blob });
  });
}

// 返り値: { text, lines: [{ text, bbox: {x0,y0,x1,y1} }] }（座標は入力画像のピクセル）
export async function recognize(blob, onProgress = () => {}) {
  if (!paddleFailed) {
    try {
      const r = await recognizePaddle(blob, onProgress);
      return { text: tidy(r.text), lines: r.lines.map(l => ({ text: tidy(l.text), bbox: l.bbox })) };
    } catch (e) {
      // 古い端末などで動かないときは、従来のOCR（tesseract）で読む
      console.error('PaddleOCR failed, falling back', e);
      paddleFailed = true;
    }
  }
  return recognizeTesseract(blob, onProgress);
}

async function recognizeTesseract(blob, onProgress) {
  const w = await acquire();
  w._progress = m => { if (m.status === 'recognizing text') onProgress(m.progress || 0); };
  try {
    const { data } = await w.recognize(blob, {}, { text: true, blocks: true });
    const lines = [];
    for (const b of data.blocks || []) for (const para of b.paragraphs || []) for (const l of para.lines || []) {
      const text = tidy(l.text.trim());
      if (text) lines.push({ text, bbox: l.bbox });
    }
    release(w);
    return { text: tidy(data.text), lines };
  } catch (e) {
    created--;
    w.terminate?.();
    throw e;
  }
}
