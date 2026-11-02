import { db, withSyncMeta } from '@/db'
import type { CashMovement, CustomerTab, TabEntry } from '@/db/types'
import type { Cents } from '@/domain/money'
import { formatMaluti } from '@/domain/money'
import { businessDate } from '@/features/sales/salesService'
import { queueEntity } from '@/sync/outbox'
import {
  cleanTabName,
  cleanTabNote,
  cleanTabPhone,
  tabBalance,
} from './tabs'

/**
 * Creating and moving customer tabs.
 *
 * Every entry is append-only. A credit or payout also writes a cash movement in
 * the same transaction, so the drawer and the tab can never disagree. Spending
 * a tab at the till is handled by `commitSale`, where it belongs with the sale
 * it pays for.
 */

export interface CreateTabInput {
  name: string
  phone?: string
  note?: string
}

export async function createTab(input: CreateTabInput): Promise<CustomerTab> {
  const name = cleanTabName(input.name)
  if (!name) throw new Error('Enter a customer name for the tab.')

  return db.transaction('rw', [db.customerTabs, db.outbox], async () => {
    const tab = withSyncMeta(undefined, {
      name,
      phone: cleanTabPhone(input.phone ?? '') || undefined,
      note: cleanTabNote(input.note ?? '') || undefined,
    }) as CustomerTab
    await db.customerTabs.put(tab)
    await queueEntity('customer_tabs', tab.id, 'upsert', tab)
    return tab
  })
}

async function requireTab(tabId: string): Promise<CustomerTab> {
  const tab = await db.customerTabs.get(tabId)
  if (!tab || tab.deletedAt != null) throw new Error('That tab no longer exists.')
  return tab
}

export interface TabCashInput {
  tabId: string
  amount: Cents
  note?: string
  staffName?: string
}

/**
 * Customer hands cash to the shop to hold on their tab. This is how change the
 * till cannot break becomes a running balance, and how a customer can top up a
 * tab without buying anything.
 */
export async function recordTabCredit(input: TabCashInput): Promise<TabEntry> {
  if (!(input.amount > 0)) throw new Error('Enter an amount greater than zero.')

  return db.transaction(
    'rw',
    [db.customerTabs, db.tabEntries, db.cashMovements, db.outbox],
    async () => {
      const tab = await requireTab(input.tabId)
      const date = businessDate()
      const note = input.note?.trim().slice(0, 240) || 'Cash held on tab'
      const staffName = input.staffName?.trim().slice(0, 60) || undefined

      const entry = withSyncMeta(undefined, {
        tabId: tab.id,
        kind: 'credit' as const,
        amount: input.amount,
        saleId: null,
        cashMovementId: null,
        businessDate: date,
        note,
        staffName,
      }) as TabEntry

      const cash = withSyncMeta(undefined, {
        reason: 'tab_credit' as const,
        delta: input.amount,
        refId: entry.id,
        businessDate: date,
        note: `Tab credit · ${tab.name}${note ? ` · ${note}` : ''}`,
        staffName,
      }) as CashMovement

      await db.cashMovements.put(cash)
      await queueEntity('cash_movements', cash.id, 'upsert', cash)

      const linked = withSyncMeta(entry, {
        ...entry,
        cashMovementId: cash.id,
      }) as TabEntry
      await db.tabEntries.put(linked)
      await queueEntity('tab_entries', linked.id, 'upsert', linked)
      return linked
    },
  )
}

/**
 * The shop gives cash back from a tab. Refuses to pay out more than the tab
 * holds, so a tab can never silently become a debt in the other direction.
 */
export async function recordTabPayout(input: TabCashInput): Promise<TabEntry> {
  if (!(input.amount > 0)) throw new Error('Enter an amount greater than zero.')

  return db.transaction(
    'rw',
    [db.customerTabs, db.tabEntries, db.cashMovements, db.outbox],
    async () => {
      const tab = await requireTab(input.tabId)
      const entries = await db.tabEntries.where('tabId').equals(tab.id).toArray()
      const balance = tabBalance(entries, tab.id)
      if (input.amount > balance) {
        throw new Error(`Only ${formatMaluti(Math.max(0, balance))} is on that tab.`)
      }

      const date = businessDate()
      const note = input.note?.trim().slice(0, 240) || 'Paid out from tab'
      const staffName = input.staffName?.trim().slice(0, 60) || undefined

      const entry = withSyncMeta(undefined, {
        tabId: tab.id,
        kind: 'payout' as const,
        amount: -Math.abs(input.amount),
        saleId: null,
        cashMovementId: null,
        businessDate: date,
        note,
        staffName,
      }) as TabEntry

      const cash = withSyncMeta(undefined, {
        reason: 'tab_payout' as const,
        delta: -Math.abs(input.amount),
        refId: entry.id,
        businessDate: date,
        note: `Tab payout · ${tab.name}${note ? ` · ${note}` : ''}`,
        staffName,
      }) as CashMovement

      await db.cashMovements.put(cash)
      await queueEntity('cash_movements', cash.id, 'upsert', cash)

      const linked = withSyncMeta(entry, {
        ...entry,
        cashMovementId: cash.id,
      }) as TabEntry
      await db.tabEntries.put(linked)
      await queueEntity('tab_entries', linked.id, 'upsert', linked)
      return linked
    },
  )
}

/** Current balance for one tab. */
export async function getTabBalance(tabId: string): Promise<Cents> {
  const entries = await db.tabEntries.where('tabId').equals(tabId).toArray()
  return tabBalance(entries, tabId)
}
