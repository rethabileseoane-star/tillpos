/**
 * Logic smoke tests.
 *
 * Covers the parts that must be right for the till to balance: money rounding,
 * barcode normalisation, and cart merging. These are pure functions, so they run
 * without a browser or IndexedDB.
 *
 * Run with: npx esbuild tools/smoke.ts --bundle --platform=node --format=esm --outfile=tools/.smoke.mjs && node tools/.smoke.mjs
 */
import assert from 'node:assert/strict'
import {
  formatMaluti,
  fromMaluti,
  parseAmount,
  suggestTender,
  toMaluti,
} from '../src/domain/money'
import {
  barcodeVariants,
  ean13CheckDigit,
  isValidBarcode,
  isValidEan13,
  normalizeBarcode,
} from '../src/domain/barcode'
import {
  addAdHoc,
  cartSubtotal,
  linesExceedingStock,
  mergeProduct,
  removeLine,
  setQty,
} from '../src/features/cart/cartStore'
import type {
  CashMovement,
  CashReason,
  Product,
  Sale,
  SaleLine,
  StockMovement,
  StockReason,
} from '../src/db/types'
import { ACCOUNTS, balanceSheet, cashFlow, incomeStatement, trialBalances } from '../src/features/reports/accounts'
import { remoteWins, stripServerFields, withShopId, SYNC_ENTITIES } from '../src/sync/merge'
import {
  cleanShopCode,
  dbNameForShop,
  validateShopCode,
} from '../src/shops/registry'
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  attemptKey,
  clearAttempts,
  cooldownRemaining,
  createCredential,
  FREE_ATTEMPTS,
  readAttempts,
  recordFailure,
  validateSecret,
  verifySecret,
} from '../src/features/security/secret'

let passed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}`)
    console.error(`      ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}`)
    console.error(`      ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
}

const product = (over: Partial<Product> = {}) =>
  ({
    id: 'p1',
    barcode: '6001234567892',
    name: 'Sugar 1kg',
    price: fromMaluti(1500),
    cost: fromMaluti(1200),
    stockQty: 10,
    lowStockThreshold: 2,
    category: 'Grocery',
    active: true,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    rev: 1,
    deviceId: 'd',
    ...over,
  }) as Product

/** Minimal localStorage stand-in for the lockout tests. */
function fakeStore() {
  const mem = new Map<string, string>()
  return {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
    removeItem: (key: string) => void mem.delete(key),
  }
}

console.log('money')
check('M100 formats without trailing decimals', () => {
  assert.equal(formatMaluti(fromMaluti(100)), 'M100')
})
check('grouping is applied', () => {
  assert.equal(formatMaluti(fromMaluti(18500)), 'M18,500')
})
check('fractional prices keep two decimals', () => {
  assert.equal(formatMaluti(50), 'M0.50')
})
check('negative totals are prefixed', () => {
  assert.equal(formatMaluti(-fromMaluti(5)), '-M5')
})
check('parses plain and comma-separated input', () => {
  assert.equal(parseAmount('1500'), fromMaluti(1500))
  assert.equal(parseAmount('1,500.50'), 150050)
  assert.equal(parseAmount('M1500'), fromMaluti(1500))
})
check('rejects unusable amounts instead of recording zero', () => {
  assert.equal(parseAmount(''), null)
  assert.equal(parseAmount('abc'), null)
  assert.equal(parseAmount('-5'), null)
})
check('round-trips', () => {
  assert.equal(toMaluti(fromMaluti(1234.56)), 1234.56)
})

console.log('tender suggestions')
check('a half-maluti item suggests M1, M2, M5 — not M100', () => {
  assert.deepEqual(suggestTender(50), [50, 100, 200, 500, 1000])
})
check('the exact amount always leads the suggestions', () => {
  assert.deepEqual(suggestTender(fromMaluti(15)), [1500, 2000, 5000, 10000, 20000])
})
check('a large total rounds up instead of offering odd multiples', () => {
  assert.deepEqual(suggestTender(fromMaluti(17500)), [1750000, 1800000])
})
check('suggestions are unique and ascending', () => {
  const s = suggestTender(fromMaluti(123))
  assert.deepEqual([...s].sort((a, b) => a - b), s)
  assert.equal(new Set(s).size, s.length)
})

console.log('barcode')
check('a 13-digit code padding a UPC-A drops the padding zero', () => {
  assert.equal(normalizeBarcode('0600123456789'), '600123456789')
  assert.equal(normalizeBarcode(' 6001234567892 '), '6001234567892')
  assert.equal(normalizeBarcode('4006381333931'), '4006381333931')
})
check('lookup tries both UPC-A and padded spellings', () => {
  assert.deepEqual(barcodeVariants('600123456789'), [
    '600123456789',
    '0600123456789',
  ])
  assert.deepEqual(barcodeVariants('4006381333931'), ['4006381333931'])
  assert.deepEqual(barcodeVariants('   '), [])
})
check('accepts alphanumeric and length bounds', () => {
  assert.equal(isValidBarcode('6001234567892'), true)
  assert.equal(isValidBarcode('ABC-123'), true)
  assert.equal(isValidBarcode('12'), false)
  assert.equal(isValidBarcode(''), false)
})
check('computes the EAN-13 check digit', () => {
  assert.equal(ean13CheckDigit('400638133393'), 1)
  assert.equal(isValidEan13('4006381333931'), true)
  assert.equal(isValidEan13('4006381333939'), false)
})

console.log('cart')
check('subtotal multiplies price by quantity', () => {
  const lines = mergeProduct([], product())
  assert.equal(cartSubtotal(setQty(lines, 'p1', 3)), fromMaluti(4500))
})
check('scanning the same item twice increments instead of duplicating', () => {
  let lines = mergeProduct([], product())
  lines = mergeProduct(lines, product())
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.qty, 2)
})
check('different barcodes stay on separate lines', () => {
  let lines = mergeProduct([], product())
  lines = mergeProduct(lines, product({ id: 'p2', barcode: '6001234567908', name: 'Salt' }))
  assert.equal(lines.length, 2)
})
check('the most recently scanned item is first', () => {
  let lines = mergeProduct([], product())
  lines = mergeProduct(lines, product({ id: 'p2', barcode: '6001234567908', name: 'Salt' }))
  assert.equal(lines[0]!.key, 'p2')
  assert.equal(lines[1]!.key, 'p1')
})
check('re-scanning an item moves it back to the top', () => {
  let lines = mergeProduct([], product())
  lines = mergeProduct(lines, product({ id: 'p2', barcode: '6001234567908', name: 'Salt' }))
  lines = mergeProduct(lines, product())
  assert.equal(lines[0]!.key, 'p1')
  assert.equal(lines[0]!.qty, 2)
  assert.equal(lines[1]!.key, 'p2')
})
check('quantity of zero removes the line', () => {
  const lines = mergeProduct([], product())
  assert.equal(setQty(lines, 'p1', 0).length, 0)
})
check('ad-hoc lines merge by barcode', () => {
  let lines = addAdHoc([], { barcode: 'X99', name: 'Mystery', unitPrice: fromMaluti(5) })
  lines = addAdHoc(lines, { barcode: 'X99', name: 'Mystery', unitPrice: fromMaluti(5) })
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.qty, 2)
})
check('an ad-hoc item does not collide with a catalog line', () => {
  const lines = addAdHoc(mergeProduct([], product()), {
    barcode: '6001234567892',
    name: 'Sugar',
    unitPrice: fromMaluti(1500),
  })
  assert.equal(lines.length, 2)
})
check('removing a line leaves the rest intact', () => {
  let lines = mergeProduct([], product())
  lines = mergeProduct(lines, product({ id: 'p2', barcode: '999', name: 'Other' }))
  assert.equal(removeLine(lines, 'p1').length, 1)
})
check('over-stock is flagged only when qty exceeds availability', () => {
  assert.equal(linesExceedingStock(mergeProduct([], product())).length, 0)
  assert.equal(
    linesExceedingStock(setQty(mergeProduct([], product()), 'p1', 11)).length,
    1,
  )
})
check('ad-hoc lines are never flagged as over-stock', () => {
  const lines = addAdHoc([], { barcode: 'X', name: 'Y', unitPrice: 1 })
  assert.equal(linesExceedingStock(lines).length, 0)
})

console.log('accounts')

const mkSale = (total: number, receiptNo: string, status: Sale['status'] = 'completed'): Sale => ({
  id: receiptNo,
  receiptNo,
  businessDate: '2026-10-12',
  subtotal: total,
  total,
  paymentMethod: 'cash',
  amountTendered: total,
  change: 0,
  status,
  voidedAt: status === 'voided' ? 1 : null,
  note: '',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  rev: 1,
  deviceId: 'd',
})
const mkLine = (saleId: string, productId: string, unitPrice: number, qty: number): SaleLine => ({
  id: `${saleId}-${productId}`,
  saleId,
  productId,
  barcode: productId,
  name: productId,
  unitPrice,
  qty,
  lineTotal: unitPrice * qty,
  adHoc: false,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  rev: 1,
  deviceId: 'd',
})
const mkCash = (reason: CashReason, delta: number, businessDate = '2026-10-12'): CashMovement => ({
  id: `${reason}-${businessDate}-${delta}`,
  reason,
  delta,
  refId: null,
  businessDate,
  note: '',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  rev: 1,
  deviceId: 'd',
})
const mkStock = (
  productId: string,
  delta: number,
  reason: StockReason,
  refId: string | null = null,
): StockMovement => ({
  id: `${productId}-${reason}-${delta}`,
  productId,
  delta,
  reason,
  refId,
  note: '',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  rev: 1,
  deviceId: 'd',
})

const P = {
  sugar: product({ id: 's1', barcode: 'S1', name: 'Sugar', price: fromMaluti(1500), cost: fromMaluti(1400), stockQty: 46 }),
  oil: product({ id: 'o1', barcode: 'O1', name: 'Oil', price: fromMaluti(6500), cost: fromMaluti(6000), stockQty: 10 }),
}

check('the income statement books sales, cost and expenses separately', () => {
  const sales = [mkSale(fromMaluti(6000), '0001'), mkSale(fromMaluti(13000), '0002')]
  const lines = [
    mkLine('0001', 's1', fromMaluti(1500), 4),
    mkLine('0002', 'o1', fromMaluti(6500), 2),
  ]
  // Sugar 4 × 1400 + Oil 2 × 6000 = M17,600 cost for M19,000 sold.
  const stmt = incomeStatement(sales, lines, [P.sugar, P.oil], [mkCash('expense', -fromMaluti(500))])
  assert.equal(stmt.revenue, fromMaluti(19000))
  assert.equal(stmt.cogs, fromMaluti(17600))
  assert.equal(stmt.grossProfit, fromMaluti(1400))
  assert.equal(stmt.expenses, fromMaluti(500))
  assert.equal(stmt.netProfit, fromMaluti(900))
  assert.equal(stmt.saleCount, 2)
  assert.equal(stmt.itemsSold, 6)
})

check('a refunded sale nets out of the P&L; only completed sales cost the shelf', () => {
  const sales = [mkSale(fromMaluti(6000), '0001'), mkSale(fromMaluti(4500), '0002', 'voided')]
  const lines = [
    mkLine('0001', 's1', fromMaluti(1500), 4),
    mkLine('0002', 's1', fromMaluti(1500), 3),
  ]
  const stmt = incomeStatement(sales, lines, [P.sugar], [mkCash('void', -fromMaluti(4500))])
  assert.equal(stmt.revenue, fromMaluti(10500), 'gross revenue includes the refunded sale')
  assert.equal(stmt.returns, fromMaluti(4500))
  assert.equal(stmt.netRevenue, fromMaluti(6000))
  assert.equal(stmt.cogs, fromMaluti(5600), 'cost only books completed sales')
  assert.equal(stmt.grossProfit, fromMaluti(400))
  assert.equal(stmt.netProfit, fromMaluti(400))
  assert.equal(stmt.itemsSold, 4)
})

check('a sale refunded in full books no profit or loss', () => {
  const sales = [mkSale(fromMaluti(4500), '0002', 'voided')]
  const lines = [mkLine('0002', 's1', fromMaluti(1500), 3)]
  const stmt = incomeStatement(sales, lines, [P.sugar], [mkCash('void', -fromMaluti(4500))])
  assert.equal(stmt.revenue, fromMaluti(4500))
  assert.equal(stmt.returns, fromMaluti(4500))
  assert.equal(stmt.netRevenue, 0)
  assert.equal(stmt.cogs, 0)
  assert.equal(stmt.netProfit, 0)
})

check('a product without a cost books at its selling price', () => {
  const stmt = incomeStatement(
    [mkSale(fromMaluti(1500), '0001')],
    [mkLine('0001', 's1', fromMaluti(1500), 1)],
    [product({ id: 's1', price: fromMaluti(1500), cost: undefined as never })],
    [],
  )
  assert.equal(stmt.cogs, fromMaluti(1500))
  assert.equal(stmt.grossProfit, 0)
})

check('the balance sheet balances when the ledger is complete', () => {
  // Cash: float 10000 + money in 5000 − purchase 14000 + sales 19000 − expense 500 − drawings 3000
  const purchaseRow = mkCash('purchase', -fromMaluti(14000))
  const cash = [
    mkCash('float', fromMaluti(10000)),
    mkCash('cash_in', fromMaluti(5000)),
    purchaseRow,
    mkCash('sale', fromMaluti(6000)),
    mkCash('sale', fromMaluti(13000)),
    mkCash('expense', -fromMaluti(500)),
    mkCash('drawing', -fromMaluti(3000)),
  ]
  const stock = [
    mkStock('s1', 40, 'import'),
    mkStock('o1', 12, 'import'),
    mkStock('s1', 10, 'purchase', purchaseRow.id),
    mkStock('s1', -4, 'sale'),
    mkStock('o1', -2, 'sale'),
  ]
  const sales = [mkSale(fromMaluti(6000), '0001'), mkSale(fromMaluti(13000), '0002')]
  const lines = [
    mkLine('0001', 's1', fromMaluti(1500), 4),
    mkLine('0002', 'o1', fromMaluti(6500), 2),
  ]
  const bs = balanceSheet(cash, [P.sugar, P.oil], stock, sales, lines)

  assert.equal(bs.cash, fromMaluti(16500))
  // Sugar 46 × 1400 + Oil 10 × 6000
  assert.equal(bs.stockValue, fromMaluti(124400))
  assert.equal(bs.totalAssets, fromMaluti(140900))
  assert.equal(bs.capitalIn, fromMaluti(15000))
  assert.equal(bs.contributedStock, fromMaluti(128000))
  assert.equal(bs.retainedProfit, fromMaluti(900))
  assert.equal(bs.drawings, -fromMaluti(3000))
  assert.equal(bs.totalEquity, fromMaluti(140900))
  assert.equal(bs.loans, 0)
  assert.equal(bs.check, 0, 'a complete ledger must balance to the tambala')
})

check('the same ledger posts a trial balance that ties', () => {
  const purchaseRow = mkCash('purchase', -fromMaluti(14000))
  const cash = [
    mkCash('float', fromMaluti(10000)),
    mkCash('cash_in', fromMaluti(5000)),
    purchaseRow,
    mkCash('sale', fromMaluti(6000)),
    mkCash('sale', fromMaluti(13000)),
    mkCash('expense', -fromMaluti(500)),
    mkCash('drawing', -fromMaluti(3000)),
  ]
  const stock = [
    mkStock('s1', 40, 'import'),
    mkStock('o1', 12, 'import'),
    mkStock('s1', 10, 'purchase', purchaseRow.id),
    mkStock('s1', -4, 'sale'),
    mkStock('o1', -2, 'sale'),
  ]
  const sales = [mkSale(fromMaluti(6000), '0001'), mkSale(fromMaluti(13000), '0002')]
  const lines = [mkLine('0001', 's1', fromMaluti(1500), 4), mkLine('0002', 'o1', fromMaluti(6500), 2)]

  const tb = trialBalances(sales, lines, cash, [P.sugar, P.oil], stock)
  const by = new Map(tb.rows.map((r) => [r.account, r.balance]))
  assert.equal(tb.difference, 0, 'debits must equal credits')
  // Assets and expenses sit on the debit side...
  assert.equal(by.get(ACCOUNTS.CASH), fromMaluti(16500))
  assert.equal(by.get(ACCOUNTS.INVENTORY), fromMaluti(124400))
  assert.equal(by.get(ACCOUNTS.COGS), fromMaluti(17600))
  assert.equal(by.get(ACCOUNTS.DRAWINGS), fromMaluti(3000))
  // ...capital, contributions and revenue on the credit side.
  assert.equal(by.get(ACCOUNTS.CAPITAL), -fromMaluti(15000))
  assert.equal(by.get(ACCOUNTS.CONTRIBUTED), -fromMaluti(128000))
  assert.equal(by.get(ACCOUNTS.SALES), -fromMaluti(19000))
})

check('a depot bargain is recognised as a gain, so the books balance', () => {
  // The owner paid M13,500 for ten units of sugar booked at M14,000 cost. Old
  // books hid the M500 as a "check" gap; now it is purchase-variance income on
  // the P&L, which is exactly what double-entry bookkeeping exists to surface.
  const purchaseRow = mkCash('purchase', -fromMaluti(13500))
  const cash = [
    mkCash('float', fromMaluti(10000)),
    purchaseRow,
    mkCash('sale', fromMaluti(6000)),
    mkCash('sale', fromMaluti(13000)),
  ]
  const stock = [
    mkStock('s1', 40, 'import'),
    mkStock('o1', 12, 'import'),
    mkStock('s1', 10, 'purchase', purchaseRow.id),
    mkStock('s1', -4, 'sale'),
    mkStock('o1', -2, 'sale'),
  ]
  const sales = [mkSale(fromMaluti(6000), '0001'), mkSale(fromMaluti(13000), '0002')]
  const lines = [mkLine('0001', 's1', fromMaluti(1500), 4), mkLine('0002', 'o1', fromMaluti(6500), 2)]

  const stmt = incomeStatement(sales, lines, [P.sugar, P.oil], cash, undefined, stock)
  assert.equal(stmt.purchaseVariance, fromMaluti(500), 'paid less than booked = a gain')
  assert.equal(stmt.netProfit, fromMaluti(1900), '1400 trading + 500 bargain')

  const bs = balanceSheet(cash, [P.sugar, P.oil], stock, sales, lines)
  const tb = trialBalances(sales, lines, cash, [P.sugar, P.oil], stock)
  assert.equal(bs.retainedProfit, fromMaluti(1900))
  assert.equal(bs.check, 0, 'the bargain is on the books, not in a check line')
  assert.equal(tb.difference, 0)
  assert.equal(
    (new Map(tb.rows.map((r) => [r.account, r.balance]))).get(ACCOUNTS.PURCHASE_VARIANCE),
    -fromMaluti(500),
    'variance is a credit balance (income)',
  )
})

check('a stock take that finds less posts a loss, and the books still tie', () => {
  // Five units of sugar came up short at the stock take. Sugar now shows 41 on
  // the shelf; posting books a stock-adjustment loss of 5 × 1400.
  const sugar = product({ id: 's1', barcode: 'S1', name: 'Sugar', price: fromMaluti(1500), cost: fromMaluti(1400), stockQty: 41 })
  const purchaseRow = mkCash('purchase', -fromMaluti(14000))
  const cash = [
    purchaseRow,
    mkCash('sale', fromMaluti(6000)),
  ]
  const stock = [
    mkStock('s1', 40, 'import'),
    mkStock('s1', 10, 'purchase', purchaseRow.id),
    mkStock('s1', -4, 'sale'),
    mkStock('s1', -5, 'adjust'),
  ]
  const sales = [mkSale(fromMaluti(6000), '0001')]
  const lines = [mkLine('0001', 's1', fromMaluti(1500), 4)]

  const stmt = incomeStatement(sales, lines, [sugar], cash, undefined, stock)
  assert.equal(stmt.stockAdjust, fromMaluti(7000), '5 units short = a 7000 loss')

  const tb = trialBalances(sales, lines, cash, [sugar], stock)
  assert.equal(tb.difference, 0)
  const by = new Map(tb.rows.map((r) => [r.account, r.balance]))
  assert.equal(by.get(ACCOUNTS.STOCK_ADJUST), fromMaluti(7000))
  // Shelf: 40 + 10 − 4 − 5 = 41 units of sugar → 41 × 1400 = 57400.
  assert.equal(by.get(ACCOUNTS.INVENTORY), fromMaluti(57400))
})

check('borrowed money is a liability: loans in, repayments out', () => {
  const cash = [
    mkCash('float', fromMaluti(10000)),
    { ...mkCash('cash_in', fromMaluti(20000)), kind: 'loan' } as CashMovement,
    { ...mkCash('loan_repay', -fromMaluti(5000)) } as CashMovement,
  ]
  const bs = balanceSheet(cash, [], [], [], [])
  assert.equal(bs.loans, fromMaluti(15000))
  assert.equal(bs.capitalIn, fromMaluti(10000), 'borrowed money is not owner capital')

  const tb = trialBalances([], [], cash, [], [])
  assert.equal(tb.difference, 0)
  assert.equal(
    (new Map(tb.rows.map((r) => [r.account, r.balance]))).get(ACCOUNTS.LOANS),
    -fromMaluti(15000),
    'a loan balance sits on the credit side',
  )
})

check('the cash flow statement classifies and ties to the drawer', () => {
  const cash = [
    mkCash('float', fromMaluti(10000), '2026-10-01'),
    { ...mkCash('cash_in', fromMaluti(20000), '2026-10-02'), kind: 'loan' } as CashMovement,
    mkCash('purchase', -fromMaluti(13500), '2026-10-03'),
    mkCash('sale', fromMaluti(6000), '2026-10-04'),
    mkCash('sale', fromMaluti(13000), '2026-10-05'),
    mkCash('void', -fromMaluti(1500), '2026-10-05'),
    mkCash('expense', -fromMaluti(500), '2026-10-06'),
    mkCash('drawing', -fromMaluti(3000), '2026-10-07'),
    mkCash('loan_repay', -fromMaluti(5000), '2026-10-08'),
  ]
  const dates = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
  const cf = cashFlow(cash, dates)

  assert.equal(cf.opening, fromMaluti(30000), 'float + loan sits in the drawer before the window')
  assert.equal(cf.operatingIn, fromMaluti(17500), 'sales minus the refund')
  assert.equal(cf.operatingOut, fromMaluti(14000), 'purchase + expense')
  assert.equal(cf.financingIn, 0)
  assert.equal(cf.financingOut, fromMaluti(8000), 'drawing + loan repayment')
  assert.equal(cf.closing, fromMaluti(25500), 'ties to the all-time drawer balance')
  assert.equal(cf.net, -fromMaluti(4500))
})

console.log('merge rules')

check('the newest edit wins', () => {
  const base = { id: 'p', createdAt: 1, updatedAt: 5000, deletedAt: null, rev: 1, deviceId: 'device-a' }
  assert.equal(remoteWins(base, { ...base, updatedAt: 6000 }), true)
  assert.equal(remoteWins(base, { ...base, updatedAt: 4000 }), false)
  assert.equal(remoteWins(base, { ...base }), false)
})

check('a tie falls back to revision, then to the device id', () => {
  const base = { id: 'p', createdAt: 1, updatedAt: 5000, deletedAt: null, rev: 3, deviceId: 'aaa' }
  assert.equal(remoteWins(base, { ...base, rev: 4 }), true)
  assert.equal(remoteWins(base, { ...base, rev: 2 }), false)
  // Same millisecond and revision: the smaller device id wins, so every device
  // resolves the conflict the same way without asking the others.
  assert.equal(remoteWins({ ...base, deviceId: 'bbb' }, base), true)
  assert.equal(remoteWins(base, { ...base, deviceId: 'bbb' }), false)
})

check('server-only columns never reach the local row', () => {
  const meta = { id: 'p', createdAt: 1, updatedAt: 1, deletedAt: null, rev: 1, deviceId: 'a' }
  const clean = stripServerFields({
    ...meta,
    shopId: 'shop-a',
    serverSeq: 9,
    serverUpdatedAt: 'x',
  }) as unknown as Record<string, unknown>
  assert.equal('serverSeq' in clean, false)
  assert.equal('serverUpdatedAt' in clean, false)
  assert.equal('shopId' in clean, false)
  assert.equal(clean.id, 'p')
})

check('outbound rows are tagged with the active shop', () => {
  const row = withShopId(
    { id: 'p', createdAt: 1, updatedAt: 1, deletedAt: null, rev: 1, deviceId: 'a' },
    'shop-b',
  ) as unknown as Record<string, unknown>
  assert.equal(row.shopId, 'shop-b')
  assert.equal(row.id, 'p')
})

check('shop A keeps the old database name and new shops get their own', () => {
  assert.equal(dbNameForShop('shop-a'), 'till-pos')
  assert.equal(dbNameForShop('shop-b'), 'till-pos-shop-b')
  assert.equal(dbNameForShop('main-street'), 'till-pos-main-street')
})

check('shop codes are lowercase, stable and validated', () => {
  assert.equal(cleanShopCode(' Shop B! '), 'shopb')
  assert.equal(cleanShopCode('MAIN-STREET'), 'main-street')
  assert.equal(validateShopCode('shop-b'), null)
  assert.notEqual(validateShopCode('a'), null)
  assert.notEqual(validateShopCode('-shop'), null)
  assert.notEqual(validateShopCode('shop-'), null)
})

check('the push order puts parents before children', () => {
  assert.ok(SYNC_ENTITIES.indexOf('sales') < SYNC_ENTITIES.indexOf('sale_lines'))
  assert.ok(SYNC_ENTITIES.indexOf('products') < SYNC_ENTITIES.indexOf('stock_movements'))
  assert.ok(SYNC_ENTITIES.includes('settings'))
})

console.log('app lock')

check('PINs are 4–8 digits and nothing else', () => {
  assert.equal(validateSecret('pin', '1234'), null)
  assert.equal(validateSecret('pin', '12345678'), null)
  assert.notEqual(validateSecret('pin', '123'), null)
  assert.notEqual(validateSecret('pin', '123456789'), null)
  assert.notEqual(validateSecret('pin', '12a4'), null)
})

check('passwords need eight characters and no edge spaces', () => {
  assert.equal(validateSecret('password', 'open sesame'), null)
  assert.notEqual(validateSecret('password', 'short'), null)
  assert.notEqual(validateSecret('password', ' leading'), null)
  assert.notEqual(validateSecret('password', 'trailing '), null)
})

check('base64 and base64url round-trip every byte value', () => {
  const bytes = new Uint8Array(256)
  for (let i = 0; i < 256; i++) bytes[i] = i
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes])
  assert.deepEqual([...base64UrlToBytes(bytesToBase64Url(bytes))], [...bytes])
  assert.ok(!bytesToBase64Url(bytes).includes('='), 'base64url kept its padding')
})

await checkAsync('the right secret verifies and the wrong one does not', async () => {
  const cred = await createCredential('pin', '482913')
  assert.equal(await verifySecret(cred, '482913'), true)
  assert.equal(await verifySecret(cred, '482914'), false)
  assert.equal(cred.length, 6)
  assert.equal(cred.iterations, 310_000)
  assert.ok(!JSON.stringify(cred).includes('482913'), 'the secret was stored in the clear')
})

await checkAsync('the same secret gets a fresh salt and digest each time', async () => {
  const a = await createCredential('password', 'open sesame')
  const b = await createCredential('password', 'open sesame')
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.hash, b.hash)
  assert.equal(await verifySecret(b, 'open sesame'), true)
})

check('five failures start a cooldown that survives a fresh screen', () => {
  const store = fakeStore()
  const t0 = 1_000_000
  for (let i = 0; i < FREE_ATTEMPTS - 1; i++) {
    const state = recordFailure(store, t0)
    assert.equal(cooldownRemaining(state, t0), 0)
  }
  const fifth = recordFailure(store, t0)
  assert.equal(fifth.fails, FREE_ATTEMPTS)
  assert.ok(cooldownRemaining(fifth, t0) > 0)

  // A reload remounts the lock screen with no in-memory state.
  const fresh = readAttempts(store)
  assert.equal(fresh.fails, FREE_ATTEMPTS, 'a new lock screen forgot the streak')
  assert.ok(cooldownRemaining(fresh, t0) > 0, 'the cooldown did not persist')

  clearAttempts(store)
  assert.equal(readAttempts(store).fails, 0)
})

check('ten failures escalate to five minutes', () => {
  const store = fakeStore()
  const t0 = 1_000_000
  let state = readAttempts(store)
  for (let i = 0; i < FREE_ATTEMPTS * 2; i++) state = recordFailure(store, t0)
  assert.equal(state.fails, FREE_ATTEMPTS * 2)
  assert.equal(cooldownRemaining(state, t0), 5 * 60_000)
})

check('a failure streak from over an hour ago resets', () => {
  const store = fakeStore()
  const t0 = 1_000_000
  for (let i = 0; i < FREE_ATTEMPTS; i++) recordFailure(store, t0)
  const later = recordFailure(store, t0 + 60 * 60_000 + 1)
  assert.equal(later.fails, 1, 'an old streak escalated instead of resetting')
  assert.equal(cooldownRemaining(later, later.last), 0)
})

check('lockout streaks are separate per staff account', () => {
  const store = fakeStore()
  const t0 = 1_000_000
  const cashier = attemptKey('cashier-1')
  const owner = attemptKey('owner')
  for (let i = 0; i < FREE_ATTEMPTS; i++) recordFailure(store, t0, cashier)

  assert.ok(
    cooldownRemaining(readAttempts(store, cashier), t0) > 0,
    'the cashier did not earn a cooldown',
  )
  assert.equal(
    cooldownRemaining(readAttempts(store, owner), t0),
    0,
    'a cashier locked the owner out',
  )

  clearAttempts(store, cashier)
  assert.equal(readAttempts(store, cashier).fails, 0)
  assert.equal(readAttempts(store).fails, 0, 'clearing one account touched the legacy key')
})

check('cooldownRemaining never reports a negative wait', () => {
  assert.equal(cooldownRemaining({ fails: 1, until: 10, last: 0 }, 50), 0)
})

console.log(`\n${passed} checks passed`)