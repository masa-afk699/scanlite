// 高精度の日本語OCR（PaddleOCR PP-OCRv6 small を ONNX Runtime Web で実行）。
// 画像もモデルもこの端末の中だけで扱い、外部へは送らない。
import * as ort from './vendor/paddle/ort.wasm.min.mjs';

const base = new URL('./vendor/paddle/', import.meta.url).href;
ort.env.wasm.wasmPaths = base;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let det = null, rec = null, chars = null;
async function load() {
  if (det) return;
  // 取れなかったファイル（圏外で未保存など）は、途中までの状態を残さず失敗にする（次に呼ばれたとき最初から読み直す）
  const get = async name => { const r = await fetch(base + name); if (!r.ok) throw new Error(`${name}: ${r.status}`); return r; };
  const buf = async name => new Uint8Array(await (await get(name)).arrayBuffer());
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const [d, r, dict] = await Promise.all([buf('det.onnx'), buf('rec.onnx'), get('dict.txt').then(r => r.text())]);
  const ds = await ort.InferenceSession.create(d, opts);
  const rs = await ort.InferenceSession.create(r, opts);
  chars = ['', ...dict.split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l), ' '];
  rec = rs; det = ds;
}

const canvas = (w, h) => new OffscreenCanvas(w, h);

// ---------- 文字の検出 ----------
async function detect(bitmap) {
  const { prob, w, h, W, H } = await probMap(bitmap);
  const n = w * h;
  return regionsOf(prob, w, h, W, H, n);
}

// 文字らしさの地図（縮小した画像の画素ごとの確からしさ）
async function probMap(bitmap) {
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
  return { prob: out[det.outputNames[0]].data, w, h, W, H };
}

function regionsOf(prob, w, h, W, H, n) {
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
async function read(bitmap, b, horizontalOnly = false) {
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const vertical = !horizontalOnly && bh > bw * 1.5;
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

// 1件ずつ順番に処理する（同時に動かすとメモリを食うため）。
// 補正に使う行の検出（lines）とモデルの読み込み（warm）は急ぎの仕事として、読み取り（PDF用のOCR）より先に行う。
// 読み取りは1行ごとに区切って、その間に急ぎの仕事が来たら先に片付ける（裏で読んでいても、撮影後の補正を待たせない）
const urgent = [], normal = [];
let busy = false, hold = false, wake = null;
self.onmessage = e => {
  const m = e.data;
  // hold: 撮影した写真の補正中は、読み取りを止めておく（CPUを補正に回す）
  if (m.hold !== undefined) { hold = m.hold; if (!hold && wake) { wake(); wake = null; } return; }
  (m.lines || m.warm ? urgent : normal).push(m);
  if (wake && urgent.length) { wake(); wake = null; }
  pump();
};
async function pump() {
  if (busy) return;
  busy = true;
  while (urgent.length || normal.length) await handle(urgent.length ? urgent.shift() : normal.shift());
  busy = false;
}
// 読み取りの区切りごとに呼ぶ: 急ぎの仕事を先に済ませ、止めるよう言われていれば再開を待つ
// （文字を読む計算の間は届いたメッセージが処理されないので、ここで一度メッセージを受け取る）
const tick = () => new Promise(r => setTimeout(r, 0));
async function yieldToUrgent() {
  await tick();
  for (;;) {
    while (urgent.length) await handle(urgent.shift());
    if (!hold) return;
    await new Promise(r => { wake = r; });
  }
}
// 行の位置: 検出した各行に直線を当てはめ、両端の点と太さを返す（ページの範囲と台形のゆがみを求めるのに使う）。
// 座標は画像に対する割合
// choose（向きの候補の配列）があるときは、向きの判定もいっしょに行う: rotation の向きで検出した行を
// 候補の向きに回して読み比べ、はっきり別の向きが正しければ、その向きで行を検出し直す
// （向きの判定のためだけに文字の検出をし直さなくてよいので速い）。返り値: { lines, scores, rotation }
async function textLines(blob, rotation, choose = null) {
  const source = await createImageBitmap(blob);
  let bitmap = turned(source, rotation), { prob, w, h, W, H } = await probMap(bitmap), scores = null;
  if (choose) {
    const boxes = topBoxes(regionsOf(prob, w, h, W, H, w * h));
    scores = await scoreTurns(bitmap, boxes, choose.map(a => (a - rotation + 360) % 360));
    const best = scores.indexOf(Math.max(...scores)), other = Math.max(...scores.filter((_, i) => i !== best));
    if (scores[best] - other > 0.02 && choose[best] !== rotation) {
      rotation = choose[best];
      bitmap.close(); bitmap = turned(source, rotation);
      ({ prob, w, h } = await probMap(bitmap));
    }
  }
  bitmap.close(); source.close();
  const lines = linesOf(prob, w, h);
  return choose ? { lines, scores, rotation } : lines;
}

// 画像を右回りに rotation 度回したもの
function turned(bitmap, rotation) {
  const swap = rotation % 180 !== 0, c = new OffscreenCanvas(swap ? bitmap.height : bitmap.width, swap ? bitmap.width : bitmap.height), x = c.getContext('2d');
  x.translate(c.width / 2, c.height / 2); x.rotate(rotation * Math.PI / 180); x.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return c.transferToImageBitmap();
}

function linesOf(prob, w, h) {
  const label = new Uint8Array(w * h), stack = [], lines = [];
  for (let s0 = 0; s0 < w * h; s0++) {
    if (prob[s0] <= 0.3 || label[s0]) continue;
    const px = [];
    label[s0] = 1; stack.push(s0);
    while (stack.length) {
      const p = stack.pop(); px.push(p);
      const x = p % w, y = (p - x) / w;
      if (x > 0 && prob[p - 1] > 0.3 && !label[p - 1]) { label[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && prob[p + 1] > 0.3 && !label[p + 1]) { label[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && prob[p - w] > 0.3 && !label[p - w]) { label[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && prob[p + w] > 0.3 && !label[p + w]) { label[p + w] = 1; stack.push(p + w); }
    }
    if (px.length < 12) continue;
    let mx = 0, my = 0;
    for (const p of px) { mx += p % w; my += (p / w) | 0; }
    mx /= px.length; my /= px.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of px) { const dx = p % w - mx, dy = ((p / w) | 0) - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
    let t0 = Infinity, t1 = -Infinity;
    for (const p of px) { const t = (p % w - mx) * ux + (((p / w) | 0) - my) * uy; if (t < t0) t0 = t; if (t > t1) t1 = t; }
    const len = t1 - t0 + 1, thick = px.length / len;
    if (len < thick * 2.5) continue;
    // 行の中心線を10か所で求める（紙の反りで曲がった行をまっすぐに直すため）
    const K = 10, sumS = new Float64Array(K), cnt = new Float64Array(K);
    for (const p of px) {
      const dx = p % w - mx, dy = ((p / w) | 0) - my, t = dx * ux + dy * uy, k = Math.min(K - 1, Math.floor((t - t0) / len * K));
      sumS[k] += -dx * uy + dy * ux; cnt[k]++;
    }
    const pts = [];
    for (let k = 0; k < K; k++) if (cnt[k]) {
      const t = t0 + (k + 0.5) * len / K, sv = sumS[k] / cnt[k];
      pts.push([(mx + ux * t - uy * sv) / w, (my + uy * t + ux * sv) / h]);
    }
    lines.push({ a: [(mx + ux * t0) / w, (my + uy * t0) / h], b: [(mx + ux * t1) / w, (my + uy * t1) / h], t: thick / Math.max(w, h), pts });
  }
  return lines;
}

// 読み比べに使う行: 大きい順に12行まで（小さすぎる枠は読めないので除く）
const topBoxes = boxes => boxes.filter(b => Math.min(b.x1 - b.x0, b.y1 - b.y0) >= 8)
  .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0)).slice(0, 12);

// 向きの判定: 行の枠 boxes を、画像ごと右回りに turns の各角度だけ回した向きで読み、向きごとの平均の確信度を返す。
// 逆さまや横倒しの文字は確信度が下がるので、いちばん高い向きが正しい向き。
// 大きい行から読み、はっきり差がついたら残りは読まない
async function scoreTurns(bitmap, boxes, turns) {
  const sum = turns.map(() => 0), wins = turns.map(() => 0);
  let n = 0;
  for (const b of boxes) {
    const got = [];
    for (let k = 0; k < turns.length; k++) { const r = await readTurned(bitmap, b, turns[k]); got.push(r.text ? r.conf : 0); sum[k] += got[k]; }
    n++;
    wins[got.indexOf(Math.max(...got))]++;
    // 4行以上読んで、同じ向きがほぼ毎回勝ち、平均でも大きく離れていれば決まり。
    // 差がとても大きい（ほかの向きではほとんど読めない）ときは2行で決める
    if (n >= 2) {
      const best = sum.indexOf(Math.max(...sum)), second = Math.max(...sum.filter((_, i) => i !== best));
      if (n >= 4 ? wins[best] >= n - 1 && (sum[best] - second) / n > 0.3 : wins[best] === n && (sum[best] - second) / n > 0.6) break;
    }
  }
  return sum.map(s => (n ? s / n : 0));
}

// 画像の中の行の枠 b を、画像ごと右回りに turn 度回したときの向きで切り出して読む（横書きの行として）
async function readTurned(bitmap, b, turn) {
  if (!turn) return read(bitmap, b, true);
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0, swap = turn % 180 !== 0;
  const c = canvas(Math.max(1, Math.round(swap ? bh : bw)), Math.max(1, Math.round(swap ? bw : bh))), x = c.getContext('2d');
  x.translate(c.width / 2, c.height / 2); x.rotate(turn * Math.PI / 180);
  x.drawImage(bitmap, b.x0, b.y0, bw, bh, -bw / 2, -bh / 2, bw, bh);
  return read(c, { x0: 0, y0: 0, x1: c.width, y1: c.height }, true);
}

async function handle({ id, blob, lines, rotation, choose, warm }) {
  if (warm) {
    try { await load(); self.postMessage({ id, result: true }); }
    catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
    return;
  }
  if (lines) {
    try { await load(); self.postMessage({ id, result: await textLines(blob, rotation || 0, choose || null) }); }
    catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
    return;
  }
  const progress = p => self.postMessage({ id, progress: p });
  try {
    progress(0);
    await load();
    await yieldToUrgent();
    const bitmap = await createImageBitmap(blob);
    const boxes = await detect(bitmap);
    progress(0.15);
    const lines = [];
    for (let i = 0; i < boxes.length; i++) {
      await yieldToUrgent();
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
