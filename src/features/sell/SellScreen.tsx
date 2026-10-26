import { useCallback, useEffect, useRef, useState } from 'react'
import { useBarcodeScanner } from '@/features/scanner/useBarcodeScanner'
import { ManualEntry } from '@/features/scanner/ManualEntry'
import { lookupProduct, useCart } from '@/features/cart/CartContext'
import { formatMaluti } from '@/domain/money'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import { UnknownCodeSheet } from './UnknownCodeSheet'
import { CheckoutSheet } from './CheckoutSheet'
import { CartPanel } from './CartPanel'
import { db } from '@/db'
import { cashBalance } from '@/features/cash/cashService'
import { useAppLock } from '@/features/security/LockContext'
import { useLiveQuery } from 'dexie-react-hooks'

export function SellScreen() {
  const { lines, subtotal, count, addProduct, addAdHocLine, changeQty, remove, clear } = useCart()
  const { isOwner } = useAppLock()
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [pendingCode, setPendingCode] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  // The drawer balance is owner-only. Do not even read it for a cashier: the
  // figure should not appear in the UI, and there is no reason to wake the
  // cash-movement table for them.
  const cash =
    useLiveQuery(
      () => (isOwner ? cashBalance() : Promise.resolve(0)),
      [isOwner],
    ) ?? 0

  const onDetected = useCallback(
    async (code: string) => {
      const product = await lookupProduct(code)
      if (!product || !product.active) {
        feedbackError()
        setPendingCode(code)
        return
      }
      addProduct(product)
      feedbackSuccess()
      setFlash(product.name)
      window.setTimeout(() => setFlash(null), 1200)
    },
    [addProduct],
  )

  const scanner = useBarcodeScanner({ onDetected, debounceMs: 1500 })
  // Derive from the hook rather than tracking a second flag: "start was called"
  // is not the same as "the camera is live", and treating them as equal hid the
  // retry button whenever the camera failed to start. `starting` counts as live
  // so the permission prompt does not look like the camera is simply off.
  const scanning = scanner.status === 'scanning' || scanner.status === 'starting'
  const startRef = useRef(scanner.start)
  startRef.current = scanner.start

  // Open the camera as soon as the sell screen mounts. A till should be ready
  // to scan the moment you land on it, with no extra tap.
  useEffect(() => {
    void startRef.current()
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* Viewport: the live camera feed fills this box. */}
      <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-black sm:aspect-[16/9]">
        <video
          ref={scanner.videoRef}
          playsInline
          muted
          className={`h-full w-full object-cover transition-opacity ${
            scanning ? 'opacity-100' : 'opacity-0'
          }`}
        />

        {/* Reticle: the box the cashier lines the barcode up with. */}
        {scanning && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-24 w-3/4 rounded-xl border-2 border-cash-400/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
              <span className="absolute -left-0.5 -top-0.5 h-3 w-3 rounded-tl-lg border-l-4 border-t-4 border-white" />
              <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-tr-lg border-r-4 border-t-4 border-white" />
              <span className="absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-bl-lg border-b-4 border-l-4 border-white" />
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-br-lg border-b-4 border-r-4 border-white" />
            </div>
          </div>
        )}

        {!scanning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900 px-6 text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-12 w-12 text-slate-600">
              <path d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M7 20H5a2 2 0 01-2-2v-2M3 12h18" />
            </svg>
            <p className="text-sm text-slate-400">Camera is off</p>
            <button className="btn-primary" onClick={() => void startRef.current()}>
              Start scanner
            </button>
          </div>
        )}

        {/* Confirmation overlay after a successful read. */}
        {flash && (
          <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 animate-beep rounded-xl bg-cash-500 px-4 py-2.5 text-ink-900 shadow-lift">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="h-4 w-4 shrink-0">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <p className="truncate text-sm font-semibold">{flash}</p>
          </div>
        )}

        {/* Camera status is intentionally text-free here: the format/API badge
            used to sit at the bottom-left and covered the scan confirmation
            (which shows the product name) on every successful scan. API details
            are still available in Settings. */}

        {/* The owner can see the drawer; a cashier cannot. */}
        {isOwner && (
          <div className="absolute left-3 top-3 rounded-full bg-ink-900/70 px-3 py-1.5 text-xs backdrop-blur">
            <span className="text-slate-400">Cash </span>
            <span className="font-mono font-semibold text-cash-400">{formatMaluti(cash)}</span>
          </div>
        )}

        {/* Scanner controls */}
        {scanning && (
          <div className="absolute right-3 top-3 flex flex-col gap-2">
            {scanner.torchAvailable && (
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
            )}
            <button
              onClick={scanner.stop}
              aria-label="Stop scanner"
              className="rounded-full bg-ink-900/70 p-3 text-white backdrop-blur"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Camera blocked / not installed / no camera */}
      {scanner.status !== 'scanning' && scanner.status !== 'starting' && scanner.error && (
        <div className="mx-4 mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
          {scanner.error}
        </div>
      )}

      <ManualEntry onSubmit={onDetected} disabled={scanner.status === 'scanning'} />

      <CartPanel
        lines={lines}
        products={products}
        onChangeQty={changeQty}
        onRemove={remove}
        onClear={clear}
      />

      {/* Sticky checkout bar */}
      {count > 0 && (
        <div className="sticky bottom-0 z-30 border-t border-ink-700 bg-ink-800/95 px-4 py-3 backdrop-blur">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-xs uppercase tracking-wider text-slate-400">Total</span>
            <span className="font-mono text-2xl font-bold text-cash-400">
              {formatMaluti(subtotal)}
            </span>
          </div>
          <button className="btn-primary w-full" onClick={() => setCheckoutOpen(true)}>
            Take payment
          </button>
        </div>
      )}

      <UnknownCodeSheet
        code={pendingCode}
        onClose={() => setPendingCode(null)}
        onSave={(input) => {
          addAdHocLine(input)
          feedbackSuccess()
        }}
      />

      <CheckoutSheet
        open={checkoutOpen}
        total={subtotal}
        onClose={() => setCheckoutOpen(false)}
        onComplete={() => {
          setCheckoutOpen(false)
          clear()
        }}
      />
    </div>
  )
}