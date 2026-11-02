import type { CustomerTab, TabEntry, TabEntryKind } from '@/db/types'
import type { Cents } from '@/domain/money'

/**
 * Customer-tab arithmetic.
 *
 * A tab is money the shop owes the customer. That is the opposite direction
 * from the credit book, where the customer owes the shop. Keeping the sign
 * convention in one pure module means the tab screen, checkout, balance sheet
 * and reports cannot disagree about a balance.
 */

export const TAB_KIND_LABEL: Record<TabEntryKind, string> = {
  credit: 'Credit added',
  sale: 'Used at till',
  payout: 'Cash paid out',
  void: 'Sale voided',
}

export const TAB_KIND_CHIP: Record<TabEntryKind, string> = {
  credit: 'bg-cash-500/15 text-cash-400',
  sale: 'bg-sky-500/15 text-sky-300',
  payout: 'bg-amber-500/15 text-amber-300',
  void: 'bg-rose-500/15 text-rose-300',
}

export interface TabRow {
  tab: CustomerTab
  balance: Cents
  lastActivity: number | null
  entryCount: number
}

/** Signed balance for every tab, from the append-only entries. */
export function tabBalanceMap(entries: readonly TabEntry[]): Map<string, Cents> {
  const map = new Map<string, Cents>()
  for (const entry of entries) {
    map.set(entry.tabId, (map.get(entry.tabId) ?? 0) + entry.amount)
  }
  return map
}

export function tabBalance(entries: readonly TabEntry[], tabId: string): Cents {
  return entries
    .filter((entry) => entry.tabId === tabId)
    .reduce((sum, entry) => sum + entry.amount, 0)
}

/** Everything the shop owes customers on tabs right now. */
export function totalTabBalance(entries: readonly TabEntry[]): Cents {
  return entries.reduce((sum, entry) => sum + entry.amount, 0)
}

/** Tabs with their current balance, newest activity first. */
export function buildTabRows(
  tabs: readonly CustomerTab[],
  entries: readonly TabEntry[],
): TabRow[] {
  const balances = tabBalanceMap(entries)
  const meta = new Map<string, { lastActivity: number | null; entryCount: number }>()
  for (const entry of entries) {
    const current = meta.get(entry.tabId) ?? { lastActivity: null, entryCount: 0 }
    meta.set(entry.tabId, {
      lastActivity:
        current.lastActivity === null
          ? entry.createdAt
          : Math.max(current.lastActivity, entry.createdAt),
      entryCount: current.entryCount + 1,
    })
  }

  return tabs
    .filter((tab) => tab.deletedAt == null)
    .map((tab) => {
      const info = meta.get(tab.id)
      return {
        tab,
        balance: balances.get(tab.id) ?? 0,
        lastActivity: info?.lastActivity ?? null,
        entryCount: info?.entryCount ?? 0,
      }
    })
    .sort((a, b) => {
      if (a.balance !== b.balance) return b.balance - a.balance
      return a.tab.name.localeCompare(b.tab.name)
    })
}

/** Tab names are typed quickly at the till; collapse whitespace and cap length. */
export function cleanTabName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 60)
}

export function cleanTabPhone(phone: string): string {
  return phone.trim().slice(0, 40)
}

export function cleanTabNote(note: string): string {
  return note.trim().replace(/\s+/g, ' ').slice(0, 240)
}

/** A tab with a non-zero balance is the only kind checkout can spend from. */
export function spendableTabBalance(entries: readonly TabEntry[], tabId: string): Cents {
  return Math.max(0, tabBalance(entries, tabId))
}
