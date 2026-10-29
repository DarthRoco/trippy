// IndexedDB on the phone (Q21): the active trip document, the profile {notes} and settings (BYO key). Nothing leaves
// the device. One record per store under the key 'active'; the trip is saved whole after each change.
// Version 2 = trip model v2: older stores and data are dropped on upgrade.
export type Key = 'trip' | 'profile' | 'settings'
const STORES: Key[] = ['trip', 'profile', 'settings']

const db = new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open('trippy', 2)
  r.onupgradeneeded = () => {
    for (const s of [...r.result.objectStoreNames]) r.result.deleteObjectStore(s)
    STORES.forEach(s => r.result.createObjectStore(s))
  }
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error)
})

const run = <T,>(key: Key, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest) =>
  db.then(d => new Promise<T>((resolve, reject) => {
    const r = op(d.transaction(key, mode).objectStore(key))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  }))

export const load = <T,>(key: Key) => run<T | undefined>(key, 'readonly', s => s.get('active'))
export const save = (key: Key, value: unknown) => run(key, 'readwrite', s => s.put(value, 'active'))
export const remove = (key: Key) => run(key, 'readwrite', s => s.delete('active'))
