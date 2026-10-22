/**
 * IndexedDB-based persistence for inventory data.
 * Stores the full inventory result so it can be shown instantly
 * on page load before the background refresh from Supabase completes.
 *
 * ⚠️ THIS CACHES PROCESSED ROWS, SO IT MUST BE VERSIONED.
 *
 * What is stored is not raw database rows -- it is the output of
 * fetchInventoryData, after cost resolution, sales joins and date resolution.
 * Add a field that the UI depends on and every previously cached row lacks it,
 * while still being served to the page as `placeholderData`. A hard reload does
 * NOT help: this is data in IndexedDB, not cached JavaScript.
 *
 * That bit us on 2026-10-21. `listing_created_basis` was added so the Created
 * column could sort real listing dates above purchase-added stand-ins. Cached
 * rows had no such field, so every row read as basis 'none', all ranks tied,
 * and the comparator fell through to a plain date comparison -- the exact
 * behaviour the change was meant to remove. It looked like the fix had not
 * deployed, and no amount of reloading fixed it.
 *
 * So: BUMP CACHE_SCHEMA_VERSION whenever the shape of a cached row changes.
 * A payload written under a different version is discarded and deleted on read,
 * and the page simply fetches fresh -- the cache is an optimisation, never a
 * source of truth, so throwing it away is always safe.
 */

const DB_NAME = "arbi_inventory_cache";
const DB_VERSION = 1;
const STORE_NAME = "inventory";

/**
 * Bump this when a cached inventory row gains, loses or changes a field.
 *
 *   1 -> 2  (2026-10-21) added listing_created_basis
 */
const CACHE_SCHEMA_VERSION = 2;

/**
 * A cached row is the PROCESSED inventory shape produced by SyncedInventory's
 * fetchInventoryData. Left deliberately loose: typing it as the real interface
 * would make this storage hook import from a page module, and the cache is
 * shape-agnostic by design -- CACHE_SCHEMA_VERSION above, not the type system,
 * is what guarantees the shape matches the code reading it. One alias here in
 * place of the three separate loose arrays this file used to declare.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CachedRow = any;

interface CachedInventory {
  data: CachedRow[];
  timestamp: number;
  schema?: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getInventoryCache(userId: string): Promise<{ data: CachedRow[]; timestamp: number } | null> {
  try {
    const db = await openDB();
    const cached = await new Promise<CachedInventory | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(userId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });

    if (!cached) return null;

    // Anything not written under the current shape is unusable. Note that a
    // payload from before versioning existed has schema === undefined, which
    // is correctly treated as a mismatch.
    if (cached.schema !== CACHE_SCHEMA_VERSION) {
      console.log(
        `[IDB Cache] Discarding stale payload (schema ${cached.schema ?? "none"}, expected ${CACHE_SCHEMA_VERSION}) — fetching fresh`,
      );
      // Delete it so this does not repeat on every load until the next write.
      void clearInventoryCache(userId);
      return null;
    }

    return { data: cached.data, timestamp: cached.timestamp };
  } catch {
    return null;
  }
}

export async function setInventoryCache(userId: string, data: CachedRow[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ data, timestamp: Date.now(), schema: CACHE_SCHEMA_VERSION }, userId);
  } catch (e) {
    console.warn("Failed to write inventory cache:", e);
  }
}

export async function clearInventoryCache(userId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(userId);
  } catch {
    // ignore
  }
}
