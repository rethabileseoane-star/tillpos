/**
 * A one-line pub/sub so the write path can nudge the sync loop.
 *
 * `outbox.ts` fires this on every queued mutation and `scheduler.ts` listens,
 * which keeps those two modules from importing each other.
 */

type Listener = () => void

const listeners = new Set<Listener>()

export function onLocalWrite(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function notifyLocalWrite(): void {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // A listener must never be able to break a sale.
    }
  }
}
