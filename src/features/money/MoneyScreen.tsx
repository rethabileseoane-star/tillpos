import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import type { CashInKind, CashMovement, CashReason, Product } from '@/db/types'
import { formatMaluti, parseAmount } from '@/domain/money'
import { normalizeBarcode } from '@/domain/barcode'
import { businessDate } from '@/features/sales/salesService'
import {
  buyStock,
  recordCashIn,
  recordDrawing,
  recordExpense,
  recordLoanRepay,
  setOpeningFloat,
} from '@/features/cash/cashService'
import { feedbackSuccess } from '@/ui/feedback'
import { BarcodeScanSheet } from '@/features/scanner/BarcodeScanSheet'

const MOVEMENT_LABEL: Record<CashReason, string> = {
  sale: 'Sale',
  void: 'Void',
  float: 'Opening float',
  cash_in: 'Money in',
  purchase: 'Bought stock',
  drawing: 'Owner took',
  expense: 'Paid out',
  loan_repay: 'Loan repaid',
  credit_payment: 'Credit payment',
}

const MOVEMENT_CHIP: Record<CashReason, string> = {
  sale: 'bg-cash-500/15 text-cash-400',
  void: 'bg-red-500/15 text-red-300',
  float: 'bg-slate-500/15 text-slate-300',
  cash_in: 'bg-cash-500/15 text-cash-400',
  purchase: 'bg-indigo-500/15 text-indigo-300',
  drawing: 'bg-amber-500/15 text-amber-300',
  expense: 'bg-rose-500/15 text-rose-300',
  loan_repay: 'bg-violet-500/15 text-violet-300',
  credit_payment: 'bg-cash-500/15 text-cash-400',
}

type SheetKind = 'buy' | 'float' | 'cash_in' | 'drawing' | 'expense' | 'loan_repay'

export function MoneyScreen() {
  const [sheet, setSheet] = useState<SheetKind | null>(null)
  const today = businessDate()

  const cash = useLiveQuery(
    () => db.cashMovements.orderBy('createdAt').reverse().toArray(),
    [],
  ) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const stockMoves = useLiveQuery(
    () => db.stockMovements.orderBy('createdAt').reverse().limit(800).toArray(),
    [],
  ) ?? []

  const balance = useMemo(() => cash.reduce((s, m) => s + m.delta, 0), [cash])

  const loansOwed = useMemo(
    () =>
      cash
        .filter((m) => (m.reason === 'cash_in' && m.kind === 'loan') || m.reason === 'loan_repay')
        .reduce((s, m) => s + m.delta, 0),
    [cash],
  )

  const todaySales = useMemo(
    () =>
      cash
        .filter(
          (m) =>
            (m.reason === 'sale' || m.reason === 'credit_payment') &&
            m.businessDate === today,
        )
        .reduce((s, m) => s + m.delta, 0),
    [cash, today],
  )
  const todayStock = useMemo(
    () => cash.filter((m) => m.reason === 'purchase' && m.businessDate === today).reduce((s, m) => s + m.delta, 0),
    [cash, today],
  )

  const stockWorth = useMemo(
    () => products.reduce((s, p) => s + p.stockQty * (p.cost ?? p.price), 0),
    [products],
  )

  // Purchase lines joined back to their cash movement, so a "Bought stock"
  // entry can say "Gum x10, bread x4" under the payment.
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const purchaseItems = useMemo(() => {
    const map = new Map<string, { name: string; qty: number }[]>()
    for (const sm of stockMoves) {
      if (sm.reason !== 'purchase' || !sm.refId) continue
      const product = productById.get(sm.productId)
      const arr = map.get(sm.refId) ?? []
      arr.push({ name: product?.name ?? 'Item', qty: sm.delta })
      map.set(sm.refId, arr)
    }
    return map
  }, [stockMoves, productById])

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-bold">Money</h1>
      <p className="text-xs text-slate-400">The till, the stock, and the cash that moves</p>

      {/* The number that must match the tin. */}
      <div className="card mt-3 border-cash-500/40 bg-cash-500/10 shadow-lift">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-400">
              Money in the till
            </p>
            <p className="mt-1 font-mono text-4xl font-bold text-cash-400">
              {formatMaluti(balance)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-cash-500/20 text-cash-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-6 w-6">
                <path d="M2 7h20v10H2z M2 10h20M6 14h4" />
              </svg>
            </div>
            <button
              onClick={() => setSheet('float')}
              className="text-xs text-cash-400 underline underline-offset-2"
            >
              Set float
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Today · {formatMaluti(todaySales)} cash from sales and credit
          {todayStock < 0 && <> · {formatMaluti(-todayStock)} on stock</>}
          {' '}· stock in shop ≈ {formatMaluti(stockWorth)}
          {loansOwed > 0 && <> · loans owed {formatMaluti(loansOwed)}</>}
        </p>
      </div>

      {/* Daily actions */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <ActionButton label="Bought stock" sub="till out, stock up" onTap={() => setSheet('buy')} />
        <ActionButton label="Money in" sub="extra cash" onTap={() => setSheet('cash_in')} />
        <ActionButton label="Owner took" sub="to pocket" onTap={() => setSheet('drawing')} />
        <ActionButton label="Paid out" sub="rent, transport…" onTap={() => setSheet('expense')} />
        <ActionButton
          label="Pay loan"
          sub={loansOwed > 0 ? `still owe ${formatMaluti(loansOwed)}` : 'money borrowed in'}
          onTap={() => setSheet('loan_repay')}
        />
      </div>

      {/* Movement history */}
      <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Recent movements
      </h2>
      {cash.length === 0 ? (
        <p className="mt-2 rounded-xl border border-ink-700 px-4 py-6 text-center text-sm text-slate-500">
          Nothing yet — sales and the buttons above build this list.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {cash.slice(0, 25).map((m) => (
            <MovementRow key={m.id} m={m} items={purchaseItems.get(m.id)} />
          ))}
        </ul>
      )}

      {sheet === 'buy' && <BuyStockSheet products={products} onClose={() => setSheet(null)} />}
      {sheet && sheet !== 'buy' && (
        <QuickAmountSheet kind={sheet} onClose={() => setSheet(null)} />
      )}
    </div>
  )
}

function ActionButton({ label, sub, onTap }: { label: string; sub: string; onTap: () => void }) {
  return (
    <button
      onClick={onTap}
      className="card flex flex-col items-center gap-0.5 !border-ink-700 !py-4 transition active:scale-[0.98] hover:border-cash-500/30"
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className="text-[11px] text-slate-500">{sub}</span>
    </button>
  )
}

function MovementRow({ m, items }: { m: CashMovement; items?: { name: string; qty: number }[] }) {
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = m.businessDate === businessDate() ? 'Today' : m.businessDate
  const positive = m.delta >= 0
  return (
    <li className="card !py-2.5">
      <div className="flex items-center gap-2">
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${MOVEMENT_CHIP[m.reason]}`}>
          {MOVEMENT_LABEL[m.reason]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-slate-300">
            {m.note || MOVEMENT_LABEL[m.reason]}
          </p>
          <p className="text-[10px] text-slate-500">
            {date} · {time}
          </p>
        </div>
        <span
          className={`shrink-0 font-mono text-sm font-semibold ${
            positive ? 'text-cash-400' : 'text-amber-400'
          }`}
        >
          {positive ? '+' : ''}
          {formatMaluti(m.delta)}
        </span>
      </div>
      {items && items.length > 0 && (
        <p className="mt-1 truncate pl-1 text-[11px] text-indigo-300/80">
          {items.map((i) => `${i.name} ×${i.qty}`).join(', ')}
        </p>
      )}
    </li>
  )
}

const QUICK: Record<Exclude<SheetKind, 'buy'>, {
  title: string
  label: string
  amountPlaceholder: string
  notePlaceholder: string
  saveLabel: string
  hint?: string
}> = {
  float: {
    title: 'Opening float',
    label: 'What does the drawer start with today?',
    amountPlaceholder: 'e.g. 100',
    notePlaceholder: 'Note (optional)',
    saveLabel: 'Set opening float',
    hint: 'Sets the drawer to this figure rather than adding to it, so doing it twice changes nothing.',
  },
  cash_in: {
    title: 'Money in',
    label: 'Cash you are putting into the till',
    amountPlaceholder: 'Amount',
    notePlaceholder: 'From where? (home, bank, loan…)',
    saveLabel: 'Add money in',
  },
  drawing: {
    title: 'Owner took',
    label: 'Cash you are taking out of the till',
    amountPlaceholder: 'Amount',
    notePlaceholder: 'For what? (lunch, home, banking…)',
    saveLabel: 'Record',
  },
  expense: {
    title: 'Paid out',
    label: 'What did you pay, and for what?',
    amountPlaceholder: 'Amount',
    notePlaceholder: 'What for? (rent, transport, electricity…)',
    saveLabel: 'Record',
  },
  loan_repay: {
    title: 'Pay loan',
    label: 'Paying back money you borrowed — this lowers what the shop owes',
    amountPlaceholder: 'Amount',
    notePlaceholder: 'To who? (bank, family, micro-lender…)',
    saveLabel: 'Record repayment',
    hint: 'You cannot repay more than the shop still owes.',
  },
}

function QuickAmountSheet({
  kind,
  onClose,
}: {
  kind: Exclude<SheetKind, 'buy'>
  onClose: () => void
}) {
  const config = QUICK[kind]
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [kind2, setKind2] = useState<CashInKind>('capital')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cents = parseAmount(amount)
  const canSave = cents !== null && cents > 0 && !busy

  const save = async () => {
    if (cents === null || cents <= 0) {
      setError('Enter an amount greater than zero')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (kind === 'float') await setOpeningFloat(cents, note || 'Opening float')
      else if (kind === 'cash_in')
        await recordCashIn(cents, note || 'Money in', kind2)
      else if (kind === 'drawing') await recordDrawing(cents, note || 'Owner took')
      else if (kind === 'loan_repay') await recordLoanRepay(cents, note || 'Loan repaid')
      else await recordExpense(cents, note || 'Paid out')
      feedbackSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record it')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/75" onClick={onClose}>
      <div
        className="w-full animate-slideUp rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />
        <h2 className="text-lg font-semibold">{config.title}</h2>
        <p className="mt-0.5 text-xs text-slate-400">{config.label}</p>

        {kind === 'cash_in' && (
          <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-ink-700 p-1">
            {(
              [
                { value: 'capital', label: 'Own money', sub: 'capital' },
                { value: 'loan', label: 'Borrowed', sub: 'loan to repay' },
              ] as { value: CashInKind; label: string; sub: string }[]
            ).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setKind2(opt.value)}
                className={`rounded-lg px-2 py-2 text-xs font-semibold ${
                  kind2 === opt.value ? 'bg-ink-600 text-cash-400' : 'text-slate-400'
                }`}
              >
                {opt.label}
                <span className="block text-[10px] font-normal text-slate-500">{opt.sub}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label className="label" htmlFor="qa-amount">Amount (M)</label>
            <input
              id="qa-amount"
              className="field text-center font-mono !text-2xl"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                setError(null)
              }}
              placeholder={config.amountPlaceholder}
            />
          </div>
          <div>
            <label className="label" htmlFor="qa-note">Note</label>
            <input
              id="qa-note"
              className="field"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={config.notePlaceholder}
            />
          </div>
        </div>

        {config.hint && (
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{config.hint}</p>
        )}
        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={!canSave} onClick={() => void save()}>
            {busy ? 'Saving…' : config.saveLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Buying stock: scan or pick items, set quantities, then enter what was
 * actually paid (depot prices are often negotiated). Money leaves the till,
 * stock goes up, and each product's movement links back to this payment.
 */
function BuyStockSheet({ products, onClose }: { products: Product[]; onClose: () => void }) {
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<Record<string, number>>({})
  const [amount, setAmount] = useState('')
  const [amountTouched, setAmountTouched] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)

  const active = useMemo(
    () => products.filter((p) => p.deletedAt == null && p.active !== false),
    [products],
  )
  const byId = useMemo(() => new Map(active.map((p) => [p.id, p])), [active])

  const term = search.trim().toLowerCase()
  const matches = useMemo(
    () => active.filter((p) => !term || p.name.toLowerCase().includes(term) || p.barcode.includes(term)),
    [active, term],
  )

  const bumped = useMemo(() => {
    let t = 0
    for (const [id, qty] of Object.entries(sel)) {
      const p = byId.get(id)
      if (p) t += qty * (p.cost ?? p.price)
    }
    return t
  }, [sel, byId])

  // Pre-fill the amount from the item costs until the owner edits it.
  useEffect(() => {
    if (amountTouched) return
    setAmount(bumped > 0 ? String(bumped / 100) : '')
  }, [bumped, amountTouched])

  const bump = (id: string, by: number) => {
    setSel((prev) => {
      const next = { ...prev }
      const qty = Math.max(0, (next[id] ?? 0) + by)
      if (qty === 0) delete next[id]
      else next[id] = qty
      return next
    })
  }

  const paid = parseAmount(amount)
  const canSave =
    Object.keys(sel).length > 0 &&
    paid !== null &&
    paid > 0 &&
    !busy

  const save = async () => {
    if (paid === null || paid <= 0) {
      setError('Enter the amount you paid')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await buyStock(
        Object.entries(sel).map(([productId, qty]) => ({ productId, qty })),
        paid,
        note.trim(),
      )
      feedbackSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the purchase')
      setBusy(false)
    }
  }

  const onScanned = async (code: string) => {
    setScanOpen(false)
    const normalized = normalizeBarcode(code)
    const found = active.find((p) => p.barcode === normalized)
    if (!found) {
      setError(`"${code}" is not in the catalog — add it there first, then buy stock.`)
      return
    }
    bump(found.id, 1)
    setError(null)
  }

  const selected = Object.keys(sel)
    .map((id) => byId.get(id))
    .filter((p): p is Product => Boolean(p))

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/75" onClick={onClose}>
      <div
        className="max-h-[92dvh] w-full animate-slideUp overflow-y-auto rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />
        <h2 className="text-lg font-semibold">Bought stock</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Money leaves the till, stock goes up
        </p>

        {/* Add items: scan or search */}
        <div className="mt-3 flex gap-2">
          <input
            className="field min-w-0 flex-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items"
          />
          <button className="btn-ghost shrink-0" onClick={() => setScanOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="mr-1 inline h-4 w-4">
              <path d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M7 20H5a2 2 0 01-2-2v-2M3 12h18" />
            </svg>
            Scan
          </button>
        </div>

        {/* Added so far */}
        {selected.length > 0 && (
          <ul className="mt-3 space-y-1.5 rounded-xl border border-ink-700 bg-ink-900/50 p-2.5">
            {selected.map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                <span className="font-mono text-[11px] text-slate-400">
                  {formatMaluti(p.cost ?? p.price)} each
                </span>
                <div className="flex items-center gap-2">
                  <QtyButton label="−" onTap={() => bump(p.id, -1)} />
                  <span className="w-6 text-center font-mono text-sm">{sel[p.id]}</span>
                  <QtyButton label="+" onTap={() => bump(p.id, 1)} />
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Picker */}
        <p className="label mt-3">Tap to add</p>
        {matches.length === 0 ? (
          <p className="mt-1 rounded-lg bg-ink-900/40 px-3 py-4 text-center text-xs text-slate-500">
            Nothing in the catalog matches — add the item in the Catalog tab first.
          </p>
        ) : (
          <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
            {matches.slice(0, 60).map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left active:bg-ink-700"
                  onClick={() => bump(p.id, 1)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{p.name}</span>
                    <span className="block text-[10px] text-slate-500">
                      {formatMaluti(p.cost ?? p.price)} each · {p.stockQty} in stock
                    </span>
                  </span>
                  <span className="font-mono text-lg text-cash-400">
                    {sel[p.id] ? `×${sel[p.id]}` : '+'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Amount paid + note */}
        <div className="mt-4 space-y-3">
          <div>
            <label className="label" htmlFor="bs-amount">
              Amount you paid (M)
            </label>
            <input
              id="bs-amount"
              className="field text-center font-mono !text-xl"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                setAmountTouched(true)
                setError(null)
              }}
              placeholder="0.00"
            />
            {amountTouched && bumped > 0 && (paid === null || paid !== bumped) && (
              <p className="mt-1 text-[11px] text-slate-500">
                Suggested from item costs: {formatMaluti(bumped)}
              </p>
            )}
          </div>
          <div>
            <label className="label" htmlFor="bs-note">From / at</label>
            <input
              id="bs-note"
              className="field"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Wholesalers, corner depot…"
            />
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={!canSave} onClick={() => void save()}>
            {busy ? 'Saving…' : selected.length > 0 ? `Save ${formatMaluti(paid ?? 0)}` : 'Save'}
          </button>
        </div>
      </div>

      {scanOpen && (
        <BarcodeScanSheet
          title="Scan an item you bought"
          onDetected={(code) => void onScanned(code)}
          onClose={() => setScanOpen(false)}
        />
      )}
    </div>
  )
}

function QtyButton({ label, onTap }: { label: string; onTap: () => void }) {
  return (
    <button
      onClick={onTap}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink-700 font-mono text-base text-slate-200 active:bg-ink-600"
    >
      {label}
    </button>
  )
}