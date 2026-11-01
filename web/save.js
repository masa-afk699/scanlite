// PDFの保存先。ブラウザーが対応していれば、選んだフォルダに直接保存する（端末内のみ）。
// 対応していない場合は通常のダウンロード（Chromeの設定で保存先を変更できる）。
const DB = 'scanlite-settings';

function kv(kind, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const r = fn(req.result.transaction('kv', kind).objectStore('kv'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
  });
}

export const canPickFolder = typeof window.showDirectoryPicker === 'function';
export const canPickFile = typeof window.showSaveFilePicker === 'function';

export async function getFolder() {
  if (!canPickFolder) return null;
  try { return (await kv('readonly', s => s.get('saveFolder'))) || null; } catch { return null; }
}
export async function chooseFolder() {
  const h = await window.showDirectoryPicker({ id: 'scanlite-pdf', mode: 'readwrite', startIn: 'documents' });
  await kv('readwrite', s => s.put(h, 'saveFolder'));
  return h;
}
export const clearFolder = () => kv('readwrite', s => s.delete('saveFolder'));

async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.'), stem = name.slice(0, dot), ext = name.slice(dot);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    try { await dir.getFileHandle(candidate); } catch { return candidate; }
  }
  return `${stem}_${Date.now()}${ext}`;
}

async function writeTo(fileHandle, blob) {
  const w = await fileHandle.createWritable();
  await w.write(blob);
  await w.close();
}

// 選んだフォルダに保存。保存したファイル名を返す
export async function saveToFolder(blob, name) {
  const dir = await getFolder();
  if (!dir) throw new Error('no folder');
  if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
      (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('denied');
  const finalName = await uniqueName(dir, name);
  await writeTo(await dir.getFileHandle(finalName, { create: true }), blob);
  return finalName;
}

// 毎回場所を選んで保存
export async function saveAs(blob, name) {
  const h = await window.showSaveFilePicker({
    id: 'scanlite-pdf', suggestedName: name, startIn: 'documents',
    types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
  });
  await writeTo(h, blob);
  return h.name;
}
