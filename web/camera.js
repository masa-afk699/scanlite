// アプリ内カメラ。ページをめくって手を止めると自動で撮影する（連続撮影）。
// 映像はこの画面の中で使うだけで、どこにも送らない。

const MOTION = 10;     // これ以上の変化で「動いた」とみなす（0〜255の平均差）
const STILL = 3.2;     // これ以下で「止まっている」とみなす
const HOLD_MS = 900;   // 止まってから撮影するまでの時間

import { detectPage } from './scan.js';
import { sharpness as photoSharpness, BLURRY_BELOW } from './sharp.js';

export function createCamera({ dialog, video, status, shutter, autoToggle, counter, onCapture, guide, torch, thumb, subject = () => 'paper', split = () => false, order = () => 'rtl', paused = () => false }) {
  let stream = null, timer = null, prev = null, stillSince = 0, needMotion = false, busy = false, shots = 0;
  const probe = document.createElement('canvas');
  probe.width = 80; probe.height = 60;
  const pctx = probe.getContext('2d', { willReadFrequently: true });

  // 注意（ぼけて撮り直し）は、すぐ次の案内で消えて見落とさないよう、しばらく残す
  let warnUntil = 0;
  const say = (t, warn = false) => {
    const now = performance.now();
    if (!warn && now < warnUntil) return;
    warnUntil = warn ? now + 2500 : 0;
    status.textContent = t; status.classList.toggle('warn', warn);
  };
  // 同じページで続けてぼけたときの撮り直し回数（2回までその場で撮り直し、3回目はそのまま残す）
  let blurTries = 0;

  // 開くたびに番号を進める。カメラの起動を待っている間に閉じられたら、後から届いた映像はすぐ止める
  // （以前は閉じた後に映像が届くと、画面が消えたままカメラと自動撮影が動き続けていた）
  let session = 0;
  const stale = id => id !== session || !dialog.open;
  async function open() {
    const id = ++session;
    shots = 0; blurTries = 0; counter.textContent = '0';
    if (thumb) { if (thumb.src) URL.revokeObjectURL(thumb.src); thumb.removeAttribute('src'); thumb.hidden = true; }
    dialog.showModal();
    say('カメラを起動しています…');
    let got;
    try {
      got = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // できるだけ高い解像度で（4:3の全画角→4K→ブラウザーに任せる、の順に試す）
        video: {
          facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 },
          advanced: [{ width: 4032, height: 3024 }, { width: 4000, height: 3000 }, { width: 3264, height: 2448 }],
        },
      });
    } catch (e) {
      if (!stale(id)) say('カメラを使えませんでした。ブラウザーの設定でカメラを許可してください。');
      return;
    }
    if (stale(id)) { got.getTracks().forEach(t => t.stop()); return; }
    stream = got;
    // ピントは合わせ続ける（対応している端末だけ）
    try {
      const track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch {}
    if (stale(id)) { stream?.getTracks().forEach(t => t.stop()); stream = null; return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (stale(id)) { close(); return; }
    setupStill();
    setupTorch();
    prev = null; stillSince = 0; needMotion = false; sharpMax = 0;
    const aim = split() ? '本の綴じ目（のど）を点線に合わせて、' : 'ページを枠に入れて、';
    say(autoToggle.checked ? aim + '手を止めると自動で撮影します' : aim + 'シャッターを押して撮影します');
    timer = setInterval(watch, 180);
    window.addEventListener('devicemotion', onMotion);
  }

  // 撮影したときのスマホの傾き（横持ちかどうか）。向きを決める手がかりにする
  // 横持ちかどうか（見開きの中央線の向きに使う）。向きが変わる境目でちらつかないよう少し幅を持たせる
  let tiltX = null, landscape = false;
  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || typeof g.x !== 'number') return;
    tiltX = g.x;
    const ax = Math.abs(g.x), ay = Math.abs(g.y || 0);
    if (!landscape && ax > ay * 1.3 && ax > 4) landscape = true;
    else if (landscape && ay > ax * 1.3 && ay > 4) landscape = false;
  }

  function close() {
    session++;
    clearInterval(timer); timer = null;
    window.removeEventListener('devicemotion', onMotion); tiltX = null; landscape = false;
    clearGuide();
    torchOn = false; torch.disabled = true; torch.setAttribute('aria-pressed', 'false');
    stream?.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    if (dialog.open) dialog.close();
  }

  // ---------- ライト（対応している端末だけ） ----------
  let torchOn = false;
  function setupTorch() {
    const track = stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities ? track.getCapabilities() : {};
    torch.disabled = !caps.torch;
  }
  torch.onclick = async () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
    torch.setAttribute('aria-pressed', String(torchOn));
  };

  // ---------- ページの枠をプレビューに重ねて表示 ----------
  const small = document.createElement('canvas');
  let tickCount = 0;
  function clearGuide() { guide.getContext('2d').clearRect(0, 0, guide.width, guide.height); }
  function drawGuide() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const k = 360 / Math.max(vw, vh);
    small.width = Math.round(vw * k); small.height = Math.round(vh * k);
    small.getContext('2d').drawImage(video, 0, 0, small.width, small.height);
    let corners = null;
    try { corners = detectPage(small, subject()); } catch {}
    const r = guide.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (guide.width !== Math.round(r.width * dpr)) { guide.width = Math.round(r.width * dpr); guide.height = Math.round(r.height * dpr); }
    const g = guide.getContext('2d');
    g.clearRect(0, 0, guide.width, guide.height);
    // 映像は object-fit: contain で表示しているので、その位置に合わせる
    const s = Math.min(guide.width / vw, guide.height / vh), ox = (guide.width - vw * s) / 2, oy = (guide.height - vh * s) / 2;
    const two = split();
    if (corners) {
      // 見つけた紙の範囲を、緑がかった色で塗って縁取る
      g.beginPath();
      corners.forEach(([x, y], i) => { const px = ox + x * vw * s, py = oy + y * vh * s; i ? g.lineTo(px, py) : g.moveTo(px, py); });
      g.closePath();
      g.fillStyle = 'rgba(92,196,168,0.55)'; g.fill();
      g.lineWidth = 3 * dpr; g.lineJoin = 'round'; g.strokeStyle = '#4fb79b'; g.stroke();
    }
    const box = corners && corners.map(([x, y]) => [ox + x * vw * s, oy + y * vh * s]);
    if (two) drawSpread(g, ox, oy, vw * s, vh * s, dpr, box);
  }

  // 見開き（2ページ）のとき、左右のページの境目（のど）を合わせる点線と、
  // 保存される順番（1・2）を各ページの上に出す。横持ちで撮るときは、画面上では横向きの線になり、
  // 数字も持っている向きから読めるように回す
  function drawSpread(g, x, y, w, h, dpr, box) {
    const horiz = landscape;
    const cx = x + w / 2, cy = y + h / 2;
    g.save();
    g.setLineDash([16 * dpr, 12 * dpr]);
    g.lineWidth = 3 * dpr; g.strokeStyle = '#fff';
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 3 * dpr;
    g.beginPath();
    if (horiz) { g.moveTo(0, cy); g.lineTo(guide.width, cy); } else { g.moveTo(cx, 0); g.lineTo(cx, guide.height); }
    g.stroke();
    g.restore();
    if (!box) return;
    // 画面の 前半（左／上）と 後半（右／下）が、紙の上ではどちらのページか
    // 縦持ち: 前半＝左ページ。横持ち: tilt>0 のときページの上が画面の右（前半＝左ページ）、tilt<0 は逆
    const up = horiz ? ((tiltX ?? 1) > 0 ? 1 : -1) : 0;
    const firstIsLeft = !horiz || up > 0;
    const leftNo = order() === 'rtl' ? 2 : 1;
    const nums = firstIsLeft ? [leftNo, 3 - leftNo] : [3 - leftNo, leftNo];
    // 数字は、紙の範囲の端と点線のあいだの真ん中に置く
    const xs = box.map(p => p[0]), ys = box.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const spots = horiz ? [[(x0 + x1) / 2, (y0 + cy) / 2], [(x0 + x1) / 2, (cy + y1) / 2]] : [[(x0 + cx) / 2, (y0 + y1) / 2], [(cx + x1) / 2, (y0 + y1) / 2]];
    const size = Math.min(x1 - x0, y1 - y0) * 0.16;
    g.save();
    g.fillStyle = '#fff';
    g.font = `300 ${Math.round(Math.max(24 * dpr, size))}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.25)'; g.shadowBlur = 4 * dpr;
    spots.forEach(([px, py], i) => {
      g.save(); g.translate(px, py); g.rotate(up * Math.PI / 2); g.fillText(String(nums[i]), 0, 0); g.restore();
    });
    g.restore();
  }

  // 映像の中央部分のくっきり具合（細かい明暗の差の大きさ）。手ぶれ・ピンぼけのフレームでは小さくなる
  const sharpCanvas = document.createElement('canvas');
  sharpCanvas.width = 240; sharpCanvas.height = 180;
  const sctx = sharpCanvas.getContext('2d', { willReadFrequently: true });
  let sharpMax = 0;
  function sharpness() {
    const vw = video.videoWidth, vh = video.videoHeight;
    // 中央の 1/3 ほどを等倍に近い細かさで見る（縮小すると ぼけ が見えなくなるので）
    const cw = Math.min(vw, 720), ch = Math.min(vh, 540);
    sctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, 240, 180);
    const d = sctx.getImageData(0, 0, 240, 180).data;
    let e = 0;
    for (let y = 1; y < 179; y++) for (let x = 1; x < 239; x++) {
      const i = (y * 240 + x) * 4, c = d[i + 1];
      const g = Math.abs(4 * c - d[i - 3] - d[i + 5] - d[i - 959] - d[i + 961]);
      e += g * g;
    }
    return e / (238 * 178);
  }

  // 小さく縮小した映像の前回との差で、動きと静止を判定する
  function watch() {
    if (!video.videoWidth || busy) return;
    // 保存先を選んでいる間は自動撮影しない（選び終えたら、もう一度動きを待つ）
    if (paused()) { prev = null; stillSince = 0; needMotion = shots > 0; return; }
    if (++tickCount % 2 === 0) drawGuide();
    pctx.drawImage(video, 0, 0, 80, 60);
    const d = pctx.getImageData(0, 0, 80, 60).data, cur = new Uint8Array(80 * 60);
    for (let i = 0, p = 0; p < cur.length; i += 4, p++) cur[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    if (!prev) { prev = cur; return; }
    let diff = 0;
    for (let p = 0; p < cur.length; p++) diff += Math.abs(cur[p] - prev[p]);
    diff /= cur.length;
    prev = cur;
    if (!autoToggle.checked) return;
    const now = performance.now();
    if (diff > MOTION) {
      needMotion = false; stillSince = 0; sharpMax = 0;
      say('動きを検出しました。手を止めてください');
    } else if (!needMotion && diff < STILL) {
      // 止まっている間のくっきり具合を見て、ピントが合いぶれていないフレームで撮る
      // （ピント合わせの途中や、わずかに揺れたフレームは、文字がぼやけて仕上がりがかすれるので）
      const sh = sharpness();
      if (!stillSince) { stillSince = now; sharpMax = sh; }
      else {
        sharpMax = Math.max(sharpMax, sh);
        const held = now - stillSince;
        if (held > HOLD_MS && (sh >= sharpMax * 0.9 || held > HOLD_MS * 3)) take();
        else if (held > HOLD_MS) say('ピントを合わせています…');
      }
    } else if (diff >= STILL) {
      stillSince = 0; sharpMax = 0;
    }
  }

  // 高画質の静止画（ImageCapture.takePhoto）。映像のフレームは多くのスマホで 1920×1080 ほどに抑えられ、
  // 動画向けの圧縮・ノイズ消しもかかって文字がぼやけるので、カメラ本来の解像度の静止画が撮れる端末ではそちらを使う
  let still = null;
  async function setupStill() {
    still = null;
    try {
      if (typeof ImageCapture === 'undefined') return;
      const track = stream?.getVideoTracks()[0];
      if (!track) return;
      const ic = new ImageCapture(track), pc = await ic.getPhotoCapabilities();
      const big = Math.max(pc.imageWidth?.max || 0, pc.imageHeight?.max || 0), now = Math.max(video.videoWidth, video.videoHeight);
      // 映像より2割以上大きく撮れるときだけ（同じくらいなら速いフレームの方がよい）
      if (!big || big < now * 1.2) return;
      const settings = {};
      if (pc.imageWidth?.max) { settings.imageWidth = pc.imageWidth.max; settings.imageHeight = pc.imageHeight.max; }
      if (pc.fillLightMode?.includes('off')) settings.fillLightMode = 'off';
      still = { ic, settings };
    } catch { still = null; }
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  // 映像の向き（縦長か横長か）と同じ向きの JPEG にする。向きが違うときは、映像の小さな画像と見比べて回す向きを決める
  async function stillShot() {
    const vw = video.videoWidth, vh = video.videoHeight;
    // 比べるための今の映像（静止画を撮る前に取っておく）
    const ref = document.createElement('canvas'); ref.width = 48; ref.height = 48;
    ref.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, 48, 48);
    let photo;
    try { photo = await withTimeout(still.ic.takePhoto(still.settings), 3000); }
    catch { photo = await withTimeout(still.ic.takePhoto(), 3000); }
    let bm;
    try { bm = await createImageBitmap(photo, { imageOrientation: 'from-image' }); } catch { bm = await createImageBitmap(photo); }
    const pw = bm.width, ph = bm.height;
    let turn = 0;
    if ((pw > ph) !== (vw > vh) && Math.abs(pw - ph) > Math.min(pw, ph) * 0.05) {
      const diff = deg => {
        const c = document.createElement('canvas'); c.width = 48; c.height = 48;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.translate(24, 24); x.rotate(deg * Math.PI / 180); x.drawImage(bm, -24, -24, 48, 48);
        const a = x.getImageData(0, 0, 48, 48).data, b = ref.getContext('2d').getImageData(0, 0, 48, 48).data;
        let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i + 1] - b[i + 1]);
        return d;
      };
      turn = diff(90) <= diff(270) ? 90 : 270;
    }
    // 長辺4000pxまで（保存するときにさらに3200pxに抑える）
    const k = Math.min(1, 4000 / Math.max(pw, ph)), w = Math.round(pw * k), h = Math.round(ph * k);
    const c = document.createElement('canvas');
    c.width = turn ? h : w; c.height = turn ? w : h;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.translate(c.width / 2, c.height / 2); x.rotate(turn * Math.PI / 180); x.drawImage(bm, -w / 2, -h / 2, w, h);
    bm.close?.();
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  }

  // 静止画が撮れない端末・ライトを点けているとき（静止画を撮るとライトが消える端末がある）は、映像のいまのフレームを使う
  async function capture() {
    if (still && !torchOn) {
      try { const b = await stillShot(); if (b) return b; }
      catch (e) { console.warn('still capture failed, using video frame', e); still = null; }
    }
    return grab();
  }

  // 映像のいまのフレームをそのまま使う（静止画撮影に切り替えるより速く、シャッターがすぐ切れる）
  async function grab() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(video, 0, 0);
      return await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  }

  async function take() {
    if (busy || !stream || paused()) return;
    busy = true;
    try {
      if (!video.videoWidth) return;
      // 押した瞬間に反応を返してから、画像を保存する
      shots++;
      counter.textContent = String(shots);
      // 音は鳴らさず、振動で撮影を知らせる（映像のフレームを使うのでシャッター音も出ない）
      navigator.vibrate?.([60, 40, 60]);
      dialog.classList.remove('flash'); void dialog.offsetWidth; dialog.classList.add('flash');
      const blob = await capture();
      if (!blob) { shots--; counter.textContent = String(shots); return; }
      // ぶれ・ピンぼけの写真は、その場で知らせて撮り直す（あとで一覧の「ぼけ」の印で気づいても、
      // ページをめくった後では撮り直しにくい）。文字の少ない写真（判定できない）と画面の撮影はそのまま
      let sharp;
      if (subject() !== 'screen' && blurTries < 2) {
        sharp = await photoSharpness(blob).catch(() => null);
        if (sharp != null && sharp < BLURRY_BELOW) {
          blurTries++;
          shots--; counter.textContent = String(shots);
          navigator.vibrate?.(400);
          dialog.classList.remove('blur-flash'); void dialog.offsetWidth; dialog.classList.add('blur-flash');
          // 自動撮影は、もう一度手が止まったところで撮り直す（ページはめくらずにそのまま）
          needMotion = false; stillSince = 0; sharpMax = 0;
          say(autoToggle.checked ? 'ぼけていたので撮り直します。ページはそのままで、スマホを止めてください'
            : 'ぼけていました。スマホを止めて、もう一度シャッターを押してください', true);
          return;
        }
      }
      blurTries = 0; warnUntil = 0;
      // 左下に今撮った写真を小さく出す
      if (thumb) { if (thumb.src) URL.revokeObjectURL(thumb.src); thumb.src = URL.createObjectURL(blob); thumb.hidden = false; }
      // 保存できなかったとき（容量不足など）は、撮れたことにしない
      if (await onCapture(blob, { tilt: tiltX, sharp }) === false) {
        shots--; counter.textContent = String(shots);
        navigator.vibrate?.(400);
        needMotion = true; stillSince = 0;
        say('保存できませんでした。端末の空き容量を確かめてください', true);
        return;
      }
      needMotion = true; stillSince = 0;
      say(autoToggle.checked ? '撮影しました。次のページをめくってください' : '撮影しました');
    } finally { busy = false; }
  }

  shutter.onclick = () => take();
  autoToggle.onchange = () => { needMotion = false; stillSince = 0; say(autoToggle.checked ? '手を止めると自動で撮影します' : 'シャッターを押して撮影します'); };
  dialog.addEventListener('close', close);
  return { open, close, redraw: () => { if (stream) drawGuide(); } };
}
