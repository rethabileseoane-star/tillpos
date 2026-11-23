import { useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import type { CustomerTab, TabEntry } from '@/db/types'
import { formatMaluti, parseAmount, type Cents } from '@/domain/money'
import { localTime } from '@/domain/time'
import { useAppLock } from '@/features/security/LockContext'
import { saleCashierName } from '@/features/security/staff'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import {
  TAB_KIND_CHIP,
  TAB_KIND_LABEL,
  buildTabRows,
  totalTabBalance,
} from './tabs'
import { createTab, recordTabCredit, recordTabPayout } from './tabService'

export function TabsScreen() {
  const { session } = useAppLock()
  const [search, setSearch] = useState('')
  const [newTabOpen, setNewTabOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [cashSheet, setCashSheet] = useState<{
    tabId: string
    kind: 'credit' | 'payout'
  } | null>(null)

  const tabs = useLiveQuery(() => db.customerTabs.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.tabEntries.orderBy('createdAt').toArray(), []) ?? []

  const rows = useMemo(() => buildTabRows(tabs, entries), [tabs, entries])
  const total = useMemo(() => totalTabBalance(entries), [entries])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (row) =>
        row.tab.name.toLowerCase().includes(q) ||
        (row.tab.phone ?? '').includes(q),
    )
  }, [rows, search])
  const detail = rows.find((row) => row.tab.id === detailId) ?? null
  const cashTab = rows.find((row) => row.tab.id === cashSheet?.tabId)?.tab ?? null

  return (
    <div className="relative min-h-[calc(100dvh-84px)] overflow-hidden">
      {/* Background image — Reference Image 4 */}
      <div
        className="absolute inset-0 z-0 bg-ice-100"
        style={{
          backgroundImage: 'url("/backgrounds/ref-4.jpg")',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
      >
        <div className="absolute inset-0 bg-ice-100/55" />
      </div>

      <div className="relative z-10 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-surface-900">Customer tabs</h1>
            <p className="text-xs leading-relaxed text-surface-600">
              Money the shop owes — change kept, deposits, and what customers spend.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setNewTabOpen(true)}
            className="btn-primary !px-3 !py-2 text-sm"
          >
            New tab
          </button>
        </div>

        <div className="card mt-3 border-cyan-400/40 bg-cyan-400/10">
          <p className="text-[10px] uppercase tracking-wider text-surface-600">
            Shop owes customers
          </p>
          <p className="mt-1 font-mono text-3xl font-bold text-cyan-600">
            {formatMaluti(total)}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-surface-600">
            This is the opposite of customer credit: cash you are holding for
            customers, not money they owe you.
          </p>
        </div>

        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search a name or phone"
          className="field mt-3"
          type="search"
        />

        {filtered.length === 0 ? (
          <div className="card mt-3 text-center !py-8">
            <p className="text-sm font-medium text-surface-900">
              {rows.length === 0 ? 'No customer tabs yet' : 'No matching tabs'}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-surface-500">
              {rows.length === 0
                ? 'Keep change on a tab at checkout, or create one now and add money to it.'
                : 'Try another name or phone number.'}
            </p>
          </div>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {filtered.map((row) => (
              <li key={row.tab.id}>
                <button
                  type="button"
                  onClick={() => setDetailId(row.tab.id)}
                  className="card flex w-full items-center gap-3 !py-3 text-left active:bg-surface-200"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-400/15 font-semibold text-cyan-600">
                    {initials(row.tab.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-surface-900">{row.tab.name}</span>
                    <span className="block truncate text-[11px] text-surface-500">
                      {row.tab.phone || (row.entryCount === 0 ? 'No movements yet' : 'Customer tab')}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-mono text-sm font-semibold text-cyan-600">
                      {formatMaluti(row.balance)}
                    </span>
                    <span className="block text-[10px] text-surface-500">
                      {row.entryCount} {row.entryCount === 1 ? 'movement' : 'movements'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {newTabOpen && (
          <NewTabSheet
            onClose={() => setNewTabOpen(false)}
            onCreated={(tab) => {
              setNewTabOpen(false)
              setDetailId(tab.id)
            }}
          />
        )}

        {detail && (
          <TabDetailSheet
            tab={detail.tab}
            balance={detail.balance}
            entries={entries.filter((entry) => entry.tabId === detail.tab.id)}
            onClose={() => setDetailId(null)}
            onAdd={() => setCashSheet({ tabId: detail.tab.id, kind: 'credit' })}
            onPayOut={() => setCashSheet({ tabId: detail.tab.id, kind: 'payout' })}
          />
        )}

        {cashSheet && cashTab && (
          <TabCashSheet
            tab={cashTab}
            kind={cashSheet.kind}
            balance={totalTabBalance(entries.filter((entry) => entry.tabId === cashTab.id))}
            staffName={saleCashierName(session)}
            onClose={() => setCashSheet(null)}
          />
        )}
      </div>
    </div>
  )
}

function TabDetailSheet({
  tab,
  balance,
  entries,
  onClose,
  onAdd,
  onPayOut,
}: {
  tab: CustomerTab
  balance: Cents
  entries: TabEntry[]
  onClose: () => void
  onAdd: () => void
  onPayOut: () => void
}) {
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-surface-900/40 sm:items-center sm:justify-center sm:p-4">
      <div className="max-h-[92dvh] w-full animate-slideUp overflow-y-auto rounded-t-2xl bg-ice-200 p-4 pb-6 sm:max-w-md sm:rounded-2xl shadow-lift">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-surface-300 sm:hidden" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-surface-900">{tab.name}</h2>
            <p className="truncate text-xs text-surface-600">
              {tab.phone || 'Customer tab'}
              {tab.note ? ` · ${tab.note}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-surface-600 hover:bg-surface-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mt-3 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-surface-600">
            Shop owes
          </p>
          <p className="font-mono text-3xl font-bold text-cyan-600">
            {formatMaluti(balance)}
          </p>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={onAdd} className="btn-primary !py-2.5 text-sm">
            Add money
          </button>
          <button type="button" onClick={onPayOut} className="btn-ghost !py-2.5 text-sm">
            Pay out
          </button>
        </div>

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-surface-600">
          Movements
        </h3>
        {sorted.length === 0 ? (
          <p className="mt-2 rounded-xl border border-surface-300 px-4 py-5 text-center text-sm text-surface-500">
            No movements yet. Add money, or use this tab at checkout.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {sorted.map((entry) => (
              <li key={entry.id} className="card !py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${TAB_KIND_CHIP[entry.kind]}`}
                    >
                      {TAB_KIND_LABEL[entry.kind]}
                    </span>
                    <p className="mt-1 truncate text-[11px] text-surface-600">
                      {entry.businessDate} {localTime(entry.createdAt)}
                      {entry.staffName ? ` · ${entry.staffName}` : ''}
                    </p>
                    {entry.note && (
                      <p className="truncate text-[11px] text-surface-500">{entry.note}</p>
                    )}
                  </div>
                  <span
                    className={`shrink-0 font-mono text-sm font-semibold ${
                      entry.amount >= 0 ? 'text-cyan-600' : 'text-surface-700'
                    }`}
                  >
                    {entry.amount >= 0 ? '+' : ''}
                    {formatMaluti(entry.amount)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function NewTabSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (tab: CustomerTab) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const tab = await createTab({ name, phone, note })
      feedbackSuccess()
      onCreated(tab)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the tab.')
      feedbackError()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SheetShell title="New customer tab" onClose={onClose}>
      <p className="mt-1 text-sm leading-relaxed text-surface-600">
        A tab records money the shop is holding for a customer. You can add the
        opening amount next.
      </p>
      <label className="mt-4 block text-xs font-medium text-surface-600" htmlFor="tab-name">
        Customer name
      </label>
      <input
        id="tab-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="e.g. Mama Chikondi"
        className="field mt-1"
        autoFocus
      />
      <label className="mt-3 block text-xs font-medium text-surface-600" htmlFor="tab-phone">
        Phone (optional)
      </label>
      <input
        id="tab-phone"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        placeholder="088 000 0000"
        className="field mt-1"
        inputMode="tel"
      />
      <label className="mt-3 block text-xs font-medium text-surface-600" htmlFor="tab-note">
        Note (optional)
      </label>
      <input
        id="tab-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Anything the next cashier should know"
        className="field mt-1"
      />
      {error && <p className="mt-3 text-sm text-surface-700">{error}</p>}
      <div
        className="sticky bottom-0 z-10 -mx-4 -mb-6 mt-4 border-t border-white/60 bg-ice-200/95 px-4 pt-3 backdrop-blur"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        {!name.trim() && !busy && (
          <p className="mb-2 text-center text-[11px] text-surface-600">
            Enter a customer name to create the tab.
          </p>
        )}
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
          className="btn-primary w-full"
        >
          {busy ? 'Creating…' : 'Create tab'}
        </button>
      </div>
    </SheetShell>
  )
}

function TabCashSheet({
  tab,
  kind,
  balance,
  staffName,
  onClose,
}: {
  tab: CustomerTab
  kind: 'credit' | 'payout'
  balance: Cents
  staffName: string
  onClose: () => void
}) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cents = parseAmount(amount)
  const isPayout = kind === 'payout'
  const tooMuch = isPayout && cents !== null && cents > balance

  const save = async () => {
    if (cents === null || cents <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    if (tooMuch) {
      setError(`Only ${formatMaluti(balance)} is on this tab.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (isPayout) {
        await recordTabPayout({ tabId: tab.id, amount: cents, note, staffName })
      } else {
        await recordTabCredit({ tabId: tab.id, amount: cents, note, staffName })
      }
      feedbackSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the movement.')
      feedbackError()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SheetShell
      title={isPayout ? `Pay out · ${tab.name}` : `Add money · ${tab.name}`}
      onClose={onClose}
    >
      <p className="mt-1 text-sm leading-relaxed text-surface-600">
        {isPayout
          ? 'Cash leaves the drawer and the tab balance goes down.'
          : 'Cash comes into the drawer and the shop owes it on the tab.'}
      </p>
      <p className="mt-2 font-mono text-xs text-surface-600">
        Current balance: <span className="text-cyan-600">{formatMaluti(balance)}</span>
      </p>
      <label className="mt-4 block text-xs font-medium text-surface-600" htmlFor="tab-amount">
        Amount
      </label>
      <input
        id="tab-amount"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        placeholder="0"
        className="field mt-1 font-mono text-lg"
        inputMode="decimal"
        autoFocus
      />
      {isPayout && (
        <button
          type="button"
          onClick={() => setAmount((balance / 100).toFixed(2))}
          className="mt-2 text-xs text-cyan-600 underline underline-offset-2"
        >
          Pay out the whole balance ({formatMaluti(balance)})
        </button>
      )}
      <label className="mt-3 block text-xs font-medium text-surface-600" htmlFor="tab-cash-note">
        Note (optional)
      </label>
      <input
        id="tab-cash-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={isPayout ? 'Why the customer is taking cash' : 'Where the money came from'}
        className="field mt-1"
      />
      {error && <p className="mt-3 text-sm text-surface-700">{error}</p>}
      <div
        className="sticky bottom-0 z-10 -mx-4 -mb-6 mt-4 border-t border-white/60 bg-ice-200/95 px-4 pt-3 backdrop-blur"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        {(cents === null || cents <= 0) && !busy && (
          <p className="mb-2 text-center text-[11px] text-surface-600">
            Enter an amount greater than zero.
          </p>
        )}
        {tooMuch && (
          <p className="mb-2 text-center text-[11px] text-surface-600">
            Only {formatMaluti(balance)} is on this tab.
          </p>
        )}
        <button
          type="button"
          disabled={busy || cents === null || cents <= 0 || tooMuch}
          onClick={() => void save()}
          className="btn-primary w-full"
        >
          {busy ? 'Saving…' : isPayout ? 'Pay out' : 'Add money'}
        </button>
      </div>
    </SheetShell>
  )
}

function SheetShell({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-surface-900/40 sm:items-center sm:justify-center sm:p-4">
      <div className="max-h-[92dvh] w-full animate-slideUp overflow-y-auto rounded-t-2xl bg-ice-200 p-4 pb-6 sm:max-w-md sm:rounded-2xl shadow-lift">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-surface-300 sm:hidden" />
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 truncate text-lg font-semibold text-surface-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-surface-600 hover:bg-surface-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] ?? ''}${parts.at(-1)![0] ?? ''}`.toUpperCase()
}
