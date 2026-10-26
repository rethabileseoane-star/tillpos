import { useEffect, useState } from 'react'
import { useCart } from '@/features/cart/CartContext'
import { formatMaluti, parseAmount, suggestTender, type Cents } from '@/domain/money'
import { commitSale } from '@/features/sales/salesService'
import { useAppLock } from '@/features/security/LockContext'
import { saleCashierName } from '@/features/security/staff'
import { feedbackSuccess } from '@/ui/feedback'
import type { PaymentMethod, Sale } from '@/db/types'

interface Props {
  open: boolean
  total: Cents
  onClose: () => void
  onComplete: () => void
}

type Stage = 'pay' | 'done'

/**
 * Checkout for cash and customer credit.
 *
 * Cash works as before: type the tender and the change updates. Credit records
 * the customer, takes an optional deposit into the drawer, and leaves the rest
 * as a receivable. The accounting for the deposit and the later balance lives in
 * `commitSale` and the credit service, not in this sheet.
 */
export function CheckoutSheet({ open, total, onClose, onComplete }: Props) {
  const { lines } = useCart()
  const { session } = useAppLock()
  const [stage, setStage] = useState<Stage>('pay')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [tendered, setTendered] = useState<string>('')
  const [customerName, setCustomerName] = useState('')
  const [paidNow, setPaidNow] = useState('')
  const [sale, setSale] = useState<Sale | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setStage('pay')
      setMethod('cash')
      setTendered('')
      setCustomerName('')
      setPaidNow('')
      setSale(null)
      setError(null)
      setBusy(false)
    }
  }, [open])

  if (!open) return null

  // Parse once. `Number(tendered.replace(...))` turned any non-numeric input
  // into 0, so "abc" completed a sale as if the customer had tendered nothing.
  const tenderedCents = parseAmount(tendered)
  const change = tenderedCents === null ? null : Math.max(0, tenderedCents - total)
  const shortBy = tenderedCents !== null && tenderedCents < total ? total - tenderedCents : 0

  const depositCents = paidNow.trim() === '' ? 0 : parseAmount(paidNow)
  const depositValid =
    depositCents !== null && depositCents >= 0 && depositCents <= total
  const customerOk = customerName.trim().length > 0
  const creditBalance = total - (depositCents ?? 0)

  const canComplete =
    method === 'cash'
      ? tenderedCents !== null && shortBy === 0
      : customerOk && depositValid

  const complete = async () => {
    if (!canComplete) return
    setBusy(true)
    setError(null)
    try {
      const result =
        method === 'cash'
          ? await commitSale({
              lines,
              paymentMethod: 'cash',
              amountTendered: tenderedCents as Cents,
              cashierName: saleCashierName(session),
            })
          : await commitSale({
              lines,
              paymentMethod: 'credit',
              amountTendered: null,
              customerName,
              amountPaidNow: (depositCents ?? 0) as Cents,
              cashierName: saleCashierName(session),
            })
      setSale(result)
      setStage('done')
      feedbackSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the sale')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/75"
      onClick={stage === 'done' ? onComplete : onClose}
    >
      <div
        className="w-full animate-slideUp rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />

        {stage === 'pay' && (
          <>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-slate-400">Amount due</p>
              <p className="font-mono text-price font-bold text-cash-400">
                {formatMaluti(total)}
              </p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                className={`btn !py-2.5 text-sm ${
                  method === 'cash' ? 'bg-cash-500 text-ink-900' : 'bg-ink-700'
                }`}
                onClick={() => setMethod('cash')}
              >
                Cash
              </button>
              <button
                className={`btn !py-2.5 text-sm ${
                  method === 'credit' ? 'bg-cash-500 text-ink-900' : 'bg-ink-700'
                }`}
                onClick={() => setMethod('credit')}
              >
                Credit
              </button>
            </div>

            {method === 'cash' ? (
              <>
                <input
                  className="field mt-4 text-center font-mono text-2xl"
                  inputMode="decimal"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  placeholder="Cash received"
                  autoFocus
                />

                {change !== null && tendered !== '' && shortBy === 0 && (
                  <p className="mt-2 text-center text-sm text-slate-300">
                    Change:{' '}
                    <span className="font-mono font-semibold text-cash-400">
                      {formatMaluti(change)}
                    </span>
                  </p>
                )}

                {shortBy > 0 && (
                  <p className="mt-2 text-center text-sm font-medium text-red-300">
                    Short by {formatMaluti(shortBy)}
                  </p>
                )}

                {tendered !== '' && tenderedCents === null && (
                  <p className="mt-2 text-center text-sm text-red-300">Enter a valid amount</p>
                )}

                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {suggestTender(total).map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setTendered(String(amt / 100))}
                      className="rounded-lg bg-ink-700 px-3 py-2 font-mono text-sm active:bg-ink-600"
                    >
                      {formatMaluti(amt)}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <input
                  className="field mt-4 text-sm"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Customer name (required)"
                  maxLength={60}
                  autoFocus
                />

                <label className="mt-3 block text-[11px] uppercase tracking-wider text-slate-400">
                  Paid now (optional)
                </label>
                <input
                  className="field mt-1 text-center font-mono text-xl"
                  inputMode="decimal"
                  value={paidNow}
                  onChange={(e) => setPaidNow(e.target.value)}
                  placeholder="0"
                />

                <p className="mt-2 text-center text-sm text-slate-300">
                  Balance to pay later:{' '}
                  <span className="font-mono font-semibold text-amber-300">
                    {formatMaluti(Math.max(0, creditBalance))}
                  </span>
                </p>
                {!depositValid && (
                  <p className="mt-1 text-center text-sm text-red-300">
                    Enter an amount between 0 and {formatMaluti(total)}
                  </p>
                )}
              </>
            )}

            {error && (
              <p className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-300">{error}</p>
            )}

            <div className="mt-5 flex gap-2">
              <button className="btn-ghost flex-1" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary flex-1"
                disabled={busy || !canComplete}
                onClick={() => void complete()}
              >
                {busy ? 'Saving…' : 'Complete sale'}
              </button>
            </div>
            <p className="mt-3 text-center text-[11px] text-slate-500">
              {method === 'cash'
                ? 'Tendering more than the total is fine, change is calculated for you.'
                : 'The unpaid balance goes into the credit book. No cash is counted until it is paid.'}
            </p>
          </>
        )}

        {stage === 'done' && sale && (
          <div className="text-center">
            <div className="mx-auto flex h-14 w-14 animate-pop items-center justify-center rounded-full bg-cash-500 text-ink-900 shadow-lift">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="h-7 w-7">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <p className="mt-3 text-lg font-semibold">Sale recorded</p>
            <p className="chip mx-auto mt-1.5 bg-ink-700 font-mono text-sm text-slate-300">
              Receipt #{sale.receiptNo}
            </p>
            <p className="mt-2 font-mono text-price font-bold text-cash-400">
              {formatMaluti(sale.total)}
            </p>

            {sale.paymentMethod === 'cash' && sale.change !== null && sale.change > 0 && (
              <p className="text-sm text-slate-300">
                Change{' '}
                <span className="font-mono font-semibold text-cash-400">
                  {formatMaluti(sale.change)}
                </span>
              </p>
            )}

            {sale.paymentMethod === 'credit' && (
              <div className="mt-1 text-sm text-slate-300">
                <p className="font-semibold">{sale.customerName}</p>
                {(depositCents ?? 0) > 0 && (
                  <p>
                    Paid now{' '}
                    <span className="font-mono">{formatMaluti(depositCents ?? 0)}</span>
                  </p>
                )}
                {(sale.total - (depositCents ?? 0)) > 0 ? (
                  <>
                    <p>
                      Balance{' '}
                      <span className="font-mono font-semibold text-amber-300">
                        {formatMaluti(sale.total - (depositCents ?? 0))}
                      </span>
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Collect it later from the credit book in History.
                    </p>
                  </>
                ) : (
                  <p className="font-semibold text-cash-400">Paid in full</p>
                )}
              </div>
            )}

            <button className="btn-primary mt-5 w-full" onClick={onComplete}>
              New sale
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
