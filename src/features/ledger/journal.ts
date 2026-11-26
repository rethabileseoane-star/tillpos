import type { Cents } from '@/domain/money'
import { localDate } from '@/domain/time'
import type {
  CashMovement,
  Product,
  Sale,
  SaleLine,
  StockMovement,
  TabEntry,
} from '@/db/types'
import { effectiveWriteOffAmount, writeOffDate } from '@/features/credit/credit'
import { ACCOUNTS } from './chart'
import type { JournalPosting } from './chart'

/**
 * The posting engine.
 *
 * Every till event becomes one or more balanced journal entries: debits equal
 * credits inside the entry. Reports read the resulting postings instead of each
 * rebuilding their own account maths, so the trial balance, P&L and balance
 * sheet cannot disagree.
 *
 * The builder is deliberately pure. It takes rows and returns entries plus
 * structural warnings; `validateJournal()` adds the balance check. This keeps
 * the accounting rules testable without a browser or IndexedDB.
 */

export type JournalEntryKind =
  | 'sale'
  | 'void'
  | 'writeoff'
  | 'overpayment'
  | 'credit'
  | 'cash'
  | 'tab'
  | 'cogs'
  | 'stock'
  | 'purchase'

export interface JournalEntry {
  /** Stable id so a future UI can point at the exact source row. */
  id: string
  kind: JournalEntryKind
  /** Business date used by windowed reports. */
  date: string
  /** Source timestamp, mainly for ordering and stock-adjustment windows. */
  createdAt: number
  sourceId: string
  postings: JournalPosting[]
  meta?: Record<string, string | number | null>
}

export type JournalErrorCode =
  | 'orphan-sale-cash'
  | 'orphan-tab-cash'
  | 'missing-sale-for-tab'
  | 'tab-entry-without-cash'
  | 'purchase-stock-without-payment'
  | 'unbalanced-entry'

export interface JournalError {
  code: JournalErrorCode
  message: string
  entryId?: string
  sourceId?: string
}

export interface Journal {
  entries: JournalEntry[]
  /** Structural problems found while building. Balance errors come from `validateJournal`. */
  errors: JournalError[]
}

export interface JournalInput {
  sales: readonly Sale[]
  lines: readonly SaleLine[]
  cash: readonly CashMovement[]
  products: readonly Product[]
  stockMoves: readonly StockMovement[]
  tabEntries?: readonly TabEntry[]
}

const post = (account: number, amount: Cents): JournalPosting => ({ account, amount })

function costOf(products: Map<string, Product>, id: string, fallback: Cents): Cents {
  const product = products.get(id)
  return product ? (product.cost ?? product.price) : fallback
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function sum(values: Iterable<number>): number {
  let total = 0
  for (const value of values) total += value
  return total
}

function sumDelta(movements: readonly CashMovement[]): Cents {
  return sum(movements.map((movement) => movement.delta))
}

function sumTabAmounts(entries: readonly TabEntry[]): Cents {
  return sum(entries.map((entry) => entry.amount))
}

function latestBusinessDate(
  movements: readonly CashMovement[],
  fallback: string,
): string {
  let latest = fallback
  for (const movement of movements) {
    if (movement.businessDate > latest) latest = movement.businessDate
  }
  return latest
}

function latestTimestamp(
  movements: readonly CashMovement[],
  fallback: number,
): number {
  let latest = fallback
  for (const movement of movements) {
    if (movement.createdAt > latest) latest = movement.createdAt
  }
  return latest
}

function entry(
  id: string,
  kind: JournalEntryKind,
  date: string,
  createdAt: number,
  sourceId: string,
  postings: JournalPosting[],
  meta?: JournalEntry['meta'],
): JournalEntry {
  return { id, kind, date, createdAt, sourceId, postings, meta }
}

export function buildJournal(input: JournalInput): Journal {
  const { sales, lines, cash, products, stockMoves } = input
  const tabEntries = input.tabEntries ?? []
  const entries: JournalEntry[] = []
  const errors: JournalError[] = []

  const saleById = new Map(sales.map((sale) => [sale.id, sale]))
  const productById = new Map(products.map((product) => [product.id, product]))
  const cashById = new Map(cash.map((movement) => [movement.id, movement]))

  const cashBySale = new Map<string, CashMovement[]>()
  const creditPaymentsBySale = new Map<string, CashMovement[]>()
  const tabsBySale = new Map<string, TabEntry[]>()

  for (const movement of cash) {
    if (!movement.refId) continue
    if (
      (movement.reason === 'sale' ||
        movement.reason === 'void' ||
        movement.reason === 'tab_credit') &&
      saleById.has(movement.refId)
    ) {
      pushTo(cashBySale, movement.refId, movement)
    }
    if (movement.reason === 'credit_payment' && saleById.has(movement.refId)) {
      pushTo(creditPaymentsBySale, movement.refId, movement)
    }
  }

  for (const tabEntry of tabEntries) {
    if (tabEntry.saleId && saleById.has(tabEntry.saleId)) {
      pushTo(tabsBySale, tabEntry.saleId, tabEntry)
    }
  }

  const usedCash = new Set<string>()
  const usedTabs = new Set<string>()
  const usedStock = new Set<string>()

  // A sale bills its full total. A cash sale also moves the drawer and the
  // customer-tab legs; a credit sale raises a receivable. The original and the
  // void are separate entries so each can sit on its own business date.
  for (const sale of sales) {
    const saleCash = cashBySale.get(sale.id) ?? []
    const originalCash = saleCash.filter(
      (movement) => movement.reason === 'sale' || movement.reason === 'tab_credit',
    )
    const voidCash = saleCash.filter((movement) => movement.reason === 'void')
    const saleTabs = tabsBySale.get(sale.id) ?? []
    const originalTabs = saleTabs.filter(
      (tabEntry) => tabEntry.kind === 'sale' || tabEntry.kind === 'credit',
    )
    const voidTabs = saleTabs.filter((tabEntry) => tabEntry.kind === 'void')

    for (const movement of originalCash) usedCash.add(movement.id)
    for (const tabEntry of originalTabs) usedTabs.add(tabEntry.id)

    const original: JournalPosting[] = [post(ACCOUNTS.SALES, -sale.total)]
    if (sale.paymentMethod === 'credit') {
      original.push(post(ACCOUNTS.RECEIVABLES, sale.total))
    } else {
      const cashIn = sumDelta(originalCash)
      const tabNet = sumTabAmounts(originalTabs)
      if (cashIn !== 0) original.push(post(ACCOUNTS.CASH, cashIn))
      if (tabNet !== 0) original.push(post(ACCOUNTS.CUSTOMER_CREDITS, -tabNet))
    }
    entries.push(
      entry(`sale:${sale.id}`, 'sale', sale.businessDate, sale.createdAt, sale.id, original, {
        receiptNo: sale.receiptNo,
        paymentMethod: sale.paymentMethod,
      }),
    )

    const received = sumDelta(creditPaymentsBySale.get(sale.id) ?? [])

    if (sale.status === 'voided') {
      for (const movement of voidCash) usedCash.add(movement.id)
      for (const tabEntry of voidTabs) usedTabs.add(tabEntry.id)

      const reversal: JournalPosting[] = [post(ACCOUNTS.RETURNS, sale.total)]
      if (sale.paymentMethod === 'credit') {
        const refunded = -sumDelta(voidCash)
        const held = received - refunded
        reversal.push(post(ACCOUNTS.RECEIVABLES, -(sale.total - received)))
        if (voidCash.length > 0) reversal.push(post(ACCOUNTS.CASH, -refunded))
        // A payment that arrived after the refund was already recorded is cash
        // the shop is holding for the customer, not a negative receivable.
        if (held !== 0) reversal.push(post(ACCOUNTS.CUSTOMER_CREDITS, -held))
      } else {
        const cashOut = sumDelta(voidCash)
        const tabNet = sumTabAmounts(voidTabs)
        if (cashOut !== 0) reversal.push(post(ACCOUNTS.CASH, cashOut))
        if (tabNet !== 0) reversal.push(post(ACCOUNTS.CUSTOMER_CREDITS, -tabNet))
      }

      entries.push(
        entry(
          `sale-void:${sale.id}`,
          'void',
          sale.businessDate,
          sale.voidedAt ?? sale.updatedAt,
          sale.id,
          reversal,
          { receiptNo: sale.receiptNo },
        ),
      )
    }

    const written = effectiveWriteOffAmount(sale, received)
    if (written > 0) {
      const date = writeOffDate(sale) ?? sale.businessDate
      entries.push(
        entry(
          `sale-writeoff:${sale.id}`,
          'writeoff',
          date,
          sale.writtenOffAt ?? sale.updatedAt,
          sale.id,
          [post(ACCOUNTS.BAD_DEBTS, written), post(ACCOUNTS.RECEIVABLES, -written)],
          { receiptNo: sale.receiptNo },
        ),
      )
    }

    if (sale.paymentMethod === 'credit' && sale.status === 'completed') {
      const overpaid = Math.max(0, received - sale.total)
      if (overpaid > 0) {
        const payments = creditPaymentsBySale.get(sale.id) ?? []
        entries.push(
          entry(
            `sale-overpayment:${sale.id}`,
            'overpayment',
            latestBusinessDate(payments, sale.businessDate),
            latestTimestamp(payments, sale.createdAt),
            sale.id,
            [
              post(ACCOUNTS.RECEIVABLES, overpaid),
              post(ACCOUNTS.CUSTOMER_CREDITS, -overpaid),
            ],
            { receiptNo: sale.receiptNo },
          ),
        )
      }
    }
  }

  // Tab deposits and payouts that did not come from a sale: cash and the
  // customer liability move together. Sale-linked tab entries were consumed by
  // the sale entry above.
  for (const tabEntry of tabEntries) {
    if (usedTabs.has(tabEntry.id)) continue

    const linkedCash = tabEntry.cashMovementId
      ? cashById.get(tabEntry.cashMovementId)
      : undefined
    const postings: JournalPosting[] = [
      post(ACCOUNTS.CUSTOMER_CREDITS, -tabEntry.amount),
    ]

    if (
      linkedCash &&
      (linkedCash.reason === 'tab_credit' || linkedCash.reason === 'tab_payout')
    ) {
      postings.push(post(ACCOUNTS.CASH, linkedCash.delta))
      usedCash.add(linkedCash.id)
    } else {
      const code = tabEntry.saleId && !saleById.has(tabEntry.saleId)
        ? 'missing-sale-for-tab'
        : 'tab-entry-without-cash'
      errors.push({
        code,
        message:
          code === 'missing-sale-for-tab'
            ? `Tab entry ${tabEntry.id} points at sale ${tabEntry.saleId}, which is not on this device.`
            : `Tab entry ${tabEntry.id} has no cash movement behind it.`,
        entryId: `tab:${tabEntry.id}`,
        sourceId: tabEntry.id,
      })
    }

    entries.push(
      entry(
        `tab:${tabEntry.id}`,
        'tab',
        tabEntry.businessDate,
        tabEntry.createdAt,
        tabEntry.id,
        postings,
        { tabId: tabEntry.tabId, kind: tabEntry.kind },
      ),
    )
  }

  // Everything else that touched the drawer.
  for (const movement of cash) {
    if (usedCash.has(movement.id)) continue

    const postings: JournalPosting[] = []
    let kind: JournalEntryKind = 'cash'

    switch (movement.reason) {
      case 'credit_payment': {
        postings.push(post(ACCOUNTS.CASH, movement.delta))
        const sale = movement.refId ? saleById.get(movement.refId) : undefined
        if (sale && sale.paymentMethod === 'credit') {
          postings.push(post(ACCOUNTS.RECEIVABLES, -movement.delta))
        } else {
          // Money held for a customer without a matching credit sale.
          postings.push(post(ACCOUNTS.CUSTOMER_CREDITS, -movement.delta))
        }
        kind = 'credit'
        break
      }
      case 'float':
        postings.push(
          post(ACCOUNTS.CASH, movement.delta),
          post(ACCOUNTS.CAPITAL, -movement.delta),
        )
        break
      case 'cash_in':
        postings.push(
          post(ACCOUNTS.CASH, movement.delta),
          post(
            movement.kind === 'loan' ? ACCOUNTS.LOANS : ACCOUNTS.CAPITAL,
            -movement.delta,
          ),
        )
        break
      case 'purchase': {
        const purchaseMoves = stockMoves.filter(
          (stockMove) =>
            stockMove.reason === 'purchase' && stockMove.refId === movement.id,
        )
        for (const stockMove of purchaseMoves) usedStock.add(stockMove.id)
        const booked = sum(
          purchaseMoves.map(
            (stockMove) =>
              stockMove.delta * costOf(productById, stockMove.productId, 0),
          ),
        )
        const paid = Math.abs(movement.delta)
        postings.push(
          post(ACCOUNTS.CASH, movement.delta),
          post(ACCOUNTS.INVENTORY, booked),
          post(ACCOUNTS.PURCHASE_VARIANCE, paid - booked),
        )
        kind = 'purchase'
        break
      }
      case 'drawing':
        postings.push(
          post(ACCOUNTS.CASH, movement.delta),
          post(ACCOUNTS.DRAWINGS, -movement.delta),
        )
        break
      case 'expense':
        postings.push(
          post(ACCOUNTS.CASH, movement.delta),
          post(ACCOUNTS.EXPENSES, -movement.delta),
        )
        break
      case 'loan_repay':
        postings.push(
          post(ACCOUNTS.CASH, movement.delta),
          post(ACCOUNTS.LOANS, -movement.delta),
        )
        break
      case 'sale':
      case 'void':
        postings.push(post(ACCOUNTS.CASH, movement.delta))
        errors.push({
          code: 'orphan-sale-cash',
          message: `Cash movement ${movement.id} points at a sale that is not on this device.`,
          entryId: `cash:${movement.id}`,
          sourceId: movement.id,
        })
        break
      case 'tab_credit':
      case 'tab_payout':
        postings.push(post(ACCOUNTS.CASH, movement.delta))
        errors.push({
          code: 'orphan-tab-cash',
          message: `Cash movement ${movement.id} has no tab entry behind it.`,
          entryId: `cash:${movement.id}`,
          sourceId: movement.id,
        })
        break
    }

    entries.push(
      entry(
        `cash:${movement.id}`,
        kind,
        movement.businessDate,
        movement.createdAt,
        movement.id,
        postings,
        { reason: movement.reason },
      ),
    )
  }

  // Completed sale lines consume stock at the recorded cost. Sale/void stock
  // movements mirror these lines, so they do not post a second time.
  for (const line of lines) {
    const sale = saleById.get(line.saleId)
    if (!sale || sale.status !== 'completed') continue
    const cost = costOf(productById, line.productId, line.unitPrice)
    const amount = line.qty * cost
    entries.push(
      entry(
        `cogs:${line.id}`,
        'cogs',
        sale.businessDate,
        sale.createdAt,
        line.id,
        [post(ACCOUNTS.COGS, amount), post(ACCOUNTS.INVENTORY, -amount)],
        { saleId: line.saleId, productId: line.productId },
      ),
    )
  }

  for (const stockMove of stockMoves) {
    if (usedStock.has(stockMove.id)) continue

    if (stockMove.reason === 'purchase') {
      errors.push({
        code: 'purchase-stock-without-payment',
        message: `Purchase stock movement ${stockMove.id} has no cash payment on this device.`,
        sourceId: stockMove.id,
      })
      continue
    }

    // Sale/void stock movements explain quantity; value was posted through the
    // completed sale lines above.
    if (stockMove.reason === 'sale' || stockMove.reason === 'void') continue

    const value = stockMove.delta * costOf(productById, stockMove.productId, 0)
    const postings =
      stockMove.reason === 'adjust'
        ? [post(ACCOUNTS.INVENTORY, value), post(ACCOUNTS.STOCK_ADJUST, -value)]
        : [post(ACCOUNTS.INVENTORY, value), post(ACCOUNTS.CONTRIBUTED, -value)]

    entries.push(
      entry(
        `stock:${stockMove.id}`,
        'stock',
        localDate(stockMove.createdAt),
        stockMove.createdAt,
        stockMove.id,
        postings,
        { reason: stockMove.reason, productId: stockMove.productId },
      ),
    )
  }

  entries.sort(
    (a, z) =>
      a.date.localeCompare(z.date) ||
      a.createdAt - z.createdAt ||
      a.id.localeCompare(z.id),
  )

  return { entries, errors }
}

/** Signed balances for every account touched by the journal. */
export function journalBalances(
  entries: readonly JournalEntry[],
): Map<number, Cents> {
  const balances = new Map<number, Cents>()
  for (const journalEntry of entries) {
    for (const posting of journalEntry.postings) {
      balances.set(
        posting.account,
        (balances.get(posting.account) ?? 0) + posting.amount,
      )
    }
  }
  return balances
}

/** Sum of every posting; zero means the whole journal ties. */
export function journalDifference(entries: readonly JournalEntry[]): Cents {
  let difference = 0
  for (const journalEntry of entries) {
    for (const posting of journalEntry.postings) difference += posting.amount
  }
  return difference
}

/**
 * Check every entry individually. Beancount-style validation happens before a
 * report is built, so an unbalanced event is reported instead of being hidden
 * in a difference line.
 */
export function validateJournal(journal: Journal): JournalError[] {
  const errors = [...journal.errors]
  for (const journalEntry of journal.entries) {
    const total = journalEntry.postings.reduce(
      (accumulator, posting) => accumulator + posting.amount,
      0,
    )
    if (total !== 0) {
      errors.push({
        code: 'unbalanced-entry',
        message: `Journal entry ${journalEntry.id} is out by ${total} tambala.`,
        entryId: journalEntry.id,
        sourceId: journalEntry.sourceId,
      })
    }
  }
  return errors
}

/** Build and validate in one call, for reports that want a health check. */
export function validateLedger(input: JournalInput): JournalError[] {
  return validateJournal(buildJournal(input))
}
