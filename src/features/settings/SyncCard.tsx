import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { feedbackSuccess } from '@/ui/feedback'
import { outboxCount } from '@/sync/outbox'
import { disableSync, loadSyncConfig, normalizeProjectUrl, saveSyncConfig } from '@/sync/config'
import { forgetClient, signIn, signOut } from '@/sync/client'
import { refreshSyncStatus, uploadEverything } from '@/sync/engine'
import { runSync } from '@/sync/scheduler'
import { useSyncState } from '@/sync/status'
import { loadTillLabel, saveTillLabel } from './tillLabel'

/**
 * Settings → Cloud sync.
 *
 * Three states, one per stage of setting a device up: enter the project (and
 * the shop's login), sign in, or connected. Everything the shopkeeper needs to
 * answer "is my other till's data here yet, and is it safe" lives on the
 * connected card.
 */
export function SyncCard() {
  const sync = useSyncState()
  const pending = useLiveQuery(() => outboxCount(), []) ?? 0

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [url, setUrl] = useState('')
  const [anonKey, setAnonKey] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const cfg = await loadSyncConfig()
      if (cfg) {
        setConfigured(true)
        setUrl(cfg.url)
        setAnonKey(cfg.anonKey)
        setEmail(cfg.email ?? '')
      } else {
        setConfigured(false)
      }
      setLabel(await loadTillLabel())
      await refreshSyncStatus()
    })()
  }, [])

  const enable = async () => {
    setBusy(true)
    setNote(null)

    await saveSyncConfig({ url: normalizeProjectUrl(url), anonKey, email })
    forgetClient()

    const result = await signIn(email, password)
    setConfigured(true)
    if (!result.ok) {
      await refreshSyncStatus()
      setNote(result.error ?? 'Sign-in failed.')
      setBusy(false)
      return
    }

    setPassword('')
    setLabel(await saveTillLabel(label.trim() || 'A'))
    await refreshSyncStatus()
    const outcome = await runSync()
    setNote(
      outcome.ok
        ? 'Connected. Sending this till’s records.'
        : outcome.error ?? 'Connected, but the first sync failed.',
    )
    feedbackSuccess()
    setBusy(false)
  }

  const doSignIn = async () => {
    setBusy(true)
    setNote(null)
    const result = await signIn(email, password)
    if (!result.ok) {
      setNote(result.error ?? 'Sign-in failed.')
      setBusy(false)
      return
    }
    setPassword('')
    await refreshSyncStatus()
    const outcome = await runSync()
    setNote(outcome.ok ? 'Signed in.' : outcome.error ?? 'Signed in, but the sync failed.')
    setBusy(false)
  }

  const doSyncNow = async () => {
    setBusy(true)
    setNote(null)
    const outcome = await runSync()
    setNote(
      outcome.skipped === 'offline'
        ? 'No connection. This till keeps recording and will catch up.'
        : outcome.ok
          ? `Sent ${outcome.pushed}, received ${outcome.pulled}.`
          : outcome.error ?? 'Sync failed.',
    )
    setBusy(false)
  }

  const sendEverything = async () => {
    if (
      !window.confirm(
        'Send every record on this device to the cloud?\n\nDo this once, on the till that already holds the shop’s history, before the other devices are set up.',
      )
    ) {
      return
    }
    setBusy(true)
    setNote(null)
    const result = await uploadEverything()
    setNote(result.ok ? `Sent ${result.pushed} records.` : result.error ?? 'Upload failed.')
    setBusy(false)
    await runSync()
  }

  const changeProject = async () => {
    if (!window.confirm('Enter a different Supabase project? Records already in the cloud are left alone.')) return
    await signOut()
    await disableSync()
    forgetClient()
    setConfigured(false)
    setPassword('')
    await refreshSyncStatus()
    setNote('Project cleared. Enter the new details.')
  }

  const turnOff = async () => {
    if (
      !window.confirm(
        'Turn off cloud sync on this device?\n\nRecords stay on the phone and in the cloud. Other tills keep syncing.',
      )
    ) {
      return
    }
    setBusy(true)
    await signOut()
    await disableSync()
    forgetClient()
    setConfigured(false)
    setPassword('')
    await refreshSyncStatus()
    setNote('Sync is off. This device records sales locally only.')
    setBusy(false)
  }

  const doSignOut = async () => {
    setBusy(true)
    await signOut()
    await refreshSyncStatus()
    setNote('Signed out. This device no longer sends or receives changes.')
    setBusy(false)
  }

  const saveLabel = async () => {
    setLabel(await saveTillLabel(label))
    setNote('Saved. New receipts on this till use this label.')
    feedbackSuccess()
  }

  return (
    <div className="card mt-3">
      <h2 className="text-sm font-semibold">Cloud sync</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        One shop account shared by up to six devices. Each till keeps selling with
        no network and merges with the others when it is online.
      </p>

      {configured === null ? (
        <p className="mt-3 text-xs text-slate-500">Checking…</p>
      ) : !configured ? (
        <>
          <div className="mt-3 space-y-2">
            <input
              className="field !py-2.5 text-sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Supabase project URL"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <input
              className="field !py-2.5 text-sm"
              value={anonKey}
              onChange={(e) => setAnonKey(e.target.value)}
              placeholder="Anon key"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <input
              className="field !py-2.5 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Shop email"
              type="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <input
              className="field !py-2.5 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Shop password"
              type="password"
              autoCapitalize="off"
            />
            <input
              className="field !py-2.5 text-sm"
              value={label}
              onChange={(e) => setLabel(e.target.value.toUpperCase())}
              placeholder="This till’s label, e.g. A"
              maxLength={6}
              autoCapitalize="characters"
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Give every till a different label — it goes in front of the receipt
            numbers (A-0001, B-0001) so two tills never print the same one.
          </p>
          <button
            className="btn-primary mt-3 w-full !py-2.5 text-sm"
            disabled={busy || !url || !anonKey || !email || !password}
            onClick={() => void enable()}
          >
            {busy ? 'Connecting…' : 'Turn on sync'}
          </button>
        </>
      ) : !sync.email ? (
        <>
          <dl className="mt-2 space-y-1.5 text-sm">
            <Row label="Project" value={url.replace(/^https?:\/\//, '')} mono />
          </dl>
          <div className="mt-3 space-y-2">
            <input
              className="field !py-2.5 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Shop email"
              type="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <input
              className="field !py-2.5 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Shop password"
              type="password"
              autoCapitalize="off"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              className="btn-primary flex-1 !py-2.5 text-sm"
              disabled={busy || !email || !password}
              onClick={() => void doSignIn()}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button className="btn-ghost !py-2.5 text-sm" disabled={busy} onClick={() => void changeProject()}>
              Change project
            </button>
          </div>
        </>
      ) : (
        <>
          <dl className="mt-2 space-y-1.5 text-sm">
            <Row label="Signed in as" value={sync.email} />
            <Row
              label="Last sync"
              value={sync.running ? sync.phase === 'pushing' ? 'sending…' : 'receiving…' : describeLastSync(sync.lastSyncAt)}
            />
            <Row
              label="Waiting to send"
              value={pending === 0 ? 'nothing' : `${pending} record${pending === 1 ? '' : 's'}`}
              mono
            />
          </dl>

          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <input
                className="field !py-2.5 text-sm"
                value={label}
                onChange={(e) => setLabel(e.target.value.toUpperCase())}
                placeholder="This till’s label, e.g. A"
                maxLength={6}
                autoCapitalize="characters"
              />
              <button className="btn-ghost !py-2.5 text-sm" disabled={busy} onClick={() => void saveLabel()}>
                Save
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Printed in front of this till’s receipt numbers. Give each device a
              different label.
            </p>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              className="btn-primary flex-1 !py-2.5 text-sm"
              disabled={busy || sync.running}
              onClick={() => void doSyncNow()}
            >
              {sync.running ? 'Syncing…' : 'Sync now'}
            </button>
            <button className="btn-ghost !py-2.5 text-sm" disabled={busy} onClick={() => void sendEverything()}>
              Send all records
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <button className="btn-ghost flex-1 !py-2.5 text-sm" disabled={busy} onClick={() => void doSignOut()}>
              Sign out
            </button>
            <button className="btn-ghost flex-1 !py-2.5 text-sm" disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Run “Send all records” once on the till that already has the shop’s
            history, so the other devices can download it.
          </p>
        </>
      )}

      {sync.error && (
        <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
          {sync.error}
        </p>
      )}

      {note && (
        <p className="mt-3 rounded-xl bg-ink-800 px-3 py-2 text-xs text-cash-400">{note}</p>
      )}
    </div>
  )
}

function describeLastSync(at: number | null): string {
  if (!at) return 'never'
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`
  return new Date(at).toLocaleString()
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className={`truncate ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}
