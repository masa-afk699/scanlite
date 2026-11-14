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

async function run(store, kind, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(store, kind).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const byOrder = (a, b) => (a.created - b.created) || (a.id - b.id);

const everyPage = async () => (await run('pages', 'readonly', s => s.getAll())).sort(byOrder);
// ゴミ箱に入れたページ（trashed に入れた日時を持つ）は、ふだんの一覧や処理には出さない
export const allPages = async () => (await everyPage()).filter(p => !p.trashed);
export const trashedPages = async () => (await everyPage()).filter(p => p.trashed).sort((a, b) => b.trashed - a.trashed || byOrder(a, b));
export const pagesOf = async docId => (await allPages()).filter(p => p.docId === docId);
export const getPage = id => run('pages', 'readonly', s => s.get(id));
export const putPage = p => run('pages', 'readwrite', s => s.put(p));
export const addPage = p => run('pages', 'readwrite', s => s.add(p));
export const removePage = id => run('pages', 'readwrite', s => s.delete(id));

export const allDocs = async () => (await run('docs', 'readonly', s => s.getAll())).sort(byOrder);
export const putDoc = d => run('docs', 'readwrite', s => s.put(d));
export const addDoc = d => run('docs', 'readwrite', s => s.add(d));
// ページをゴミ箱へ移す。元の文書が消えても戻せるよう、文書の名前とフォルダも覚えておく
export async function trashPage(id, doc) {
  const p = await getPage(id);
  if (!p) return;
  p.trashed = Date.now();
  if (doc) p.trashDoc = { name: doc.name, folderId: doc.folderId ?? null };
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
  for (const p of await pagesOf(id)) await trashPage(p.id, doc);
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
