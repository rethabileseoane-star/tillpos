import { useEffect, useRef } from 'react'
import { useBarcodeScanner } from './useBarcodeScanner'
import { ManualEntry } from './ManualEntry'
import { RETAIL_FORMATS } from '@/domain/barcode'

interface Props {
  /** Shown at the top of the sheet. */
  title: string
  onDetected: (code: string) => void
  onClose: () => void
}

/**
 * A camera sheet for a single barcode read — adding a product in the catalog,
 * for instance. It owns its own camera lifecycle: opening starts the stream,
 * closing (or a successful read) stops it.
 *
 * Reuses the exact same scanner logic as the sell screen, so behaviour matches
 * there and the manual-entry fallback is always available underneath.
 */
export function BarcodeScanSheet({ title, onDetected, onClose }: Props) {
  const doneRef = useRef(false)
  const scanner = useBarcodeScanner({ onDetected: onRead })

  // A barcode held in the frame fires the detector repeatedly; one read per
  // opening of the sheet is enough. Stop the camera before reporting so the
  // stream is released even before React unmounts the sheet.
  function onRead(code: string) {
    if (doneRef.current) return
    doneRef.current = true
    scanner.stop()
    onDetected(code)
  }

  // Open = start looking. The hook stops the stream again on unmount.
  useEffect(() => {
    void scanner.start()
  }, [])

  const scanning = scanner.status === 'scanning' || scanner.status === 'starting'

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/75" onClick={onClose}>
      <div
        className="w-full animate-slideUp rounded-t-2xl bg-ink-800 pb-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2 mt-3 h-1 w-10 rounded-full bg-ink-600" />

        {/* Sheet header */}
        <div className="flex items-start justify-between px-4">
          <div>
            <p className="text-sm font-semibold">{title}</p>
            <p className="text-xs text-slate-400">Hold the barcode inside the box</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close scanner"
            className="rounded-full bg-ink-700 p-2 text-slate-300 active:bg-ink-600"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Camera viewport */}
        <div className="relative mx-4 mt-3 aspect-[4/3] overflow-hidden rounded-xl bg-black">
          <video
            ref={scanner.videoRef}
            playsInline
            muted
            className={`h-full w-full object-cover transition-opacity ${
              scanning ? 'opacity-100' : 'opacity-0'
            }`}
          />

          {scanning && (
            <>
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative h-24 w-3/4 rounded-xl border-2 border-cash-400/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
                  <span className="absolute -left-0.5 -top-0.5 h-3 w-3 rounded-tl-lg border-l-4 border-t-4 border-white" />
                  <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-tr-lg border-r-4 border-t-4 border-white" />
                  <span className="absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-bl-lg border-b-4 border-l-4 border-white" />
                  <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-br-lg border-b-4 border-r-4 border-white" />
                </div>
              </div>

              {scanner.torchAvailable && (
                <div className="absolute right-3 top-3">
                  <button
                    onClick={scanner.toggleTorch}
                    aria-label="Toggle torch"
                    className={`rounded-full p-3 backdrop-blur ${
                      scanner.torchOn ? 'bg-cash-500 text-ink-900' : 'bg-ink-900/70 text-white'
                    }`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
                      <path d="M9 18h6m-5 3h4M12 3a6 6 0 013.6 10.8c-.5.4-.8 1-.8 1.6H9.2c0-.6-.3-1.2-.8-1.6A6 6 0 0112 3z" />
                    </svg>
                  </button>
                </div>
              )}

              {scanner.status === 'scanning' && (
                <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full bg-ink-900/70 px-2.5 py-1 text-[10px] text-slate-300 backdrop-blur">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cash-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cash-400" />
                  </span>
                  {RETAIL_FORMATS.length} formats{scanner.nativeApi ? ' · native' : ' · wasm'}
                </div>
              )}
            </>
          )}

          {!scanning && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900 px-6 text-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-12 w-12 text-slate-600">
                <path d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M7 20H5a2 2 0 01-2-2v-2M3 12h18" />
              </svg>
              <p className="text-sm text-slate-400">Camera is off</p>
              <button className="btn-primary" onClick={() => void scanner.start()}>
                Start scanner
              </button>
            </div>
          )}
        </div>

        {!scanning && scanner.error && (
          <p className="mx-4 mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
            {scanner.error}
          </p>
        )}

        {/* Typing stays a first-class fallback, exactly as on the sell screen. */}
        {scanning && (
          <button
            className="mx-auto mt-3 block text-xs text-slate-400 underline underline-offset-2"
            onClick={() => scanner.stop()}
          >
            Type the barcode instead
          </button>
        )}
        <ManualEntry id="scan-sheet-manual" onSubmit={onRead} disabled={scanning} />

        <div className="px-4">
          <button className="btn-ghost w-full" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}