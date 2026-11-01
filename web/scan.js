// 画像補正の処理一式。すべて端末内（ブラウザー）で計算し、外部には何も送らない。
// 対象: ページ端の検出と台形補正、傾き補正、明るさの均一化、ノイズ除去、指の消去。

export const MAX_SIDE = 2400;
const tick = () => new Promise(r => setTimeout(r, 0));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
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
export function detectPage(canvas, subject = 'paper') {
  const img = shrink(canvas, 360), { width: w, height: h, data: d } = img;
  const score = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < score.length; i += 4, p++) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    score[p] = subject === 'screen' ? (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8 : Math.max(0, Math.min(255, mx - 1.5 * (mx - mn)));
  }
  // 画面: 暗い枠・部屋と、光っている画面（色の濃いタイトルバーなども含む）を分ける
  const t = subject === 'screen' ? Math.max(45, Math.min(otsu(score), 70)) : otsu(score);
  let mask = new Uint8Array(w * h);
  for (let p = 0; p < mask.length; p++) mask[p] = score[p] > t ? 1 : 0;
  // 文字の穴を埋め、細いつながりを切る
  mask = morph(mask, w, h, 2, true); mask = morph(mask, w, h, 4, false); mask = morph(mask, w, h, 2, true);
  const comps = components(mask, w, h);
  if (!comps.length) return null;
  const page = comps.reduce((a, b) => (b.px.length > a.px.length ? b : a));
  if (page.px.length < w * h * 0.12) return null;
  // 画像全体が紙なら切り抜き不要
  if (page.px.length > w * h * 0.97) return null;
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, -Infinity];
  for (const p of page.px) {
    const x = p % w, y = (p - x) / w;
    if (x + y < tl[2]) tl = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y];
    if (x + y > br[2]) br = [x, y, x + y];
    if (y - x > bl[2]) bl = [x, y, y - x];
  }
  const corners = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
  // 中心へ少しだけ寄せて、机の写り込みを残さない
  const cx = corners.reduce((s, c) => s + c[0], 0) / 4, cy = corners.reduce((s, c) => s + c[1], 0) / 4;
  return corners.map(([x, y]) => [x + (cx - x) * 0.01, y + (cy - y) * 0.01]);
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

export function warp(canvas, corners) {
  const W = canvas.width, H = canvas.height;
  const q = corners.map(([x, y]) => [x * W, y * H]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let ow = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, oh = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const k = Math.min(1, MAX_SIDE / Math.max(ow, oh));
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
  const b1 = ctx2d(blurred(canvas, r)).getImageData(0, 0, W, H).data;
  const b2 = ctx2d(blurred(canvas, r * 3)).getImageData(0, 0, W, H).data;
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
    const Y = y1 + 0.9 * (y1 - y2);
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
    screenLevels(d);
    // 背景（白い画面やタイトルバーの地の色）に近い部分をその色にそろえ、明るさの縞を消す
    x.putImageData(img, 0, 0);
    const bg = estimateBackground(canvas);
    for (let i = 0; i < d.length; i += 4) {
      const yy = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const yb = Math.max(1, 0.299 * bg[i] + 0.587 * bg[i + 1] + 0.114 * bg[i + 2]);
      const k = Math.min(1, Math.max(0, (yy / yb - 0.78) / 0.12));
      if (k > 0) { d[i] += (bg[i] - d[i]) * k; d[i + 1] += (bg[i + 1] - d[i + 1]) * k; d[i + 2] += (bg[i + 2] - d[i + 2]) * k; }
    }
  } else if (filter !== 'none') {
    const bg = estimateBackground(canvas);
    // gray/color はなめらかに、bw は文字をくっきり（ほぼ2値）にする
    const gamma = filter === 'gray' ? 1.6 : 1.35, lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = filter === 'bw' ? Math.max(0, Math.min(255, (i - 150) * 255 / 70)) : 255 * Math.pow(i / 255, gamma);
    }
    for (let i = 0; i < d.length; i += 4) {
      const r = Math.min(255, d[i] * 250 / Math.max(bg[i], 1));
      const g = Math.min(255, d[i + 1] * 250 / Math.max(bg[i + 1], 1));
      const b = Math.min(255, d[i + 2] * 250 / Math.max(bg[i + 2], 1));
      if (filter === 'bw' || filter === 'gray') {
        d[i] = d[i + 1] = d[i + 2] = lut[Math.round(0.299 * r + 0.587 * g + 0.114 * b)];
      } else {
        d[i] = lut[r | 0]; d[i + 1] = lut[g | 0]; d[i + 2] = lut[b | 0];
      }
    }
    if (filter === 'color' && evenColor) removeColorBlotches(d, W, H);
    if (fingerMask) for (let p = 0; p < W * H; p++) if (fingerMask[p]) d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = 255;
  }

  if (denoise && filter !== 'none' && filter !== 'screen') {
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

// ---------- 傾き補正 ----------
// 文字の行が水平になる角度を探す（投影プロファイルの分散が最大になる角度）
export function detectSkew(canvas) {
  const img = shrink(canvas, 900), { width: w, height: h, data: d } = img;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  const mean = sum / (w * h * 3), pts = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 120000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4;
    if ((d[i] + d[i + 1] + d[i + 2]) / 3 < mean * 0.6) pts.push(x - w / 2, y - h / 2);
  }
  if (pts.length < 200) return 0;
  const rows = Math.ceil(Math.hypot(w, h)) + 2;
  const score = deg => {
    const t = deg * Math.PI / 180, s = Math.sin(t), c = Math.cos(t), hist = new Float64Array(rows);
    for (let i = 0; i < pts.length; i += 2) hist[(pts[i + 1] * c - pts[i] * s + rows / 2) | 0]++;
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
    for (let i = 0; i < pts.length; i += 2) hist[(pts[i] * c + pts[i + 1] * s + rows / 2) | 0]++;
    let v = 0; for (const n of hist) v += n * n;
    return v;
  };
  let bestV = 0, bestVScore = scoreV(0);
  for (let a = -8; a <= 8; a += 0.5) { const sc = scoreV(a); if (sc > bestVScore) { bestVScore = sc; bestV = a; } }
  const cV = bestV;
  for (let a = cV - 0.5; a <= cV + 0.5; a += 0.1) { const sc = scoreV(a); if (sc > bestVScore) { bestVScore = sc; bestV = a; } }
  const horizontalGain = bestScore / score(0), verticalGain = bestVScore / scoreV(0);
  const angle = verticalGain > horizontalGain ? bestV : best;
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
  let canvas = drawRotated(bitmap, opts.rotation || 0);
  bitmap.close?.();
  await tick();
  let corners = null;
  if (opts.crop === 'auto') corners = detectPage(canvas, opts.subject);
  else if (Array.isArray(opts.crop)) corners = opts.crop;
  if (corners) { canvas = warp(canvas, corners); await tick(); }
  if (opts.half === 'left' || opts.half === 'right') canvas = cropHalf(canvas, opts.half);
  if (opts.moire) { demoire(canvas); await tick(); }
  enhance(canvas, { filter: opts.filter || 'none', fingers: !!opts.fingers, denoise: opts.denoise !== false, evenColor: opts.evenColor !== false });
  await tick();
  let skew = 0;
  if (opts.deskew) { skew = detectSkew(canvas); canvas = rotateBy(canvas, skew); }
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.86));
  // 一覧表示用の小さな画像（大量のページでも一覧が重くならないように）
  const tk = Math.min(1, 420 / Math.max(canvas.width, canvas.height));
  const tc = makeCanvas(Math.max(1, Math.round(canvas.width * tk)), Math.max(1, Math.round(canvas.height * tk))), tx = ctx2d(tc);
  tx.imageSmoothingQuality = 'high';
  tx.drawImage(canvas, 0, 0, tc.width, tc.height);
  const thumb = await new Promise(r => tc.toBlob(r, 'image/jpeg', 0.7));
  return { blob, thumb, width: canvas.width, height: canvas.height, corners: corners || FULL_FRAME, skew };
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
  return { blob: await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)), width: c.width, height: c.height / frac };
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
  return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
}
