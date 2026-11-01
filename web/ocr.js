// 日本語OCR。tesseract.jsと日本語データを同梱しており、端末内（Web Worker）で動く。
// 複数ページを速く処理できるよう、端末の性能に合わせて最大2つのワーカーで並行処理する。
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
export const tidy = t => t.replace(new RegExp(`(?<=${CJK}) +(?=${CJK})`, 'g'), '');

// 返り値: { text, lines: [{ text, bbox: {x0,y0,x1,y1} }] }（座標は入力画像のピクセル）
export async function recognize(blob, onProgress = () => {}) {
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
