// アプリ内カメラ。ページをめくって手を止めると自動で撮影する（連続撮影）。
// 映像はこの画面の中で使うだけで、どこにも送らない。

const MOTION = 10;     // これ以上の変化で「動いた」とみなす（0〜255の平均差）
const STILL = 3.2;     // これ以下で「止まっている」とみなす
const HOLD_MS = 900;   // 止まってから撮影するまでの時間

export function createCamera({ dialog, video, status, shutter, autoToggle, counter, onCapture }) {
  let stream = null, timer = null, prev = null, stillSince = 0, needMotion = false, busy = false, shots = 0;
  const probe = document.createElement('canvas');
  probe.width = 80; probe.height = 60;
  const pctx = probe.getContext('2d', { willReadFrequently: true });

  const say = t => { status.textContent = t; };

  async function open() {
    shots = 0; counter.textContent = '0枚';
    dialog.showModal();
    say('カメラを起動しています…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
    } catch (e) {
      say('カメラを使えませんでした。ブラウザーの設定でカメラを許可してください。');
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    prev = null; stillSince = 0; needMotion = false;
    say(autoToggle.checked ? 'ページを枠に入れて、手を止めると自動で撮影します' : 'シャッターを押して撮影します');
    timer = setInterval(watch, 180);
  }

  function close() {
    clearInterval(timer); timer = null;
    stream?.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    if (dialog.open) dialog.close();
  }

  // 小さく縮小した映像の前回との差で、動きと静止を判定する
  function watch() {
    if (!video.videoWidth || busy) return;
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
      needMotion = false; stillSince = 0;
      say('動きを検出しました。手を止めてください');
    } else if (!needMotion && diff < STILL) {
      if (!stillSince) stillSince = now;
      else if (now - stillSince > HOLD_MS) take();
    } else if (diff >= STILL) {
      stillSince = 0;
    }
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
    if (busy || !stream) return;
    busy = true;
    try {
      if (!video.videoWidth) return;
      // 押した瞬間に反応を返してから、画像を保存する
      shots++;
      counter.textContent = `${shots}枚`;
      navigator.vibrate?.(30);
      dialog.classList.remove('flash'); void dialog.offsetWidth; dialog.classList.add('flash');
      const blob = await grab();
      if (!blob) { shots--; counter.textContent = `${shots}枚`; return; }
      onCapture(blob);
      needMotion = true; stillSince = 0;
      say(autoToggle.checked ? '撮影しました。次のページをめくってください' : '撮影しました');
    } finally { busy = false; }
  }

  shutter.onclick = () => take();
  autoToggle.onchange = () => { needMotion = false; stillSince = 0; say(autoToggle.checked ? '手を止めると自動で撮影します' : 'シャッターを押して撮影します'); };
  dialog.addEventListener('close', close);
  return { open, close };
}
