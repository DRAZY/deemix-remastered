/**
 * favoritesStorage — IndexedDB persistence for the favourites list.
 *
 * Favourites used to live in localStorage, which Chromium caps at 5 MB per
 * origin. A large Deezer library (issue #149: 6,886 tracks plus albums, artists
 * and playlists, roughly 10 MB as Deezer returns them) blew past the cap, the
 * save threw QuotaExceededError, and the tracks never survived a restart.
 * IndexedDB has no such cap, so the whole list is stored there as one record.
 *
 * The first load after upgrade migrates whatever localStorage holds and then
 * removes the legacy key so the 5 MB budget is freed for everything else.
 */

const DB_NAME = 'deemix-favorites'
const DB_VERSION = 1
const STORE = 'kv'
const KEY = 'favorites'
const LEGACY_LOCALSTORAGE_KEY = 'favorites'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    req.onblocked = () => reject(new Error('IndexedDB open blocked'))
  })
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

/** The stored list, or null when nothing has ever been written. */
export async function readFavorites<T = unknown>(): Promise<T[] | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const value = await requestToPromise(tx.objectStore(STORE).get(KEY))
    return Array.isArray(value) ? (value as T[]) : null
  } finally {
    db.close()
  }
}

/**
 * Replace the stored list. Rejects on any storage failure.
 *
 * The list is copied to plain data first. IndexedDB structured-clones what it
 * stores, and a Vue reactive Proxy cannot be cloned: handing it the store's
 * live array threw DataCloneError ("[object Array] could not be cloned") on
 * every save from 2.6.3 to 2.6.4, so imports did nothing and added favourites
 * were lost on restart (#168). Unwrapping only the top level is not enough,
 * because an item added from a page can itself be reactive. Favourites are
 * JSON by origin (Deezer and Qobuz API objects), so the round-trip is lossless.
 */
export async function writeFavorites(items: unknown[]): Promise<void> {
  const plain: unknown[] = JSON.parse(JSON.stringify(items))
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(plain, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'))
    })
  } finally {
    db.close()
  }
}

/**
 * One-time move from the legacy localStorage key. Returns the number of items
 * migrated, or null when there was nothing to migrate. The legacy key is only
 * removed once the IndexedDB write has succeeded.
 */
export async function migrateLegacyFavorites(): Promise<number | null> {
  let raw: string | null = null
  try { raw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY) } catch { return null }
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(parsed)) return null
  await writeFavorites(parsed)
  try { localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY) } catch { /* best effort */ }
  return parsed.length
}
