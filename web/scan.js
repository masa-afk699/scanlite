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
function documentTone(d, Y) {
  const hist = new Uint32Array(256);
  for (let p = 0; p < Y.length; p += 3) hist[Y[p]]++;
  const total = hist.reduce((a, b) => a + b, 0);
  const pct = q => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * q) return v; } return 255; };
  const paper = pct(0.6), black = Math.min(pct(0.004), paper - 90);
  const white = Math.max(black + 60, paper - 16), k = 255 / (white - black);
  const lut = new Uint8ClampedArray(256);
  // 芯はほぼ黒に、中間調は少し濃く（小さい文字やかすれた文字も読みやすく）
  for (let v = 0; v < 256; v++) { const t = Math.min(1, Math.max(0, (v - black) * k / 255)); lut[v] = 8 + 247 * Math.pow(t, 1.15); }
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
}

// 背景のまだら・縞・薄い汚れを白にし、点状のゴミとページ端の線を消す。
// binarize: 文字を黒・背景を白にくっきり分ける（白黒）
function cleanDocument(d, W, H, { binarize, fine = false }) {
  // 画面の細かい縞を打ち消す処理。紙の写真では薄い・ぼけた文字まで紙と見なして消してしまうので使わない
  if (fine) flattenFine(d, W, H);
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
    // 輪郭を少し締めて、にじんだ文字を細く・くっきりさせる
    for (let p = 0, i = 0; p < Y.length; p++, i += 4) {
      const dv = 0.9 * (Y[p] - S[p]);
      if (dv) { d[i] += dv; d[i + 1] += dv; d[i + 2] += dv; }
    }
    documentTone(d, Y);
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
  for (const c of components(dark, W, H)) {
    // 小さすぎて周りに何もない点、または濃い芯のない薄いまだら（画面の縞・ざらつき）は文字ではない
    let core = 255;
    for (const p of c.px) if (Y2[p] < core) core = Y2[p];
    if (c.px.length > maxArea && (core < 150 || c.px.length > maxArea * 40)) continue;
    if (c.px.length <= maxArea && core < 150 && count(c.minX - R, c.minY - R, c.maxX + R + 1, c.maxY + R + 1) > c.px.length) continue;
    for (const p of c.px) d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 255;
  }
  // ページの端にかかった暗いかたまり（影になった指・のどの奥・本の外の机など）を消す。
  // 文字は端に接しないので、端に接していて文字より大きく、中まで詰まった暗い部分だけを対象にする
  const big = Math.max(W, H) / 50;
  for (const c of components(dark, W, H)) {
    if (c.minX > 1 && c.minY > 1 && c.maxX < W - 2 && c.maxY < H - 2) continue;
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (Math.max(bw, bh) < big || c.px.length > W * H * 0.06 || c.px.length < bw * bh * 0.3) continue;
    for (const p of c.px) d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 255;
  }
  // 線の判定は薄いグレーも含める（かすれた縁の線も消せるように）
  for (let p = 0; p < dark.length; p++) dark[p] = d[p * 4] < 235 || d[p * 4 + 1] < 235 || d[p * 4 + 2] < 235 ? 1 : 0;
  removeEdgeLines(d, W, H, dark);
}

// ページの縁に沿った長い線（元の紙の端・とじ目・画面の枠）を消す
function removeEdgeLines(d, W, H, dark) {
  const whiten = p => { d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 255; };
  const mx = Math.round(W * 0.07), my = Math.round(H * 0.07);
  const isDark = (x, y) => dark[y * W + x] || (x > 0 && dark[y * W + x - 1]) || (x < W - 1 && dark[y * W + x + 1]);
  const isDarkV = (x, y) => dark[y * W + x] || (y > 0 && dark[(y - 1) * W + x]) || (y < H - 1 && dark[(y + 1) * W + x]);
  for (const x of [...Array(mx).keys(), ...Array.from({ length: mx }, (_, i) => W - 1 - i)]) {
    let run = 0, best = 0;
    for (let y = 0; y < H; y++) { run = isDark(x, y) ? run + 1 : 0; if (run > best) best = run; }
    if (best > H * 0.15) for (let y = 0; y < H; y++) for (let k = -2; k <= 2; k++) { const xx = x + k; if (xx >= 0 && xx < W && dark[y * W + xx]) whiten(y * W + xx); }
  }
  for (const y of [...Array(my).keys(), ...Array.from({ length: my }, (_, i) => H - 1 - i)]) {
    let run = 0, best = 0;
    for (let x = 0; x < W; x++) { run = isDarkV(x, y) ? run + 1 : 0; if (run > best) best = run; }
    if (best > W * 0.15) for (let x = 0; x < W; x++) for (let k = -2; k <= 2; k++) { const yy = y + k; if (yy >= 0 && yy < H && dark[yy * W + x]) whiten(yy * W + x); }
  }
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

// ---------- 紙の反りの補正 ----------
// 台形補正した画像の上で、各行の中心線が水平になるよう縦方向に画素をずらす。
// 行と行の間はずれ量をなめらかにつなぐ。corners: 台形補正に使った四隅（割合）、size: 補正前の画像の大きさ
function straightenLines(canvas, corners, size, lines) {
  const W = canvas.width, H = canvas.height;
  // 補正前の画像の座標 → 補正後の画像の座標（射影変換の逆）
  const m = squareToQuad(corners.map(([x, y]) => [x * size.w, y * size.h]));
  const A = [[m.a, m.b, m.c], [m.d, m.e, m.f], [m.g, m.h, 1]];
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  if (Math.abs(det) < 1e-12) return canvas;
  const inv = [
    [(A[1][1] * A[2][2] - A[1][2] * A[2][1]) / det, (A[0][2] * A[2][1] - A[0][1] * A[2][2]) / det, (A[0][1] * A[1][2] - A[0][2] * A[1][1]) / det],
    [(A[1][2] * A[2][0] - A[1][0] * A[2][2]) / det, (A[0][0] * A[2][2] - A[0][2] * A[2][0]) / det, (A[0][2] * A[1][0] - A[0][0] * A[1][2]) / det],
    [(A[1][0] * A[2][1] - A[1][1] * A[2][0]) / det, (A[0][1] * A[2][0] - A[0][0] * A[2][1]) / det, (A[0][0] * A[1][1] - A[0][1] * A[1][0]) / det],
  ];
  const toOut = ([x, y]) => {
    const X = x * size.w, Y = y * size.h, z = inv[2][0] * X + inv[2][1] * Y + inv[2][2];
    return [(inv[0][0] * X + inv[0][1] * Y + inv[0][2]) / z * W, (inv[1][0] * X + inv[1][1] * Y + inv[1][2]) / z * H];
  };
  // このページの中にある横向きの長い行だけ使う
  const polys = [];
  const ts = lines.map(l => l.t).sort((a, b) => a - b), tMed = ts[ts.length >> 1] || 0;
  for (const l of lines) {
    if (!l.pts || l.pts.length < 6 || l.t > tMed * 1.6) continue; // 2行がつながって検出されたものは使わない
    const P = l.pts.map(toOut);
    if (P.some(([x, y]) => x < -W * 0.02 || x > W * 1.02 || y < 0 || y > H)) continue;
    const dx = P[P.length - 1][0] - P[0][0];
    if (Math.abs(dx) < W * 0.3 || Math.abs(P[P.length - 1][1] - P[0][1]) > Math.abs(dx) * 0.3) continue;
    if (dx < 0) P.reverse();
    polys.push(P);
  }
  if (polys.length < 5) return canvas;
  // 各行の、あるべき高さ（行のまっすぐな部分＝中央値）からのずれを列ごとに求める
  const C = 48, colX = Array.from({ length: C + 1 }, (_, i) => i * W / C);
  // 列ごとに、その列を通る行の（あるべき高さ, ずれ）の一覧を作る
  const cols = colX.map(() => []);
  let maxOff = 0;
  for (const P of polys) {
    const ys = P.map(p => p[1]).slice().sort((a, b) => a - b), base = ys[ys.length >> 1];
    colX.forEach((x, c) => {
      // 行の端より外は、端の曲がり方をそのまま延ばす（行の長さの1/4まで）
      const span = P[P.length - 1][0] - P[0][0];
      if (x < P[0][0] - span * 0.25 || x > P[P.length - 1][0] + span * 0.25) return;
      let k = 1; while (k < P.length - 1 && x > P[k][0]) k++;
      const t = (x - P[k - 1][0]) / (P[k][0] - P[k - 1][0] || 1), off = P[k - 1][1] + (P[k][1] - P[k - 1][1]) * t - base;
      cols[c].push([base, off]);
      maxOff = Math.max(maxOff, Math.abs(off));
    });
  }
  cols.forEach(l => l.sort((a, b) => a[0] - b[0]));
  if (maxOff < H * 0.003) return canvas; // ほとんど曲がっていない
  const offAt = (c, y) => {
    const l = cols[c];
    if (!l.length) return 0;
    if (y <= l[0][0]) return l[0][1];
    if (y >= l[l.length - 1][0]) return l[l.length - 1][1];
    let k = 1; while (k < l.length && l[k][0] < y) k++;
    const t = (y - l[k - 1][0]) / (l[k][0] - l[k - 1][0] || 1);
    return l[k - 1][1] + (l[k][1] - l[k - 1][1]) * t;
  };
  // 出力の各画素 (x, y) は、元の (x, y + ずれ) から取る。ずれは上下の行の間で直線的につなぐ
  const src = ctx2d(canvas).getImageData(0, 0, W, H).data;
  const out = makeCanvas(W, H), octx = ctx2d(out), dst = octx.createImageData(W, H), o = dst.data;
  const colOff = new Float32Array(C + 1);
  for (let y = 0; y < H; y++) {
    for (let c = 0; c <= C; c++) colOff[c] = offAt(c, y);
    for (let x = 0; x < W; x++) {
      const cf = x / W * C, c0 = Math.min(C - 1, cf | 0), t = cf - c0;
      let sy = y + colOff[c0] + (colOff[c0 + 1] - colOff[c0]) * t;
      sy = Math.min(H - 1.001, Math.max(0, sy));
      const y0 = sy | 0, fy = sy - y0, i0 = (y0 * W + x) * 4, i1b = i0 + W * 4, oi = (y * W + x) * 4;
      o[oi] = src[i0] + (src[i1b] - src[i0]) * fy; o[oi + 1] = src[i0 + 1] + (src[i1b + 1] - src[i0 + 1]) * fy; o[oi + 2] = src[i0 + 2] + (src[i1b + 2] - src[i0 + 2]) * fy; o[oi + 3] = 255;
    }
  }
  octx.putImageData(dst, 0, 0);
  return out;
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
  const col = new Float64Array(w);
  for (let y = Math.floor(h * 0.1); y < h * 0.9; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    col[x] += d[i] + d[i + 1] + d[i + 2];
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

export function cropHalf(canvas, half) {
  const gx = findGutter(canvas), W = canvas.width, H = canvas.height;
  // のどの影を少し切り落とす
  const trim = Math.round(W * 0.02);
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
  let corners = null, perPage = Array.isArray(opts.crop) && !!opts.perPage, fromLines = false;
  if (opts.crop === 'auto') {
    corners = detectPage(canvas, opts.subject);
    // ページの端がはっきり写っていない（白い机に白い紙、ページが写真からはみ出す等）ときは、
    // 本文の行の並びからページの範囲と台形のゆがみを求める。見開きは左右のページを別々に求める
    if (opts.subject !== 'screen' && opts.lines && (!corners || insideSides(corners) < 3)) {
      const blocks = linesQuads(opts.lines, canvas.width, canvas.height);
      let pick = null;
      if (opts.half && blocks.length >= 2) {
        const two = blocks.slice(0, 2).sort((a, b) => a.cx - b.cx);
        pick = opts.half === 'left' ? two[0] : two[1];
        perPage = true;
      } else if (!opts.half && blocks.length >= 2 && blocks[1].n > blocks[0].n * 0.5) {
        // 1ページとして撮った見開き: 左右のページをまとめた範囲
        const [l, r] = blocks.slice(0, 2).sort((a, b) => a.cx - b.cx);
        pick = { corners: [l.corners[0], r.corners[1], r.corners[2], l.corners[3]] };
      } else if (blocks.length && (!opts.half || blocks[0].wide)) pick = blocks[0];
      if (pick) { corners = pick.corners; fromLines = true; }
    }
  } else if (Array.isArray(opts.crop)) corners = opts.crop;
  const before = { w: canvas.width, h: canvas.height };
  if (corners) { canvas = warp(canvas, corners, maxSide); await tick(); }
  // 紙の反りで曲がった行をまっすぐにする（行の位置がわかっているとき）
  if (corners && fromLines) { canvas = straightenLines(canvas, corners, before, opts.lines); await tick(); }
  if ((opts.half === 'left' || opts.half === 'right') && !perPage) canvas = cropHalf(canvas, opts.half);
  if (opts.moire) { demoire(canvas); await tick(); }
  enhance(canvas, { filter: opts.filter || 'none', fingers: !!opts.fingers, denoise: opts.denoise !== false, evenColor: opts.evenColor !== false });
  await tick();
  let skew = 0;
  // 文字のかたまりに合わせて切り抜き、台形のゆがみも直す（ページの端が見つからなかったとき・余白が多いとき）
  if (opts.crop === 'auto' && (fromLines || !perPage) && opts.subject !== 'screen' && opts.filter !== 'none') {
    const q = textBlock(canvas);
    if (q) { canvas = warp(canvas, q, Math.max(canvas.width, canvas.height)); await tick(); }
  }
  if (opts.deskew) { skew = detectSkew(canvas); canvas = rotateBy(canvas, skew); }
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
