import type { Cents } from '@/domain/money'

/**
 * The chart of accounts shared by the posting engine and every report.
 *
 * Debits are positive and credits are negative. Keeping one chart here means a
 * report can never invent a new account code and quietly drift from the ledger.
 */
export const ACCOUNTS = {
  CASH: 1100,
  INVENTORY: 1200,
  RECEIVABLES: 1300,
  CUSTOMER_CREDITS: 2400,
  LOANS: 2500,
  CAPITAL: 3100,
  CONTRIBUTED: 3110,
  DRAWINGS: 3200,
  SALES: 4100,
  RETURNS: 4200,
  COGS: 5100,
  EXPENSES: 6000,
  BAD_DEBTS: 6100,
  PURCHASE_VARIANCE: 7210,
  STOCK_ADJUST: 7300,
} as const

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS]
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export const ACCOUNT_NAMES: Record<number, string> = {
  [ACCOUNTS.CASH]: 'Cash in drawer',
  [ACCOUNTS.INVENTORY]: 'Stock in the shop',
  [ACCOUNTS.RECEIVABLES]: 'Customers who owe (credit)',
  [ACCOUNTS.CUSTOMER_CREDITS]: 'Customer credits and tabs (cash held for customers)',
  [ACCOUNTS.LOANS]: 'Loans owed',
  [ACCOUNTS.CAPITAL]: 'Owner capital (cash put in)',
  [ACCOUNTS.CONTRIBUTED]: 'Stock brought in',
  [ACCOUNTS.DRAWINGS]: 'Owner drawings',
  [ACCOUNTS.SALES]: 'Sales revenue',
  [ACCOUNTS.RETURNS]: 'Sales returns (voids)',
  [ACCOUNTS.COGS]: 'Cost of goods sold',
  [ACCOUNTS.EXPENSES]: 'Expenses paid',
  [ACCOUNTS.BAD_DEBTS]: 'Bad debts written off',
  [ACCOUNTS.PURCHASE_VARIANCE]: 'Purchase variance',
  [ACCOUNTS.STOCK_ADJUST]: 'Stock adjustments',
}

export const ACCOUNT_TYPES: Record<number, AccountType> = {
  [ACCOUNTS.CASH]: 'asset',
  [ACCOUNTS.INVENTORY]: 'asset',
  [ACCOUNTS.RECEIVABLES]: 'asset',
  [ACCOUNTS.CUSTOMER_CREDITS]: 'liability',
  [ACCOUNTS.LOANS]: 'liability',
  [ACCOUNTS.CAPITAL]: 'equity',
  [ACCOUNTS.CONTRIBUTED]: 'equity',
  [ACCOUNTS.DRAWINGS]: 'equity',
  [ACCOUNTS.SALES]: 'income',
  [ACCOUNTS.RETURNS]: 'expense',
  [ACCOUNTS.COGS]: 'expense',
  [ACCOUNTS.EXPENSES]: 'expense',
  [ACCOUNTS.BAD_DEBTS]: 'expense',
  [ACCOUNTS.PURCHASE_VARIANCE]: 'expense',
  [ACCOUNTS.STOCK_ADJUST]: 'expense',
}

/** One side of a transaction. Positive debits, negative credits. */
export interface JournalPosting {
  account: number
  amount: Cents
}
