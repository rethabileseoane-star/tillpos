import { useState } from 'react'
import { localDate } from '@/domain/time'
import { downloadBlob, exportProductsCsv } from '@/features/catalog/csvImport'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import { downloadBackupJson, eraseLocalData } from './backup'
import type { SecretKind } from './secret'

export function RecoverySheet({
  kind,
  onClose,
}: {
  kind: SecretKind
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runExport = async (label: string, task: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setNote(null)
    try {
      await task()
      feedbackSuccess()
      setNote('Saved. Keep the file somewhere safe — this device is about to forget it.')
    } catch (err) {
      feedbackError()
      setError(err instanceof Error ? err.message : 'Could not create the file.')
    } finally {
      setBusy(null)
    }
  }

  const wipe = async () => {
    setBusy('Erasing')
    setError(null)
    try {
      await eraseLocalData()
      location.reload()
    } catch (err) {
      setBusy(null)
      feedbackError()
      setError(err instanceof Error ? err.message : 'Could not erase the data.')
    }
  }

  const canErase = confirm.trim().toUpperCase() === 'ERASE' && busy === null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-surface-900/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full max-w-md animate-slideUp overflow-y-auto rounded-t-2xl bg-ice-200 p-4 pb-6 sm:rounded-2xl shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-surface-300 sm:hidden" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-surface-900">
              Forgot {kind === 'pin' ? 'PIN' : 'password'}?
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-surface-600">
              The lock cannot be bypassed. Your records are stored on this device
              only, so they have to be erased with it.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-surface-600 active:bg-surface-200"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-cyan-400/30 bg-cyan-400/10 p-3 text-[11px] leading-relaxed text-cyan-600">
          <strong className="font-semibold">Save a copy first.</strong> Both files
          download to this device's Downloads folder. They cover the shop you are
          unlocking. The JSON archive contains every sale, product and movement;
          the catalog CSV can be re-imported with the existing importer.
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            className="btn-ghost !py-2.5 text-sm"
            disabled={busy !== null}
            onClick={() => void runExport('backup', downloadBackupJson)}
          >
            {busy === 'backup' ? 'Saving…' : 'Backup (JSON)'}
          </button>
          <button
            className="btn-ghost !py-2.5 text-sm"
            disabled={busy !== null}
            onClick={() =>
              void runExport('catalog', async () => {
                downloadBlob(
                  await exportProductsCsv(),
                  `catalog-${localDate()}.csv`,
                )
              })
            }
          >
            {busy === 'catalog' ? 'Saving…' : 'Catalog (CSV)'}
          </button>
        </div>

        {note && (
          <p className="mt-2 rounded-xl bg-cyan-400/10 px-3 py-2 text-[11px] leading-relaxed text-cyan-600">
            {note}
          </p>
        )}
        {error && (
          <p className="mt-2 rounded-xl bg-surface-300 px-3 py-2 text-[11px] leading-relaxed text-surface-700">
            {error}
          </p>
        )}

        <div className="mt-5 border-t border-surface-300 pt-4">
          <h3 className="text-sm font-semibold text-surface-700">Erase this device</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-surface-600">
            Deletes every product, sale, stock and cash movement for <strong className="text-surface-900">every
            shop on this phone</strong>, plus every lock and the sync settings. This
            cannot be undone. Cloud copies are not touched. Type{' '}
            <strong className="font-mono text-surface-900">ERASE</strong> to confirm.
          </p>
          <input
            className="field mt-3 text-center font-mono uppercase tracking-[0.3em]"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value)
              setError(null)
            }}
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="ERASE"
            aria-label="Type ERASE to confirm"
          />
          <button
            className="btn-danger mt-2 w-full !py-2.5 text-sm"
            disabled={!canErase}
            onClick={() => void wipe()}
          >
            {busy === 'Erasing' ? 'Erasing…' : 'Erase everything and reset'}
          </button>
          <p className="mt-2 text-center text-[10px] leading-relaxed text-surface-500">
            If the download will not work, clearing this site's data in the
            browser settings also resets the lock.
          </p>
        </div>
      </div>
    </div>
  )
}
