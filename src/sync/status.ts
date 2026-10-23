import { useSyncExternalStore } from 'react'

/**
 * What the sync loop is doing right now, for the Settings card.
 *
 * A module-level store rather than React state because the loop runs outside
 * the component tree (on a timer, on reconnect, after a sale).
 */

export interface SyncState {
  /** A project URL and anon key have been entered. */
  enabled: boolean
  /** The email of the signed-in shop account, or null when signed out. */
  email: string | null
  running: boolean
  phase: 'idle' | 'pushing' | 'pulling'
  lastSyncAt: number | null
  pending: number
  pushed: number
  pulled: number
  error: string | null
}

const initialState: SyncState = {
  enabled: false,
  email: null,
  running: false,
  phase: 'idle',
  lastSyncAt: null,
  pending: 0,
  pushed: 0,
  pulled: 0,
  error: null,
}

let state: SyncState = initialState
const listeners = new Set<() => void>()

function changed(a: SyncState, b: SyncState): boolean {
  return (
    a.enabled !== b.enabled ||
    a.email !== b.email ||
    a.running !== b.running ||
    a.phase !== b.phase ||
    a.lastSyncAt !== b.lastSyncAt ||
    a.pending !== b.pending ||
    a.pushed !== b.pushed ||
    a.pulled !== b.pulled ||
    a.error !== b.error
  )
}

export function getSyncState(): SyncState {
  return state
}

export function setSyncState(patch: Partial<SyncState>): void {
  const next = { ...state, ...patch }
  if (!changed(next, state)) return
  state = next
  for (const fn of [...listeners]) fn()
}

export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState, getSyncState)
}
