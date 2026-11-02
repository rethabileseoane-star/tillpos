import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { useCart } from '@/features/cart/CartContext'
import { formatMaluti, parseAmount, suggestTender, type Cents } from '@/domain/money'
import { commitSale } from '@/features/sales/salesService'
import { useAppLock } from '@/features/security/LockContext'
import { saleCashierName } from '@/features/security/staff'
import { feedbackSuccess } from '@/ui/feedback'
import { tabBalanceMap } from '@/features/tabs/tabs'
import type { CustomerTab, PaymentMethod, Sale, TabEntry } from '@/db/types'

interface Props {
  open: boolean
  total: Cents
  onClose: () => void
  onComplete: () => void
}

type Stage = 'pay' | 'done'

/**
 * Checkout for cash, customer credit and customer tabs.
 *
 * Cash works as before: type the tender and the change updates. A customer tab
 * can pay part of a cash sale, and the change can be left on a tab instead of
 * handed back when the drawer cannot break it. Credit records the customer,
 * takes an optional deposit into the drawer, and leaves the rest as a
 * receivable. The accounting for all three lives in `commitSale`, not here.
 */
export function CheckoutSheet({ open, total, onClose, onComplete }: Props) {
  const { lines } = useCart()
  const { session } = useAppLock()
  const [stage, setStage] = useState<Stage>('pay')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [tendered, setTendered] = useState<string>('')
  const [customerName, setCustomerName] = useState('')
  const [paidNow, setPaidNow] = useState('')
  const [tabId, setTabId] = useState<string | null>(null)
  const [tabUse, setTabUse] = useState('')
  const [keepChange, setKeepChange] = useState(false)
  const [newTabName, setNewTabName] = useState('')
  const [tabPickerOpen, setTabPickerOpen] = useState(false)
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
      setTabId(null)
      setTabUse('')
      setKeepChange(false)
      setNewTabName('')
      setTabPickerOpen(false)
      setSale(null)
      setError(null)
      setBusy(false)
    }
  }, [open])

  // Load only while the sheet is open. The Sell screen keeps this component
  // mounted, so an unconditional query would load every tab on every visit.
  const tabs =
    useLiveQuery(
      () =>
        open
          ? db.customerTabs.filter((tab) => tab.deletedAt == null).toArray()
          : Promise.resolve([] as CustomerTab[]),
      [open],
    ) ?? []
  const tabEntries =
    useLiveQuery(
      () =>
        open ? db.tabEntries.toArray() : Promise.resolve([] as TabEntry[]),
      [open],
    ) ?? []
  const balances = useMemo(() => tabBalanceMap(tabEntries), [tabEntries])
  const selectedTab = tabs.find((tab) => tab.id === tabId) ?? null
  const selectedBalance = selectedTab
    ? Math.max(0, balances.get(selectedTab.id) ?? 0)
    : 0

  if (!open) return null

  // Parse once. `Number(tendered.replace(...))` turned any non-numeric input
  // into 0, so "abc" completed a sale as if the customer had tendered nothing.
  const tenderedCents = parseAmount(tendered)
  const tabUseCents = tabUse.trim() === '' ? 0 : parseAmount(tabUse)
  const tabApplied = method === 'cash' && tabUseCents !== null ? tabUseCents : 0
  const tabAmountValid =
    tabUseCents !== null &&
    tabApplied >= 0 &&
    tabApplied <= total &&
    tabApplied <= selectedBalance &&
    (tabApplied === 0 || selectedTab !== null)
  const cashDue = Math.max(0, total - tabApplied)
  const change = tenderedCents === null ? null : Math.max(0, tenderedCents - cashDue)
  const shortBy =
    tenderedCents !== null && tenderedCents < cashDue ? cashDue - tenderedCents : 0
  const changeKept = method === 'cash' && keepChange ? (change ?? 0) : 0
  const changeTabOk =
    changeKept === 0 || selectedTab !== null || newTabName.trim().length > 0
  const cashTenderOk =
    cashDue === 0
      ? tendered.trim() === '' || tenderedCents !== null
      : tenderedCents !== null && shortBy === 0

  const depositCents = paidNow.trim() === '' ? 0 : parseAmount(paidNow)
  const depositValid =
    depositCents !== null && depositCents >= 0 && depositCents <= total
  const customerOk = customerName.trim().length > 0
  const creditBalance = total - (depositCents ?? 0)

  const canComplete =
    method === 'cash'
      ? cashTenderOk && tabAmountValid && changeTabOk
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
              amountTendered: cashDue === 0 ? 0 : (tenderedCents as Cents),
              tabId:
                selectedTab && (tabApplied > 0 || changeKept > 0)
                  ? selectedTab.id
                  : undefined,
              tabApplied: tabApplied > 0 ? tabApplied : undefined,
              changeToTab: changeKept > 0,
              newTabName:
                changeKept > 0 && !selectedTab ? newTabName : undefined,
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

  const changeGiven = sale ? Math.max(0, (sale.change ?? 0) - (sale.tabChangeKept ?? 0)) : 0
  const saleTabName = sale?.tabId
    ? tabs.find((tab) => tab.id === sale.tabId)?.name ?? 'customer tab'
    : 'customer tab'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/75"
      onClick={stage === 'done' ? onComplete : onClose}
    >
      <div
        className="max-h-[94dvh] w-full animate-slideUp overflow-y-auto rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />

        {stage === 'pay' && (
          <>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-slate-400">
                {tabApplied > 0 ? 'Amount due after tab' : 'Amount due'}
              </p>
              <p className="font-mono text-price font-bold text-cash-400">
                {formatMaluti(cashDue)}
              </p>
              {tabApplied > 0 && (
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Sale {formatMaluti(total)} · from tab {formatMaluti(tabApplied)}
                </p>
              )}
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
                <div className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[10px] uppercase tracking-wider text-slate-400">
                        Customer tab
                      </p>
                      <p className="truncate text-sm font-medium">
                        {selectedTab
                          ? `${selectedTab.name} · ${formatMaluti(selectedBalance)} available`
                          : 'Use money the shop owes a customer'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTabPickerOpen(true)}
                      className="shrink-0 rounded-lg bg-ink-700 px-2.5 py-1.5 text-xs font-medium active:bg-ink-600"
                    >
                      {selectedTab ? 'Change' : 'Use tab'}
                    </button>
                  </div>

                  {selectedTab && (
                    <>
                      <div className="mt-2 flex gap-2">
                        <input
                          className="field !py-2 text-center font-mono text-lg"
                          inputMode="decimal"
                          value={tabUse}
                          onChange={(e) => setTabUse(e.target.value)}
                          placeholder="0"
                          aria-label="Amount from tab"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setTabUse(
                              (Math.min(selectedBalance, total) / 100).toFixed(2),
                            )
                          }
                          className="shrink-0 rounded-lg bg-ink-700 px-3 text-xs font-medium active:bg-ink-600"
                        >
                          Use max
                        </button>
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500">
                        Up to {formatMaluti(Math.min(selectedBalance, total))} of this sale.
                      </p>
                      {tabUse.trim() !== '' && tabUseCents === null && (
                        <p className="mt-1 text-xs text-red-300">Enter a valid amount.</p>
                      )}
                      {tabUseCents !== null && tabApplied > selectedBalance && (
                        <p className="mt-1 text-xs text-red-300">
                          Only {formatMaluti(selectedBalance)} is on that tab.
                        </p>
                      )}
                      {tabUseCents !== null && tabApplied > total && (
                        <p className="mt-1 text-xs text-red-300">
                          The tab cannot pay more than the sale.
                        </p>
                      )}
                    </>
                  )}

                  {change !== null && change > 0 && (
                    <label className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-slate-300">
                      <input
                        type="checkbox"
                        checked={keepChange}
                        onChange={(e) => setKeepChange(e.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-sky-400"
                      />
                      <span>
                        Keep the {formatMaluti(change)} change on a tab instead of
                        handing it back
                      </span>
                    </label>
                  )}

                  {keepChange && changeKept > 0 && !selectedTab && (
                    <input
                      className="field mt-2 text-sm"
                      value={newTabName}
                      onChange={(e) => setNewTabName(e.target.value)}
                      placeholder="Customer name for the new tab (required)"
                      maxLength={60}
                    />
                  )}
                </div>

                <input
                  className="field mt-3 text-center font-mono text-2xl"
                  inputMode="decimal"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  placeholder={cashDue === 0 ? 'Tab covers the sale' : 'Cash received'}
                  autoFocus
                />

                {change !== null && tendered !== '' && shortBy === 0 && change > 0 && (
                  <p className="mt-2 text-center text-sm text-slate-300">
                    Change:{' '}
                    <span className="font-mono font-semibold text-cash-400">
                      {formatMaluti(change)}
                    </span>
                    {changeKept > 0 && (
                      <span className="text-sky-300"> · kept on tab</span>
                    )}
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

                {cashDue > 0 && (
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {suggestTender(cashDue).map((amt) => (
                      <button
                        key={amt}
                        onClick={() => setTendered(String(amt / 100))}
                        className="rounded-lg bg-ink-700 px-3 py-2 font-mono text-sm active:bg-ink-600"
                      >
                        {formatMaluti(amt)}
                      </button>
                    ))}
                  </div>
                )}
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
                ? tabApplied > 0
                  ? 'The tab pays the rest. Cash received can still be more, and the change can go back on the tab.'
                  : 'Tendering more than the total is fine. You can keep the change on a customer tab.'
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

            {sale.paymentMethod === 'cash' && (sale.tabApplied ?? 0) > 0 && (
              <p className="text-sm text-slate-300">
                From {saleTabName}:{' '}
                <span className="font-mono font-semibold text-sky-300">
                  {formatMaluti(sale.tabApplied ?? 0)}
                </span>
              </p>
            )}

            {sale.paymentMethod === 'cash' && changeGiven > 0 && (
              <p className="text-sm text-slate-300">
                Change{' '}
                <span className="font-mono font-semibold text-cash-400">
                  {formatMaluti(changeGiven)}
                </span>
              </p>
            )}

            {sale.paymentMethod === 'cash' && (sale.tabChangeKept ?? 0) > 0 && (
              <p className="text-sm text-slate-300">
                Change kept on {saleTabName}:{' '}
                <span className="font-mono font-semibold text-sky-300">
                  {formatMaluti(sale.tabChangeKept ?? 0)}
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

      {tabPickerOpen && (
        <TabPickerSheet
          tabs={tabs}
          balances={balances}
          selectedId={tabId}
          onSelect={(tab) => {
            setTabId(tab.id)
            setTabUse(
              (Math.min(Math.max(0, balances.get(tab.id) ?? 0), total) / 100).toFixed(2),
            )
            setTabPickerOpen(false)
          }}
          onClear={() => {
            setTabId(null)
            setTabUse('')
            setKeepChange(false)
            setTabPickerOpen(false)
          }}
          onClose={() => setTabPickerOpen(false)}
        />
      )}
    </div>
  )
}

function TabPickerSheet({
  tabs,
  balances,
  selectedId,
  onSelect,
  onClear,
  onClose,
}: {
  tabs: CustomerTab[]
  balances: Map<string, Cents>
  selectedId: string | null
  onSelect: (tab: CustomerTab) => void
  onClear: () => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const rows = tabs
    .filter(
      (tab) =>
        !q ||
        tab.name.toLowerCase().includes(q) ||
        (tab.phone ?? '').includes(q),
    )
    .sort((a, b) => (balances.get(b.id) ?? 0) - (balances.get(a.id) ?? 0))

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-black/80 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85dvh] w-full animate-slideUp overflow-y-auto rounded-t-2xl bg-ink-800 p-4 pb-6 sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600 sm:hidden" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Use a customer tab</h2>
            <p className="text-xs text-slate-400">
              Choose a customer whose tab should pay part of this sale.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-ink-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search a name or phone"
          className="field mt-3"
          type="search"
          autoFocus
        />

        {rows.length === 0 ? (
          <p className="mt-3 rounded-xl border border-ink-700 px-4 py-6 text-center text-sm text-slate-500">
            No tabs match. Keep change on a tab at checkout to create one.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {rows.map((tab) => {
              const balance = Math.max(0, balances.get(tab.id) ?? 0)
              const selected = tab.id === selectedId
              return (
                <li key={tab.id}>
                  <button
                    type="button"
                    disabled={balance <= 0}
                    onClick={() => onSelect(tab)}
                    className={`card flex w-full items-center gap-3 !py-3 text-left active:bg-ink-700 disabled:opacity-40 ${
                      selected ? 'border-sky-500/50' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{tab.name}</span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {tab.phone || 'Customer tab'}
                      </span>
                    </span>
                    <span className="font-mono text-sm font-semibold text-sky-300">
                      {formatMaluti(balance)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {selectedId && (
          <button type="button" onClick={onClear} className="btn-ghost mt-3 w-full !py-2.5 text-sm">
            Don't use a tab
          </button>
        )}
      </div>
    </div>
  )
}
