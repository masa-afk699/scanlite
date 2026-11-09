// 画像補正の処理一式。すべて端末内（ブラウザー）で計算し、外部には何も送らない。
// 対象: ページ端の検出と台形補正、傾き補正、明るさの均一化、ノイズ除去、指の消去。

export const MAX_SIDE = 2400;
const tick = () => new Promise(r => setTimeout(r, 0));

// Web Worker の中でも動くよう、document が無ければ OffscreenCanvas を使う
function makeCanvas(w, h) {
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
const toJpeg = (c, q) => c.convertToBlob ? c.convertToBlob({ type: 'image/jpeg', quality: q }) : new Promise(r => c.toBlob(r, 'image/jpeg', q));
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });

function shrink(canvas, longSide) {
  const k = Math.min(1, longSide / Math.max(canvas.width, canvas.height));
  const w = Math.max(4, Math.round(canvas.width * k)), h = Math.max(4, Math.round(canvas.height * k));
  const c = makeCanvas(w, h), x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, 0, 0, w, h);
  return x.getImageData(0, 0, w, h);
}

// ---------- 読み込みと回転 ----------
export async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { return await createImageBitmap(blob); }
}

export function drawRotated(bitmap, rotation, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const swap = rotation % 180 !== 0;
  const canvas = makeCanvas(swap ? h : w, swap ? w : h);
  const x = ctx2d(canvas);
  x.translate(canvas.width / 2, canvas.height / 2);
  x.rotate(rotation * Math.PI / 180);
  x.imageSmoothingQuality = 'high';
  x.drawImage(bitmap, -w / 2, -h / 2, w, h);
  return canvas;
}

// ---------- 2値マスクの小道具 ----------
function morph(mask, w, h, r, dilate) {
  // 横→縦の2パスで正方形の膨張／収縮
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let d = -r; d <= r; d++) {
      const xx = Math.min(w - 1, Math.max(0, x + d)), m = mask[y * w + xx];
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let d = -r; d <= r; d++) {
      const yy = Math.min(h - 1, Math.max(0, y + d)), m = tmp[yy * w + x];
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}

// 4近傍の連結成分。各成分の画素リストとbboxを返す
function components(mask, w, h) {
  const label = new Int32Array(mask.length).fill(-1), comps = [], stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const id = comps.length, px = [];
    let minX = w, minY = h, maxX = 0, maxY = 0;
    label[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      px.push(p);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && mask[q] && label[q] < 0) { label[q] = id; stack.push(q); }
    }
    comps.push({ px, minX, minY, maxX, maxY });
  }
  return comps;
}

function otsu(values) {
  const hist = new Float64Array(256);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// ---------- ページ端の検出 ----------
// 紙は「明るく、色みが少ない」。その最大の領域を探し、四隅を推定する。
// 返り値は画像サイズに対する0〜1の座標 [左上, 右上, 右下, 左下]。見つからなければ null。
// subject: 'paper'（紙） | 'screen'（PCなどの画面。光っていて色があるので明るさだけで判定）
// ページ（または画面）の四隅を探す。返り値は画像に対する割合 [[x,y]×4]（左上から時計回り）
export function detectPage(canvas, subject = 'paper') {
  const img = shrink(canvas, 480), { width: w, height: h, data: d } = img;
  const masks = [];
  // 候補1: 白っぽさ（彩度が低く明るい）で紙を探す。画面モードは明るさで光っている部分を探す
  const score = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < score.length; i += 4, p++) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    score[p] = subject === 'screen' ? (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8 : Math.max(0, Math.min(255, mx - 1.5 * (mx - mn)));
  }
  const t = subject === 'screen' ? Math.max(45, Math.min(otsu(score), 70)) : otsu(score);
  masks.push(score.map(v => (v > t ? 1 : 0)));
  // 候補2: 写真の縁（机など背景）の色との違いで探す。白っぽい机の上の紙にも効く
  if (subject !== 'screen') {
    const ring = [[], [], []], m = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= m && x < w - m && y >= m && y < h - m) continue;
      const i = (y * w + x) * 4; ring[0].push(d[i]); ring[1].push(d[i + 1]); ring[2].push(d[i + 2]);
    }
    const bg = ring.map(a => { a.sort((u, v) => u - v); return a[a.length >> 1]; });
    const ybg = bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114;
    const diff = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < diff.length; i += 4, p++) {
      const y = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const chroma = Math.abs(d[i] - bg[0] - (y - ybg)) + Math.abs(d[i + 2] - bg[2] - (y - ybg));
      // 背景より明るい、または色が違う（影は背景より暗いだけなので含めない）
      diff[p] = Math.max(0, Math.min(255, (y - ybg) * 3 + chroma * 0.5));
    }
    const t2 = Math.max(12, otsu(diff));
    masks.push(diff.map(v => (v > t2 ? 1 : 0)));
  }
  let best = null;
  for (let mask of masks) {
    // 文字の穴を埋め、細いつながりを切る
    mask = morph(mask, w, h, 2, true); mask = morph(mask, w, h, 4, false); mask = morph(mask, w, h, 2, true);
    const q = quadOf(mask, w, h);
    if (q && (!best || q.score > best.score)) best = q;
  }
  if (!best) return null;
  // 写真の中ほどを通る辺は、内と外で明るさか色がはっきり違うはず（紙の端）。
  // 違いがなければ、照明の明暗で紙の途中を区切っただけなので使わない
  const m = Math.min(w, h) * 0.02, off = Math.max(3, Math.round(Math.min(w, h) * 0.03));
  const at = (x, y) => { const i = (Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)))) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  const cx = best.corners.reduce((s, c) => s + c[0], 0) / 4, cy = best.corners.reduce((s, c) => s + c[1], 0) / 4;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = best.corners[k], [bx, by] = best.corners[(k + 1) % 4];
    const onBorder = (Math.max(ax, bx) < m) || (Math.min(ax, bx) > w - m) || (Math.max(ay, by) < m) || (Math.min(ay, by) > h - m);
    if (onBorder) continue;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let nx = -(by - ay) / len, ny = (bx - ax) / len;
    if ((cx - ax) * nx + (cy - ay) * ny < 0) { nx = -nx; ny = -ny; } // 内向きに
    let diff = 0, n = 0;
    for (let t = 0.15; t <= 0.85; t += 0.05) {
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      const a = at(px + nx * off, py + ny * off), b = at(px - nx * off, py - ny * off);
      diff += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); n++;
    }
    if (diff / n < 40) return null;
  }
  return best.corners.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
}

// マスクからページの四角形を求める（見開きの左右のページはまとめる）
function quadOf(mask, w, h) {
  const comps = components(mask, w, h);
  if (!comps.length) return null;
  const big = comps.reduce((a, b) => (b.px.length > a.px.length ? b : a));
  // のどの影で左右に分かれたページ: 高さがほぼ重なる大きな領域を合わせる
  // （スマホを横にして撮ると見開きが上下に並ぶので、幅が重なる場合も合わせる）
  const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0.6 * Math.min(a1 - a0, b1 - b0);
  const parts = comps.filter(c => c === big || (c.px.length > big.px.length * 0.2 &&
    (overlap(c.minY, c.maxY, big.minY, big.maxY) || overlap(c.minX, c.maxX, big.minX, big.maxX))));
  const area = parts.reduce((s, c) => s + c.px.length, 0);
  if (area < w * h * 0.1 || area > w * h * 0.97) return null;
  const sel = new Uint8Array(w * h);
  for (const c of parts) for (const p of c.px) sel[p] = 1;
  // 行ごとの左端・右端、列ごとの上端・下端（輪郭の点）
  const pts = [];
  for (let y = 0; y < h; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < w; x++) if (sel[y * w + x]) { if (l < 0) l = x; r = x; }
    if (l >= 0) { pts.push([l, y]); pts.push([r + 1, y]); }
  }
  for (let x = 0; x < w; x++) {
    let t = -1, b = -1;
    for (let y = 0; y < h; y++) if (sel[y * w + x]) { if (t < 0) t = y; b = y; }
    if (t >= 0) { pts.push([x, t]); pts.push([x, b + 1]); }
  }
  const hull = convexHull(pts);
  if (hull.length < 4) return null;
  // 凸包から面積が最大になる4点を選ぶ
  const n = hull.length, ext = [0, 0, 0, 0], val = [Infinity, -Infinity, -Infinity, -Infinity];
  hull.forEach(([x, y], i) => {
    if (x + y < val[0]) { val[0] = x + y; ext[0] = i; }
    if (x - y > val[1]) { val[1] = x - y; ext[1] = i; }
    if (x + y > val[2]) { val[2] = x + y; ext[2] = i; }
    if (y - x > val[3]) { val[3] = y - x; ext[3] = i; }
  });
  const quadArea = idx => { let s = 0; for (let k = 0; k < 4; k++) { const [x1, y1] = hull[idx[k]], [x2, y2] = hull[idx[(k + 1) % 4]]; s += x1 * y2 - x2 * y1; } return Math.abs(s) / 2; };
  let idx = ext.slice();
  for (let iter = 0; iter < 4; iter++) {
    for (let k = 0; k < 4; k++) {
      const from = idx[(k + 3) % 4], to = idx[(k + 1) % 4];
      let bestI = idx[k], bestA = quadArea(idx);
      for (let i = (from + 1) % n; i !== to; i = (i + 1) % n) {
        const trial = idx.slice(); trial[k] = i;
        const a = quadArea(trial);
        if (a > bestA) { bestA = a; bestI = i; }
      }
      idx[k] = bestI;
    }
  }
  let corners = idx.map(i => hull[i].slice());
  // 各辺に沿った輪郭の点に直線を当てはめて、角の位置を正確にする（指や紙の反りの影響を減らす）
  const refined = refineQuad(corners, pts, Math.max(w, h));
  if (refined) corners = refined;
  // 机の写り込みを残さないよう、ほんの少し内側へ
  const cx = corners.reduce((s, c) => s + c[0], 0) / 4, cy = corners.reduce((s, c) => s + c[1], 0) / 4;
  corners = corners.map(([x, y]) => [x + (cx - x) * 0.006, y + (cy - y) * 0.006]);
  const qa = Math.abs(corners.reduce((s, [x1, y1], k) => { const [x2, y2] = corners[(k + 1) % 4]; return s + x1 * y2 - x2 * y1; }, 0)) / 2;
  const fill = area / Math.max(1, qa);
  // 写真の四辺すべてに張りついた四角形は、紙ではなく背景ごと拾った可能性が高い
  const m = Math.min(w, h) * 0.02;
  const hugs = corners.filter(([x, y]) => (x < m || x > w - m) && (y < m || y > h - m)).length === 4;
  // 四角形らしさ（領域が四角形をよく埋めている）と大きさで評価
  return { corners, score: Math.min(1, fill) * Math.min(1, qa / (w * h * 0.5)) * (fill > 0.8 ? 1 : 0.3) * (hugs ? 0.7 : 1) };
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  // 画面の座標（y下向き）で時計回り＝左上→右上→右下→左下の順になる
  return lower.concat(upper);
}

function refineQuad(corners, pts, size) {
  const tol = size * 0.02, lines = [];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = corners[k], [bx, by] = corners[(k + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay); if (len < 4) return null;
    const nx = -(by - ay) / len, ny = (bx - ax) / len;
    // 辺の両端10%を除いた範囲で、辺の近くにある輪郭点を使う
    let sel = pts.filter(([x, y]) => {
      const t = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (len * len);
      return t > 0.1 && t < 0.9 && Math.abs((x - ax) * nx + (y - ay) * ny) < tol;
    });
    let line = null;
    for (let it = 0; it < 3 && sel.length >= 8; it++) {
      // 全最小二乗で直線を当てはめ、外れた点を除いてやり直す
      let mx = 0, my = 0; for (const [x, y] of sel) { mx += x; my += y; } mx /= sel.length; my /= sel.length;
      let sxx = 0, sxy = 0, syy = 0; for (const [x, y] of sel) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), dx = Math.cos(th), dy = Math.sin(th);
      line = { mx, my, nx: -dy, ny: dx };
      const keep = sel.filter(([x, y]) => Math.abs((x - mx) * line.nx + (y - my) * line.ny) < Math.max(1.5, size * 0.004));
      if (keep.length === sel.length || keep.length < 8) break;
      sel = keep;
    }
    if (!line) return null;
    lines.push(line);
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const L1 = lines[(k + 3) % 4], L2 = lines[k];
    const c1 = L1.nx * L1.mx + L1.ny * L1.my, c2 = L2.nx * L2.mx + L2.ny * L2.my, det = L1.nx * L2.ny - L1.ny * L2.nx;
    if (Math.abs(det) < 1e-6) return null;
    const x = (c1 * L2.ny - L1.ny * c2) / det, y = (L1.nx * c2 - c1 * L2.nx) / det;
    // 元の角から大きく離れたら当てはめ失敗とみなす
    if (Math.hypot(x - corners[k][0], y - corners[k][1]) > size * 0.05) return null;
    out.push([x, y]);
  }
  return out;
}

export const FULL_FRAME = [[0, 0], [1, 0], [1, 1], [0, 1]];

// ---------- 台形補正 ----------
// 単位正方形 → 四角形 の射影変換（Heckbert）
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  return { a: x1 - x0 + g * x1, b: x3 - x0 + hh * x3, c: x0, d: y1 - y0 + g * y1, e: y3 - y0 + hh * y3, f: y0, g, h: hh };
}

export function warp(canvas, corners, maxSide = MAX_SIDE) {
  const W = canvas.width, H = canvas.height;
  const q = corners.map(([x, y]) => [x * W, y * H]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let ow = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, oh = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const k = Math.min(1, maxSide / Math.max(ow, oh));
  ow = Math.max(8, Math.round(ow * k)); oh = Math.max(8, Math.round(oh * k));
  const src = ctx2d(canvas).getImageData(0, 0, W, H).data;
  const out = makeCanvas(ow, oh), octx = ctx2d(out), dst = octx.createImageData(ow, oh), o = dst.data;
  const m = squareToQuad(q);
  for (let y = 0; y < oh; y++) {
    const v = (y + 0.5) / oh;
    for (let x = 0; x < ow; x++) {
      const u = (x + 0.5) / ow, z = m.g * u + m.h * v + 1;
      let sx = (m.a * u + m.b * v + m.c) / z - 0.5, sy = (m.d * u + m.e * v + m.f) / z - 0.5;
      sx = Math.min(W - 1.001, Math.max(0, sx)); sy = Math.min(H - 1.001, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      const oi = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        o[oi + c] = top + (bot - top) * fy;
      }
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

// ---------- 明るさの均一化（照明ムラ・影の除去） ----------
// 縮小→最大値フィルターで文字を消す→ぼかし→拡大 で「紙だけの明るさ」を推定する
export function estimateBackground(canvas) {
  const W = canvas.width, H = canvas.height;
  const img = shrink(canvas, 96), { width: sw, height: sh } = img;
  const pass = (src, r, op) => {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) for (let c = 0; c < 3; c++) {
      let acc = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const v = src[(Math.min(sh - 1, Math.max(0, y + dy)) * sw + Math.min(sw - 1, Math.max(0, x + dx))) * 4 + c];
        if (op === 'max') { if (v > acc) acc = v; } else { acc += v; n++; }
      }
      out[(y * sw + x) * 4 + c] = op === 'max' ? acc : acc / n;
      out[(y * sw + x) * 4 + 3] = 255;
    }
    return out;
  };
  const data = pass(pass(img.data, 3, 'max'), 3, 'mean');
  const small = makeCanvas(sw, sh);
  ctx2d(small).putImageData(new ImageData(data, sw, sh), 0, 0);
  const big = makeCanvas(W, H), b = ctx2d(big);
  b.imageSmoothingQuality = 'high';
  b.drawImage(small, 0, 0, W, H);
  return b.getImageData(0, 0, W, H).data;
}

// ---------- 指の検出 ----------
// 肌色で、ページの縁に接している領域を「指」とみなす。返り値は縮小マスクとそのサイズ
export function detectFingers(canvas) {
  const img = shrink(canvas, 320), { width: w, height: h, data: d } = img;
  let mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    mask[p] = y > 50 && cr > 138 && cr < 180 && cb > 80 && cb < 128 && r > g && g >= b * 0.9 && r - b > 25 ? 1 : 0;
  }
  // 黄ばんだ紙や電球色の照明では紙も肌色に近くなるので、紙より「はっきり赤みが強く、暗い」ところだけを指とみなす
  const crs = [], ys = [];
  for (let i = 0; i < d.length; i += 4 * 7) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    crs.push(0.5 * r - 0.418688 * g - 0.081312 * b); ys.push(0.299 * r + 0.587 * g + 0.114 * b);
  }
  crs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const paperCr = crs[Math.floor(crs.length * 0.6)], paperY = ys[Math.floor(ys.length * 0.8)];
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    if (!mask[p]) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b, y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (cr < paperCr + 12 || y > paperY * 0.93) mask[p] = 0;
  }
  mask = morph(mask, w, h, 1, false); mask = morph(mask, w, h, 2, true);
  const keep = new Uint8Array(w * h);
  let found = 0;
  for (const c of components(mask, w, h)) {
    const touches = c.minX <= 1 || c.minY <= 1 || c.maxX >= w - 2 || c.maxY >= h - 2;
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    // 縁から入り込んでいて、ページの中央まで届かない大きさのもの
    const reach = Math.min(
      c.minX <= 1 ? bw / w : 1, c.maxX >= w - 2 ? bw / w : 1,
      c.minY <= 1 ? bh / h : 1, c.maxY >= h - 2 ? bh / h : 1);
    if (!touches || c.px.length < w * h * 0.0015 || reach > 0.4) continue;
    for (const p of c.px) keep[p] = 1;
    found++;
  }
  if (!found) return null;
  // 爪や影も覆えるよう少し広げる
  return { mask: morph(keep, w, h, 3, true), w, h };
}

// ---------- 補正の適用 ----------
function median9(a) {
  // 9要素の中央値（比較交換ネットワーク）
  const s = (i, j) => { if (a[i] > a[j]) { const t = a[i]; a[i] = a[j]; a[j] = t; } };
  s(1, 2); s(4, 5); s(7, 8); s(0, 1); s(3, 4); s(6, 7); s(1, 2); s(4, 5); s(7, 8);
  s(0, 3); s(5, 8); s(4, 7); s(3, 6); s(1, 4); s(2, 5); s(4, 7); s(4, 2); s(6, 4); s(4, 2);
  return a[4];
}

// ---------- 画面（モニター）撮影向け ----------
// モアレ除去: 画素の格子とカメラが干渉してできる縞を消す。
// 縞の多くは「色」の波なので色成分は大きくならし、明るさは細かい縞だけぼかして文字の輪郭を戻す
export function demoire(canvas) {
  const W = canvas.width, H = canvas.height;
  const r = Math.max(0.8, Math.max(W, H) / 1600);
  const blurred = (src, radius, w = W, h = H) => {
    const c = makeCanvas(w, h), x = ctx2d(c);
    x.filter = `blur(${radius.toFixed(2)}px)`;
    x.drawImage(src, 0, 0, w, h);
    return c;
  };
  const src0 = ctx2d(canvas).getImageData(0, 0, W, H).data;
  // 書類なら明るさはぼかさない（文字が太らないように）。明るさの縞は補正の段階で紙の明るさで割って消す
  const doc = looksLikeDocument(src0, 150);
  const b1 = doc ? src0 : ctx2d(blurred(canvas, r)).getImageData(0, 0, W, H).data;
  const b2 = doc ? src0 : ctx2d(blurred(canvas, r * 3)).getImageData(0, 0, W, H).data;
  // 色成分用: 縮小して強くぼかしてから元の大きさへ
  const sw = Math.max(8, Math.round(W / 6)), sh = Math.max(8, Math.round(H / 6));
  const small = blurred(canvas, Math.max(2, Math.max(sw, sh) / 90), sw, sh);
  const big = makeCanvas(W, H), bx = ctx2d(big);
  bx.imageSmoothingQuality = 'high';
  bx.drawImage(small, 0, 0, W, H);
  const c = bx.getImageData(0, 0, W, H).data;
  const x = ctx2d(canvas), img = x.createImageData(W, H), o = img.data;
  for (let i = 0; i < o.length; i += 4) {
    // 明るさ: 細かい縞をぼかし、輪郭を強調し直す
    const y1 = 0.299 * b1[i] + 0.587 * b1[i + 1] + 0.114 * b1[i + 2];
    const y2 = 0.299 * b2[i] + 0.587 * b2[i + 1] + 0.114 * b2[i + 2];
    const Y = doc ? 0.299 * src0[i] + 0.587 * src0[i + 1] + 0.114 * src0[i + 2] : y1 + 0.9 * (y1 - y2);
    // 色: 広い範囲でならした色を使う
    const cb = -0.168736 * c[i] - 0.331264 * c[i + 1] + 0.5 * c[i + 2];
    const cr = 0.5 * c[i] - 0.418688 * c[i + 1] - 0.081312 * c[i + 2];
    o[i] = Y + 1.402 * cr;
    o[i + 1] = Y - 0.344136 * cb - 0.714136 * cr;
    o[i + 2] = Y + 1.772 * cb;
    o[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
}

// 画面向けの色補正: チャンネルごとに暗部と明部を伸ばし、白を白に戻す（青っぽさ・黄ばみを取る）
function screenLevels(d) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let i = 0; i < d.length; i += 16) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; n++; }
  const lut = hist.map(hc => {
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hc[v]; if (acc >= n * 0.005) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hc[v]; if (acc >= n * 0.01) { hi = v; break; } }
    if (hi - lo < 40) { lo = 0; hi = 255; }
    const t = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) t[v] = 255 * Math.pow(Math.min(1, Math.max(0, (v - lo) / (hi - lo))), 1.1);
    return t;
  });
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[0][d[i]]; d[i + 1] = lut[1][d[i + 1]]; d[i + 2] = lut[2][d[i + 2]];
    // 白に近い背景は白にそろえ、薄い縞やにじみを消す
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mn > 205) {
      const k = Math.min(1, (mn - 205) / 30);
      d[i] += (255 - d[i]) * k; d[i + 1] += (255 - d[i + 1]) * k; d[i + 2] += (255 - d[i + 2]) * k;
    }
  }
}

// ---------- 書類の背景を整える ----------
function luma(d, W, H) {
  const Y = new Uint8ClampedArray(W * H);
  for (let p = 0, i = 0; p < Y.length; p++, i += 4) Y[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return Y;
}

// 白っぽい背景に文字が載った画像か（画面に表示した書類など）
function looksLikeDocument(d, brightLevel = 170) {
  let bright = 0, sat = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 13) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx > brightLevel) bright++;
    sat += mx - mn; n++;
  }
  return bright / n > 0.6 && sat / n < 28;
}

// 細かい縞（モアレ）を消す: 文字以外の画素から、すぐ近くの紙の明るさを求めて割る。
// 文字の部分は少し広い範囲の紙から補う。縞の周期より狭い範囲で追うので、縞そのものが打ち消される
function flattenFine(d, W, H) {
  const Y = luma(d, W, H), paper = new Float32Array(W * H);
  const isText = new Uint8Array(W * H);
  for (let p = 0; p < Y.length; p++) if (Y[p] < 200) isText[p] = 1;
  // 文字の縁のにじみも紙に含めないよう、1画素ふくらませる
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (isText[p] || (x > 0 && isText[p - 1]) || (x < W - 1 && isText[p + 1]) || (y > 0 && isText[p - W]) || (y < H - 1 && isText[p + W])) mask[p] = 1;
  }
  // 積分画像で、紙の画素だけの平均を求める
  const S = new Int32Array((W + 1) * (H + 1)), N = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0, rn = 0;
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!mask[p]) { rs += Y[p]; rn++; }
      const q = (y + 1) * (W + 1) + x + 1;
      S[q] = S[q - W - 1] + rs; N[q] = N[q - W - 1] + rn;
    }
  }
  const W1 = W + 1;
  let bs = 0, bn = 0;
  const box = (x, y, r) => {
    const x0 = x > r ? x - r : 0, y0 = y > r ? y - r : 0, x1 = x + r + 1 < W ? x + r + 1 : W, y1 = y + r + 1 < H ? y + r + 1 : H;
    const a = y0 * W1 + x0, b = y0 * W1 + x1, c = y1 * W1 + x0, e = y1 * W1 + x1;
    bs = S[e] - S[b] - S[c] + S[a]; bn = N[e] - N[b] - N[c] + N[a];
  };
  const r1 = Math.max(1, Math.round(Math.max(W, H) / 1200)), r2 = r1 * 6, r3 = r1 * 24, need = (2 * r1 + 1) ** 2 * 0.3;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    box(x, y, r1);
    if (bn < need) { box(x, y, r2); if (bn < 8) box(x, y, r3); }
    paper[y * W + x] = bn ? bs / bn : 250;
  }
  for (let p = 0, i = 0; p < paper.length; p++, i += 4) {
    const k = 250 / Math.max(150, paper[p]);
    d[i] = d[i] * k; d[i + 1] = d[i + 1] * k; d[i + 2] = d[i + 2] * k;
  }
}

// 紙を白・文字の芯を黒にする直線の濃度補正。曲線をかけないので、文字が太らず輪郭もなめらかなまま
function documentTone(d, Y, W, H) {
  const hist = new Uint32Array(256);
  for (let p = 0; p < Y.length; p += 3) hist[Y[p]]++;
  const total = hist.reduce((a, b) => a + b, 0);
  const pct = q => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * q) return v; } return 255; };
  // 文字の芯の濃さは、文字のある小さな区画ごとに調べた値から決める。画像全体のいちばん暗い所で
  // 決めると、端に写り込んだ机・影・指のような真っ黒な部分に引っぱられて、文字が灰色のまま残る
  const G = Math.max(16, Math.round(Math.max(W, H) / 48)), cells = [], ch = new Uint32Array(256);
  for (let gy = 0; gy + G <= H; gy += G) for (let gx = 0; gx + G <= W; gx += G) {
    ch.fill(0); let n = 0;
    for (let y = gy; y < gy + G; y += 2) for (let x = gx; x < gx + G; x += 2) { ch[Y[y * W + x]]++; n++; }
    let acc = 0, med = 0, ink = 0;
    for (; med < 256; med++) { acc += ch[med]; if (acc >= n * 0.5) break; }
    if (med < 200) continue; // 紙の少ない区画（図・帯・紙の外）
    acc = 0; for (; ink < 256; ink++) { acc += ch[ink]; if (acc >= n * 0.03) break; }
    if (med - ink > 50) cells.push(ink);
  }
  cells.sort((a, b) => a - b);
  const paper = pct(0.6), darkest = pct(0.004);
  const core = cells.length >= 12 ? cells[Math.floor(cells.length * 0.15)] : darkest;
  const black = Math.min(Math.max(darkest, core), paper - 90);
  const white = Math.max(black + 60, paper - 16), k = 255 / (white - black);
  const lut = new Uint8ClampedArray(256);
  // 芯はほぼ黒に、中間調は少し濃く（小さい文字やかすれた文字も読みやすく）
  for (let v = 0; v < 256; v++) { const t = Math.min(1, Math.max(0, (v - black) * k / 255)); lut[v] = 8 + 247 * Math.pow(t, 1.15); }
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
}

// ---------- 光の反射（白飛び）で薄くなった文字を戻す ----------
// 照明の映り込みがあると、その周りだけ紙と文字の差が小さくなり、文字が薄く写る。
// 細かい区画ごとに「いちばん濃い文字の濃さ」を調べ、周り一帯の文字がそろって薄い所だけ、
// 紙の白さを保ったまま文字の濃さを広げる。灰色で印刷された行のように、すぐ近くに濃い文字が
// ある所は元から薄い印刷なので、そのままにする。紙は白（250前後）にそろえてある前提
function liftFaded(d, W, H) {
  // 区画は文字1〜2字ぶん。1行の中で一部の字だけ光って薄くなった所も、その字だけ濃くできる
  const G = Math.max(10, Math.round(Math.max(W, H) / 96)), gw = Math.ceil(W / G), gh = Math.ceil(H / G);
  // 区画ごとの紙の明るさ（中央値）と、文字の濃さとの差（コントラスト）
  const paper = new Float32Array(gw * gh).fill(NaN), con = new Float32Array(gw * gh).fill(NaN), hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    hist.fill(0); let n = 0;
    for (let y = gy * G; y < Math.min(H, gy * G + G); y++) for (let x = gx * G; x < Math.min(W, gx * G + G); x++) {
      const i = (y * W + x) * 4; hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; n++;
    }
    if (!n) continue;
    let acc = 0, ink = 0, med = 0;
    for (; ink < 256; ink++) { acc += hist[ink]; if (acc >= Math.max(2, n * 0.02)) break; }
    acc = 0; for (; med < 256; med++) { acc += hist[med]; if (acc >= n * 0.5) break; }
    if (med < 215) continue; // 紙の部分が少ない区画（図・写真・見出しの帯）
    paper[gy * gw + gx] = med;
    let dark = 0; for (let u = 0; u < med - 8; u++) dark += hist[u];
    if (dark >= n * 0.02) con[gy * gw + gx] = med - ink; // 文字のある区画
  }
  const vals = Array.from(con).filter(v => !isNaN(v)).sort((a, b) => a - b);
  if (vals.length < 20) return;
  const ref = vals[Math.floor(vals.length * 0.6)]; // ふつうの文字のコントラスト
  if (ref < 40) return; // 全体が淡い（もともと薄い印刷・鉛筆など）は何もしない
  // 文字と紙の差が、ふつうの文字よりはっきり小さい区画を濃くする。
  // 周り一帯がそろって薄い（強い白飛び）ときは大きく、その区画だけ薄いときは控えめに
  const R = 2, gain = new Float32Array(gw * gh).fill(1);
  let any = false;
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const own = con[gy * gw + gx];
    if (isNaN(own) || own > ref * 0.72) continue;
    let m = 0, cnt = 0, edge = false;
    for (let yy = Math.max(0, gy - R); yy <= Math.min(gh - 1, gy + R); yy++) for (let xx = Math.max(0, gx - R); xx <= Math.min(gw - 1, gx + R); xx++) {
      const v = con[yy * gw + xx]; if (!isNaN(v)) { m = Math.max(m, v); cnt++; }
      // 紙でない所（見出しの帯・図）のすぐそばは濃くしない
      if (Math.abs(yy - gy) <= 1 && Math.abs(xx - gx) <= 1 && isNaN(paper[yy * gw + xx])) edge = true;
    }
    if (edge) continue;
    const all = cnt >= 6 && m <= ref * 0.6;
    gain[gy * gw + gx] = Math.min(all ? 8 : 3, ref * (all ? 1 : 0.92) / Math.max(4, own));
    any = true;
  }
  if (!any) return;
  // 紙の明るさの抜けた区画を周りで埋め、区画の境目が見えないよう、なめらかにつなぐ
  const smooth = (src, keepMax) => {
    const o = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let s = 0, c = 0;
      for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy++) for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx++) { const v = src[yy * gw + xx]; if (!isNaN(v)) { s += v; c++; } }
      const own = src[gy * gw + gx];
      o[gy * gw + gx] = !c ? NaN : keepMax ? (isNaN(paper[gy * gw + gx]) ? 1 : Math.max(own * 0.6 + 0.4, s / c)) : s / c;
    }
    return o;
  };
  let g2 = gain, p2 = paper;
  for (let it = 0; it < 3; it++) { g2 = smooth(g2, true); p2 = smooth(p2, false); }
  const at = (arr, x, y, dflt) => {
    const fx = Math.min(gw - 1, Math.max(0, x / G - 0.5)), fy = Math.min(gh - 1, Math.max(0, y / G - 0.5));
    const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    const g = (xx, yy) => { const v = arr[yy * gw + xx]; return isNaN(v) ? dflt : v; };
    return (g(x0, y0) * (1 - tx) + g(x1, y0) * tx) * (1 - ty) + (g(x0, y1) * (1 - tx) + g(x1, y1) * tx) * ty;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = at(g2, x, y, 1);
    if (k <= 1.01) continue;
    // 紙の明るさを白(250)に、文字との差を k 倍に
    const P = Math.max(150, at(p2, x, y, 250)), i = (y * W + x) * 4;
    for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.max(0, Math.min(255, 250 - (P - d[i + ch]) * k));
  }
}

// べた塗りの所（紙の白がほとんど見えない、ある程度の広さの暗い面）を見つけ、ざらつきをならす。
// d と Y を書き換え、べた塗りの画素を 1 にしたマスクを返す（なければ null）
function smoothFills(d, Y, S, W, H) {
  const r = Math.max(3, Math.round(Math.max(W, H) / 260)), W1 = W + 1;
  const integ = f => { const I = new Uint32Array(W1 * (H + 1)); for (let y = 0; y < H; y++) { let rs = 0; for (let x = 0; x < W; x++) { rs += f(y * W + x); I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + rs; } } return I; };
  const box = (I, x, y, rr) => { const x0 = Math.max(0, x - rr), y0 = Math.max(0, y - rr), x1 = Math.min(W, x + rr + 1), y1 = Math.min(H, y + rr + 1); return [I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0], (x1 - x0) * (y1 - y0)]; };
  // 候補: 周りの平均が暗く、紙の白い画素がほとんどない
  const IY = integ(p => Y[p]), IW = integ(p => (Y[p] >= 232 ? 1 : 0));
  const cand = new Uint8Array(W * H); let any = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [sy, n] = box(IY, x, y, r), [sw] = box(IW, x, y, r);
    if (sy / n < 205 && sw < n * 0.18) { cand[y * W + x] = 1; any++; }
  }
  if (any < W * H * 0.002) return null;
  // 広さのあるものだけ（線の詰まった字は周りに紙の白があるので、広い範囲では候補が続かない）
  const IC = integ(p => cand[p]), core = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!cand[y * W + x]) continue; const [c, n] = box(IC, x, y, r * 2); if (c > n * 0.82) core[y * W + x] = 1; }
  const IK = integ(p => core[p]), fill = new Uint8Array(W * H); any = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = y * W + x; if (cand[p] && Y[p] < 232 && box(IK, x, y, r * 2)[0] > 0) { fill[p] = 1; any++; } }
  if (!any) return null;
  // べた塗りの画素だけの平均でならす。平均から大きく離れた画素（白抜きの字・中の線）はそのまま
  const IF = integ(p => fill[p]), IFY = integ(p => (fill[p] ? Y[p] : 0));
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (!fill[p]) continue;
    // 白抜きの字や線は数画素まとまって平均から離れる（3x3平均 S で見る）。ざらつきは1画素ごとにばらつくだけ
    const [n] = box(IF, x, y, r), [sy] = box(IFY, x, y, r), mean = sy / n, df = Math.abs(S[p] - mean);
    const t = Math.min(1, Math.max(0.3, (df - 5) / 8)); // 小さいほど強くならす。1: そのまま
    out[p] = mean + (Y[p] - mean) * t;
  }
  for (let p = 0, i = 0; p < fill.length; p++, i += 4) {
    if (!fill[p]) continue;
    // 色のついた塗り（色帯・写真）は色を保ち、明るさだけならす
    const dv = out[p] - Y[p];
    d[i] += dv; d[i + 1] += dv; d[i + 2] += dv; Y[p] = out[p];
  }
  return fill;
}

// 背景のまだら・縞・薄い汚れを白にし、点状のゴミとページ端の線を消す。
// binarize: 文字を黒・背景を白にくっきり分ける（白黒）
function cleanDocument(d, W, H, { binarize, fine = false }) {
  // 画面の細かい縞を打ち消す処理。紙の写真では薄い・ぼけた文字まで紙と見なして消してしまうので使わない
  if (fine) flattenFine(d, W, H);
  else liftFaded(d, W, H);
  const Y = luma(d, W, H);
  // 3x3平均で判定する（細かい縞やJPEGのざらつきに引っぱられないように）
  const S = new Uint8ClampedArray(W * H), row = new Uint16Array(W * H);
  // 横→縦の2回に分けて足し合わせる（速い）
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) row[o + x] = Y[o + x] + (x > 0 ? Y[o + x - 1] : Y[o + x]) + (x < W - 1 ? Y[o + x + 1] : Y[o + x]);
  }
  for (let y = 0; y < H; y++) {
    const o = y * W, up = y > 0 ? o - W : o, dn = y < H - 1 ? o + W : o;
    for (let x = 0; x < W; x++) S[o + x] = (row[up + x] + row[o + x] + row[dn + x]) / 9;
  }
  const sample = [];
  for (let p = 0; p < S.length; p += 7) sample.push(S[p]);
  const t = Math.min(200, Math.max(90, otsu(sample)));
  if (binarize) {
    // 境目を文字側に寄せて、白黒でも文字が太らないようにする
    const lo = t - 45, hi = Math.min(245, t + 15);
    for (let p = 0, i = 0; p < Y.length; p++, i += 4) {
      const sharp = Y[p] + 0.9 * (Y[p] - S[p]);
      const v = Math.max(0, Math.min(255, (sharp - lo) * 255 / (hi - lo)));
      d[i] = d[i + 1] = d[i + 2] = S[p] >= hi ? 255 : v;
    }
  } else {
    // 見出しの帯・図の塗りのような「べた塗り」の所は、印刷の網点や紙のざらつきが輪郭の強調で
    // まだら・砂目になる。そこは強調せず、ならして元のなめらかな濃淡に戻す（中の白抜き文字は残す）
    const fill = smoothFills(d, Y, S, W, H);
    // 輪郭を少し締めて、にじんだ文字を細く・くっきりさせる
    for (let p = 0, i = 0; p < Y.length; p++, i += 4) {
      if (fill && fill[p]) continue;
      const dv = 0.9 * (Y[p] - S[p]);
      if (dv) { d[i] += dv; d[i + 1] += dv; d[i + 2] += dv; }
    }
    documentTone(d, Y, W, H);
  }
  // 点状のゴミ（文字にしては小さすぎる暗い点）を消す
  const Y2 = luma(d, W, H), dark = new Uint8Array(W * H);
  for (let p = 0; p < dark.length; p++) dark[p] = Y2[p] < 215 ? 1 : 0;
  const maxArea = Math.max(4, Math.round((Math.max(W, H) / 1400) ** 2 * 9));
  // 近くにほかの文字がある点（句読点・点線「……」・濁点など）は残すため、暗い画素の数を積分画像で数える
  const W1 = W + 1, I = new Int32Array(W1 * (H + 1));
  for (let y = 0; y < H; y++) { let rs = 0; for (let x = 0; x < W; x++) { rs += dark[y * W + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + rs; } }
  const count = (x0, y0, x1, y1) => { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1); return I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]; };
  const R = Math.max(6, Math.round(Math.max(W, H) / 120));
  // 文字とみなす芯の濃さ。紙の写真では薄い灰色の印刷や光って薄くなった文字も残す
  const coreMax = fine ? 150 : 185;
  for (const c of components(dark, W, H)) {
    // 小さすぎて周りに何もない点、または濃い芯のない薄いまだら（画面の縞・ざらつき）は文字ではない
    let core = 255;
    for (const p of c.px) if (Y2[p] < core) core = Y2[p];
    if (c.px.length > maxArea && (core < coreMax || c.px.length > maxArea * 40)) continue;
    if (c.px.length <= maxArea && core < coreMax && count(c.minX - R, c.minY - R, c.maxX + R + 1, c.maxY + R + 1) > c.px.length) continue;
    for (const p of c.px) d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 255;
  }
  // ページの端にかかった暗いかたまり（影になった指・のどの奥・本の外の机など）を消す。
  // 文字は端に接しないので、端に接していて文字より大きく、中まで詰まった暗い部分だけを対象にする
  const big = Math.max(W, H) / 50;
  for (const c of components(dark, W, H)) {
    if (c.minX > 1 && c.minY > 1 && c.maxX < W - 2 && c.maxY < H - 2) continue;
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (Math.max(bw, bh) < big || c.px.length > W * H * 0.06 || c.px.length < bw * bh * 0.3) continue;
    // 端に太く接しているものだけ（細い線で端とつながっただけの見出しの帯などは中身なので残す）
    let contact = 0;
    for (const p of c.px) { const x = p % W, y = (p - x) / W; if (x <= 1 || y <= 1 || x >= W - 2 || y >= H - 2) contact++; }
    if (contact < Math.min(bw, bh) * 0.3) continue;
    // 端からページの奥まで（4割以上）のびているもの（端まで続く見出しの帯・図など）は中身
    // 接している辺から測った奥行き（割合）
    const depthFrac = Math.min(c.minX <= 1 ? (c.maxX + 1) / W : 1, c.maxX >= W - 2 ? (W - c.minX) / W : 1,
      c.minY <= 1 ? (c.maxY + 1) / H : 1, c.maxY >= H - 2 ? (H - c.minY) / H : 1);
    if (depthFrac > 0.4) continue;
    for (const p of c.px) d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 255;
  }
  // 線の判定は薄いグレーも含める（かすれた縁の線も消せるように）
  for (let p = 0; p < dark.length; p++) dark[p] = d[p * 4] < 235 || d[p * 4 + 1] < 235 || d[p * 4 + 2] < 235 ? 1 : 0;
  removeEdgeLines(d, W, H, dark);
}

// ページの縁に沿った長い線（元の紙の端・とじ目・画面の枠）を消す
function removeEdgeLines(d, W, H, dark) {
  const whiten = p => { d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 255; };
  const mx = Math.round(W * 0.05), my = Math.round(H * 0.05);
  const isDark = (x, y) => dark[y * W + x] || (x > 0 && dark[y * W + x - 1]) || (x < W - 1 && dark[y * W + x + 1]);
  const isDarkV = (x, y) => dark[y * W + x] || (y > 0 && dark[(y - 1) * W + x]) || (y < H - 1 && dark[(y + 1) * W + x]);
  // 線は細いものだけ。見出しの帯や枠の太い部分など、太い暗い帯は中身なので残す
  const thin = Math.max(4, Math.round(Math.max(W, H) * 0.006));
  const colHit = new Uint8Array(W), rowHit = new Uint8Array(H);
  for (const x of [...Array(mx).keys(), ...Array.from({ length: mx }, (_, i) => W - 1 - i)]) {
    let run = 0, best = 0;
    for (let y = 0; y < H; y++) { run = isDark(x, y) ? run + 1 : 0; if (run > best) best = run; }
    if (best > H * 0.15) colHit[x] = 1;
  }
  for (const y of [...Array(my).keys(), ...Array.from({ length: my }, (_, i) => H - 1 - i)]) {
    let run = 0, best = 0;
    for (let x = 0; x < W; x++) { run = isDarkV(x, y) ? run + 1 : 0; if (run > best) best = run; }
    if (best > W * 0.15) rowHit[y] = 1;
  }
  // 帯の外側（数画素先）も同じ場所が暗ければ、太いもの（文字の入った見出しの帯など）の一部
  const thick = (a, b, n, get, len) => {
    const m = (a + b) >> 1; let base = 0, out = 0;
    for (let t = 0; t < len; t++) {
      if (!get(m, t)) continue; base++;
      const p1 = a - 3, p2 = b + 3;
      if ((p1 >= 0 && get(p1, t)) || (p2 < n && get(p2, t))) out++;
    }
    return base > 0 && out > base * 0.5;
  };
  const bands = (hit, n, get, len) => { const out = []; for (let i = 0; i < n; i++) { if (!hit[i]) continue; let j = i; while (j + 1 < n && hit[j + 1]) j++; if (j - i + 1 <= thin && !thick(i, j, n, get, len)) out.push([i, j]); i = j; } return out; };
  for (const [a, b] of bands(colHit, W, (x, y) => dark[y * W + x], H)) for (let x = a - 2; x <= b + 2; x++) if (x >= 0 && x < W) for (let y = 0; y < H; y++) if (dark[y * W + x]) whiten(y * W + x);
  for (const [a, b] of bands(rowHit, H, (y, x) => dark[y * W + x], W)) for (let y = a - 2; y <= b + 2; y++) if (y >= 0 && y < H) for (let x = 0; x < W; x++) if (dark[y * W + x]) whiten(y * W + x);
}

// 色ムラ補正: 紙や文字に出る薄い色かぶり・まだらな色を消し、はっきりした色（印鑑・図・写真）は残す
function removeColorBlotches(d, W, H) {
  const S = 8, gw = Math.ceil(W / S), gh = Math.ceil(H / S);
  const cb = new Float32Array(gw * gh), cr = new Float32Array(gw * gh), n = new Float32Array(gw * gh);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, g = ((y / S) | 0) * gw + ((x / S) | 0);
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    cb[g] += -0.168736 * r - 0.331264 * gg + 0.5 * b;
    cr[g] += 0.5 * r - 0.418688 * gg - 0.081312 * b;
    n[g]++;
  }
  for (let g = 0; g < n.length; g++) { cb[g] /= n[g]; cr[g] /= n[g]; }
  // 周囲と平均して、まだら模様をならす
  const blur = a => {
    const o = new Float32Array(a.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
        s += a[yy * gw + xx]; c++;
      }
      o[y * gw + x] = s / c;
    }
    return o;
  };
  const sb = blur(cb), sr = blur(cr);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, (y / S) | 0);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, g = gy * gw + Math.min(gw - 1, (x / S) | 0);
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const Y = 0.299 * r + 0.587 * gg + 0.114 * b;
      const pcb = -0.168736 * r - 0.331264 * gg + 0.5 * b, pcr = 0.5 * r - 0.418688 * gg - 0.081312 * b;
      // 周辺の色の濃さ。薄い色（ムラ）は0に、濃い色はそのまま
      const local = Math.hypot(sb[g], sr[g]), own = Math.hypot(pcb, pcr);
      const strength = Math.max(local, own * 0.6);
      let k = Math.min(1, Math.max(0, (strength - 9) / 16));
      if (Y > 215) k *= Math.max(0, (245 - Y) / 30); // 明るい紙の部分はより強く無彩色に
      const ncb = pcb * k, ncr = pcr * k;
      d[i] = Y + 1.402 * ncr;
      d[i + 1] = Y - 0.344136 * ncb - 0.714136 * ncr;
      d[i + 2] = Y + 1.772 * ncb;
    }
  }
}

export function enhance(canvas, { filter, fingers, denoise, evenColor = true }) {
  let docColor = false;
  const W = canvas.width, H = canvas.height, x = ctx2d(canvas);
  const img = x.getImageData(0, 0, W, H), d = img.data;

  // 指: 先に紙の色で塗りつぶしてから明るさを推定する（肌色が周りの補正に影響しないように）
  let fingerMask = null;
  if (fingers) {
    const f = detectFingers(canvas);
    if (f) {
      fingerMask = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        const my = Math.min(f.h - 1, (y * f.h / H) | 0);
        for (let x2 = 0; x2 < W; x2++) if (f.mask[my * f.w + Math.min(f.w - 1, (x2 * f.w / W) | 0)]) fingerMask[y * W + x2] = 1;
      }
      // 行ごとに、指の左右にある紙の色（近くの明るい画素）でつないで塗る
      const paperAt = (y, from, dir) => {
        let best = -1, bi = -1;
        for (let k = 0, xx = from; k < 24 && xx >= 0 && xx < W; k++, xx += dir) {
          const p = y * W + xx;
          if (fingerMask[p]) continue;
          const l = d[p * 4] + d[p * 4 + 1] + d[p * 4 + 2];
          if (l > best) { best = l; bi = p; }
        }
        return bi < 0 ? null : [d[bi * 4], d[bi * 4 + 1], d[bi * 4 + 2]];
      };
      for (let y = 0; y < H; y++) {
        let x2 = 0;
        while (x2 < W) {
          if (!fingerMask[y * W + x2]) { x2++; continue; }
          const start = x2;
          while (x2 < W && fingerMask[y * W + x2]) x2++;
          const L = start > 0 ? paperAt(y, start - 1, -1) : null, R = x2 < W ? paperAt(y, x2, 1) : null;
          const A = L || R, B = R || L;
          if (!A) continue;
          for (let xx = start; xx < x2; xx++) {
            const t = (xx - start + 0.5) / (x2 - start), i = (y * W + xx) * 4;
            for (let c = 0; c < 3; c++) d[i + c] = A[c] + (B[c] - A[c]) * t;
          }
        }
      }
      x.putImageData(img, 0, 0);
    }
  }

  if (filter === 'screen') {
    // 画面に表示した書類（白っぽい背景に文字）なら、明るさの縞と色かぶりを背景で割って消し、紙のように仕上げる
    const bg = estimateBackground(canvas);
    const flat = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      flat[i] = d[i] * 250 / Math.max(bg[i], 1);
      flat[i + 1] = d[i + 1] * 250 / Math.max(bg[i + 1], 1);
      flat[i + 2] = d[i + 2] * 250 / Math.max(bg[i + 2], 1);
      flat[i + 3] = 255;
    }
    if (looksLikeDocument(flat)) {
      d.set(flat);
      cleanDocument(d, W, H, { binarize: false, fine: true });
    } else {
      screenLevels(d);
      // 背景（白い画面やタイトルバーの地の色）に近い部分をその色にそろえ、明るさの縞を消す
      x.putImageData(img, 0, 0);
      const bg2 = estimateBackground(canvas);
      for (let i = 0; i < d.length; i += 4) {
        const yy = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const yb = Math.max(1, 0.299 * bg2[i] + 0.587 * bg2[i + 1] + 0.114 * bg2[i + 2]);
        const k = Math.min(1, Math.max(0, (yy / yb - 0.78) / 0.12));
        if (k > 0) { d[i] += (bg2[i] - d[i]) * k; d[i + 1] += (bg2[i + 1] - d[i + 1]) * k; d[i + 2] += (bg2[i + 2] - d[i + 2]) * k; }
      }
    }
  } else if (filter !== 'none') {
    const bg = estimateBackground(canvas);
    // gray/color はなめらかに、bw は文字をくっきり（ほぼ2値）にする
    const gamma = filter === 'gray' ? 1.6 : 1.35, lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = filter === 'color' ? 255 * Math.pow(i / 255, gamma) : i;
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, d[i] * 250 / Math.max(bg[i], 1));
      d[i + 1] = Math.min(255, d[i + 1] * 250 / Math.max(bg[i + 1], 1));
      d[i + 2] = Math.min(255, d[i + 2] * 250 / Math.max(bg[i + 2], 1));
    }
    // 本や書類のページ（白っぽい紙に文字）は、紙を白・文字をくっきりに仕上げる（色のある部分は残す）
    docColor = filter === 'color' && looksLikeDocument(d);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (filter === 'bw' || filter === 'gray') {
        d[i] = d[i + 1] = d[i + 2] = lut[Math.round(0.299 * r + 0.587 * g + 0.114 * b)];
      } else if (!docColor) {
        d[i] = lut[r]; d[i + 1] = lut[g]; d[i + 2] = lut[b];
      }
    }
    if (filter === 'color' && evenColor) removeColorBlotches(d, W, H);
    if (docColor) cleanDocument(d, W, H, { binarize: false });
    if (filter === 'bw' || filter === 'gray') cleanDocument(d, W, H, { binarize: filter === 'bw' });
    if (fingerMask) for (let p = 0; p < W * H; p++) if (fingerMask[p]) d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 255;
  }

  if (denoise && filter !== 'none' && filter !== 'screen' && !docColor && filter !== 'gray' && filter !== 'bw') {
    // 紙のざらつき・薄い汚れを白に寄せる
    for (let i = 0; i < d.length; i += 4) {
      const mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mn > 200) {
        const k = Math.min(1, (mn - 200) / 30);
        d[i] += (255 - d[i]) * k; d[i + 1] += (255 - d[i + 1]) * k; d[i + 2] += (255 - d[i + 2]) * k;
      }
    }
    // 明るさに3x3メディアンをかけて点状のノイズを消す（色みは保つ）
    const lum = new Uint8ClampedArray(W * H);
    for (let p = 0, i = 0; p < lum.length; p++, i += 4) lum[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    const buf = new Uint8ClampedArray(9);
    for (let y = 1; y < H - 1; y++) for (let x2 = 1; x2 < W - 1; x2++) {
      const p = y * W + x2;
      buf[0] = lum[p - W - 1]; buf[1] = lum[p - W]; buf[2] = lum[p - W + 1];
      buf[3] = lum[p - 1]; buf[4] = lum[p]; buf[5] = lum[p + 1];
      buf[6] = lum[p + W - 1]; buf[7] = lum[p + W]; buf[8] = lum[p + W + 1];
      const m = median9(buf), diff = m - lum[p];
      if (diff) { const i = p * 4; d[i] += diff; d[i + 1] += diff; d[i + 2] += diff; }
    }
  }
  x.putImageData(img, 0, 0);
}

// 写真の縁に乗っていない辺の数（4なら、ページ全体が写真の中に収まって端まで見えている）
function insideSides(c) {
  const m = 0.02;
  let n = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = c[k], [bx, by] = c[(k + 1) % 4];
    if (!(Math.max(ax, bx) < m || Math.min(ax, bx) > 1 - m || Math.max(ay, by) < m || Math.min(ay, by) > 1 - m)) n++;
  }
  return n;
}

// 4点を 左上・右上・右下・左下 の順に並べる
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // atan2 の小さい順 = 左上(-135°付近)から時計回り
  let start = 0, best = Infinity;
  sorted.forEach((p, i) => { if (p[0] + p[1] < best) { best = p[0] + p[1]; start = i; } });
  return [0, 1, 2, 3].map(k => sorted[(start + k) % 4]);
}

// 点の集まりに直線を当てはめる（外れた点を除きながら）。{ mx, my, dx, dy } 方向つき
function fitLine(pts, tol, dir) {
  let sel = pts;
  let line = null;
  for (let it = 0; it < 4 && sel.length >= 2; it++) {
    let mx = 0, my = 0; for (const [x, y] of sel) { mx += x; my += y; } mx /= sel.length; my /= sel.length;
    let dx, dy;
    if (dir) { [dx, dy] = dir; } else {
      let sxx = 0, sxy = 0, syy = 0; for (const [x, y] of sel) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); dx = Math.cos(th); dy = Math.sin(th);
    }
    line = { mx, my, dx, dy };
    const keep = sel.filter(([x, y]) => Math.abs((x - mx) * -dy + (y - my) * dx) < tol);
    if (keep.length === sel.length || keep.length < Math.max(2, sel.length * 0.4)) break;
    sel = keep;
  }
  return line;
}
const meet = (a, b) => {
  const det = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(det) < 1e-6) return null;
  const t = ((b.mx - a.mx) * b.dy - (b.my - a.my) * b.dx) / det;
  return [a.mx + a.dx * t, a.my + a.dy * t];
};
const shiftLine = (l, nx, ny, d) => ({ ...l, mx: l.mx + nx * d, my: l.my + ny * d });

// ---------- 本文の行からページの範囲を求める ----------
// 文字認識の検出で見つけた行（両端の点）から、本文のかたまりごとに四辺の直線を求める。
// 本文の左右の端（行頭・行末）と最初・最後の行は印刷でまっすぐそろっているので、
// 写真の台形のゆがみと傾きがわかる。lines: [{ a:[x,y], b:[x,y], t }]（割合）
// 返り値: かたまりごとに { corners（余白を足した四隅・割合）, cx, wide }。行の多い順
// 行が縦（縦書き）か。写真の向きを直したあとの行で判定する
export function linesVertical(lines) {
  let v = 0, t = 0;
  for (const l of lines || []) { const dx = Math.abs(l.b[0] - l.a[0]), dy = Math.abs(l.b[1] - l.a[1]), len = Math.hypot(dx, dy); t += len; if (dy > dx) v += len; }
  return t ? v > t / 2 : null;
}

export function linesQuads(lines, W, H) {
  if (!lines || lines.length < 6) return [];
  const S = Math.max(W, H);
  let L = lines.map(l => {
    const a = [l.a[0] * W, l.a[1] * H], b = [l.b[0] * W, l.b[1] * H];
    return { a, b, t: l.t * S, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
  // 縦書き（行が縦）なら x と y を入れかえて同じ処理をする
  const vert = L.filter(l => Math.abs(l.b[1] - l.a[1]) > Math.abs(l.b[0] - l.a[0])).reduce((s, l) => s + l.len, 0);
  const vertical = vert > L.reduce((s, l) => s + l.len, 0) / 2;
  if (vertical) L = L.map(l => ({ ...l, a: [l.a[1], l.a[0]], b: [l.b[1], l.b[0]] }));
  // 横向きの行だけ使い、左→右の順にそろえる
  L = L.filter(l => Math.abs(l.b[1] - l.a[1]) < Math.abs(l.b[0] - l.a[0])).map(l => (l.a[0] <= l.b[0] ? l : { ...l, a: l.b, b: l.a }));
  if (L.length < 6) return [];
  // 行の間隔（上下に重なって並ぶ、いちばん近い行までの距離の中央値）。検出した行は実際の文字より細いので、間隔を目安にする
  const midY = l => (l.a[1] + l.b[1]) / 2;
  const gaps = [];
  for (const p of L) {
    let best = Infinity;
    for (const q of L) {
      if (q === p || Math.min(p.b[0], q.b[0]) - Math.max(p.a[0], q.a[0]) < Math.min(p.len, q.len) * 0.3) continue;
      const dy = Math.abs(midY(q) - midY(p));
      if (dy > 0 && dy < best) best = dy;
    }
    if (best < Infinity) gaps.push(best);
  }
  if (gaps.length < 4) return [];
  gaps.sort((x, y) => x - y);
  const pitch = gaps[gaps.length >> 1], cs = pitch * 0.6;
  // 行どうしをつないで本文のかたまりにする（上下の行間は狭く、ページとページの間は広い）
  const parent = L.map((_, i) => i), find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const p = L[i], q = L[j];
    const gapX = Math.max(p.a[0], q.a[0]) - Math.min(p.b[0], q.b[0]); // 負なら横方向に重なる
    const yp = (p.a[1] + p.b[1]) / 2, yq = (q.a[1] + q.b[1]) / 2;
    if (gapX < pitch * 1.2 && Math.abs(yp - yq) < pitch * 2.2) parent[find(i)] = find(j);
  }
  const groups = new Map();
  L.forEach((l, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); });
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 5) continue;
    const q = blockQuad(g, cs, pitch);
    if (!q) continue;
    let pts = q;
    if (vertical) pts = pts.map(([x, y]) => [y, x]);
    const corners = orderCorners(pts);
    const qw = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]), qh = Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]);
    out.push({ corners: corners.map(([x, y]) => [Math.min(1, Math.max(0, x / W)), Math.min(1, Math.max(0, y / H))]), cx: corners.reduce((s, p) => s + p[0], 0) / 4 / W, wide: qw > qh * 1.1, n: g.length });
  }
  out.sort((a, b) => b.n - a.n);
  return out.filter(q => q.n > out[0].n * 0.3);
}

// 1つの本文のかたまり（横向きの行の一覧）から、余白を足した四隅を求める
function blockQuad(rows, cs, pitch) {
  const maxLen = Math.max(...rows.map(r => r.len));
  // 行頭・行末に直線を当てはめる（字下げ・短い行・見出しは外れ値として除く）
  const leftLine = fitLine(rows.filter(r => r.len > maxLen * 0.4).map(r => r.a), pitch * 0.35);
  const rightLine = fitLine(rows.filter(r => r.len > maxLen * 0.8).map(r => r.b), pitch * 0.35);
  if (!leftLine || !rightLine) return null;
  // 上下: 最初と最後の行の向きと位置（長い行の向きを使い、位置はいちばん外の行）
  const mid = r => [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2];
  const dirOf = r => { const dx = r.b[0] - r.a[0], dy = r.b[1] - r.a[1], n = Math.hypot(dx, dy) || 1; return [dx / n, dy / n]; };
  const long = rows.filter(r => r.len > maxLen * 0.6).sort((p, q) => mid(p)[1] - mid(q)[1]);
  if (long.length < 2) return null;
  const byY = rows.slice().sort((p, q) => mid(p)[1] - mid(q)[1]);
  const first = byY[0], last = byY[byY.length - 1];
  const [tdx, tdy] = dirOf(long[0]), [bdx, bdy] = dirOf(long[long.length - 1]);
  // いちばん外の行を通り、近くの長い行と同じ向きの直線
  const topLine = { mx: mid(first)[0], my: mid(first)[1], dx: tdx, dy: tdy };
  const botLine = { mx: mid(last)[0], my: mid(last)[1], dx: bdx, dy: bdy };
  // 当てはめた直線は向きだけ使い、位置はいちばん外にある行の端まで広げる（字下げ・見出しの文字を切らないように）。
  // そこから行の間隔ほどの余白を足す
  const ends = rows.flatMap(r => [r.a, r.b]);
  const out = (l, sx, sy, m) => {
    let nx = -l.dy, ny = l.dx; if (nx * sx + ny * sy < 0) { nx = -nx; ny = -ny; }
    let far = -Infinity;
    for (const [x, y] of ends) far = Math.max(far, (x - l.mx) * nx + (y - l.my) * ny);
    return shiftLine(l, nx, ny, far + m);
  };
  // 上下は広めに取り、ページ番号や柱（本文から少し離れた小さな文字）も入るようにする。
  const tl = out(topLine, 0, -1, pitch * 2.8), bl = out(botLine, 0, 1, pitch * 2.8);
  const ll = out(leftLine, -1, 0, pitch * 1.3), rl = out(rightLine, 1, 0, pitch * 1.3);
  const pts = [meet(tl, ll), meet(tl, rl), meet(bl, rl), meet(bl, ll)];
  if (pts.some(p => !p)) return null;
  return pts;
}

// ---------- 行の範囲から、図・見出し・ページ番号まで広げる ----------
// 紙の端が見つからないとき（白い机に白い紙など）は文字の行から範囲を決めるが、行だけだと
// 見出しの帯・イラスト・ページ番号が切れてしまう。行の四角形を同じ台形のまま外へ少しずつ広げ、
// 紙の上にある印刷（周りの紙より暗い所）が続く限り含める。机など紙でない所に出たら止める。
// sides: 辺ごとにどこまで探すか [上, 右, 下, 左]（1: ふつう。0: 探さず少し余白を足すだけ。見開きの のど側は隣のページの文字が続くので0）
export function extendToContent(canvas, corners, sides = [1, 1, 1, 1]) {
  const img = shrink(canvas, 800), { width: w, height: h, data: d } = img;
  const Y = new Float32Array(w * h);
  for (let i = 0, p = 0; p < Y.length; i += 4, p++) Y[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  // 近くの紙の明るさ: 小さな区画の最大値を、となりの区画とならす（文字は消え、影の明暗は残る）
  const B = 8, bw = Math.ceil(w / B), bh = Math.ceil(h / B), bm = new Float32Array(bw * bh), bg = new Float32Array(bw * bh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = ((y / B) | 0) * bw + ((x / B) | 0); if (Y[y * w + x] > bm[q]) bm[q] = Y[y * w + x]; }
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const v = [];
    for (let yy = Math.max(0, by - 1); yy <= Math.min(bh - 1, by + 1); yy++) for (let xx = Math.max(0, bx - 1); xx <= Math.min(bw - 1, bx + 1); xx++) v.push(bm[yy * bw + xx]);
    v.sort((a, b) => a - b); bg[by * bw + bx] = v[v.length >> 1];
  }
  const bgAt = (x, y) => bg[((y / B) | 0) * bw + ((x / B) | 0)];
  const m = squareToQuad(corners.map(([x, y]) => [x * w, y * h]));
  const map = (u, v) => { const z = m.g * u + m.h * v + 1; return [(m.a * u + m.b * v + m.c) / z, (m.d * u + m.e * v + m.f) / z]; };
  // 紙の明るさの基準（四角形の内側）
  const ref = [];
  for (let u = 0.05; u < 1; u += 0.05) for (let v = 0.05; v < 1; v += 0.05) { const [x, y] = map(u, v); if (x >= 0 && y >= 0 && x < w && y < h) ref.push(bgAt(x, y)); }
  if (ref.length < 20) return corners;
  ref.sort((a, b) => a - b);
  const paper = ref[ref.length >> 1];
  if (paper < 80) return corners;
  const P = corners.map(([x, y]) => [x * w, y * h]);
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const qw = (len(P[0], P[1]) + len(P[3], P[2])) / 2, qh = (len(P[0], P[3]) + len(P[1], P[2])) / 2;
  const S = Math.max(qw, qh), gap = S * 0.5, margin = S * 0.03;
  let u0 = 0, u1 = 1, v0 = 0, v1 = 1;
  // 1辺ぶん外へたどる。dir: 0=上 1=右 2=下 3=左。返り値はその辺の新しい位置
  const walk = dir => {
    const horiz = dir === 0 || dir === 2, unit = horiz ? qh : qw, step = 1.5 / unit;
    const sgn = dir === 0 || dir === 3 ? -1 : 1, start = [v0, u1, v1, u0][dir];
    if (!sides[dir]) return start;
    // 行の範囲の1.5倍より先へは広げない（遠くの物を拾わないように）
    const limit = 1.5;
    const a0 = horiz ? u0 : v0, a1 = horiz ? u1 : v1, n = Math.max(60, Math.round((a1 - a0) * (horiz ? qw : qh)));
    let t = start, lastInk = start, stop = null;
    const near = S * 0.08 / unit, hist = []; // [位置, 文字があったか] の記録（紙の外に出たときに直前の分を取り消す）
    for (let k = 1; k < 4000; k++) {
      t = start + sgn * step * k;
      let out = 0, dark = 0, ink = 0, lo = n, hi = -1;
      for (let i = 0; i < n; i++) {
        const a = a0 + (a1 - a0) * (i + 0.5) / n, [x, y] = horiz ? map(a, t) : map(t, a);
        if (!(x >= 0 && y >= 0 && x < w && y < h)) { out++; continue; }
        const b = bgAt(x, y);
        if (b < paper * 0.78) { dark++; continue; } // 紙より暗い面（机・影・紙の外）
        // 両端に近い所の暗い点（紙の縁の影・となりのページ）は数えない
        if (Y[(y | 0) * w + (x | 0)] < b * 0.72 && i > n * 0.04 && i < n * 0.96) { ink++; if (i < lo) lo = i; hi = i; }
      }
      if (out > n * 0.5) { stop = t; break; }        // 写真の端
      if (dark > (n - out) * 0.35) { stop = t; break; } // 紙の外に出た
      let isInk = ink >= 4 && ink < (n - out) * 0.6;
      // 本文から離れた所では、ページ番号のような小さなものだけを中身とみなす
      // （紙の縁の影・机の上の物の縁のような横に長いものは拾わない）
      if (isInk && Math.abs(t - lastInk) > near && hi - lo > n * 0.25) isInk = false;
      if (isInk) { lastInk = t; hist.push(t); }
      if (Math.abs(t - lastInk) * unit > gap * sides[dir] || Math.abs(t - [0, 1, 1, 0][dir]) > limit) break;
    }
    // 紙の外（机の上の物・写真の端）に出たときは、そのすぐ手前で拾ったもの（物の縁）を取り消す
    if (stop !== null) {
      const cut = S * 0.03 / unit;
      while (hist.length && Math.abs(stop - hist[hist.length - 1]) < cut) hist.pop();
      lastInk = hist.length ? hist[hist.length - 1] : start;
    }
    stops[dir] = stop;
    return lastInk;
  };
  const stops = [null, null, null, null];
  for (let round = 0; round < 2; round++) {
    if (sides[1]) u1 = walk(1);
    if (sides[3]) u0 = walk(3);
    if (sides[0]) v0 = walk(0);
    if (sides[2]) v1 = walk(2);
  }
  // 余白を少し足す（紙の外や写真の端は越えない）
  const pad = (t, dir) => {
    const sgn = dir === 0 || dir === 3 ? -1 : 1, unit = dir === 0 || dir === 2 ? qh : qw, st = stops[dir];
    let e = t + sgn * (sides[dir] ? margin : margin * 0.5) / unit;
    if (st !== null && (e - st) * sgn > 0) e = st - sgn / unit;
    return sgn < 0 ? Math.min(t, e) : Math.max(t, e);
  };
  v0 = pad(v0, 0); u1 = pad(u1, 1); v1 = pad(v1, 2); u0 = pad(u0, 3);
  return [map(u0, v0), map(u1, v0), map(u1, v1), map(u0, v1)].map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
}

// ---------- 文字の行全体を囲む四角形 ----------
// 行の向き（長さで重みづけした平均）にそろえた、すべての行を囲む長方形（四隅・割合）
export function linesSpan(lines, W, H) {
  if (!lines || lines.length < 6) return null;
  let sx = 0, sy = 0;
  const pts = [];
  for (const l of lines) {
    const ax = l.a[0] * W, ay = l.a[1] * H, bx = l.b[0] * W, by = l.b[1] * H, len = Math.hypot(bx - ax, by - ay);
    const th = Math.atan2(by - ay, bx - ax);
    sx += len * Math.cos(2 * th); sy += len * Math.sin(2 * th);
    pts.push([ax, ay], [bx, by]);
  }
  const th = Math.atan2(sy, sx) / 2, ux = Math.cos(th), uy = Math.sin(th);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of pts) { const u = x * ux + y * uy, v = -x * uy + y * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  const at = (u, v) => [(u * ux - v * uy) / W, (u * uy + v * ux) / H];
  return orderCorners([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]);
}

// ---------- 本文の行だけを残す ----------
// 紙の外にある文字（マグカップのロゴ・机の上の物）の行を除く。行のまわりの地が、紙の白さと違うものを捨てる
export function linesMain(lines, canvas) {
  if (!lines || lines.length < 6) return lines;
  const img = shrink(canvas, 800), { width: w, height: h, data: d } = img, S = Math.max(w, h);
  // 行のまわりの地の色（明るい方から15%の画素の明るさと色みの濃さ）
  const bg = l => {
    const pad = Math.max(2, l.t * S);
    const x0 = Math.max(0, Math.floor(Math.min(l.a[0], l.b[0]) * w - pad)), x1 = Math.min(w - 1, Math.ceil(Math.max(l.a[0], l.b[0]) * w + pad));
    const y0 = Math.max(0, Math.floor(Math.min(l.a[1], l.b[1]) * h - pad)), y1 = Math.min(h - 1, Math.ceil(Math.max(l.a[1], l.b[1]) * h + pad));
    const px = [];
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { const i = (y * w + x) * 4; px.push([d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114, Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])]); }
    if (!px.length) return null;
    px.sort((p, q) => q[0] - p[0]);
    const top = px.slice(0, Math.max(1, Math.round(px.length * 0.15)));
    return [top[top.length >> 1][0], top.reduce((s, p) => s + p[1], 0) / top.length];
  };
  const info = lines.map(bg), ys = info.filter(Boolean).map(v => v[0]).sort((p, q) => p - q), cs = info.filter(Boolean).map(v => v[1]).sort((p, q) => p - q);
  if (!ys.length) return lines;
  const Ym = ys[ys.length >> 1], Cm = cs[cs.length >> 1];
  // 地が紙よりずっと暗い・色が濃い行は紙の外（マグカップのロゴなど）
  const keep = lines.filter((_, i) => info[i] && info[i][0] > Ym * 0.78 && info[i][1] < Cm + 35);
  return keep.length >= 6 ? keep : lines;
}

// ---------- 本文の範囲から紙の端まで広げる ----------
// 文字の行から求めた四角形は本文だけを囲むので、図や枠が欠けやすい。
// 四辺それぞれを外へたどり、紙から机に変わるところ（黄色っぽさが増える・暗くなる）まで広げる。
// クリーム色の机と白い紙は明るさがほぼ同じでも、明るさで割った黄色っぽさ (R-B)/Y で見分けられる。
// keep: 広げない辺の番号（見開きの のど 側）。見つからない辺はそのまま
export function expandToPaper(canvas, corners, keep = [], info = {}, pad = 0) {
  info.found = 0;
  const img = shrink(canvas, 720), { width: w, height: h, data: d } = img;
  const S = Math.max(w, h), raw = new Float32Array(w * h), Y = new Float32Array(w * h);
  for (let i = 0, p = 0; p < raw.length; i += 4, p++) { raw[p] = d[i] - d[i + 2]; Y[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; }
  // 小さくぼかしてから (R-B)/Y。暗い画素は NaN
  const warm = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, sy = 0, n = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) { const q = yy * w + xx; s += raw[q]; sy += Y[q]; n++; }
    warm[y * w + x] = sy / n < 90 ? NaN : (s / n) / (sy / n + 20) * 500;
  }
  const med = a => { a = a.filter(v => !isNaN(v)).sort((u, v) => u - v); return a.length ? a[a.length >> 1] : NaN; };
  const P = corners.map(([x, y]) => [x * w, y * h]);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? undefined : warm[Math.floor(y) * w + Math.floor(x)];
  // 紙（四角形の内側）と机（写真の縁）の黄色っぽさ
  const inside = [];
  for (let u = 0.1; u <= 0.9; u += 0.04) for (let v = 0.1; v <= 0.9; v += 0.04) {
    const x = (1 - v) * ((1 - u) * P[0][0] + u * P[1][0]) + v * ((1 - u) * P[3][0] + u * P[2][0]);
    const y = (1 - v) * ((1 - u) * P[0][1] + u * P[1][1]) + v * ((1 - u) * P[3][1] + u * P[2][1]);
    inside.push(at(x, y));
  }
  const ring = [], m = Math.round(Math.min(w, h) * 0.03);
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (x < m || y < m || x >= w - m || y >= h - m) ring.push(warm[y * w + x]);
  const pw = med(inside), dw = med(ring);
  if (isNaN(pw) || isNaN(dw) || dw - pw < 6) return corners;
  const half = (dw - pw) / 2, K = Math.max(4, Math.round(S * 0.02));
  const cx = P.reduce((s, p) => s + p[0], 0) / 4, cy = P.reduce((s, p) => s + p[1], 0) / 4;
  const sides = [];
  for (let k = 0; k < 4; k++) {
    const A = P[k], B = P[(k + 1) % 4], len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const tx = (B[0] - A[0]) / len, ty = (B[1] - A[1]) / len;
    let nx = -ty, ny = tx; if ((A[0] - cx) * nx + (A[1] - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const orig = { mx: A[0], my: A[1], dx: tx, dy: ty };
    if (keep.includes(k)) { sides.push(orig); continue; }
    const pts = []; let tries = 0;
    for (let t = 0.08; t <= 0.92; t += 0.04) {
      tries++;
      const ox = A[0] + (B[0] - A[0]) * t, oy = A[1] + (B[1] - A[1]) * t, v = [];
      // 外へ1画素ずつ。辺の向きに少し幅を持たせて平均（暗い画素は机とみなす）
      for (let dd = 0; ; dd++) {
        const x = ox + nx * dd, y = oy + ny * dd;
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        let s = 0, n = 0;
        for (let e = -4; e <= 4; e += 2) { const val = at(x + tx * e, y + ty * e); if (val === undefined || isNaN(val)) continue; s += val; n++; }
        v.push(n ? s / n : NaN);
      }
      // 区間の平均。暗い画素（図の線・机の黒い部分）は数えず、ほとんど暗ければ机とみなす
      const avg = (from, len = K) => { let s = 0, n = 0; const to = Math.min(v.length, from + len); for (let j = from; j < to; j++) if (!isNaN(v[j])) { s += v[j]; n++; } return n < (to - from) * 0.3 ? dw : s / n; };
      // 内側は紙らしく、外側は机らしい最初の段差
      let found = -1;
      for (let dd = K; dd + K <= v.length; dd++) {
        const a = avg(dd - K), b = avg(dd);
        // 外側がしばらく机らしいまま続くこと（灰色の見出しの帯などで止まらないように）
        if (b - a > half && a < pw + half && b > pw + half && avg(dd, K * 4) > pw + half) {
          // 段差がいちばん大きいところに合わせる
          let best = dd, bv = b - a;
          for (let e = dd + 1; e < Math.min(v.length - K, dd + K); e++) { const g = avg(e) - avg(e - K); if (g > bv) { bv = g; best = e; } }
          found = best; break;
        }
      }
      if (found >= 0) pts.push([ox + nx * found, oy + ny * found]);
    }
    let line = pts.length >= Math.max(4, tries * 0.35) ? fitLine(pts, S * 0.008) : null;
    if (line) {
      // 向きがもとの辺と大きく違う・内側に入る なら使わない
      const cos = Math.abs(line.dx * tx + line.dy * ty);
      const dist = (line.mx - A[0]) * nx + (line.my - A[1]) * ny;
      if (cos < Math.cos(15 * Math.PI / 180) || dist < 0) line = null;
    }
    // 紙の端そのものに合わせる（内側へは寄せない。紙が欠けるより、机が少し写る方がよい）
    if (line) info.found++;
    // 見つからなかった辺は、迷ったら広めに（紙を切らないように）外へ pad の分だけ広げる
    sides.push(line || (pad && !keep.includes(k) ? shiftLine(orig, nx, ny, S * pad) : orig));
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const c = meet(sides[(k + 3) % 4], sides[k]);
    if (!c || c[0] < -w * 0.05 || c[1] < -h * 0.05 || c[0] > w * 1.05 || c[1] > h * 1.05) return corners;
    out.push([Math.min(1, Math.max(0, c[0] / w)), Math.min(1, Math.max(0, c[1] / h))]);
  }
  return out;
}

// ---------- 紙の反りの補正 ----------
// 補正前の画像の座標（割合）→ 台形補正後の画像の座標（画素）に変換する関数を作る。
// corners: 台形補正に使った四隅（割合）、size: 補正前の画像の大きさ、W/H: 補正後の大きさ
function projector(corners, size, W, H) {
  const m = squareToQuad(corners.map(([x, y]) => [x * size.w, y * size.h]));
  const A = [[m.a, m.b, m.c], [m.d, m.e, m.f], [m.g, m.h, 1]];
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    [(A[1][1] * A[2][2] - A[1][2] * A[2][1]) / det, (A[0][2] * A[2][1] - A[0][1] * A[2][2]) / det, (A[0][1] * A[1][2] - A[0][2] * A[1][1]) / det],
    [(A[1][2] * A[2][0] - A[1][0] * A[2][2]) / det, (A[0][0] * A[2][2] - A[0][2] * A[2][0]) / det, (A[0][2] * A[1][0] - A[0][0] * A[1][2]) / det],
    [(A[1][0] * A[2][1] - A[1][1] * A[2][0]) / det, (A[0][1] * A[2][0] - A[0][0] * A[2][1]) / det, (A[0][0] * A[1][1] - A[0][1] * A[1][0]) / det],
  ];
  return ([x, y]) => {
    const X = x * size.w, Y = y * size.h, z = inv[2][0] * X + inv[2][1] * Y + inv[2][2];
    return [(inv[0][0] * X + inv[0][1] * Y + inv[0][2]) / z * W, (inv[1][0] * X + inv[1][1] * Y + inv[1][2]) / z * H];
  };
}

// 小さな連立一次方程式（正規方程式）を解く
function solve(M, v) {
  const n = v.length, a = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]; }
  }
  return a.map((r, i) => r[n] / r[i]);
}

// 見出しの帯・表の罫線・枠などの、横に長くのびた明暗の境目をたどる（文字の行と同じように紙の曲がりを表す）。
// 返り値: 台形補正後の画像の座標（画素）の折れ線の一覧。左→右
function edgeCurves(canvas, gutter) {
  const img = shrink(canvas, 900), { width: w, height: h, data: d } = img, k = canvas.width / w;
  const g = new Float32Array(w * h);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) g[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const S = 6, ns = Math.floor(w / S), T = 30, tol = 1.6;
  // 細い帯ごとに、縦方向の明るさの変化が大きい所（横向きの境目）を探す
  const peaks = [];
  for (let s = 0; s < ns; s++) {
    const prof = new Float32Array(h);
    for (let y = 1; y < h - 1; y++) { let a = 0; for (let x = s * S; x < s * S + S; x++) a += g[(y + 1) * w + x] - g[(y - 1) * w + x]; prof[y] = a / S; }
    const list = [];
    for (let y = 2; y < h - 2; y++) {
      const v = prof[y];
      if (Math.abs(v) < T || Math.abs(v) < Math.abs(prof[y - 1]) || Math.abs(v) < Math.abs(prof[y + 1])) continue;
      // 放物線で山の位置を細かく求める
      const a = Math.abs(prof[y - 1]), b = Math.abs(v), c = Math.abs(prof[y + 1]), den = a - 2 * b + c;
      list.push({ y: y + (den ? 0.5 * (a - c) / den : 0), sign: Math.sign(v), chain: null });
    }
    peaks.push(list);
  }
  // 隣の帯の、同じ向きでほぼ同じ高さの境目どうしをつなぐ
  const chains = [];
  for (let s = 0; s < ns; s++) for (const p of peaks[s]) {
    const xs = (s + 0.5) * S;
    let best = null;
    if (s > 0 && !(gutter && (xs - S) * k < gutter && xs * k >= gutter)) {
      for (const q of peaks[s - 1]) if (q.sign === p.sign && Math.abs(q.y - p.y) < tol && q.chain && q.chain.last === s - 1 && (!best || Math.abs(q.y - p.y) < Math.abs(best.y - p.y))) best = q;
    }
    if (best) { p.chain = best.chain; best.chain = null; }
    else { p.chain = { pts: [], last: s }; chains.push(p.chain); }
    p.chain.pts.push([xs * k, p.y * k]); p.chain.last = s;
  }
  // 十分に長いものだけ（文字の上下の縁のような短いものは除く）。曲がりが急すぎるものも除く
  const half = gutter ? Math.min(gutter, canvas.width - gutter) : canvas.width;
  return chains.map(c => c.pts).filter(P => {
    if (P.length < 8 || P[P.length - 1][0] - P[0][0] < half * 0.3) return false;
    const ys = P.map(p => p[1]);
    return Math.max(...ys) - Math.min(...ys) < (P[P.length - 1][0] - P[0][0]) * 0.15;
  }).map(P => {
    // 10点ほどに間引いて、行の中心線と同じ形にする
    const n = 12, out = [];
    for (let i = 0; i < n; i++) out.push(P[Math.round(i * (P.length - 1) / (n - 1))]);
    return out;
  });
}

// 折れ線を3次式でなめらかにする（外れた点は1回除いて当てはめ直す）。合わない点が多ければ null
function smoothLine(P, tol) {
  const x0 = P[0][0], x1 = P[P.length - 1][0], U = x => (x - x0) / (x1 - x0 || 1) * 2 - 1;
  const fit = pts => {
    const M = Array.from({ length: 4 }, () => new Array(4).fill(0)), r = new Array(4).fill(0);
    for (const [x, y] of pts) { const u = U(x), f = [1, u, u * u, u * u * u]; for (let i = 0; i < 4; i++) { r[i] += f[i] * y; for (let j = 0; j < 4; j++) M[i][j] += f[i] * f[j]; } }
    for (let i = 2; i < 4; i++) M[i][i] += 1e-6 * pts.length;
    return solve(M, r);
  };
  const at = (c, x) => { const u = U(x); return c[0] + c[1] * u + c[2] * u * u + c[3] * u * u * u; };
  let c = fit(P);
  if (!c) return null;
  const good = P.filter(([x, y]) => Math.abs(y - at(c, x)) <= tol);
  if (good.length < Math.max(5, P.length * 0.7)) return null;
  if (good.length < P.length) { c = fit(good); if (!c) return null; }
  const n = 12, out = [];
  for (let i = 0; i < n; i++) { const x = x0 + (x1 - x0) * i / (n - 1); out.push([x, at(c, x)]); }
  return out;
}

// 紙の反り（本の湾曲）を平らにする。
// 台形補正した画像の上で、各行の中心線が水平になるよう縦方向に画素をずらす。
// 紙の曲がり方を「横位置ごとの、上下に比例して変わるずれ」としてなめらかな式で表し、行のない所
// （見出しの帯・図・ページの上下の端）にも延ばす。行のある所は、行そのものの曲がりに合わせる
function straightenLines(canvas, corners, size, lines, gutter = null) {
  const W = canvas.width, H = canvas.height;
  const toOut = projector(corners, size, W, H);
  if (!toOut) return canvas;
  // このページの中にある横向きの長い行だけ使う
  const polys = [];
  const ts = lines.map(l => l.t).sort((a, b) => a - b), tMed = ts[ts.length >> 1] || 0;
  for (const l of lines) {
    if (!l.pts || l.pts.length < 6 || l.t > tMed * 3) continue;
    let P = l.pts.map(toOut);
    if (P.some(([x, y]) => x < -W * 0.02 || x > W * 1.02 || y < 0 || y > H)) continue;
    const dx = P[P.length - 1][0] - P[0][0];
    if (Math.abs(dx) < W * (gutter ? 0.1 : 0.2) || Math.abs(P[P.length - 1][1] - P[0][1]) > Math.abs(dx) * 0.3) continue;
    if (dx < 0) P.reverse();
    // 行の中心線は文字の形（小さい字・句読点）でこまかく上下にぶれる。そのまま合わせると行が波打つので、
    // なめらかな曲線（3次式）に直してから使う。曲線に乗らない行（2行がつながって段がついたもの等）は使わない
    P = smoothLine(P, H * 0.006);
    if (!P) continue;
    polys.push(P);
  }
  if (polys.length < 3) return canvas;
  // 各行の、あるべき高さ（行のまっすぐな部分＝中央値）からのずれを列ごとに求める
  const C = 64, colX = Array.from({ length: C + 1 }, (_, i) => i * W / C);
  const cols = colX.map(() => []);
  const sampleOf = P => {
    const ys = P.map(p => p[1]).slice().sort((a, b) => a - b), base = ys[ys.length >> 1];
    const span = P[P.length - 1][0] - P[0][0], out = [];
    colX.forEach((x, c) => {
      // 行の端より外は、端の曲がり方をそのまま延ばす（行の長さの1/4まで）
      if (x < P[0][0] - span * 0.25 || x > P[P.length - 1][0] + span * 0.25) return;
      if (gutter && (x < gutter) !== ((P[0][0] + P[P.length - 1][0]) / 2 < gutter)) return; // のどの向こうへは延ばさない
      let k = 1; while (k < P.length - 1 && x > P[k][0]) k++;
      const t = (x - P[k - 1][0]) / (P[k][0] - P[k - 1][0] || 1), off = P[k - 1][1] + (P[k][1] - P[k - 1][1]) * t - base;
      out.push({ c, x, base, off, inside: x >= P[0][0] && x <= P[P.length - 1][0] });
    });
    return out;
  };
  let samples = [], maxOff = 0;
  for (const P of polys) for (const q of sampleOf(P)) {
    cols[q.c].push([q.base, q.off]);
    if (q.inside) samples.push([q.x, q.base, q.off]);
    maxOff = Math.max(maxOff, Math.abs(q.off));
  }
  // なめらかな式: ずれ = a(u) + b(u)·v（u, v は -1〜1 の横・縦位置、a・b は u の5次式）。
  // カメラから見て紙が浮いた・沈んだ分だけ、行は中心から上下に比例してずれる（本の湾曲の形）。
  // 見開きは のど で曲がり方が折れ曲がるので、左右のページで別々に求める
  const D = 5, NP = 2 * (D + 1);
  const parts = gutter ? [[0, gutter], [gutter, W]] : [[0, W]];
  const fit = (samples, maxOff) => {
    const lim = maxOff * 1.5 + H * 0.004;
    const models = parts.map(([x0, x1]) => {
      const basis = (x, y) => { const u = (x - x0) / (x1 - x0) * 2 - 1, v = y / H * 2 - 1, f = []; let p = 1; for (let k = 0; k <= D; k++) { f.push(p, p * v); p *= u; } return f; };
      const mine = samples.filter(([x]) => x >= x0 && x <= x1);
      let coef = null;
      for (let it = 0; it < 3; it++) {
        const M = Array.from({ length: NP }, () => new Array(NP).fill(0)), r = new Array(NP).fill(0);
        let n = 0;
        for (const [x, y, off] of mine) {
          const f = basis(x, y);
          if (coef) { let e = 0; for (let k = 0; k < NP; k++) e += f[k] * coef[k]; if (Math.abs(e - off) > Math.max(2, maxOff * 0.25)) continue; }
          n++;
          for (let i = 0; i < NP; i++) { r[i] += f[i] * off; for (let j = 0; j < NP; j++) M[i][j] += f[i] * f[j]; }
        }
        if (n < NP * 3) { coef = null; break; }
        for (let i = 0; i < NP; i++) M[i][i] += 1e-3 * n; // 弱い正則化（行の少ない所で暴れないように）
        coef = solve(M, r) || coef;
      }
      // 行のない所では、行で見た最大のずれを大きく超えないようにする
      return (x, y) => { if (!coef) return 0; const f = basis(Math.min(x1, Math.max(x0, x)), y); let e = 0; for (let k = 0; k < NP; k++) e += f[k] * coef[k]; return Math.max(-lim, Math.min(lim, e)); };
    });
    return (x, y) => models[gutter && x >= gutter ? 1 : 0](x, y);
  };
  let model = fit(samples, maxOff);
  // 見出しの帯・罫線・枠の縁も使う（行のない上下の端まで、紙の曲がりがわかる）。
  // ただし図の丸い輪郭などを拾わないよう、行から求めた曲がり方と大きく食い違うものは使わない。
  // 式を求めるのにだけ使い、行のある所の細かい合わせ込みには使わない
  const tol = Math.max(4, Math.min(maxOff * 0.6, H * 0.008));
  let added = 0, maxAll = maxOff;
  for (const P of edgeCurves(canvas, gutter)) {
    const q = sampleOf(P).filter(s => s.inside);
    if (q.length < 4) continue;
    const dev = q.map(s => s.off - model(s.x, s.base)).sort((a, b) => a - b), mid = dev[dev.length >> 1];
    const rms = Math.sqrt(dev.reduce((s, v) => s + (v - mid) ** 2, 0) / dev.length);
    // 山なり（両端が同じ側に曲がる形。図の丸い輪郭など）は、行の曲がりとよく合うときだけ使う
    const n = q.length, xs = q.map(s => s.x), x0 = xs[0], x1 = xs[n - 1];
    let arch = false;
    { // 2次式を当てはめて、頂点が線の内側にあるか
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
      for (const s of q) { const u = (s.x - x0) / (x1 - x0 || 1) * 2 - 1, y = s.off; s0++; s1 += u; s2 += u * u; s3 += u ** 3; s4 += u ** 4; t0 += y; t1 += u * y; t2 += u * u * y; }
      const c = solve([[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]], [t2, t1, t0]);
      if (c && Math.abs(c[0]) > 1.5) { const vx = -c[1] / (2 * c[0]); arch = vx > -0.6 && vx < 0.6; }
    }
    if (rms > (arch ? 2.5 : tol)) continue;
    for (const s of q) { samples.push([s.x, s.base, s.off]); maxAll = Math.max(maxAll, Math.abs(s.off)); }
    added++;
  }
  if (added) model = fit(samples, maxAll);
  if (maxAll < H * 0.003) return canvas; // ほとんど曲がっていない
  cols.forEach(l => l.sort((a, b) => a[0] - b[0]));
  // 行のある所は行の実際のずれ（式との差を行と行の間でつなぐ）。最初の行より上・最後の行より下は、
  // 式のずれに、行の間隔の数倍の距離でなめらかに移る
  const fade = H * 0.06;
  const offAt = (c, y) => {
    const l = cols[c], x = colX[c], base = model(x, y);
    if (!l.length) return base;
    const res = ([b, o]) => o - model(x, b);
    if (y <= l[0][0]) return base + res(l[0]) * Math.max(0, 1 - (l[0][0] - y) / fade);
    if (y >= l[l.length - 1][0]) { const b = l[l.length - 1]; return base + res(b) * Math.max(0, 1 - (y - b[0]) / fade); }
    let k = 1; while (k < l.length && l[k][0] < y) k++;
    const t = (y - l[k - 1][0]) / (l[k][0] - l[k - 1][0] || 1);
    return base + res(l[k - 1]) + (res(l[k]) - res(l[k - 1])) * t;
  };
  // 出力の各画素 (x, y) は、元の (x, y + ずれ) から取る
  const src = ctx2d(canvas).getImageData(0, 0, W, H).data;
  const out = makeCanvas(W, H), octx = ctx2d(out), dst = octx.createImageData(W, H), o = dst.data;
  const colOff = new Float32Array(C + 1);
  for (let y = 0; y < H; y++) {
    for (let c = 0; c <= C; c++) colOff[c] = offAt(c, y);
    for (let x = 0; x < W; x++) {
      const cf = x / W * C, c0 = Math.min(C - 1, cf | 0), t = cf - c0;
      const sy = y + colOff[c0] + (colOff[c0 + 1] - colOff[c0]) * t, oi = (y * W + x) * 4;
      if (sy < 0 || sy > H - 1.001) { o[oi] = o[oi + 1] = o[oi + 2] = 255; o[oi + 3] = 255; continue; } // 紙の外は白
      const y0 = sy | 0, fy = sy - y0, i0 = (y0 * W + x) * 4, i1b = i0 + W * 4;
      o[oi] = src[i0] + (src[i1b] - src[i0]) * fy; o[oi + 1] = src[i0 + 1] + (src[i1b + 1] - src[i0 + 1]) * fy; o[oi + 2] = src[i0 + 2] + (src[i1b + 2] - src[i0 + 2]) * fy; o[oi + 3] = 255;
    }
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

// ---------- 行の波打ち・傾きの仕上げ補正（画像そのものから） ----------
// 文字認識の行の位置だけに頼ると、行の端（のど の近くの急な曲がり）や大きな字・表・見出しの帯で
// 曲がりが残り、行が波打って見える。そこで画像を細い縦の帯に分け、となりの帯どうしで
// 「横に並ぶ文字の行・罫線の高さ」がどれだけずれているかを明暗の並びの重なりで測り、
// そのずれを横につないで、行がまっすぐ水平になるよう縦方向に画素をずらす。
// 文字のない所（図・余白）は周りの値でなめらかに埋める
export function levelRows(canvas) {
  const W = canvas.width, H = canvas.height;
  const img = shrink(canvas, 1100), { width: w, height: h, data: d } = img, k = W / w;
  const NS = Math.max(16, Math.min(56, Math.round(w / 18))), sw = w / NS;
  const bh = Math.max(40, Math.round(h / 7)), stepB = Math.round(bh / 2), NB = Math.max(1, Math.ceil((h - bh) / stepB) + 1);
  const m = Math.max(3, Math.round(sw * 0.35)); // となりの帯との最大のずれ（約19度まで）
  // 帯ごとの「暗さ」の縦の並び。ゆるやかな明暗（影・照明むら）は引いて、行の縞だけ残す
  const prof = [];
  const win = Math.max(6, Math.round(h / 45));
  for (let s = 0; s < NS; s++) {
    const x0 = Math.round(s * sw), x1 = Math.max(x0 + 1, Math.round((s + 1) * sw)), raw = new Float32Array(h);
    for (let y = 0; y < h; y++) { let a = 0; for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; a += 255 - (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) / 256; } raw[y] = a / (x1 - x0); }
    const acc = new Float32Array(h + 1); for (let y = 0; y < h; y++) acc[y + 1] = acc[y] + raw[y];
    const hp = new Float32Array(h);
    for (let y = 0; y < h; y++) { const a = Math.max(0, y - win), b = Math.min(h, y + win + 1); hp[y] = raw[y] - (acc[b] - acc[a]) / (b - a); }
    prof.push(hp);
  }
  // となりの帯とのずれ g[s][b]（帯 s+1 の行が帯 s より何画素下にあるか）と、その確かさ
  const g = new Float32Array((NS - 1) * NB), cf = new Float32Array((NS - 1) * NB);
  for (let s = 0; s < NS - 1; s++) for (let b = 0; b < NB; b++) {
    const y0 = Math.min(Math.max(0, h - bh), b * stepB) + m, y1 = Math.min(h, Math.min(Math.max(0, h - bh), b * stepB) + bh) - m;
    if (y1 - y0 < 20) continue;
    const A = prof[s], B = prof[s + 1];
    let ea = 0; for (let y = y0; y < y1; y++) ea += A[y] * A[y];
    if (ea / (y1 - y0) < 60) continue; // 文字も線もない
    let best = -2, bi = 0; const sc = new Float32Array(2 * m + 1);
    for (let dlt = -m; dlt <= m; dlt++) {
      let ab = 0, eb = 0;
      for (let y = y0; y < y1; y++) { const v = B[y + dlt]; ab += A[y] * v; eb += v * v; }
      const c = eb > 0 ? ab / Math.sqrt(ea * eb) : 0; sc[dlt + m] = c;
      if (c > best) { best = c; bi = dlt; }
    }
    if (best < 0.45 || bi === -m || bi === m) continue;
    const a = sc[bi + m - 1], c0 = sc[bi + m], c = sc[bi + m + 1], den = a - 2 * c0 + c;
    g[s * NB + b] = bi + (den < 0 ? 0.5 * (a - c) / den : 0); cf[s * NB + b] = (best - 0.45) * Math.min(1, ea / (y1 - y0) / 400);
  }
  let known = 0; for (let i = 0; i < cf.length; i++) if (cf[i] > 0) known++;
  if (known < cf.length * 0.15) return canvas; // 行がほとんどない（写真・図だけ・縦書きなど）
  // 外れた値を除く: 周り（3x3）の中央値と大きく違うものは使わない
  for (let s = 0; s < NS - 1; s++) for (let b = 0; b < NB; b++) {
    if (!cf[s * NB + b]) continue;
    const v = [];
    for (let ss = Math.max(0, s - 2); ss <= Math.min(NS - 2, s + 2); ss++) for (let bb = Math.max(0, b - 1); bb <= Math.min(NB - 1, b + 1); bb++) if (cf[ss * NB + bb] > 0) v.push(g[ss * NB + bb]);
    v.sort((x, y) => x - y);
    if (v.length >= 4 && Math.abs(g[s * NB + b] - v[v.length >> 1]) > Math.max(1.2, m * 0.25)) cf[s * NB + b] = -1;
  }
  for (let i = 0; i < cf.length; i++) if (cf[i] < 0) cf[i] = 0;
  // 確かさで重みをつけてならし、測れなかった所を周りから埋める
  let gs = Float32Array.from(g), ws = Float32Array.from(cf);
  for (let it = 0; it < 4; it++) {
    const g2 = new Float32Array(gs.length), w2 = new Float32Array(gs.length);
    for (let s = 0; s < NS - 1; s++) for (let b = 0; b < NB; b++) {
      let a = 0, ww = 0;
      for (let ss = Math.max(0, s - 1); ss <= Math.min(NS - 2, s + 1); ss++) for (let bb = Math.max(0, b - 1); bb <= Math.min(NB - 1, b + 1); bb++) {
        const q = ss * NB + bb, wt = ws[q] * (ss === s && bb === b ? 2 : 1);
        a += gs[q] * wt; ww += wt;
      }
      g2[s * NB + b] = ww > 0 ? a / ww : 0; w2[s * NB + b] = ww / 10;
    }
    // 測れた所は元の値も残す（ならしすぎて急な曲がりを消さない）
    for (let i = 0; i < gs.length; i++) { const c = cf[i]; gs[i] = c > 0 ? (g[i] * c + g2[i] * 0.5 * c + g2[i] * 0.05) / (1.5 * c + 0.05) : g2[i]; ws[i] = Math.max(c, w2[i]); }
  }
  // 横につないで、各帯のずれ（中央の帯を基準）にする
  const off = new Float32Array(NS * NB), mid = NS >> 1;
  let maxAbs = 0;
  for (let b = 0; b < NB; b++) {
    for (let s = mid + 1; s < NS; s++) off[s * NB + b] = off[(s - 1) * NB + b] + gs[(s - 1) * NB + b];
    for (let s = mid - 1; s >= 0; s--) off[s * NB + b] = off[(s + 1) * NB + b] - gs[s * NB + b];
    // 全体の上下の位置は変えない（帯ごとの平均を引く）
    let mean = 0; for (let s = 0; s < NS; s++) mean += off[s * NB + b]; mean /= NS;
    for (let s = 0; s < NS; s++) { off[s * NB + b] -= mean; maxAbs = Math.max(maxAbs, Math.abs(off[s * NB + b])); }
  }
  if (maxAbs * k < Math.max(0.6, H * 0.0005)) return canvas; // すでにまっすぐ
  const src = ctx2d(canvas).getImageData(0, 0, W, H).data;
  const out = makeCanvas(W, H), octx = ctx2d(out), dst = octx.createImageData(W, H), o = dst.data;
  const cb = b => (Math.min(Math.max(0, h - bh), b * stepB) + bh / 2) * k; // 帯の中心の高さ
  const colOff = new Float32Array(NS);
  for (let y = 0; y < H; y++) {
    let b0 = 0; while (b0 < NB - 2 && cb(b0 + 1) < y) b0++;
    const b1 = Math.min(NB - 1, b0 + 1), t = NB === 1 || b1 === b0 ? 0 : Math.min(1, Math.max(0, (y - cb(b0)) / (cb(b1) - cb(b0))));
    for (let s = 0; s < NS; s++) colOff[s] = (off[s * NB + b0] * (1 - t) + off[s * NB + b1] * t) * k;
    for (let x = 0; x < W; x++) {
      const f = Math.min(NS - 1, Math.max(0, x / W * NS - 0.5)), s0 = Math.min(NS - 2, f | 0), tx = f - s0;
      const sy = y + colOff[s0] + (colOff[s0 + 1] - colOff[s0]) * tx, oi = (y * W + x) * 4;
      if (sy < 0 || sy > H - 1.001) { o[oi] = o[oi + 1] = o[oi + 2] = 255; o[oi + 3] = 255; continue; }
      const y0 = sy | 0, fy = sy - y0, i0 = (y0 * W + x) * 4, i1 = i0 + W * 4;
      o[oi] = src[i0] + (src[i1] - src[i0]) * fy; o[oi + 1] = src[i0 + 1] + (src[i1 + 1] - src[i0 + 1]) * fy; o[oi + 2] = src[i0 + 2] + (src[i1 + 2] - src[i0 + 2]) * fy; o[oi + 3] = 255;
    }
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

// ---------- 見開きの のど（左右のページの境目）を文字の行から求める ----------
// 左ページの行の右端と右ページの行の左端の間の、行がまったく通らない縦のすき間を探す。
// 台形補正後の画像の x（画素）を返す。見つからなければ null
function linesGutter(canvas, corners, size, lines) {
  const W = canvas.width, H = canvas.height, toOut = projector(corners, size, W, H);
  if (!toOut || !lines) return null;
  const N = 200, cover = new Float32Array(N);
  let used = 0;
  for (const l of lines) {
    const a = toOut(l.a), b = toOut(l.b);
    if (Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1])) continue; // 横向きの行だけ
    const ym = (a[1] + b[1]) / 2;
    if (ym < 0 || ym > H) continue;
    const x0 = Math.max(0, Math.min(a[0], b[0])), x1 = Math.min(W, Math.max(a[0], b[0]));
    for (let i = Math.floor(x0 / W * N); i < Math.ceil(x1 / W * N) && i < N; i++) cover[i]++;
    used++;
  }
  if (used < 8) return null;
  // 中央付近（3〜7割）で、行が通らない区間のうち、両側に行の多いもの
  let best = null;
  for (let i = Math.floor(N * 0.3); i < N * 0.7; i++) {
    if (cover[i] > 0) continue;
    let j = i; while (j + 1 < N * 0.7 && cover[j + 1] === 0) j++;
    let left = 0, right = 0;
    for (let k = 0; k < i; k++) left = Math.max(left, cover[k]);
    for (let k = j + 1; k < N; k++) right = Math.max(right, cover[k]);
    const score = (j - i + 1) * Math.min(left, right);
    if (left >= 3 && right >= 3 && (!best || score > best.score)) best = { i, j, score };
    i = j;
  }
  if (!best) return null;
  const a = best.i / N * W, b = (best.j + 1) / N * W;
  // すき間の中で、のどの影（上から下まで続く暗い縦の帯）がはっきりあればそこ、なければ真ん中。
  // 行の端のすぐそばは文字の一部（短い語・ラベル）のことがあるので、すき間の両端4分の1は除く
  const img = shrink(canvas, 600), { width: w, height: h, data: d } = img;
  const sa = Math.max(0, Math.floor((a + (b - a) * 0.25) / W * w)), sb = Math.min(w - 1, Math.ceil((b - (b - a) * 0.25) / W * w));
  let bx = (a + b) / 2 / W * w;
  if (sb - sa >= 3) {
    const col = [], buf = [];
    for (let x = sa; x <= sb; x++) {
      buf.length = 0;
      for (let y = Math.floor(h * 0.1); y < h * 0.9; y++) { const i = (y * w + x) * 4; buf.push(d[i] + d[i + 1] + d[i + 2]); }
      buf.sort((p, q) => p - q); col.push(buf[buf.length >> 1]);
    }
    const sm = col.map((_, i) => { let s = 0, n = 0; for (let k = -2; k <= 2; k++) if (col[i + k] !== undefined) { s += col[i + k]; n++; } return s / n; });
    const mean = sm.reduce((p, q) => p + q, 0) / sm.length, mi = sm.indexOf(Math.min(...sm));
    if (mean - sm[mi] > 15) bx = sa + mi;
  }
  return bx * W / w;
}

// ---------- 文字のかたまり（本文の範囲） ----------
// 補正後の画像から、文字や図がある範囲を求め、余白を少し残して切り抜く範囲（割合の四隅）を返す。
// ページの外の机や物が残ったときや、余白が広すぎるときに使う。切り取る量が少なければ null
export function textBlock(canvas) {
  const img = shrink(canvas, 600), { width: w, height: h, data: d } = img;
  let mask = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) mask[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8 < 170 ? 1 : 0;
  // 端にかかった大きな暗い部分（指・机・ページの外の物）は本文ではない
  const big = Math.max(w, h) / 30;
  for (const c of components(mask, w, h)) {
    if (c.minX > 0 && c.minY > 0 && c.maxX < w - 1 && c.maxY < h - 1) continue;
    if (Math.max(c.maxX - c.minX, c.maxY - c.minY) > big || c.px.length < 30) for (const p of c.px) mask[p] = 0;
  }
  const r = Math.max(3, Math.round(Math.max(w, h) / 70));
  mask = morph(mask, w, h, r, true); mask = morph(mask, w, h, r, false);
  // 小さな点（ゴミ）は数えず、文字のかたまりが占める範囲を求める
  let x0 = w, y0 = h, x1 = -1, y1 = -1, total = 0;
  for (const c of components(mask, w, h)) {
    if (c.px.length < w * h * 0.0002) continue; // ページ番号くらいの小さな文字は残す
    total += c.px.length;
    x0 = Math.min(x0, c.minX); y0 = Math.min(y0, c.minY); x1 = Math.max(x1, c.maxX); y1 = Math.max(y1, c.maxY);
  }
  if (x1 < 0 || total < w * h * 0.08) return null;
  // ふくらませた分を戻し、長辺の3%の余白を残す
  const m = Math.max(w, h) * 0.03;
  const L = Math.max(0, x0 + r - m) / w, T = Math.max(0, y0 + r - m) / h, R = Math.min(w, x1 + 1 - r + m) / w, B = Math.min(h, y1 + 1 - r + m) / h;
  if ((R - L) * (B - T) > 0.88) return null;
  return [[L, T], [R, T], [R, B], [L, B]];
}

// ---------- ページの外の写り込みを消す（仕上げ） ----------
// 範囲を広めに取ると、ページの縁の外にある机・影・となりのページの端が、黒い帯や灰色のかげりとして
// 縁に残る。仕上がった画像（紙は白）で、縁に接していて縁の近くだけにとどまる暗いかたまりを白くする。
// ページの奥まで続くもの（枠の線・端まである図）や、縁から離れたページ番号は中身なので残す
export function clearEdges(canvas) {
  const W = canvas.width, H = canvas.height;
  const img = shrink(canvas, 700), { width: w, height: h, data: d } = img;
  const dark = new Uint8Array(w * h), gray = new Uint8Array(w * h); let white = 0;
  for (let p = 0, i = 0; p < dark.length; p++, i += 4) {
    const v = Math.min(d[i], d[i + 1], d[i + 2]);
    if (v < 130) dark[p] = 1; else if (v < 238) gray[p] = 1; else white++;
  }
  if (white < w * h * 0.5) return; // 紙の白が少ない（写真など）は触らない
  const deep = 0.09, kill = new Uint8Array(w * h);
  let any = false;
  const sweep = (mask, near) => {
    for (const c of components(mask, w, h)) {
      let mn = 1, mx = 0;
      for (const p of c.px) {
        const x = p % w, y = (p - x) / w, dp = Math.min((x + 0.5) / w, (w - x - 0.5) / w, (y + 0.5) / h, (h - y - 0.5) / h);
        if (dp < mn) mn = dp; if (dp > mx) mx = dp;
        if (mx > deep) break;
      }
      if (mn > near || mx > deep) continue;
      for (const p of c.px) kill[p] = 1;
      any = true;
    }
  };
  // まず濃いかたまり（机・となりのページの端）。縁から少し離れた見出しの帯は残る
  sweep(dark, 0.018);
  // 次に薄いかげり（影）。影は濃淡がなだらかで、写真の縁まで続く。見出しの帯の薄い部分や図の塗りは
  // 輪郭がはっきりしているので、明るさが急に変わる所を境目にして、影だけを縁からたどって消す
  const val = p => Math.min(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (kill[p]) { gray[p] = 1; continue; }
    if (!gray[p]) continue;
    const v = val(p);
    const g = Math.max(x > 0 ? Math.abs(v - val(p - 1)) : 0, x < w - 1 ? Math.abs(v - val(p + 1)) : 0, y > 0 ? Math.abs(v - val(p - w)) : 0, y < h - 1 ? Math.abs(v - val(p + w)) : 0);
    if (g > 26) gray[p] = 0;
  }
  sweep(gray, 0.006);
  if (!any) return;
  // 縁のぼけた分まで消えるよう、1画素ふくらませる
  const grown = morph(kill, w, h, 1, true);
  const ctx = ctx2d(canvas), full = ctx.getImageData(0, 0, W, H), o = full.data;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, (y * h / H) | 0);
    for (let x = 0; x < W; x++) if (grown[sy * w + Math.min(w - 1, (x * w / W) | 0)]) { const i = (y * W + x) * 4; o[i] = o[i + 1] = o[i + 2] = 255; }
  }
  ctx.putImageData(full, 0, 0);
}

// ---------- 傾き補正 ----------
// 文字の行が水平になる角度を探す（投影プロファイルの分散が最大になる角度）
export function detectSkew(canvas) {
  const img = shrink(canvas, 900), { width: w, height: h, data: d } = img;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  const mean = sum / (w * h * 3), pts = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 400000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4;
    if ((d[i] + d[i + 1] + d[i + 2]) / 3 < mean * 0.6) pts.push(x - w / 2, y - h / 2);
  }
  if (pts.length < 200) return 0;
  // 間引いた点の間隔と同じ幅の区間で数える（細かい区間だと0度だけ点が同じ区間に集まり、傾きを見逃していた）
  const rows = Math.ceil(Math.hypot(w, h) / step) + 2;
  const score = deg => {
    const t = deg * Math.PI / 180, s = Math.sin(t), c = Math.cos(t), hist = new Float64Array(rows);
    for (let i = 0; i < pts.length; i += 2) hist[((pts[i + 1] * c - pts[i] * s) / step + rows / 2) | 0]++;
    let v = 0; for (const n of hist) v += n * n;
    return v;
  };
  // 粗く→細かく
  let best = 0, bestScore = score(0);
  for (let a = -8; a <= 8; a += 0.5) { const sc = score(a); if (sc > bestScore) { bestScore = sc; best = a; } }
  const center = best;
  for (let a = center - 0.5; a <= center + 0.5; a += 0.1) { const sc = score(a); if (sc > bestScore) { bestScore = sc; best = a; } }
  // 縦書き（日本語の本）は列が縦に並ぶので、横方向でも試して強い方を採る
  const scoreV = deg => {
    const t = deg * Math.PI / 180, s = Math.sin(t), c = Math.cos(t), hist = new Float64Array(rows);
    for (let i = 0; i < pts.length; i += 2) hist[((pts[i] * c + pts[i + 1] * s) / step + rows / 2) | 0]++;
    let v = 0; for (const n of hist) v += n * n;
    return v;
  };
  let bestV = 0, bestVScore = scoreV(0);
  for (let a = -8; a <= 8; a += 0.5) { const sc = scoreV(a); if (sc > bestVScore) { bestVScore = sc; bestV = a; } }
  const cV = bestV;
  for (let a = cV - 0.5; a <= cV + 0.5; a += 0.1) { const sc = scoreV(a); if (sc > bestVScore) { bestVScore = sc; bestV = a; } }
  // 行の向き: 行と行の間のすき間は字と字の間より広いので、行に沿った方向のほうが山と谷がはっきり出る
  // （日本語は字が升目に並ぶため、改善の割合で比べると逆の向きを選ぶことがあった）
  const angle = bestVScore > bestScore ? bestV : best;
  return Math.abs(angle) < 0.15 ? 0 : angle;
}

export function rotateBy(canvas, deg, fill = '#fff') {
  if (!deg) return canvas;
  const W = canvas.width, H = canvas.height, out = makeCanvas(W, H), x = ctx2d(out);
  x.fillStyle = fill; x.fillRect(0, 0, W, H);
  x.translate(W / 2, H / 2);
  x.rotate(-deg * Math.PI / 180);
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, -W / 2, -H / 2);
  return out;
}

// ---------- 見開き分割 ----------
// 中央付近で最も暗い縦の帯（のど）を探し、そのx座標を返す
export function findGutter(canvas) {
  const img = shrink(canvas, 600), { width: w, height: h, data: d } = img;
  // 列ごとの明るさの中央値（のどの影は上から下まで続く。図の黒い部分などは一部の行だけなので効かない）
  const col = new Float64Array(w), buf = [];
  for (let x = 0; x < w; x++) {
    buf.length = 0;
    for (let y = Math.floor(h * 0.1); y < h * 0.9; y++) { const i = (y * w + x) * 4; buf.push(d[i] + d[i + 1] + d[i + 2]); }
    buf.sort((a, b) => a - b); col[x] = buf[buf.length >> 1];
  }
  let best = Math.round(w / 2), bestV = Infinity;
  for (let x = Math.floor(w * 0.35); x < w * 0.65; x++) {
    let v = 0;
    for (let k = -3; k <= 3; k++) v += col[Math.min(w - 1, Math.max(0, x + k))];
    // 中央から離れるほど少し不利にする
    v *= 1 + Math.abs(x - w / 2) / w;
    if (v < bestV) { bestV = v; best = x; }
  }
  return Math.round(best * canvas.width / w);
}

export function cropHalf(canvas, half, gutter = null) {
  const gx = gutter ?? findGutter(canvas), W = canvas.width, H = canvas.height;
  // のどの影を少し切り落とす（文字の行のすき間から求めたときは、行の端を切らないよう少しだけ）
  const trim = Math.round(W * (gutter == null ? 0.01 : 0.003));
  const x0 = half === 'left' ? 0 : Math.min(W - 8, gx + trim), x1 = half === 'left' ? Math.max(8, gx - trim) : W;
  const out = makeCanvas(Math.max(8, x1 - x0), H);
  ctx2d(out).drawImage(canvas, x0, 0, x1 - x0, H, 0, 0, x1 - x0, H);
  return out;
}

// PDF用に画質と大きさを変える
export async function recompress(blob, maxSide, quality) {
  const bitmap = await decode(blob);
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = makeCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k)), x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close?.();
  const out = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  return { blob: out, width: c.width, height: c.height };
}

// ---------- まとめ ----------
// opts: { rotation, filter, crop: 'auto' | 'none' | corners, half: 'left' | 'right' | null, deskew, fingers, denoise }
export async function processImage(original, opts) {
  const bitmap = await decode(original);
  // 見開きは2ページ分あるので、1ページあたりの細かさが落ちないよう大きめに扱う
  const maxSide = opts.half ? MAX_SIDE * 1.5 : MAX_SIDE;
  let canvas = drawRotated(bitmap, opts.rotation || 0, maxSide);
  bitmap.close?.();
  await tick();
  let corners = null, perPage = Array.isArray(opts.crop) && !!opts.perPage, fromLines = false, edgeFound = false, extended = false, leveled = false;
  if (opts.crop === 'auto') {
    corners = detectPage(canvas, opts.subject);
    // ページの端がはっきり写っていない（白い机に白い紙、ページが写真からはみ出す等）ときは、
    // 本文の行の並びからページの範囲と台形のゆがみを求める。見開きは左右のページを別々に求める
    if (opts.subject !== 'screen' && opts.lines && (!corners || insideSides(corners) < 3)) {
      const blocks = linesQuads(linesMain(opts.lines, canvas), canvas.width, canvas.height);
      let pick = null;
      // まず、すべての行を囲む範囲から外へたどって紙の端を探す（図の多いページや、机と紙の色が違うとき）。
      // 三辺以上で紙の端が見つかれば、それを使う（見開きは後で のど で左右に分ける）
      const main = linesMain(opts.lines, canvas);
      const span = linesSpan(main, canvas.width, canvas.height), info = {};
      const paper = span && expandToPaper(canvas, span, [], info);
      if (paper && info.found >= 3) { pick = { corners: paper, done: true }; edgeFound = true; }
      else if (paper && info.found >= 2) {
        // 紙の端が二辺だけ見つかったとき: 見つからない辺は行の範囲から広めに取る（紙が切れないように）
        pick = { corners: expandToPaper(canvas, span, [], {}, 0.05), done: true }; edgeFound = true;
      } else if (opts.half && blocks.length >= 2) {
        // 本文のかたまりを左右のページに分ける（1ページに見出しで区切られたかたまりが複数あっても、
        // 横位置のいちばん大きなすき間で左右に分け、それぞれ全部を囲む）
        const sorted = blocks.slice().sort((a, b) => a.cx - b.cx);
        let cut = 1, best = -1;
        for (let i = 1; i < sorted.length; i++) { const g = sorted[i].cx - sorted[i - 1].cx; if (g > best) { best = g; cut = i; } }
        const side = opts.half === 'left' ? sorted.slice(0, cut) : sorted.slice(cut);
        const all = side.flatMap(b => b.corners);
        const ext = f => all.reduce((p, q) => (f(q) > f(p) ? q : p));
        pick = { corners: [ext(([x, y]) => -x - y), ext(([x, y]) => x - y), ext(([x, y]) => x + y), ext(([x, y]) => y - x)] };
        perPage = true;
      } else if (!opts.half && blocks.length >= 2 && blocks[1].n > blocks[0].n * 0.5) {
        // 1ページとして撮った見開き: 左右のページをまとめた範囲
        const [l, r] = blocks.slice(0, 2).sort((a, b) => a.cx - b.cx);
        pick = { corners: [l.corners[0], r.corners[1], r.corners[2], l.corners[3]] };
      } else if (blocks.length && (!opts.half || blocks[0].wide)) pick = blocks[0];
      if (pick) {
        corners = pick.corners; fromLines = true;
        // 行だけで決めた範囲は、見出しの帯・図・ページ番号が切れないよう、紙の上の印刷が続く所まで広げる
        if (!pick.done) {
          corners = extendToContent(canvas, corners, perPage ? (opts.half === 'left' ? [1, 0, 1, 1] : [1, 1, 1, 0]) : [1, 1, 1, 1]);
          extended = true;
        }
      }
    }
  } else if (Array.isArray(opts.crop)) corners = opts.crop;
  const before = { w: canvas.width, h: canvas.height };
  if (corners) { canvas = warp(canvas, corners, maxSide); await tick(); }
  // 紙の反りで曲がった行をまっすぐにする（行の位置がわかっているとき）
  // 見開きの左右の境目は、文字の行のすき間から求める（のどの影がはっきりしない・中央からずれているときも正しく分ける）
  const gutter = opts.half && !perPage && corners && opts.lines ? linesGutter(canvas, corners, before, opts.lines) : null;
  if (corners && fromLines) { canvas = straightenLines(canvas, corners, before, opts.lines, gutter); await tick(); }
  if ((opts.half === 'left' || opts.half === 'right') && !perPage) canvas = cropHalf(canvas, opts.half, gutter);
  // 行の波打ち・傾きを画像から測って仕上げる（横書きの紙のみ。2回かけて残りを詰める）
  if (opts.subject !== 'screen' && opts.crop === 'auto' && opts.lines && linesVertical(opts.lines) === false) {
    for (let i = 0; i < 2; i++) { const c2 = levelRows(canvas); if (c2 === canvas) break; canvas = c2; leveled = true; await tick(); }
  }
  if (opts.moire) { demoire(canvas); await tick(); }
  enhance(canvas, { filter: opts.filter || 'none', fingers: !!opts.fingers, denoise: opts.denoise !== false, evenColor: opts.evenColor !== false });
  await tick();
  let skew = 0;
  // 文字のかたまりに合わせて切り抜き、台形のゆがみも直す（ページの端が見つからなかったとき・余白が多いとき）
  if (opts.crop === 'auto' && !edgeFound && !extended && (fromLines || !perPage) && opts.subject !== 'screen' && opts.filter !== 'none') {
    const q = textBlock(canvas);
    if (q) { canvas = warp(canvas, q, Math.max(canvas.width, canvas.height)); await tick(); }
  }
  // 行を水平にそろえ済みなら、全体を回す傾き補正はしない（回すとかえって傾く）
  if (opts.deskew && !leveled) { skew = detectSkew(canvas); canvas = rotateBy(canvas, skew); }
  if (opts.crop === 'auto' && opts.subject !== 'screen' && opts.filter !== 'none') clearEdges(canvas);
  const blob = await toJpeg(canvas, 0.86);
  // 一覧表示用の小さな画像（大量のページでも一覧が重くならないように）
  const tk = Math.min(1, 420 / Math.max(canvas.width, canvas.height));
  const tc = makeCanvas(Math.max(1, Math.round(canvas.width * tk)), Math.max(1, Math.round(canvas.height * tk))), tx = ctx2d(tc);
  tx.imageSmoothingQuality = 'high';
  tx.drawImage(canvas, 0, 0, tc.width, tc.height);
  const thumb = await toJpeg(tc, 0.7);
  return { blob, thumb, width: canvas.width, height: canvas.height, corners: corners || FULL_FRAME, skew, perPage };
}

// ---------- 向きの自動判定 ----------
// スマホを横にして撮ると、縦向きに固定した画面では本が90度回って写る。
// ページの形から「90度回す必要があるか」を調べ、必要なら右回り・左回りの2つの候補画像を作る
// （そのまま・右回り・左回りのどれが正しいかは文字を読んで決める）。split: 見開き（左右2ページ）として撮ったか
export async function orientCandidates(blob, split) {
  const bitmap = await decode(blob);
  let canvas = drawRotated(bitmap, 0, 1400);
  bitmap.close?.();
  const corners = detectPage(canvas, 'paper');
  if (corners) canvas = warp(canvas, corners);
  const w = canvas.width, h = canvas.height;
  // 見開きは横長、1ページは縦長のはず。そうでなければ横倒しに写っている
  const need = split ? h > w * 1.05 : w > h * 1.15;
  if (!need) return { need: false };
  const k = Math.min(1, 1100 / Math.max(w, h));
  const small = makeCanvas(Math.round(w * k), Math.round(h * k));
  ctx2d(small).drawImage(canvas, 0, 0, small.width, small.height);
  const cands = [];
  for (const r of [0, 90, 270]) {
    const c = r ? makeCanvas(small.height, small.width) : makeCanvas(small.width, small.height), x = ctx2d(c);
    x.translate(c.width / 2, c.height / 2); x.rotate(r * Math.PI / 180);
    x.drawImage(small, -small.width / 2, -small.height / 2);
    cands.push(await toJpeg(c, 0.85));
  }
  return { need: true, cands };
}

// 画像の上の方だけを切り出す（題名の読み取り用。小さい画像の方がOCRが速い）
export async function cropTop(blob, frac = 0.4, maxSide = 1600) {
  const bitmap = await decode(blob);
  const k = Math.min(1, maxSide / bitmap.width);
  const h = Math.round(bitmap.height * frac);
  const c = makeCanvas(Math.round(bitmap.width * k), Math.round(h * k)), x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(bitmap, 0, 0, bitmap.width, h, 0, 0, c.width, c.height);
  bitmap.close?.();
  return { blob: await toJpeg(c, 0.9), width: c.width, height: c.height / frac };
}

// 元画像を保存用に整える。大きすぎる写真は長辺3200pxに縮めて容量を抑える（向きはここで確定）
export async function limitOriginal(blob, maxSide = 3200) {
  const bitmap = await decode(blob);
  const big = Math.max(bitmap.width, bitmap.height);
  if (big <= maxSide && blob.size < 2.5e6) { bitmap.close?.(); return blob; }
  const k = Math.min(1, maxSide / big);
  const c = makeCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k)), x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close?.();
  return await toJpeg(c, 0.9);
}
