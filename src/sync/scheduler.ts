import { syncNow, refreshSyncStatus, type SyncOutcome } from './engine'
import { onLocalWrite } from './signal'

/**
 * When the app syncs.
 *
 * There is no realtime subscription: a shop till is open on a counter all day,
 * so a short poll while the app is in front of someone is simpler, cheaper and
 * far more forgiving of a flaky connection than a websocket that has to be
 * re-established. On top of the poll, a sync is asked for right after a sale
 * (so a second till sees it within a second or two), when the app comes back to
 * the foreground, and when the phone regains a connection.
 */

const POLL_MS = 20_000
const WRITE_DEBOUNCE_MS = 1_500

let started = false
let pollId: number | null = null
let debounceId: number | null = null
let inFlight: Promise<SyncOutcome> | null = null
let teardown: Array<() => void> = []

/** Run a sync unless one is already running; concurrent callers share it. */
export function runSync(): Promise<SyncOutcome> {
  if (inFlight) return inFlight
  inFlight = syncNow().finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Ask for a sync shortly, coalescing a burst of writes into one run. */
export function requestSync(delay = WRITE_DEBOUNCE_MS): void {
  if (!started || typeof window === 'undefined') return
  if (debounceId !== null) window.clearTimeout(debounceId)
  debounceId = window.setTimeout(() => {
    debounceId = null
    void runSync()
  }, delay)
}

export function startSync(): () => void {
  if (typeof window === 'undefined') return () => {}
  if (started) return stopSync

  started = true

  void refreshSyncStatus().then(() => runSync())

  const onOnline = () => void runSync()
  const onVisible = () => {
    if (document.visibilityState === 'visible') void runSync()
  }

  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisible)
  teardown.push(() => window.removeEventListener('online', onOnline))
  teardown.push(() => document.removeEventListener('visibilitychange', onVisible))
  teardown.push(onLocalWrite(() => requestSync()))

  pollId = window.setInterval(() => {
    if (document.visibilityState === 'visible') void runSync()
  }, POLL_MS)

  return stopSync
}

export function stopSync(): void {
  if (pollId !== null) window.clearInterval(pollId)
  if (debounceId !== null) window.clearTimeout(debounceId)
  pollId = null
  debounceId = null
  for (const fn of teardown) fn()
  teardown = []
  started = false
}
