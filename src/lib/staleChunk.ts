/**
 * Detecting and recovering from a stale code-split chunk after a deployment.
 *
 * Lived inside App.tsx and was only reachable by lazyWithRetry, so ROUTE
 * chunks recovered automatically while every other dynamic import fell over
 * with a raw error. Moved here so any `await import(...)` can use the same
 * proven logic.
 *
 * ---- WHY THIS FAILURE LOOKS LIKE A 200 ---------------------------------
 *
 * A tab open across a deploy still holds the old entry bundle, whose chunk
 * filenames are content-hashed and no longer exist. Vercel's SPA rewrite then
 * serves index.html for the missing path -- measured 2026-09-05:
 *
 *   GET /assets/exceljs.min-kycDTznP.js
 *   -> 200, content-type: text/html
 *
 * So it is not a 404 anyone can spot in the network tab. The browser tries to
 * parse HTML as a module and reports "Failed to fetch dynamically imported
 * module", which reads like a network fault rather than a stale tab.
 */

// Chrome says "Failed to fetch dynamically imported module", Safari
// "Importing a module script failed", Firefox "error loading dynamically
// imported module". Vite's CSS-chunk message and the older webpack "Loading
// chunk" string are covered too.
export function isStaleChunkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('importing a module script failed') ||
    msg.includes('loading chunk') ||
    msg.includes('unable to preload css') ||
    msg.includes('dynamically imported module')
  );
}

// One auto-reload per browser session for this failure class — if a reload
// doesn't actually fix it (e.g. a persistent network issue, not a stale
// chunk), loop forever is worse than falling through to the manual buttons.
const CHUNK_RELOAD_GUARD_KEY = 'chunk-error-auto-reload-attempted';

export function reloadOnceForStaleChunk(): boolean {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
  } catch {
    // sessionStorage unavailable (private mode etc.) — reload once anyway,
    // no way to guard against a loop in that case.
  }
  window.location.reload();
  return true;
}

/**
 * Run a dynamic import, retrying briefly and then reloading once if the chunk
 * is stale.
 *
 * For imports that are NOT React components, where lazyWithRetry does not
 * apply — the exceljs import behind "Export Excel" is the worked example: a
 * tab left open across a deploy failed the export with a message that sounded
 * like the exporter was broken.
 */
export async function importWithRetry<T>(
  importFn: () => Promise<T>,
  retries = 2,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await importFn();
    } catch (error) {
      if (!isStaleChunkError(error)) throw error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // Reloading discards whatever the user was doing, so it is the last
      // resort rather than the first response — and only once per session.
      if (reloadOnceForStaleChunk()) {
        // The reload is asynchronous; keep the caller parked rather than
        // letting it continue against a half-loaded app.
        await new Promise(() => {});
      }
      throw error;
    }
  }
  throw new Error('Import failed after retries');
}
