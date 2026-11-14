// 端末内の保存（IndexedDB）。フォルダ（folders）・文書（docs）・ページ（pages）を持つ。
const DB_NAME = 'scanlite-local';

const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 3);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// 書き込みは、端末に保存し終わった（トランザクションが完了した）ところで成功とする。
// 容量不足は書き込みの最後に分かることがあり、以前はその失敗を見落として「保存した」ことにしていた
async function run(store, kind, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, kind), r = fn(tx.objectStore(store));
    let result;
    r.onsuccess = () => { result = r.result; if (kind === 'readonly') resolve(result); };
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || r.error || new DOMException('保存できませんでした', 'AbortError'));
  });
}
// 端末の保存領域がいっぱいで保存できなかったか
export const isStorageFull = e => !!e && (e.name === 'QuotaExceededError' || /quota|space|disk/i.test(String(e.message || '')));

const byOrder = (a, b) => (a.created - b.created) || (a.id - b.id);

// ページの記録は起動時に1回だけ読み、以後は手元の写しを使う（数百ページあると、毎回すべて読み直すだけで
// 1秒近くかかり、一覧の表示や削除のたびに待たされていた）。書き込みは端末に保存できてから写しにも反映する。
// 同じアプリを別の画面（タブ）でも開いているときは、書き込みを知らせ合って写しを読み直す
let cache = null, loading = null;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('scanlite-pages') : null;
if (channel) channel.onmessage = () => { cache = null; loading = null; };
const changed = () => channel?.postMessage(1);
function pageMap() {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    const job = loading = run('pages', 'readonly', s => s.getAll()).then(list => {
      if (loading !== job) return pageMap(); // 読んでいる間に別の画面で変わった
      cache = new Map(list.map(p => [p.id, p]));
      return cache;
    }).finally(() => { if (loading === job) loading = null; });
  }
  return loading;
}
const copy = p => (p ? { ...p } : p);
const everyPage = async () => [...(await pageMap()).values()].map(copy).sort(byOrder);
// ゴミ箱に入れたページ（trashed に入れた日時を持つ）は、ふだんの一覧や処理には出さない
export const allPages = async () => (await everyPage()).filter(p => !p.trashed);
export const trashedPages = async () => (await everyPage()).filter(p => p.trashed).sort((a, b) => b.trashed - a.trashed || byOrder(a, b));
export const pagesOf = async docId => (await allPages()).filter(p => p.docId === docId);
export const getPage = async id => copy((await pageMap()).get(id));
export async function putPage(p) {
  const map = await pageMap();
  const id = await run('pages', 'readwrite', s => s.put(p));
  map.set(id, { ...p, id }); changed();
  return id;
}
export async function addPage(p) {
  const map = await pageMap();
  const id = await run('pages', 'readwrite', s => s.add(p));
  map.set(id, { ...p, id }); changed();
  return id;
}
export async function removePage(id) {
  const map = await pageMap();
  await run('pages', 'readwrite', s => s.delete(id));
  map.delete(id); changed();
}

export const allDocs = async () => (await run('docs', 'readonly', s => s.getAll())).sort(byOrder);
export const putDoc = d => run('docs', 'readwrite', s => s.put(d));
export const addDoc = d => run('docs', 'readwrite', s => s.add(d));
// ページをゴミ箱へ移す。元の文書が消えても戻せるよう、文書の名前とフォルダも覚えておく
export async function trashPage(id, doc, folderName = null) {
  const p = await getPage(id);
  if (!p) return;
  p.trashed = Date.now();
  if (doc) p.trashDoc = { name: doc.name, folderId: doc.folderId ?? null, folderName };
  await putPage(p);
}
export async function restorePage(id) {
  const p = await getPage(id);
  if (!p) return;
  delete p.trashed; delete p.trashDoc;
  await putPage(p);
}
// 文書を消すときも、ページはゴミ箱へ移す（30日間は戻せる）
export async function removeDoc(id) {
  const doc = (await allDocs()).find(d => d.id === id);
  // フォルダごと消したあとでも同じ名前のフォルダに戻せるよう、フォルダ名も覚える
  const folder = doc?.folderId != null ? await run('folders', 'readonly', s => s.get(doc.folderId)) : null;
  for (const p of await pagesOf(id)) await trashPage(p.id, doc, folder?.name ?? null);
  await run('docs', 'readwrite', s => s.delete(id));
}

// フォルダ: 文書をまとめる入れ物。文書は folderId で所属を持つ（なしなら「フォルダなし」）
export const allFolders = async () => (await run('folders', 'readonly', s => s.getAll())).sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id - b.id);
export const addFolder = f => run('folders', 'readwrite', s => s.add(f));
export const putFolder = f => run('folders', 'readwrite', s => s.put(f));
// フォルダを消しても中の文書は消さず、「フォルダなし」に戻す
export async function removeFolder(id) {
  for (const d of await allDocs()) if (d.folderId === id) { delete d.folderId; await putDoc(d); }
  await run('folders', 'readwrite', s => s.delete(id));
}
