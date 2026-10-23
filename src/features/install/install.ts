/**
 * PWA install + storage-persistence helpers.
 *
 * Installing matters on Android: a browser tab and the installed app can be
 * treated as different storage buckets, and the browser may evict site data
 * under pressure. Asking for persistent storage makes the browser keep the
 * IndexedDB ledger instead of silently dropping it.
 */

/** True when running from the Home Screen icon rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari exposes its own flag; harmless to check everywhere.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

/** True when this browser can raise the native install prompt right now. */
export function canPromptInstall(): boolean {
  return pendingPrompt !== null
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// The event fires once, early, before React mounts. Capture it at module load
// so a Settings button added later can still replay it.
let pendingPrompt: BeforeInstallPromptEvent | null = null
const installListeners = new Set<() => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    pendingPrompt = e as BeforeInstallPromptEvent
    installListeners.forEach((fn) => fn())
  })
  window.addEventListener('appinstalled', () => {
    pendingPrompt = null
    installListeners.forEach((fn) => fn())
  })
}

/** Subscribe to changes in installability. Returns an unsubscribe function. */
export function onInstallAvailability(fn: () => void): () => void {
  installListeners.add(fn)
  return () => installListeners.delete(fn)
}

/**
 * Show the native install prompt. Resolves to the outcome, or 'unavailable'
 * when the browser never offered one (already installed, iOS Safari, etc).
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!pendingPrompt) return 'unavailable'
  const event = pendingPrompt
  await event.prompt()
  const { outcome } = await event.userChoice
  pendingPrompt = null
  installListeners.forEach((fn) => fn())
  return outcome
}

/** Ask the browser to keep our storage. Returns the resulting persisted state. */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = navigator.storage
  if (!storage?.persist) return false
  try {
    if (await storage.persisted?.()) return true
    return await storage.persist()
  } catch {
    return false
  }
}

/** Current persistence state without prompting. */
export async function isStoragePersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false
  } catch {
    return false
  }
}
