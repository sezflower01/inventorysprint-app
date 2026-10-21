import { describe, it, expect, vi } from "vitest";
import {
  REVEAL_CODE,
  CODE_LENGTH,
  UNLOCK_KEY,
  isRevealCode,
  readStoredUnlock,
  writeStoredUnlock,
  type UnlockStorage,
} from "../valuationPrivacy";

/** A storage stub whose every method throws, like a private window does. */
const throwingStorage: UnlockStorage = {
  getItem: () => { throw new Error("SecurityError: site data blocked"); },
  setItem: () => { throw new Error("SecurityError: site data blocked"); },
  removeItem: () => { throw new Error("SecurityError: site data blocked"); },
};

function memStorage(initial?: Record<string, string>): UnlockStorage {
  const m = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

describe("isRevealCode", () => {
  it("accepts only the exact code", () => {
    expect(isRevealCode(REVEAL_CODE)).toBe(true);
    expect(CODE_LENGTH).toBe(4);
  });

  it("rejects near misses, padding and wrong types", () => {
    for (const bad of ["1364", "1366", "136", "13655", "", "0000", " 1365", "1365 ", "1365\n"]) {
      expect(isRevealCode(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
    }
    for (const bad of [1365, null, undefined, {}, ["1365"], true]) {
      expect(isRevealCode(bad), `expected ${String(bad)} to be rejected`).toBe(false);
    }
  });
});

describe("readStoredUnlock FAILS CLOSED", () => {
  // This is the whole point of the module. Every unexpected outcome must keep
  // the figures hidden; a storage problem revealing them would be the exact
  // inverse of what the gate is for.
  it("returns false when storage throws", () => {
    expect(readStoredUnlock(throwingStorage)).toBe(false);
  });

  it("returns false with no storage at all (SSR, sandboxed frame)", () => {
    expect(readStoredUnlock(null)).toBe(false);
    expect(readStoredUnlock(undefined)).toBe(false);
  });

  it("returns false for a missing key or any value but the exact flag", () => {
    expect(readStoredUnlock(memStorage())).toBe(false);
    for (const v of ["0", "", "true", "yes", "2", "01", " 1", "1365"]) {
      expect(readStoredUnlock(memStorage({ [UNLOCK_KEY]: v })), `value ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("returns true ONLY for the exact flag written by writeStoredUnlock", () => {
    const s = memStorage();
    expect(writeStoredUnlock(s, true)).toBe(true);
    expect(readStoredUnlock(s)).toBe(true);
  });
});

describe("writeStoredUnlock", () => {
  it("clears the flag when re-locking, so a later read is locked", () => {
    const s = memStorage();
    writeStoredUnlock(s, true);
    expect(readStoredUnlock(s)).toBe(true);
    writeStoredUnlock(s, false);
    expect(readStoredUnlock(s)).toBe(false);
    expect(s.getItem(UNLOCK_KEY)).toBeNull();
  });

  it("reports failure instead of throwing when storage is unavailable", () => {
    expect(writeStoredUnlock(throwingStorage, true)).toBe(false);
    expect(writeStoredUnlock(throwingStorage, false)).toBe(false);
    expect(writeStoredUnlock(null, true)).toBe(false);
  });

  it("does not write the flag anywhere else", () => {
    const setItem = vi.fn();
    writeStoredUnlock({ getItem: () => null, setItem, removeItem: () => {} }, true);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(UNLOCK_KEY, "1");
  });
});
