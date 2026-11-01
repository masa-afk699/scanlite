// 高精度の日本語OCR（PaddleOCR PP-OCRv6 small を ONNX Runtime Web で実行）。
// 画像もモデルもこの端末の中だけで扱い、外部へは送らない。
import * as ort from './vendor/paddle/ort.wasm.min.mjs';

const base = new URL('./vendor/paddle/', import.meta.url).href;
ort.env.wasm.wasmPaths = base;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let det = null, rec = null, chars = null;
async function load() {
  if (det) return;
  const buf = async name => new Uint8Array(await (await fetch(base + name)).arrayBuffer());
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const [d, r, dict] = await Promise.all([buf('det.onnx'), buf('rec.onnx'), fetch(base + 'dict.txt').then(r => r.text())]);
  det = await ort.InferenceSession.create(d, opts);
  rec = await ort.InferenceSession.create(r, opts);
  chars = ['', ...dict.split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l), ' '];
}

const canvas = (w, h) => new OffscreenCanvas(w, h);

// ---------- 文字の検出 ----------
async function detect(bitmap) {
  const W = bitmap.width, H = bitmap.height;
  const k = Math.min(1, 1280 / Math.max(W, H));
  const w = Math.max(32, Math.round(W * k / 32) * 32), h = Math.max(32, Math.round(H * k / 32) * 32);
  const c = canvas(w, h), x = c.getContext('2d');
  x.drawImage(bitmap, 0, 0, w, h);
  const px = x.getImageData(0, 0, w, h).data;
  const input = new Float32Array(3 * w * h), n = w * h;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    // モデルはBGRの順で学習されている
    input[p] = (px[i + 2] / 255 - mean[0]) / std[0];
    input[n + p] = (px[i + 1] / 255 - mean[1]) / std[1];
    input[2 * n + p] = (px[i] / 255 - mean[2]) / std[2];
  }
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) });
  const prob = out[det.outputNames[0]].data;
  // しきい値を超えた領域をまとめて、行の枠にする
  const label = new Int32Array(n).fill(-1), stack = [], boxes = [];
  for (let s = 0; s < n; s++) {
    if (prob[s] <= 0.3 || label[s] >= 0) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0, sum = 0;
    label[s] = 1; stack.push(s);
    while (stack.length) {
      const p = stack.pop(), px2 = p % w, py = (p - px2) / w;
      area++; sum += prob[p];
      if (px2 < x0) x0 = px2; if (px2 > x1) x1 = px2; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px2 > 0 && prob[p - 1] > 0.3 && label[p - 1] < 0) { label[p - 1] = 1; stack.push(p - 1); }
      if (px2 < w - 1 && prob[p + 1] > 0.3 && label[p + 1] < 0) { label[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && prob[p - w] > 0.3 && label[p - w] < 0) { label[p - w] = 1; stack.push(p - w); }
      if (py < h - 1 && prob[p + w] > 0.3 && label[p + w] < 0) { label[p + w] = 1; stack.push(p + w); }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 3 || sum / area < 0.6) continue;
    // 検出枠は文字より細いので、面積と周長に応じて広げる
    const d = area * 1.5 / (2 * (bw + bh)), sx = W / w, sy = H / h;
    boxes.push({
      x0: Math.max(0, (x0 - d) * sx), y0: Math.max(0, (y0 - d) * sy),
      x1: Math.min(W, (x1 + 1 + d) * sx), y1: Math.min(H, (y1 + 1 + d) * sy),
    });
  }
  return boxes;
}

// ---------- 文字の認識 ----------
async function read(bitmap, b) {
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const vertical = bh > bw * 1.5;
  // 縦書きの行は90度回して横書きとして読む
  const lw = vertical ? bh : bw, lh = vertical ? bw : bh;
  const w = Math.max(16, Math.min(3200, Math.round(48 * lw / lh)));
  const c = canvas(w, 48), x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  if (vertical) {
    x.translate(0, 48); x.rotate(-Math.PI / 2);
    x.drawImage(bitmap, b.x0, b.y0, bw, bh, 0, 0, 48, w);
  } else {
    x.drawImage(bitmap, b.x0, b.y0, bw, bh, 0, 0, w, 48);
  }
  const px = x.getImageData(0, 0, w, 48).data, n = w * 48;
  const input = new Float32Array(3 * n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    input[p] = px[i + 2] / 127.5 - 1; input[n + p] = px[i + 1] / 127.5 - 1; input[2 * n + p] = px[i] / 127.5 - 1;
  }
  const out = (await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 48, w]) }))[rec.outputNames[0]];
  const [, T, C] = out.dims, y = out.data;
  let text = '', prev = -1, conf = 0, count = 0;
  for (let t = 0; t < T; t++) {
    let best = 0, bv = -Infinity;
    for (let k = 0, o = t * C; k < C; k++) if (y[o + k] > bv) { bv = y[o + k]; best = k; }
    if (best !== prev && best !== 0) { text += chars[best] || ''; conf += bv; count++; }
    prev = best;
  }
  return { text: text.trim(), conf: count ? conf / count : 0, vertical };
}

// 読む順に並べる: 横書きは上から（同じ高さなら左から）、縦書きは右の行から
function order(lines) {
  const vertical = lines.filter(l => l.vertical).length > lines.length / 2;
  if (vertical) return lines.sort((a, b) => b.bbox.x1 - a.bbox.x1 || a.bbox.y0 - b.bbox.y0);
  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const rows = [];
  for (const l of lines) {
    const row = rows.find(r => {
      const top = Math.max(r.y0, l.bbox.y0), bot = Math.min(r.y1, l.bbox.y1);
      return bot - top > 0.5 * Math.min(r.y1 - r.y0, l.bbox.y1 - l.bbox.y0);
    });
    if (row) { row.items.push(l); row.y0 = Math.min(row.y0, l.bbox.y0); row.y1 = Math.max(row.y1, l.bbox.y1); }
    else rows.push({ y0: l.bbox.y0, y1: l.bbox.y1, items: [l] });
  }
  return rows.flatMap(r => r.items.sort((a, b) => a.bbox.x0 - b.bbox.x0));
}

// 1枚ずつ順番に処理する（同時に動かすとメモリを食うため）
let queue = Promise.resolve();
self.onmessage = e => { queue = queue.then(() => handle(e.data)); };
async function handle({ id, blob }) {
  const progress = p => self.postMessage({ id, progress: p });
  try {
    progress(0);
    await load();
    const bitmap = await createImageBitmap(blob);
    const boxes = await detect(bitmap);
    progress(0.15);
    const lines = [];
    for (let i = 0; i < boxes.length; i++) {
      const r = await read(bitmap, boxes[i]);
      if (r.text && r.conf > 0.5) {
        const b = boxes[i];
        lines.push({ text: r.text, vertical: r.vertical, bbox: { x0: Math.round(b.x0), y0: Math.round(b.y0), x1: Math.round(b.x1), y1: Math.round(b.y1) } });
      }
      progress(0.15 + 0.85 * (i + 1) / boxes.length);
    }
    bitmap.close();
    const sorted = order(lines);
    self.postMessage({ id, result: { text: sorted.map(l => l.text).join('\n'), lines: sorted.map(({ text, bbox }) => ({ text, bbox })) } });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
}
