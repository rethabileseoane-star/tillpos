/**
 * Node shims for the integration test.
 *
 * Imported first so every module that follows sees a browser-shaped global
 * environment. `fake-indexeddb/auto` installs `indexedDB` / `IDBKeyRange`;
 * the rest exist because `db/index.ts` and `salesService.ts` touch them.
 */
import 'fake-indexeddb/auto'

const mem = new Map<string, string>()

const ls = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => void mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
}

try {
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
} catch {
  // A real localStorage already exists; leave it alone.
}
