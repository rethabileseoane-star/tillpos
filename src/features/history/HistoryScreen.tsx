import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import type { CashMovement } from '@/db/types'
import { formatMaluti, parseAmount } from '@/domain/money'
import { businessDate, voidSale } from '@/features/sales/salesService'
import { exportSalesCsv } from '@/features/reports/exportCsv'
import { useAppLock } from '@/features/security/LockContext'
import { saleCashierName } from '@/features/security/staff'
import { downloadBlob } from '@/features/catalog/csvImport'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import {
  recordCreditPayment,
  writeOffCreditSale,
} from '@/features/credit/creditService'
import {
  CREDIT_STATE_LABEL,
  creditBalance,
  creditPaidMap,
  creditState,
  effectiveWriteOffAmount,
  outstandingCreditRows,
  type CreditRow,
} from '@/features/credit/credit'

/**
 * Sales history for both roles.
 *
 * The owner sees the day's money and can void a sale. A cashier sees the same
 * day's transactions with every price and total hidden, but can work the credit
 * book: take a payment or write off a debt, at the owner's explicit request.
 * The credit book is operational (who owes what) rather than a revenue report,
 * so it shows balances to both roles while the day view stays money-free.
 */
const UNASSIGNED = 'Unassigned'

export function HistoryScreen() {
  const { isOwner, accounts } = useAppLock()
  const today = businessDate()
  const [date, setDate] = useState(today)
  const [cashierFilter, setCashierFilter] = useState('all')
  const [openSaleId, setOpenSaleId] = useState<string | null>(null)
  const [creditOpen, setCreditOpen] = useState(false)
  const [payRow, setPayRow] = useState<CreditRow | null>(null)
  const [writeOffRow, setWriteOffRow] = useState<CreditRow | null>(null)

  const sales =
    useLiveQuery(async () => {
      const rows = await db.sales.where('businessDate').equals(date).toArray()
      // Newest first. `.reverse().sortBy()` does not do this: sortBy re-sorts
      // ascending after the cursor direction is applied.
      return rows.sort((a, b) => b.createdAt - a.createdAt)
    }, [date]) ?? []

  const creditPayments =
    useLiveQuery(
      () => db.cashMovements.where('reason').equals('credit_payment').toArray(),
      [],
    ) ?? []

  const allSales = useLiveQuery(() => db.sales.toArray(), []) ?? []
  const paidMap = useMemo(() => creditPaidMap(creditPayments), [creditPayments])
  const book = useMemo(
    () => outstandingCreditRows(allSales, creditPayments),
    [allSales, creditPayments],
  )
  const owed = book.reduce((sum, row) => sum + row.balance, 0)
  const lastPaymentBySale = useMemo(() => {
    const map = new Map<string, CashMovement>()
    for (const movement of creditPayments) {
      if (!movement.refId) continue
      const current = map.get(movement.refId)
      if (!current || movement.createdAt > current.createdAt) {
        map.set(movement.refId, movement)
      }
    }
    return map
  }, [creditPayments])

  // The owner can narrow the day to one person's transactions. Names come from
  // the staff roster as well as the day's rows, so a cashier with no sales still
  // appears and an old/removed name can still be found in history.
  const staffNames = useMemo(() => {
    if (!isOwner) return []
    const names = new Set<string>()
    for (const account of accounts) names.add(account.name)
    for (const sale of sales) names.add(sale.cashierName?.trim() || UNASSIGNED)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [accounts, isOwner, sales])
  const activeFilter = staffNames.includes(cashierFilter) ? cashierFilter : 'all'
  const shownSales = useMemo(() => {
    if (activeFilter === 'all') return sales
    return sales.filter(
      (sale) => (sale.cashierName?.trim() || UNASSIGNED) === activeFilter,
    )
  }, [activeFilter, sales])

  const totals = shownSales.reduce(
    (acc, s) => {
      if (s.status === 'completed') {
        acc.count++
        acc.net += s.total
        if (s.paymentMethod === 'credit') acc.creditCount++
      } else {
        acc.voided += s.total
        acc.voidCount++
      }
      return acc
    },
    { count: 0, net: 0, creditCount: 0, voided: 0, voidCount: 0 },
  )

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Sales</h1>
          <p className="text-[11px] text-slate-500">
            {isOwner
              ? 'Every sale by cashier, and the credit book'
              : "Today's sales · amounts hidden"}
          </p>
        </div>
        {isOwner && (
          <button
            onClick={() => {
              void exportSalesCsv([date])
                .then((blob) => downloadBlob(blob, `sales-${date}.csv`))
                .catch(() => feedbackError())
            }}
            className="text-xs text-slate-400 underline"
          >
            Export day
          </button>
        )}
      </div>

      {isOwner ? (
        <>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value || today)}
            className="field mt-3 font-mono"
          />
          <label className="mt-2 block">
            <span className="text-[10px] uppercase tracking-wider text-slate-400">
              Cashier
            </span>
            <select
              value={activeFilter}
              onChange={(e) => {
                setCashierFilter(e.target.value)
                setOpenSaleId(null)
              }}
              className="field mt-1 font-mono"
            >
              <option value="all">All staff</option>
              {staffNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <div className="mt-3 rounded-xl border border-ink-700 bg-ink-800/70 px-3 py-2 font-mono text-sm text-slate-300">
          Today · {today}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="card !p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Sales</p>
          <p className="font-mono text-lg font-semibold">{totals.count}</p>
        </div>
        {isOwner ? (
          <div className="card !p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Net sales</p>
            <p className="font-mono text-lg font-semibold text-cash-400">
              {formatMaluti(totals.net)}
            </p>
          </div>
        ) : (
          <div className="card !p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">On credit</p>
            <p className="font-mono text-lg font-semibold">{totals.creditCount}</p>
          </div>
        )}
        {isOwner ? (
          <div className="card !p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Owed now</p>
            <p className="font-mono text-lg font-semibold text-amber-400">
              {formatMaluti(owed)}
            </p>
          </div>
        ) : (
          <div className="card !p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">Credit book</p>
            <p className="font-mono text-lg font-semibold">{book.length} open</p>
          </div>
        )}
        <div className="card !p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Voided</p>
          <p className="font-mono text-lg font-semibold text-amber-400">{totals.voidCount}</p>
        </div>
      </div>

      <button
        onClick={() => setCreditOpen(true)}
        className="card mt-2 flex w-full items-center justify-between !border-amber-500/30 !bg-amber-500/10 !py-3 text-left active:scale-[0.99]"
      >
        <span>
          <span className="block text-sm font-semibold text-amber-300">Credit book</span>
          <span className="block text-[11px] text-slate-400">
            {isOwner
              ? `${book.length} open · ${formatMaluti(owed)} owed`
              : `${book.length} open · take a payment or write one off`}
          </span>
        </span>
        <span className="font-mono text-xs text-amber-300">Open ›</span>
      </button>

      <ul className="mt-3 space-y-2">
        {shownSales.map((sale) => {
          const credit = sale.paymentMethod === 'credit'
          const balance = creditBalance(sale, paidMap)
          const writtenOff = (sale.writtenOffAmount ?? 0) > 0
          return (
            <li key={sale.id}>
              <button
                onClick={() => setOpenSaleId(openSaleId === sale.id ? null : sale.id)}
                className={`card w-full !py-3 text-left ${
                  sale.status === 'voided' ? 'opacity-60' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 font-mono text-sm font-semibold">
                      #{sale.receiptNo}
                      {sale.status === 'voided' && (
                        <span className="chip bg-amber-500/20 text-amber-300">VOIDED</span>
                      )}
                      {credit && sale.status === 'completed' && (
                        <span className="chip bg-sky-500/20 text-sky-300">CREDIT</span>
                      )}
                      {writtenOff && (
                        <span className="chip bg-rose-500/20 text-rose-300">WRITTEN OFF</span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {new Date(sale.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {' · '}
                      {credit ? 'Credit' : 'Cash'}
                      {' · '}
                      {sale.cashierName?.trim()
                        ? `Cashier: ${sale.cashierName.trim()}`
                        : 'Cashier: Unassigned'}
                      {credit && sale.customerName ? ` · ${sale.customerName}` : ''}
                    </p>
                    {isOwner && credit && balance > 0 && (
                      <p className="mt-0.5 text-[11px] text-amber-300">
                        {formatMaluti(balance)} still owed
                      </p>
                    )}
                  </div>
                  {isOwner && (
                    <p
                      className={`shrink-0 font-mono text-lg font-semibold ${
                        sale.status === 'voided'
                          ? 'text-slate-400 line-through'
                          : 'text-cash-400'
                      }`}
                    >
                      {formatMaluti(sale.total)}
                    </p>
                  )}
                </div>
              </button>

              {openSaleId === sale.id && (
                <SaleDetail
                  saleId={sale.id}
                  isOwner={isOwner}
                  onVoided={() => setOpenSaleId(null)}
                  onPay={setPayRow}
                  onWriteOff={setWriteOffRow}
                />
              )}
            </li>
          )
        })}
        {shownSales.length === 0 && (
          <li className="py-8 text-center text-sm text-slate-500">
            {isOwner && activeFilter !== 'all'
              ? `No sales by ${activeFilter} on ${date}`
              : `No sales on ${date}`}
          </li>
        )}
      </ul>

      {creditOpen && (
        <CreditBookSheet
          rows={book}
          lastPayments={lastPaymentBySale}
          isOwner={isOwner}
          owed={owed}
          onClose={() => setCreditOpen(false)}
          onPay={setPayRow}
          onWriteOff={setWriteOffRow}
        />
      )}

      {payRow && (
        <CreditPaymentSheet row={payRow} onClose={() => setPayRow(null)} />
      )}

      {writeOffRow && (
        <WriteOffSheet row={writeOffRow} onClose={() => setWriteOffRow(null)} />
      )}
    </div>
  )
}

function SaleDetail({
  saleId,
  isOwner,
  onVoided,
  onPay,
  onWriteOff,
}: {
  saleId: string
  isOwner: boolean
  onVoided: () => void
  onPay: (row: CreditRow) => void
  onWriteOff: (row: CreditRow) => void
}) {
  const sale = useLiveQuery(() => db.sales.get(saleId), [saleId])
  const lines = useLiveQuery(
    () => db.saleLines.where('saleId').equals(saleId).toArray(),
    [saleId],
  )
  const payments =
    useLiveQuery(
      async () =>
        (await db.cashMovements.where('refId').equals(saleId).toArray()).filter(
          (m) => m.reason === 'credit_payment',
        ),
      [saleId],
    ) ?? []

  const paid = payments.reduce((sum, m) => sum + m.delta, 0)
  const paidMap = useMemo(() => new Map([[saleId, paid]]), [saleId, paid])

  if (!sale) return null
  const credit = sale.paymentMethod === 'credit'
  const balance = creditBalance(sale, paidMap)
  const state = creditState(sale, paidMap)
  const writtenOff = (sale.writtenOffAmount ?? 0) > 0
  const writtenOffAmount = effectiveWriteOffAmount(sale, paid)
  const row: CreditRow = { sale, paid, balance, state }

  return (
    <div className="mt-2 animate-slideUp rounded-xl border border-ink-700 bg-ink-800 p-3">
      <ul className="space-y-1.5 text-sm">
        {(lines ?? []).map((l) => (
          <li key={l.id} className="flex justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-slate-300">
              {l.qty} × {l.name}
            </span>
            {isOwner && (
              <span className="font-mono text-slate-400">{formatMaluti(l.lineTotal)}</span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 border-t border-ink-700 pt-2 text-sm">
        <div className="flex justify-between text-slate-400">
          <span>Cashier</span>
          <span>{sale.cashierName?.trim() || 'Unassigned'}</span>
        </div>
        <div className="flex justify-between text-slate-400">
          <span>Payment</span>
          <span>{credit ? 'Credit' : 'Cash'}</span>
        </div>
        {credit && (
          <div className="flex justify-between text-slate-400">
            <span>Customer</span>
            <span className="ml-2 truncate">{sale.customerName || '—'}</span>
          </div>
        )}

        {isOwner && (
          <>
            <div className="flex justify-between">
              <span className="text-slate-400">Subtotal</span>
              <span className="font-mono">{formatMaluti(sale.subtotal)}</span>
            </div>
            {sale.amountTendered !== null && (
              <>
                <div className="flex justify-between text-slate-400">
                  <span>Cash received</span>
                  <span className="font-mono">{formatMaluti(sale.amountTendered)}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Change</span>
                  <span className="font-mono">{formatMaluti(sale.change ?? 0)}</span>
                </div>
              </>
            )}
            {credit && sale.status === 'completed' && (
              <>
                <div className="flex justify-between text-slate-400">
                  <span>Paid so far</span>
                  <span className="font-mono">{formatMaluti(paid)}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Balance</span>
                  <span className="font-mono">{formatMaluti(balance)}</span>
                </div>
              </>
            )}
            {credit && sale.status === 'voided' && (
              <div className="flex justify-between text-slate-400">
                <span>Refunded</span>
                <span className="font-mono">{formatMaluti(paid)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between font-semibold">
              <span>Total</span>
              <span className="font-mono text-cash-400">{formatMaluti(sale.total)}</span>
            </div>
          </>
        )}

        {isOwner && payments.length > 0 && (
          <div className="mt-2 rounded-lg border border-ink-700 bg-ink-900/50 p-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              Credit payments received
            </p>
            <ul className="mt-1 space-y-1">
              {[...payments]
                .sort((a, b) => a.createdAt - b.createdAt)
                .map((m) => (
                  <li
                    key={m.id}
                    className="flex items-baseline justify-between gap-2 text-[11px]"
                  >
                    <span className="min-w-0 truncate text-slate-400">
                      {m.businessDate} · {m.staffName?.trim() || 'Not recorded'}
                    </span>
                    <span className="shrink-0 font-mono text-slate-300">
                      {formatMaluti(m.delta)}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {!isOwner && credit && (
          <div className="mt-1 flex justify-between font-semibold">
            <span>Credit status</span>
            <span className="text-slate-200">{CREDIT_STATE_LABEL[state]}</span>
          </div>
        )}

        {writtenOff && (
          <p className="mt-2 rounded-lg bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-200">
            {isOwner
              ? writtenOffAmount > 0
                ? `Written off ${formatMaluti(writtenOffAmount)}`
                : 'Written off · recovered in full'
              : 'Written off'}
            {sale.writeOffReason ? ` · ${sale.writeOffReason}` : ''}
            {sale.writtenOffBy ? ` · by ${sale.writtenOffBy}` : ''}
          </p>
        )}
      </div>

      {sale.note && <p className="mt-2 text-xs text-slate-500">{sale.note}</p>}

      {credit && sale.status === 'completed' && balance > 0 && (
        <div className="mt-3 flex gap-2">
          <button
            className="btn-primary flex-1 !py-2.5 text-sm"
            onClick={() => onPay(row)}
          >
            Receive payment
          </button>
          <button
            className="btn-ghost flex-1 !py-2.5 text-sm"
            onClick={() => onWriteOff(row)}
          >
            Write off
          </button>
        </div>
      )}

      {isOwner && sale.status === 'completed' && !writtenOff && (
        <button
          className="btn-danger mt-3 w-full !py-2.5 text-sm"
          onClick={async () => {
            const reason = window.prompt('Reason for voiding this sale')
            if (reason === null) return
            try {
              await voidSale(sale.id, reason)
              onVoided()
            } catch (err) {
              window.alert(err instanceof Error ? err.message : 'Could not void the sale')
            }
          }}
        >
          Void sale
        </button>
      )}
    </div>
  )
}

function CreditBookSheet({
  rows,
  lastPayments,
  isOwner,
  owed,
  onClose,
  onPay,
  onWriteOff,
}: {
  rows: CreditRow[]
  lastPayments: Map<string, CashMovement>
  isOwner: boolean
  owed: number
  onClose: () => void
  onPay: (row: CreditRow) => void
  onWriteOff: (row: CreditRow) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/75" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full animate-slideUp overflow-y-auto rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Credit book</h2>
            <p className="text-[11px] text-slate-400">
              {rows.length} open{isOwner ? ` · ${formatMaluti(owed)} owed` : ''}
            </p>
          </div>
          <button className="text-xs text-slate-400 underline" onClick={onClose}>
            Close
          </button>
        </div>

        <ul className="mt-3 space-y-2">
          {rows.map((row) => {
            const lastPayment = lastPayments.get(row.sale.id)
            return (
              <li key={row.sale.id} className="card !py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {row.sale.customerName || 'Customer'}
                    </p>
                    <p className="text-xs text-slate-400">
                      #{row.sale.receiptNo} · {row.sale.businessDate} ·{' '}
                      {CREDIT_STATE_LABEL[row.state]}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      Sold by {row.sale.cashierName?.trim() || 'Unassigned'}
                    </p>
                    {isOwner && lastPayment && (
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        Last payment {lastPayment.businessDate} ·{' '}
                        {lastPayment.staffName?.trim() || 'Not recorded'}
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 font-mono text-lg font-semibold text-amber-300">
                    {formatMaluti(row.balance)}
                  </p>
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    className="btn-primary flex-1 !py-2 text-xs"
                    onClick={() => onPay(row)}
                  >
                    Payment
                  </button>
                  <button
                    className="btn-ghost flex-1 !py-2 text-xs"
                    onClick={() => onWriteOff(row)}
                  >
                    Write off
                  </button>
                </div>
              </li>
            )
          })}
          {rows.length === 0 && (
            <li className="py-8 text-center text-sm text-slate-500">
              No customer owes anything.
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}

function CreditPaymentSheet({ row, onClose }: { row: CreditRow; onClose: () => void }) {
  const { session } = useAppLock()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cents = parseAmount(amount)
  const valid = cents !== null && cents > 0 && cents <= row.balance
  const remaining = valid ? row.balance - (cents as number) : row.balance

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      await recordCreditPayment({
        saleId: row.sale.id,
        amount: cents as number,
        note,
        staffName: saleCashierName(session),
      })
      feedbackSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the payment')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/80" onClick={onClose}>
      <div
        className="w-full animate-slideUp rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />
        <p className="text-xs uppercase tracking-wider text-slate-400">Credit payment</p>
        <p className="mt-1 text-lg font-semibold">{row.sale.customerName || 'Customer'}</p>
        <p className="text-xs text-slate-400">
          Receipt #{row.sale.receiptNo} · balance{' '}
          <span className="font-mono text-amber-300">{formatMaluti(row.balance)}</span>
        </p>

        <input
          className="field mt-4 text-center font-mono text-2xl"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount received"
          autoFocus
        />
        <button
          className="mt-2 text-xs text-slate-400 underline"
          onClick={() => setAmount(String(row.balance / 100))}
        >
          Pay full balance
        </button>

        <input
          className="field mt-3 text-sm"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
        />

        <p className="mt-2 text-center text-sm text-slate-300">
          {valid
            ? `Balance after this: ${formatMaluti(remaining)}`
            : `Enter up to ${formatMaluti(row.balance)}`}
        </p>

        {error && (
          <p className="mt-2 rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-300">{error}</p>
        )}

        <div className="mt-4 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary flex-1"
            disabled={busy || !valid}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : 'Record payment'}
          </button>
        </div>
      </div>
    </div>
  )
}

function WriteOffSheet({ row, onClose }: { row: CreditRow; onClose: () => void }) {
  const { session } = useAppLock()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!reason.trim()) return
    setBusy(true)
    setError(null)
    try {
      await writeOffCreditSale({
        saleId: row.sale.id,
        reason,
        staffName: saleCashierName(session),
      })
      feedbackSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not write off the debt')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/80" onClick={onClose}>
      <div
        className="w-full animate-slideUp rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />
        <p className="text-xs uppercase tracking-wider text-slate-400">Write off a debt</p>
        <p className="mt-1 text-lg font-semibold">{row.sale.customerName || 'Customer'}</p>
        <p className="text-xs text-slate-400">
          Receipt #{row.sale.receiptNo} · balance to write off{' '}
          <span className="font-mono text-rose-300">{formatMaluti(row.balance)}</span>
        </p>

        <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-200">
          This cancels the debt and records a bad-debt expense. No cash leaves the
          drawer. It cannot be undone from this screen.
        </p>

        <textarea
          className="field mt-3 min-h-[80px] text-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this debt uncollectible?"
          autoFocus
        />

        {error && (
          <p className="mt-2 rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-300">{error}</p>
        )}

        <div className="mt-4 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-danger flex-1"
            disabled={busy || !reason.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : `Write off ${formatMaluti(row.balance)}`}
          </button>
        </div>
      </div>
    </div>
  )
}
