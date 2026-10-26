import { db, withSyncMeta } from '@/db'
import type { CashMovement, Sale } from '@/db/types'
import type { Cents } from '@/domain/money'
import { formatMaluti } from '@/domain/money'
import { businessDate } from '@/features/sales/salesService'
import { queueEntity } from '@/sync/outbox'
import { creditBalance, creditPaidMap } from './credit'

/**
 * Taking money against a credit sale and writing off an uncollectible one.
 *
 * Payments are cash movements, so the drawer, the receipts journal and the
 * trial balance all see the same row. A write-off is not a cash movement: it
 * stores the amount and reason on the sale, which the books read as a bad-debt
 * expense. Nothing is deleted, and neither action creates a second sale.
 */

export interface CreditPaymentInput {
  saleId: string
  amount: Cents
  note?: string
  /** Staff member receiving the money. */
  staffName?: string
}

export interface CreditPaymentResult {
  movement: CashMovement
  balance: Cents
}

export async function recordCreditPayment(
  input: CreditPaymentInput,
): Promise<CreditPaymentResult> {
  if (!(input.amount > 0)) throw new Error('Enter an amount greater than zero.')

  return db.transaction(
    'rw',
    [db.sales, db.cashMovements, db.outbox],
    async () => {
      const sale = await db.sales.get(input.saleId)
      if (!sale) throw new Error('That sale no longer exists.')
      if (sale.paymentMethod !== 'credit') throw new Error('That sale was paid in cash.')
      if (sale.status === 'voided') throw new Error('That credit sale was voided.')
      if ((sale.writtenOffAmount ?? 0) > 0) {
        throw new Error('That debt has been written off; it cannot take a payment.')
      }

      const payments = (
        await db.cashMovements.where('refId').equals(sale.id).toArray()
      ).filter((m) => m.reason === 'credit_payment')
      const paid = creditPaidMap(payments)
      const balance = creditBalance(sale, paid)
      if (balance === 0) throw new Error('There is nothing left to pay on that sale.')
      if (input.amount > balance) {
        throw new Error(`Only ${formatMaluti(balance)} is still owed.`)
      }

      const note = input.note?.trim()
      const who = input.staffName?.trim().slice(0, 60)
      const extra = note ? ` · ${note}` : ''
      const movement = withSyncMeta(undefined, {
        reason: 'credit_payment' as const,
        delta: input.amount,
        refId: sale.id,
        businessDate: businessDate(),
        note: `Credit payment · ${sale.customerName || 'Customer'} · #${sale.receiptNo}${extra}`,
        staffName: who || undefined,
      }) as CashMovement
      await db.cashMovements.put(movement)
      await queueEntity('cash_movements', movement.id, 'upsert', movement)

      return { movement, balance: balance - input.amount }
    },
  )
}

export interface WriteOffInput {
  saleId: string
  reason: string
  /** Staff member authorising the write-off. */
  staffName?: string
}

export async function writeOffCreditSale(input: WriteOffInput): Promise<Cents> {
  const reason = input.reason.trim().slice(0, 240)
  if (!reason) throw new Error('Enter a reason for writing off this debt.')

  return db.transaction('rw', [db.sales, db.cashMovements, db.outbox], async () => {
    const sale = await db.sales.get(input.saleId)
    if (!sale) throw new Error('That sale no longer exists.')
    if (sale.paymentMethod !== 'credit') throw new Error('That sale was paid in cash.')
    if (sale.status === 'voided') throw new Error('A voided credit sale has no debt to write off.')
    if ((sale.writtenOffAmount ?? 0) > 0) {
      throw new Error('That debt has already been written off.')
    }

    const payments = (
      await db.cashMovements.where('refId').equals(sale.id).toArray()
    ).filter((m) => m.reason === 'credit_payment')
    const balance = creditBalance(sale, creditPaidMap(payments))
    if (balance === 0) throw new Error('There is nothing left to write off.')

    const updated = withSyncMeta(sale, {
      ...sale,
      writtenOffAt: Date.now(),
      writeOffDate: businessDate(),
      writtenOffAmount: balance,
      writeOffReason: reason,
      writtenOffBy: input.staffName?.trim().slice(0, 60) ?? '',
    }) as Sale
    await db.sales.put(updated)
    await queueEntity('sales', sale.id, 'upsert', updated)
    return balance
  })
}
