// 端末内の保存（IndexedDB）。文書（docs）とページ（pages）を持つ。
const DB_NAME = 'scanlite-local';

const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id', autoIncrement: true });
    if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id', autoIncrement: true });
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

export const allPages = async () => (await run('pages', 'readonly', s => s.getAll())).sort(byOrder);
export const pagesOf = async docId => (await allPages()).filter(p => p.docId === docId);
export const putPage = p => run('pages', 'readwrite', s => s.put(p));
export const addPage = p => run('pages', 'readwrite', s => s.add(p));
export const removePage = id => run('pages', 'readwrite', s => s.delete(id));

export const allDocs = async () => (await run('docs', 'readonly', s => s.getAll())).sort(byOrder);
export const putDoc = d => run('docs', 'readwrite', s => s.put(d));
export const addDoc = d => run('docs', 'readwrite', s => s.add(d));
export async function removeDoc(id) {
  for (const p of await pagesOf(id)) await removePage(p.id);
  await run('docs', 'readwrite', s => s.delete(id));
}
