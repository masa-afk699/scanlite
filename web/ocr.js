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
// paddleFailed: この端末では PaddleOCR が動かない（一度も読めずに失敗が続いた）とき true。
// 以前は1回失敗しただけで true にしていたため、その後アプリを閉じるまで、文字の行からのページ範囲の検出が
// 止まり、OCRも精度の低い方式のままになっていた
let paddle = null, paddleFailed = false, paddleOk = false, paddleErrors = 0, gen = 0, seq = 0, held = false;
const jobs = new Map();
// 読み取りに失敗したワーカーは、中の状態が壊れているかもしれないので作り直す
function restartPaddle(failedGen) {
  if (failedGen !== gen || !paddle) return;
  paddle.terminate();
  paddle = null;
  for (const job of jobs.values()) job.reject(new Error('OCR worker restarted'));
  jobs.clear();
}
function paddleWorker() {
  if (paddle) return paddle;
  gen++;
  paddle = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
  paddle.onmessage = e => {
    const { id, progress, result, error } = e.data, job = jobs.get(id);
    if (!job) return;
    if (progress !== undefined) return job.onProgress(progress);
    jobs.delete(id);
    if (error) job.reject(new Error(error)); else job.resolve(result);
  };
  const mine = paddle;
  paddle.onerror = e => {
    if (paddle !== mine) return;
    for (const job of jobs.values()) job.reject(new Error(e.message || 'OCR worker error'));
    jobs.clear(); paddle = null;
  };
  if (held) paddle.postMessage({ hold: true });
  return paddle;
}
function recognizePaddle(blob, onProgress) {
  const w = paddleWorker(), g = gen;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject: e => { e.gen = g; reject(e); }, onProgress });
    w.postMessage({ id, blob });
  });
}

// 文字の検出・認識のモデルを先に読み込んでおく（カメラを開いたときに呼ぶと、1枚目の補正が早く終わる）
export function warmUp() {
  if (paddleFailed) return;
  const id = ++seq;
  jobs.set(id, { resolve: () => {}, reject: () => {}, onProgress: () => {} });
  paddleWorker().postMessage({ id, warm: true });
}

// 撮影した写真の補正中は、PDF用の読み取りを止めておく（true で止める、false で再開）
export function holdReading(on) {
  if (held === on) return;
  held = on;
  if (paddle) paddle.postMessage({ hold: on });
}

// 写真の中の文字の行（両端の点と太さ、割合）。使えない端末では null。
// choose（向きの候補の配列）を渡すと向きの判定もいっしょに行い、{ lines, scores, rotation } を返す
// （scores は候補ごとの読み取りの確かさ、lines は rotation の向きで検出した行）
export async function textLines(blob, rotation = 0, choose = null) {
  if (paddleFailed) return null;
  const w = paddleWorker(), g = gen;
  try {
    return await new Promise((resolve, reject) => {
      const id = ++seq;
      jobs.set(id, { resolve, reject, onProgress: () => {} });
      w.postMessage({ id, blob, lines: true, rotation, choose });
    });
  } catch (e) { console.error(e); restartPaddle(g); return null; }
}

// 返り値: { text, lines: [{ text, bbox: {x0,y0,x1,y1} }] }（座標は入力画像のピクセル）
export async function recognize(blob, onProgress = () => {}) {
  if (!paddleFailed) {
    // 失敗したら、ワーカーを作り直してもう1回だけ試す
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await recognizePaddle(blob, onProgress);
        paddleOk = true; paddleErrors = 0;
        return { text: tidy(r.text), lines: r.lines.map(l => ({ text: tidy(l.text), bbox: l.bbox })) };
      } catch (e) {
        console.error('PaddleOCR failed', e);
        restartPaddle(e.gen);
      }
    }
    // 一度も読めないまま失敗が続くときだけ、この端末では動かないとみなす。
    // それまでに読めていたなら、このページだけ従来のOCR（tesseract）で読み、次のページはまた PaddleOCR で読む
    if (!paddleOk && ++paddleErrors >= 2) paddleFailed = true;
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
