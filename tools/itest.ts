/**
 * Integration tests against a real Dexie database.
 *
 * `tools/smoke.ts` only covers pure functions — it never touches IndexedDB, so
 * the whole write path (import, commit, void, repair) could be broken while
 * `npm test` stayed green. This suite runs the actual service code on a
 * headless IndexedDB to close that gap.
 *
 * Run with: npm run test:int
 */
import './setup-env'
import assert from 'node:assert/strict'
import { db, repairStockCache, TillDatabase } from '../src/db'
import type { Product } from '../src/db/types'
import { importProducts, exportProductsCsv } from '../src/features/catalog/csvImport'
import { commitSale, voidSale, adjustStock, businessDate } from '../src/features/sales/salesService'
import {
  buyStock,
  cashBalance,
  outstandingLoans,
  recordCashIn,
  recordDrawing,
  recordExpense,
  recordLoanRepay,
  setOpeningFloat,
  summariseCash,
} from '../src/features/cash/cashService'
import { mergeProduct, setQty } from '../src/features/cart/cartStore'
import { lookupProduct } from '../src/features/cart/CartContext'
import { exportSalesCsv } from '../src/features/reports/exportCsv'
import {
  exportCashLedgerCsv,
  exportStatementsCsv,
  exportStockLedgerCsv,
} from '../src/features/reports/exportAccounts'
import { buildBookPack, loadBooksData } from '../src/features/reports/books'
import { exportBooksPdf } from '../src/features/reports/pdfPack'
import { buildReport } from '../src/features/reports/ReportsScreen'
import { loadShopName, saveShopName } from '../src/features/settings/shopName'
import { cleanTillLabel, loadTillLabel, saveTillLabel } from '../src/features/settings/tillLabel'
import { buildBackup } from '../src/features/security/backup'
import {
  loadBiometric,
  loadCredential,
  removeBiometric,
  removeCredential,
  saveBiometric,
  saveCredential,
} from '../src/features/security/credentialService'
import { verifySecret } from '../src/features/security/secret'
import {
  OWNER_ACCOUNT_ID,
  STAFF_KEY,
  addCashier,
  changeStaffSecret,
  createOwner,
  loadStaff,
  parseStaffRoster,
  removeAllStaff,
  removeCashier,
} from '../src/features/security/staff'
import { addShop } from '../src/features/shops/shopManager'
import { getActiveDbName, listShops } from '../src/shops/registry'
import {
  disableSync,
  loadCursors,
  loadLastSyncAt,
  loadSyncConfig,
  normalizeProjectUrl,
  saveCursors,
  saveSyncConfig,
  setLastSyncAt,
} from '../src/sync/config'
import { applyRemoteRow, isPendingLocally } from '../src/sync/apply'
import { remoteWins, stripServerFields, type RemoteRow } from '../src/sync/merge'
import { isSharedSettingKey, saveSharedSetting } from '../src/sync/shared'
import { queueEntity, outboxCount } from '../src/sync/outbox'

let passed = 0
let failed = 0

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL  ${name}`)
    console.error(`      ${err instanceof Error ? (err.stack ?? err.message) : err}`)
    process.exitCode = 1
  }
}

async function reset() {
  await db.transaction(
    'rw',
    db.products,
    db.sales,
    db.saleLines,
    db.stockMovements,
    db.cashMovements,
    db.outbox,
    db.settings,
    async () => {
      await Promise.all([
        db.products.clear(),
        db.sales.clear(),
        db.saleLines.clear(),
        db.stockMovements.clear(),
        db.cashMovements.clear(),
        db.outbox.clear(),
        db.settings.clear(),
      ])
    },
  )
}

const CSV = [
  'barcode,name,price,cost,stockQty,lowStockThreshold,category',
  '6001234567892,Sugar 1kg,1500,1400,40,10,Grocery',
  '6001234567908,Salt 1kg,800,700,0,8,Grocery',
  '6001234567814,Cooking Oil 1L,6500,6000,12,5,Grocery',
].join('\n')

const csvFile = (text: string, name = 'products.csv') =>
  new File([text], name, { type: 'text/csv' })

async function productByBarcode(code: string): Promise<Product | undefined> {
  return db.products.where('barcode').equals(code).first()
}

async function stockOf(code: string): Promise<number | null> {
  const p = await productByBarcode(code)
  return p ? p.stockQty : null
}

async function ledgerSum(productId: string): Promise<number> {
  const moves = await db.stockMovements.where('productId').equals(productId).toArray()
  return moves.reduce((s, m) => s + m.delta, 0)
}

/** A row shaped the way one arrives from Postgres, for the merge tests. */
function remoteProduct(overrides: Partial<Product> & { id: string }): RemoteRow {
  return {
    barcode: '6000000000000',
    barcodes: ['6000000000000'],
    name: 'Product',
    price: 100,
    cost: 100,
    stockQty: 0,
    lowStockThreshold: 0,
    category: 'Grocery',
    active: true,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    rev: 1,
    deviceId: 'device-a',
    shopId: 'shop-a',
    ...overrides,
  } as unknown as RemoteRow
}

/** Look a product up the way the till does, then build a cart line from it. */
async function lineFor(code: string, qty = 1) {
  const p = await productByBarcode(code)
  assert.ok(p, `expected product ${code} to exist`)
  return mergeProduct([], p!, qty)[0]!
}

async function main() {
  console.log('transaction boundaries')

  await check('an undeclared table in a transaction is rejected by Dexie', async () => {
    await reset()
    // Documents the constraint that caused every write in the app to fail:
    // Dexie refuses a table db.transaction() did not list, and that aborts the
    // whole transaction. queueEntity() writes the outbox, so outbox must be
    // declared everywhere it is used.
    let threw = false
    try {
      await db.transaction('rw', db.products, async () => {
        await db.products.put({
          id: 'probe',
          barcode: 'PROBE',
          name: 'probe',
          price: 1,
          cost: 1,
          stockQty: 0,
          lowStockThreshold: 0,
          category: 'x',
          active: true,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          rev: 1,
          deviceId: 'd',
        })
        await queueEntity('products', 'probe', 'upsert', { hello: 'world' })
      })
    } catch {
      threw = true
    }
    assert.ok(threw, 'Dexie accepted an undeclared table — behaviour changed, revisit this test')
    assert.equal(await db.products.count(), 0, 'aborted transaction left data behind')
  })

  await check('declaring the outbox makes the same write succeed', async () => {
    await db.transaction('rw', db.products, db.outbox, async () => {
      await db.products.put({
        id: 'probe',
        barcode: 'PROBE',
        name: 'probe',
        price: 1,
        cost: 1,
        stockQty: 0,
        lowStockThreshold: 0,
        category: 'x',
        active: true,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        rev: 1,
        deviceId: 'd',
      })
      await queueEntity('products', 'probe', 'upsert', { hello: 'world' })
    })
    assert.equal(await db.products.count(), 1)
    assert.equal(await db.outbox.count(), 1, 'outbox row was not written')
  })

  console.log('csv import')

  await check('imports a catalog and records opening stock in the ledger', async () => {
    await reset()
    const res = await importProducts(csvFile(CSV))
    assert.equal(res.created, 3, `created=${res.created} errors=${JSON.stringify(res.errors)}`)
    assert.equal(res.errors.length, 0)
    assert.equal(await stockOf('6001234567892'), 40)
    assert.equal(await stockOf('6001234567908'), 0)
    const sugar = (await productByBarcode('6001234567892'))!
    assert.equal(await ledgerSum(sugar.id), 40, 'opening stock missing from ledger')
    assert.equal(sugar.cost, 140000, 'cost column was not read by the import')
  })

  await check('re-import reconciles a changed stock figure', async () => {
    const changed = CSV.replace('40,10', '35,10')
    const res = await importProducts(csvFile(changed, 'products2.csv'))
    assert.equal(res.updated, 3)
    assert.equal(await stockOf('6001234567892'), 35)
    const sugar = (await productByBarcode('6001234567892'))!
    assert.equal(await ledgerSum(sugar.id), 35, 're-import movement wrong')
  })

  await check('import leaves one coalesced outbox row per product', async () => {
    // Rows are keyed per entity id, so re-importing must not pile up duplicates.
    const productRows = await db.outbox.where('entity').equals('products').count()
    assert.equal(productRows, 3, `expected 3 product rows, saw ${productRows}`)
    assert.equal(await db.products.count(), 3)
  })

  await check('a re-import keeps the existing cost when the file has none', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const noCost = [
      'barcode,name,price,stockQty,lowStockThreshold,category',
      '6001234567892,Sugar 1kg,1500,40,10,Grocery',
    ].join('\n')
    await importProducts(csvFile(noCost, 'no-cost.csv'))
    const sugar = (await productByBarcode('6001234567892'))!
    assert.equal(sugar.cost, 140000, 'cost was reset by a file that did not state one')
  })

  await check('an import with no cost column defaults cost to the selling price', async () => {
    await reset()
    const noCost = [
      'barcode,name,price,stockQty,lowStockThreshold,category',
      '6001234567892,Sugar 1kg,1500,40,10,Grocery',
    ].join('\n')
    await importProducts(csvFile(noCost))
    const sugar = (await productByBarcode('6001234567892'))!
    assert.equal(sugar.cost, 150000, 'cost should fall back to the selling price')
  })

  await check('duplicate barcodes in one file are rejected, not silently merged', async () => {
    await reset()
    const dup = [
      'barcode,name,price,stockQty,lowStockThreshold,category',
      '6001234567892,Sugar 1kg,1500,10,10,Grocery',
      '6001234567892,Sugar Large,2000,10,10,Grocery',
    ].join('\n')
    const res = await importProducts(csvFile(dup, 'dup.csv'))
    assert.equal(res.created, 1)
    assert.equal(res.errors.length, 1)
    assert.match(res.errors[0]!.reason, /duplicate/)
    assert.deepEqual(res.duplicates, ['6001234567892'], 'duplicates list was not populated')
  })

  await check('a re-import can lower a threshold to zero', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const zeroed = CSV.replace('40,10', '40,0')
    await importProducts(csvFile(zeroed, 'zero.csv'))
    const sugar = (await productByBarcode('6001234567892'))!
    assert.equal(sugar.lowStockThreshold, 0, 'explicit threshold 0 was ignored')
  })

  await check('rows with a bad price are skipped and reported', async () => {
    await reset()
    const bad = [
      'barcode,name,price,stockQty,lowStockThreshold,category',
      '6001234567892,Sugar 1kg,abc,10,10,Grocery',
      '6001234567908,Salt 1kg,800,10,10,Grocery',
    ].join('\n')
    const res = await importProducts(csvFile(bad, 'bad.csv'))
    assert.equal(res.created, 1)
    assert.equal(res.errors.length, 1)
    assert.match(res.errors[0]!.reason, /price/)
  })

  console.log('lookup')

  await check('a barcode resolves, an ambiguous prefix does not', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    assert.equal((await lookupProduct('6001234567892'))?.name, 'Sugar 1kg')
    // Every CSV barcode starts with 6001234567, so this partial read is
    // ambiguous. It used to resolve to whichever row came back first.
    assert.equal(await lookupProduct('6001234567'), undefined)
    // A truncation that still identifies exactly one product is still allowed.
    assert.equal((await lookupProduct('600123456789'))?.name, 'Sugar 1kg')
  })

  console.log('sale commit')

  await check('commits a sale, writes lines, and deducts stock', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sale = await commitSale({
      lines: [await lineFor('6001234567892', 3)],
      paymentMethod: 'cash',
      amountTendered: 500000,
    })
    assert.equal(sale.status, 'completed')
    assert.equal(sale.total, 3 * 150000)
    assert.equal(sale.change, 500000 - 450000)
    assert.equal(await db.saleLines.where('saleId').equals(sale.id).count(), 1)
    assert.equal(await stockOf('6001234567892'), 37)
    const sugar = (await productByBarcode('6001234567892'))!
    assert.equal(await ledgerSum(sugar.id), 37, 'ledger disagrees with cached stock')
  })

  await check('receipt numbers increment within the day', async () => {
    const sale = await commitSale({
      lines: [await lineFor('6001234567814', 1)],
      paymentMethod: 'cash',
      amountTendered: 700000,
    })
    assert.equal(sale.receiptNo, '0002')
  })

  await check('every sale is cash and carries its tender and change', async () => {
    const sales = await db.sales.toArray()
    for (const s of sales) {
      assert.equal(s.paymentMethod, 'cash')
      assert.ok(s.amountTendered !== null && s.amountTendered >= s.total)
      assert.equal(s.change, s.amountTendered - s.total)
    }
  })

  await check('every mutation queues an outbox row', async () => {
    assert.ok((await outboxCount()) > 0, 'outbox is empty')
    const items = await db.outbox.toArray()
    for (const i of items) {
      assert.ok(i.entity && i.entityId, 'malformed outbox row')
      assert.doesNotThrow(() => JSON.parse(i.payload), 'payload is not JSON')
    }
  })

  await check('concurrent commits do not collide on a receipt number', async () => {
    const before = (await db.sales.count())
    const commits = []
    for (let i = 0; i < 8; i++) {
      const line = await lineFor('6001234567892', 1)
      commits.push(
        commitSale({
          lines: [line],
          paymentMethod: 'cash',
          amountTendered: 500000,
        }),
      )
    }
    const results = await Promise.all(commits)
    const nos = results.map((r) => r.receiptNo)
    assert.equal(new Set(nos).size, nos.length, `receipt numbers collided: ${nos.join(', ')}`)
    assert.equal(await db.sales.count(), before + 8)
  })

  await check('a cash sale tendered short of the total is refused', async () => {
    const before = await db.sales.count()
    await assert.rejects(
      commitSale({
        lines: [await lineFor('6001234567892', 1)],
        paymentMethod: 'cash',
        amountTendered: 1,
      }),
      /short/i,
    )
    assert.equal(await db.sales.count(), before, 'a short-paid sale was recorded')
  })

  console.log('over-sell and repair')

  await check('selling past zero drives stock negative', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    // Salt starts at 0, Cooking Oil at 12.
    const oil = (await productByBarcode('6001234567814'))!
    const sale = await commitSale({
      lines: [await lineFor('6001234567814', 20)],
      paymentMethod: 'cash',
      amountTendered: 99999999,
    })
    const after = (await productByBarcode('6001234567814'))!
    assert.equal(after.stockQty, -8, 'stock should be allowed to go negative')
    const moves = await db.stockMovements.where('productId').equals(oil.id).toArray()
    const saleMove = moves.find((m) => m.refId === sale.id && m.reason === 'sale')
    assert.ok(saleMove, 'no sale movement recorded — ledger no longer explains stock')
    assert.equal(await ledgerSum(oil.id), -8)
  })

  await check('selling an item that was already at zero drives it negative', async () => {
    // Salt is imported with stock 0. A sale of it must still hit the ledger,
    // otherwise the Z-report and the stock cache quietly disagree.
    const salt = (await productByBarcode('6001234567908'))!
    assert.equal(salt.stockQty, 0)
    await commitSale({
      lines: [await lineFor('6001234567908', 2)],
      paymentMethod: 'cash',
      amountTendered: 200000,
    })
    const after = (await productByBarcode('6001234567908'))!
    assert.equal(after.stockQty, -2, 'sale of a zero-stock item was not deducted')
    assert.equal(await ledgerSum(salt.id), -2, 'ledger does not record the sale')
    await repairStockCache()
    const repaired = (await productByBarcode('6001234567908'))!
    assert.equal(repaired.stockQty, -2, 'repairStockCache reverted the sale')
  })

  await check('repairStockCache reconciles the cache against the ledger', async () => {
    await repairStockCache()
    const oil = (await productByBarcode('6001234567814'))!
    assert.equal(oil.stockQty, await ledgerSum(oil.id))
    const sugar = (await productByBarcode('6001234567892'))!
    assert.equal(sugar.stockQty, await ledgerSum(sugar.id))
  })

  await check('repairStockCache does not wipe imported stock', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    await repairStockCache()
    assert.equal(await stockOf('6001234567892'), 40, 'opening stock was destroyed')
    assert.equal(await stockOf('6001234567814'), 12, 'opening stock was destroyed')
  })

  console.log('void')

  await check('voiding a sale reverses stock and flags the sale', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sale = await commitSale({
      lines: [await lineFor('6001234567892', 5)],
      paymentMethod: 'cash',
      amountTendered: 1000000,
    })
    assert.equal(await stockOf('6001234567892'), 35)
    await voidSale(sale.id, 'wrong item')
    const after = (await productByBarcode('6001234567892'))!
    assert.equal(after.stockQty, 40, 'stock not returned')
    assert.equal(await ledgerSum(after.id), 40, 'reversal movement missing')
    const row = (await db.sales.get(sale.id))!
    assert.equal(row.status, 'voided')
    assert.ok(row.voidedAt, 'voidedAt not stamped')
    assert.match(row.note, /wrong item/)
  })

  await check('voiding twice does not double the stock', async () => {
    const sale = (await db.sales.toArray())[0]!
    await voidSale(sale.id, 'again')
    const p = (await productByBarcode('6001234567892'))!
    assert.equal(p.stockQty, 40, 'double void gave stock away')
    assert.equal(await ledgerSum(p.id), 40)
  })

  await check('a voided sale is excluded from the CSV export totals', async () => {
    await commitSale({
      lines: [await lineFor('6001234567814', 2)],
      paymentMethod: 'cash',
      amountTendered: 2000000,
    })
    const blob = await exportSalesCsv()
    const text = await blob.text()
    assert.ok(!text.includes('Void:'), 'voided sale leaked into export')
    assert.match(text, /# Completed sales: 1/)
    assert.match(text, /# Voided sales: 1/)
    assert.match(text, /6001234567814,Cooking Oil 1L,2,/)
  })

  console.log('ad-hoc items')

  await check('an ad-hoc barcode becomes a real product on commit', async () => {
    await reset()
    const before = await db.products.count()
    await commitSale({
      lines: [
        {
          key: 'adhoc-1',
          productId: null,
          barcode: 'ADHOC-001',
          name: 'Unlabelled item',
          unitPrice: 500,
          qty: 2,
          adHoc: true,
          stockAtAdd: null,
        },
      ],
      paymentMethod: 'cash',
      amountTendered: 2000,
    })
    assert.equal(await db.products.count(), before + 1)
    const p = await db.products.where('barcode').equals('ADHOC-001').first()
    assert.ok(p, 'ad-hoc product was not created')
    // Ad-hoc items are created at zero and oversold like anything else, so the
    // ledger still has to show the deduction.
    assert.equal(p!.stockQty, -2, 'ad-hoc sale was not deducted')
    assert.equal(await ledgerSum(p!.id), -2, 'ad-hoc sale missing from the ledger')
    assert.equal(p!.cost, 500, 'ad-hoc item should default cost to its price')
    const lines = await db.saleLines.toArray()
    assert.equal(lines.at(-1)!.productId, p!.id, 'sale line not linked to the new product')
  })

  console.log('adjustments and exports')

  await check('adjustStock appends a movement rather than editing history', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sugar = (await productByBarcode('6001234567892'))!
    const movesBefore = await db.stockMovements.where('productId').equals(sugar.id).count()
    await adjustStock(sugar.id, 55, 'stock take')
    const after = (await productByBarcode('6001234567892'))!
    assert.equal(after.stockQty, 55)
    assert.equal(await ledgerSum(sugar.id), 55)
    assert.equal(
      await db.stockMovements.where('productId').equals(sugar.id).count(),
      movesBefore + 1,
      'no movement appended',
    )
  })

  await check('adjustStock is a no-op when the figure is unchanged', async () => {
    const sugar = (await productByBarcode('6001234567892'))!
    const moves = await db.stockMovements.where('productId').equals(sugar.id).count()
    await adjustStock(sugar.id, 55, 'again')
    assert.equal(await db.stockMovements.where('productId').equals(sugar.id).count(), moves)
  })

  await check('catalog CSV round-trips through export', async () => {
    const text = await (await exportProductsCsv()).text()
    assert.match(text, /barcode,barcodes,name,details,price,cost/)
    assert.match(text, /6001234567892,6001234567892,Sugar 1kg,,1500\.00,1400\.00,55,10,Grocery/)
  })

  console.log('cart quantity')

  await check('quantity edit does not lose the rest of the cart', async () => {
    const lines = await lineFor('6001234567892', 2)
    const bumped = setQty([lines], lines.key, 7)
    assert.equal(bumped[0]!.qty, 7)
    assert.equal(bumped[0]!.unitPrice, 150000)
  })

  console.log('full trading day')

  await check('report, ledger and stock cache all agree after a day', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    // CSV: Sugar 40 @ 1500, Salt 0 @ 800, Cooking Oil 12 @ 6500 (Maluti).

    const a = await commitSale({
      lines: [await lineFor('6001234567892', 3), await lineFor('6001234567814', 2)],
      paymentMethod: 'cash',
      amountTendered: 2000000,
    })
    const b = await commitSale({
      lines: [await lineFor('6001234567908', 5)], // Salt is at zero: an oversell.
      paymentMethod: 'cash',
      amountTendered: 500000,
    })
    const c = await commitSale({
      lines: [await lineFor('6001234567892', 1)],
      paymentMethod: 'cash',
      amountTendered: 200000,
    })
    await voidSale(c.id, 'customer changed mind')

    const sales = await db.sales.toArray()
    const lines = await db.saleLines.toArray()
    const report = buildReport(sales, lines, 14)

    assert.equal(report.saleCount, 2, 'completed sale count')
    assert.equal(report.voidCount, 1, 'void count')
    assert.equal(report.voided, c.total, 'voided total')
    assert.equal(report.net, a.total + b.total, 'net excludes the void')
    assert.equal(report.itemsSold, 3 + 2 + 5, 'items sold excludes the voided line')
    assert.equal(report.days.at(-1)!.date, businessDate(), 'window ends today')
    assert.equal(report.days.length, 14, 'window length')

    // The drawer ends with the two completed sales; the void handed its cash back.
    assert.equal(await cashBalance(), a.total + b.total, 'drawer does not match sales')

    // The cache is only a cache: it must equal the movement ledger for every row.
    for (const p of await db.products.toArray()) {
      assert.equal(p.stockQty, await ledgerSum(p.id), `stock/ledger mismatch: ${p.name}`)
    }
    assert.equal(await stockOf('6001234567892'), 37)
    assert.equal(await stockOf('6001234567814'), 10)
    assert.equal(await stockOf('6001234567908'), -5)

    await repairStockCache()
    for (const p of await db.products.toArray()) {
      assert.equal(p.stockQty, await ledgerSum(p.id), `repair changed: ${p.name}`)
    }
  })

  await check('a voided day is excluded from its date export', async () => {
    const text = await (await exportSalesCsv([businessDate()])).text()
    assert.match(text, /# Completed sales: 2/)
    assert.match(text, /# Voided sales: 1/)
    // The voided line (1 Sugar) must not appear as a sold row.
    assert.ok(!text.includes('6001234567892,Sugar 1kg,1,'), 'voided line leaked into export')
  })

  console.log('cash drawer')

  await check('a cash sale puts the sale total into the drawer', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    await commitSale({
      lines: [await lineFor('6001234567892', 2)],
      paymentMethod: 'cash',
      amountTendered: 500000,
    })
    assert.equal(await cashBalance(), 300000, 'drawer took the wrong amount')
    const moves = await db.cashMovements.toArray()
    assert.equal(moves.length, 1)
    assert.equal(moves[0]!.reason, 'sale')
    assert.equal(moves[0]!.delta, 300000)
  })

  await check('voiding a cash sale hands the money back', async () => {
    const sale = (await db.sales.toArray())[0]!
    await voidSale(sale.id, 'double charge')
    assert.equal(await cashBalance(), 0, 'void did not return the cash')
    assert.equal(await db.cashMovements.count(), 2, 'expected one sale + one void movement')
  })

  await check('setting the opening float adjusts, it does not add', async () => {
    await setOpeningFloat(10000)
    assert.equal(await cashBalance(), 10000)
    await setOpeningFloat(10000)
    assert.equal(await cashBalance(), 10000, 'float was added twice')
    await setOpeningFloat(20000)
    assert.equal(await cashBalance(), 20000)
    await setOpeningFloat(0)
    assert.equal(await cashBalance(), 0)
  })

  await check('money in and the owner taking cash move the drawer', async () => {
    await recordCashIn(5000)
    await recordDrawing(2000)
    assert.equal(await cashBalance(), 3000)
  })

  await check('a paid-out expense is recorded separately from a drawing', async () => {
    await reset()
    await recordExpense(1500, 'Stall rent')
    await recordDrawing(800, 'Lunch')
    const summary = summariseCash(await db.cashMovements.toArray())
    assert.equal(summary.expenses, -1500, 'expense landed in the wrong bucket')
    assert.equal(summary.drawings, -800, 'drawing landed in the wrong bucket')
    assert.equal(await cashBalance(), -2300)
  })

  await check('summariseCash breaks the drawer down by reason', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sale = await commitSale({
      lines: [await lineFor('6001234567892', 2)],
      paymentMethod: 'cash',
      amountTendered: 500000,
    })
    await voidSale(sale.id, 'wrong item')
    await setOpeningFloat(0)
    await recordCashIn(5000)
    await recordDrawing(2000)

    const summary = summariseCash(await db.cashMovements.toArray(), [businessDate()])
    assert.equal(summary.sales, 300000)
    assert.equal(summary.voids, -300000)
    assert.equal(summary.cashIn, 5000)
    assert.equal(summary.drawings, -2000)
    assert.equal(summary.purchases, 0)
    assert.equal(summary.expenses, 0)
    assert.equal(summary.openingFloat, 0)
    assert.equal(summary.balance, 3000)
    // A window with no activity is zero per reason, but balance stays all-time.
    const other = summariseCash(await db.cashMovements.toArray(), ['2000-01-01'])
    assert.equal(other.sales, 0)
    assert.equal(other.balance, 3000)
  })

  console.log('buying stock')

  await check('buying stock moves the money out and the stock up', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sugar = (await productByBarcode('6001234567892'))!
    await buyStock([{ productId: sugar.id, qty: 10 }], 1400000, 'Corner depot')
    assert.equal(await cashBalance(), -1400000, 'payment missing from the drawer')
    const after = (await productByBarcode('6001234567892'))!
    assert.equal(after.stockQty, 50, 'stock did not go up')
    assert.equal(await ledgerSum(sugar.id), 50, 'purchase missing from the stock ledger')
    const cash = await db.cashMovements.toArray()
    assert.equal(cash.length, 1, 'expected exactly one cash movement')
    assert.equal(cash[0]!.reason, 'purchase')
    assert.equal(cash[0]!.delta, -1400000)
    assert.match(cash[0]!.note, /Corner depot/)
    const moves = await db.stockMovements.where('productId').equals(sugar.id).toArray()
    const purchaseMove = moves.find((m) => m.reason === 'purchase' && m.refId === cash[0]!.id)
    assert.ok(purchaseMove, 'stock movement does not link back to the payment')
    assert.equal(purchaseMove!.delta, 10)
  })

  await check('buying several items writes one payment and one stock row each', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sugar = (await productByBarcode('6001234567892'))!
    const oil = (await productByBarcode('6001234567814'))!
    // 3 sugar × 1400 + 2 oil × 6000 = 16200 (Maluti).
    await buyStock(
      [{ productId: sugar.id, qty: 3 }, { productId: oil.id, qty: 2 }],
      1620000,
      'Wholesalers',
    )
    assert.equal(await cashBalance(), -1620000)
    assert.equal(await db.cashMovements.count(), 1, 'one purchase must be one payment')
    assert.equal((await productByBarcode('6001234567892'))!.stockQty, 43)
    assert.equal((await productByBarcode('6001234567814'))!.stockQty, 14)
    assert.equal(await db.stockMovements.where('reason').equals('purchase').count(), 2)
  })

  await check('buying stock refuses an empty list or a zero amount', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sugar = (await productByBarcode('6001234567892'))!
    await assert.rejects(buyStock([], 1000), /at least one/i)
    await assert.rejects(buyStock([{ productId: sugar.id, qty: 2 }], 0), /amount/i)
    assert.equal(await cashBalance(), 0, 'a rejected purchase still moved money')
    assert.equal((await productByBarcode('6001234567892'))!.stockQty, 40)
  })

  console.log('accounting exports')

  // One consistent day of books, reused by every export check below:
  // float 10,000 · money in 5,000 · bought sugar 10 @ 1,400 · sold sugar 4 @
  // 1,500 and oil 2 @ 6,500 · paid out 500 · owner took 3,000.
  // Expected: net profit 900, assets 140,900, equity 140,900, check 0.
  const bookUp = async () => {
    const tick = () => new Promise((r) => setTimeout(r, 3))
    await reset()
    await importProducts(csvFile(CSV))
    await setOpeningFloat(1000000) // M10,000
    await tick()
    const sugar = (await productByBarcode('6001234567892'))!
    await buyStock([{ productId: sugar.id, qty: 10 }], 1400000, 'Corner depot')
    await tick()
    await commitSale({
      lines: [await lineFor('6001234567892', 4)],
      paymentMethod: 'cash',
      amountTendered: 1000000,
    })
    await tick()
    await commitSale({
      lines: [await lineFor('6001234567814', 2)],
      paymentMethod: 'cash',
      amountTendered: 2000000,
    })
    await tick()
    await recordExpense(50000, 'Wages')
    await tick()
    await recordDrawing(300000, 'Banking')
    await tick()
    await recordCashIn(500000, 'From home')
  }

  await check('the statements export shows a P&L and a balanced balance sheet', async () => {
    await bookUp()
    const text = await (await exportStatementsCsv([businessDate()])).text()
    // Income statement: M19,000 sales − M17,600 cost − M500 expenses.
    assert.match(text, /Sales \(gross\),19000\.00/)
    assert.match(text, /Less: refunds \(voided sales\),0\.00/)
    assert.match(text, /Cost of goods sold \(at recorded cost\),17600\.00/)
    assert.match(text, /Gross profit,1400\.00/)
    assert.match(text, /"Expenses paid \(rent, transport\.\.\.\)",500\.00/)
    assert.match(text, /NET PROFIT,900\.00/)
    // Balance sheet: M140,900 of assets, M140,900 of equity.
    assert.match(text, /# Cash in drawer \(MWK\), 16500\.00/)
    assert.match(text, /# Stock in shop at cost \(MWK\), 124400\.00/)
    assert.match(text, /# Total assets \(MWK\), 140900\.00/)
    assert.match(text, /# Owner capital in \(float \+ money in\) \(MWK\), 15000\.00/)
    assert.match(text, /# Stock brought in \(opening\/import\) \(MWK\), 128000\.00/)
    assert.match(text, /# Retained profit, all time \(MWK\), 900\.00/)
    assert.match(text, /# Owner took \(MWK\), -3000\.00/)
    assert.match(text, /# Loans owed \(MWK\), 0\.00/)
    assert.match(text, /# CHECK - assets minus \(loans \+ equity\) \(MWK\), 0\.00/)
  })

  await check('the cash ledger export carries a true running balance', async () => {
    await bookUp()
    const text = await (await exportCashLedgerCsv([businessDate()])).text()
    assert.equal((text.match(/,Sale,/g) ?? []).length, 2, 'expected two sale rows')
    assert.match(text, /Bought stock,Corner depot,-14000\.00,-4000\.00/)
    // The running balance ends on the drawer figure (movements within the same
    // millisecond may reorder, so only the endpoint is fixed).
    assert.match(text, /Money in,From home,5000\.00,16500\.00/)
    assert.match(text, /# Cash in drawer now \(MWK\): 16500\.00/)
    assert.equal(await cashBalance(), 1650000, 'running balance disagrees with the ledger')
  })

  await check('the stock ledger export lists movements and a valuation', async () => {
    await bookUp()
    const start = new Date(`${businessDate()}T00:00:00`).getTime()
    const end = start + 86_400_000
    const text = await (await exportStockLedgerCsv(start, end)).text()
    assert.match(text, /Bought stock,10,1400\.00,14000\.00/)
    assert.match(text, /# Total stock value \(MWK\): 124400\.00/)
    assert.match(text, /Sugar 1kg,46,1400\.00,64400\.00/)
  })

  await check('the sales export carries cost and profit per line', async () => {
    await bookUp()
    const text = await (await exportSalesCsv([businessDate()])).text()
    assert.match(text, /6001234567892,Sugar 1kg,4,1500\.00,1400\.00,/)
    assert.match(text, /# Cost of goods sold \(MWK\): 17600/)
    assert.match(text, /# Gross profit \(MWK\): 1400/)
  })

  await check('borrowed money is a loan: repayments lower it and cannot overshoot', async () => {
    await reset()
    await recordCashIn(2000000, 'Mchenga loan', 'loan')
    assert.equal(await outstandingLoans(), 2000000)
    await recordCashIn(500000, 'From home', 'capital')
    assert.equal(await outstandingLoans(), 2000000, 'own money must not count as a loan')
    await recordLoanRepay(500000, 'Paid Mchenga')
    assert.equal(await outstandingLoans(), 1500000)
    await assert.rejects(
      recordLoanRepay(9990000),
      /Only 15000\.00 Maluti of loans is outstanding/,
    )
    assert.equal(await outstandingLoans(), 1500000, 'an over-repayment still moved money')
    const summary = summariseCash(await db.cashMovements.toArray())
    assert.equal(summary.loans, 1500000)
    assert.equal(summary.loanRepay, -500000)
    // The balance sheet must show the loan, not the owner's capital.
    const bsText = await (await exportStatementsCsv([businessDate()])).text()
    assert.match(bsText, /# Loans owed \(MWK\), 15000\.00/)
    // The Z-report export carries the loan position in its footer too.
    const csvText = await (await exportSalesCsv([businessDate()])).text()
    assert.match(csvText, /# Loan repayments \(MWK\): 5000/)
    assert.match(csvText, /# Loans owed \(MWK\): 15000/)
    // M20,000 borrowed, M5,000 repaid and M5,000 of the owner's own money in:
    // the drawer holds M20,000, none of it counted as capital or loans wrongly.
    assert.match(bsText, /# Cash in drawer \(MWK\), 20000\.00/)
    assert.match(bsText, /# Owner capital in \(float \+ money in\) \(MWK\), 5000\.00/)
  })

  await check('the books pack builds every record and the trial balance ties', async () => {
    await bookUp()
    const data = await loadBooksData()
    const tables = buildBookPack(data, [businessDate()])
    assert.equal(tables.length, 8)

    // Sales journal: one row per sale line.
    const journal = tables[0]!
    assert.equal(journal.title, 'Sales journal')
    assert.equal(journal.rows.length, 2)
    assert.ok(
      journal.rows.some((r) => r.join(',').includes('Sugar 1kg,4,1,500.00,6,000.00')),
      'sugar line missing from the sales journal',
    )
    assert.ok(
      journal.rows.some((r) => r.join(',').includes('Cooking Oil 1L,2,6,500.00,13,000.00')),
      'oil line missing from the sales journal',
    )
    assert.match(journal.notes[0]!, /Total of 2 lines \(M\): 19,000\.00/)

    // Receipts: float + money in + two sales, ending on the drawer figure.
    const receipts = tables[1]!
    assert.equal(receipts.rows.length, 4)
    assert.match(receipts.rows[3]!.join(','), /16,500\.00/)

    // Payments: the depot purchase, the wage, and the banking.
    const payments = tables[2]!
    assert.equal(payments.rows.length, 3)
    assert.match(payments.rows.join(','), /Corner depot,14,000\.00/)
    assert.match(payments.notes.join(','), /Owner took \(M\): 3,000\.00/)
    assert.match(payments.notes.join(','), /Total paid out \(M\): 17,500\.00/)

    // Trial balance: debits equal credits to the tambala.
    const tb = tables[3]!
    const total = tb.rows[tb.rows.length - 1]!
    assert.deepEqual(total, ['', 'TOTAL', '162,000.00', '162,000.00'])
    assert.match(tb.notes[0]!, /books balance/)

    // P&L and cash flow.
    const pnl = tables[4]!
    assert.match(pnl.rows.map((r) => r.join(',')).join('\n'), /NET PROFIT,900\.00/)
    const cf = tables[5]!
    assert.match(cf.rows.map((r) => r.join(',')).join('\n'), /CASH IN THE DRAWER AT THE END,16,500\.00/)

    // Balance sheet: assets equal liabilities + equity.
    const bs = tables[6]!
    const bsText = bs.rows.map((r) => r.join(',')).join('\n')
    assert.match(bsText, /TOTAL ASSETS,140,900\.00/)
    assert.match(bsText, /Loans owed,0\.00/)
    assert.match(bsText, /LIABILITIES \+ EQUITY,140,900\.00/)
    assert.match(bs.notes[0]!, /agree with the tin and the shelf/)

    // Inventory: movements plus the shelf, worth M124,400 now.
    const inv = tables[7]!
    assert.match(inv.rows.join(','), /Sugar 1kg,NOW|NOW,Sugar 1kg/)
    assert.match(inv.notes[0]!, /Stock in the shop now is worth \(M\): 124,400\.00/)
  })

  await check('a refunded sale nets to zero in the books pack', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sale = await commitSale({
      lines: [await lineFor('6001234567892', 2)], // Sugar 1kg × 1,500 = 3,000
      paymentMethod: 'cash',
      amountTendered: 500000, // tendered M5,000
    })
    await voidSale(sale.id, 'wrong item')

    const data = await loadBooksData()
    const tables = buildBookPack(data, [businessDate()])

    // The drawer ends exactly where it started: cash out with the refund.
    assert.equal(await cashBalance(), 0, 'refund brought the drawer back to zero')

    // Receipts: the sale goes in, the void comes straight back out.
    const receipts = tables[1]!
    assert.equal(receipts.rows.length, 2)
    assert.match(receipts.rows[0]!.join(','), /3,000\.00,,3,000\.00$/, 'sale in, running balance 3,000')
    assert.match(receipts.rows[1]!.join(','), /0\.00,3,000\.00,0\.00$/, 'refund out, running balance 0')

    // P&L: gross revenue and the refund cancel; no cost books because the
    // sale was never completed.
    const pnl = tables[4]!
    const pnlText = pnl.rows.map((r) => r.join(',')).join('\n')
    assert.match(pnlText, /Sales \(gross, before refunds\),3,000\.00/)
    assert.match(pnlText, /Less: refunds \(voided sales\),-3,000\.00/)
    assert.match(pnlText, /NET REVENUE,0\.00/)
    assert.match(pnlText, /NET PROFIT,0\.00/)

    // Cash flow: nothing came in and nothing went out when the dust settles.
    const cf = tables[5]!
    const cfText = cf.rows.map((r) => r.join(',')).join('\n')
    assert.match(cfText, /NET CHANGE IN CASH,0\.00/)
    assert.match(cfText, /CASH IN THE DRAWER AT THE END,0\.00/)
  })

  await check('the books PDF downloads as a real PDF', async () => {
    await bookUp()
    await saveShopName('Maluti Traders')
    const blob = await exportBooksPdf([businessDate()])
    assert.ok(blob.type === 'application/pdf', `wrong blob type: ${blob.type}`)
    const buf = Buffer.from(await blob.arrayBuffer())
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-', 'not a PDF header')
    assert.ok(buf.length > 5000, `suspiciously small PDF: ${buf.length} bytes`)
  })

  console.log('sync config')

  await check('sync config round-trips, normalises the URL, and turning it off clears it', async () => {
    await reset()
    assert.equal(await loadSyncConfig(), null)
    assert.equal(normalizeProjectUrl('demo.supabase.co/'), 'https://demo.supabase.co')
    assert.equal(normalizeProjectUrl('https://demo.supabase.co//'), 'https://demo.supabase.co')
    assert.equal(normalizeProjectUrl('  '), '')

    await saveSyncConfig({ url: 'demo.supabase.co/', anonKey: '  anon  ', email: ' shop@example.com ' })
    const cfg = await loadSyncConfig()
    assert.equal(cfg?.url, 'https://demo.supabase.co')
    assert.equal(cfg?.anonKey, 'anon')
    assert.equal(cfg?.email, 'shop@example.com')

    await disableSync()
    assert.equal(await loadSyncConfig(), null, 'disable did not clear the config')
    assert.equal(await loadLastSyncAt(), null, 'disable left a last-sync stamp behind')
  })

  await check('a config with no URL or key reads as not configured', async () => {
    await reset()
    await saveSyncConfig({ url: '', anonKey: 'anon' })
    assert.equal(await loadSyncConfig(), null)
    await saveSyncConfig({ url: 'https://demo.supabase.co', anonKey: '' })
    assert.equal(await loadSyncConfig(), null)
  })

  await check('the sync cursor round-trips and a damaged one reads as empty', async () => {
    await reset()
    assert.deepEqual(await loadCursors(), {})
    await saveCursors({ products: 12, sale_lines: 40 })
    assert.deepEqual(await loadCursors(), { products: 12, sale_lines: 40 })

    await setLastSyncAt(1_700_000_000_000)
    assert.equal(await loadLastSyncAt(), 1_700_000_000_000)

    await db.settings.clear()
    await db.settings.put({
      id: 'bad',
      key: 'sync.cursor',
      value: '{oops',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      deviceId: 'd',
    })
    assert.deepEqual(await loadCursors(), {}, 'a damaged cursor blocked the pull')
  })

  await check('a malformed stored config is ignored rather than crashing', async () => {
    await db.settings.clear()
    await db.settings.put({
      id: 'x',
      key: 'sync.config',
      value: '{not json',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      deviceId: 'd',
    })
    assert.equal(await loadSyncConfig(), null)
  })

  console.log('shared settings')

  await check('only shop-wide keys are allowed to sync', () => {
    assert.equal(isSharedSettingKey('report.shopName'), true)
    assert.equal(isSharedSettingKey('security.credential'), false)
    assert.equal(isSharedSettingKey('security.biometric'), false)
    assert.equal(isSharedSettingKey('sync.config'), false)
  })

  await check('a private setting cannot be written through the shared path', async () => {
    await reset()
    await assert.rejects(
      saveSharedSetting('security.credential', 'hunter2'),
      /not a shared setting/,
    )
    assert.equal(await db.outbox.count(), 0, 'a lock was queued for the cloud')
  })

  await check('a shop-wide setting gets a stable id and one coalesced queue row', async () => {
    await reset()
    await saveSharedSetting('report.shopName', 'Maluti Traders')
    await saveSharedSetting('report.shopName', 'Maluti Traders Ltd')

    const rows = await db.settings.where('key').equals('report.shopName').toArray()
    assert.equal(rows.length, 1, 'the shop name duplicated instead of updating')
    assert.equal(rows[0]!.id, 'report.shopName', 'the row id is not stable across devices')
    assert.equal(await loadShopName(), 'Maluti Traders Ltd')

    const queued = await db.outbox.where('entity').equals('settings').toArray()
    assert.equal(queued.length, 1, 'two edits did not coalesce into one queue row')
    assert.equal(queued[0]!.entityId, 'report.shopName')
  })

  await check('a shop-name row from an older build is replaced, not shadowed', async () => {
    await reset()
    await db.settings.put({
      id: 'legacy-uuid',
      key: 'report.shopName',
      value: 'Old name',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      deviceId: 'd',
    })
    await saveSharedSetting('report.shopName', 'New name')
    const rows = await db.settings.where('key').equals('report.shopName').toArray()
    assert.equal(rows.length, 1, 'the legacy row was left behind to shadow the new one')
    assert.equal(rows[0]!.id, 'report.shopName')
    assert.equal(await loadShopName(), 'New name')
  })

  console.log('merge rules')

  await check('the newest edit wins and an older remote copy is ignored', () => {
    const base = { createdAt: 1, deletedAt: null, rev: 1, deviceId: 'device-a' }
    assert.equal(remoteWins({ ...base, id: 'p', updatedAt: 5000 }, { ...base, id: 'p', updatedAt: 6000 }), true)
    assert.equal(remoteWins({ ...base, id: 'p', updatedAt: 5000 }, { ...base, id: 'p', updatedAt: 4000 }), false)
    // Same millisecond: the higher revision wins.
    assert.equal(remoteWins({ ...base, id: 'p', updatedAt: 5000, rev: 2 }, { ...base, id: 'p', updatedAt: 5000, rev: 3 }), true)
    // Same millisecond and revision: the smaller device id wins, so every
    // device reaches the same answer without talking to the others.
    assert.equal(remoteWins({ ...base, id: 'p', updatedAt: 5000, deviceId: 'bbb' }, { ...base, id: 'p', updatedAt: 5000, deviceId: 'aaa' }), true)
    assert.equal(remoteWins({ ...base, id: 'p', updatedAt: 5000, deviceId: 'aaa' }, { ...base, id: 'p', updatedAt: 5000, deviceId: 'bbb' }), false)
  })

  await check('server-only columns are stripped before a row is stored', async () => {
    await reset()
    const row = { ...remoteProduct({ id: 'p6' }), serverSeq: 42, serverUpdatedAt: '2026-01-01' }
    assert.equal('serverSeq' in stripServerFields(row), false)
    await applyRemoteRow('products', row)
    const stored = (await db.products.get('p6')) as unknown as Record<string, unknown>
    assert.equal('serverSeq' in stored, false, 'the pull cursor leaked into IndexedDB')
    assert.equal('serverUpdatedAt' in stored, false)
  })

  await check('a remote row with no local copy is written and never queued back', async () => {
    await reset()
    const applied = await applyRemoteRow('products', remoteProduct({ id: 'p1', name: 'Remote sugar' }))
    assert.equal(applied, true)
    assert.equal((await db.products.get('p1'))!.name, 'Remote sugar')
    assert.equal(await db.outbox.count(), 0, 'a pulled row was queued straight back to the server')
  })

  await check('a pull applies the newest product edit over an older local one', async () => {
    await reset()
    await db.products.put(remoteProduct({ id: 'p2', name: 'Local', updatedAt: 5000 }) as unknown as Product)
    assert.equal(await applyRemoteRow('products', remoteProduct({ id: 'p2', name: 'Older', updatedAt: 4000 })), false)
    assert.equal((await db.products.get('p2'))!.name, 'Local', 'an older remote edit overwrote a newer one')
    assert.equal(await applyRemoteRow('products', remoteProduct({ id: 'p2', name: 'Newer', updatedAt: 6000 })), true)
    assert.equal((await db.products.get('p2'))!.name, 'Newer')
  })

  await check('an unsynced local edit is never overwritten by a pull', async () => {
    await reset()
    await db.products.put(remoteProduct({ id: 'p3', name: 'Mine', updatedAt: 1000 }) as unknown as Product)
    await queueEntity('products', 'p3', 'upsert', { id: 'p3' })
    assert.equal(await isPendingLocally('products', 'p3'), true)
    assert.equal(
      await applyRemoteRow('products', remoteProduct({ id: 'p3', name: 'Theirs', updatedAt: 9000 })),
      false,
      'a pull clobbered an edit that had not been pushed yet',
    )
    assert.equal((await db.products.get('p3'))!.name, 'Mine')
  })

  await check('a tombstone from another device hides the product here too', async () => {
    await reset()
    await db.products.put(remoteProduct({ id: 'p5', name: 'Gone soon' }) as unknown as Product)
    assert.equal(
      await applyRemoteRow('products', remoteProduct({ id: 'p5', name: 'Gone soon', updatedAt: 2000, deletedAt: 2000 })),
      true,
    )
    const row = (await db.products.get('p5'))!
    assert.equal(row.deletedAt, 2000)
    assert.equal((await db.products.toArray()).filter((p) => p.deletedAt == null).length, 0)
  })

  await check('a pulled settings row is refused unless its key is shared', async () => {
    await reset()
    const meta = {
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      deviceId: 'd',
      shopId: 'shop-a',
    }
    assert.equal(
      await applyRemoteRow('settings', { id: 'security.credential', key: 'security.credential', value: '{"v":1}', ...meta }),
      false,
    )
    assert.equal(await db.settings.count(), 0, 'a pulled row changed the app lock')
    assert.equal(
      await applyRemoteRow('settings', { id: 'report.shopName', key: 'report.shopName', value: 'Maluti Traders', ...meta }),
      true,
    )
    assert.equal(await loadShopName(), 'Maluti Traders')
    assert.equal(await db.outbox.count(), 0, 'a pulled setting was queued back')
  })

  await check('a pulled row from another shop is refused', async () => {
    await reset()
    const applied = await applyRemoteRow('products', {
      ...remoteProduct({ id: 'foreign-product' }),
      shopId: 'shop-b',
    })
    assert.equal(applied, false, 'a shop B row was written into shop A')
    assert.equal(await db.products.get('foreign-product'), undefined)
  })

  console.log('receipt labels')

  await check('labelling a till changes the shape of its receipt numbers', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    assert.equal(await loadTillLabel(), '', 'a fresh device should not be labelled')
    assert.equal(cleanTillLabel(' b1 '), 'B1')
    assert.equal(cleanTillLabel('a-b/2'), 'AB2')

    await saveTillLabel('b1')
    assert.equal(await loadTillLabel(), 'B1')
    const sale = await commitSale({
      lines: [await lineFor('6001234567892', 1)],
      paymentMethod: 'cash',
      amountTendered: 200000,
    })
    assert.equal(sale.receiptNo, 'B1-0001', 'the label was not printed on the receipt')

    await saveTillLabel('')
    assert.equal(await loadTillLabel(), '')
  })

  await check("a till's numbering counts only its own sales, not another till's", async () => {
    await reset()
    await importProducts(csvFile(CSV))
    await saveTillLabel('A')

    // A sale that arrived from another device, already numbered on that device.
    await db.sales.put({
      id: 'other-1',
      receiptNo: 'B-0001',
      businessDate: businessDate(),
      subtotal: 1,
      total: 1,
      paymentMethod: 'cash',
      amountTendered: 1,
      change: 0,
      status: 'completed',
      voidedAt: null,
      note: '',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      deviceId: 'other-device',
    })

    const first = await commitSale({
      lines: [await lineFor('6001234567892', 1)],
      paymentMethod: 'cash',
      amountTendered: 200000,
    })
    const second = await commitSale({
      lines: [await lineFor('6001234567892', 1)],
      paymentMethod: 'cash',
      amountTendered: 200000,
    })
    assert.equal(first.receiptNo, 'A-0001', "another till's sale shifted this till's numbering")
    assert.equal(second.receiptNo, 'A-0002')

    await saveTillLabel('')
  })

  console.log('app lock')

  await check('a saved PIN verifies without storing the secret or queueing a sync row', async () => {
    await reset()
    assert.equal(await loadCredential(), null)

    const saved = await saveCredential('pin', '482913')
    const loaded = await loadCredential()
    assert.ok(loaded, 'the credential did not survive the round-trip')
    assert.equal(saved.kind, 'pin')
    assert.equal(loaded!.kind, 'pin')
    assert.equal(loaded!.length, 6)
    assert.equal(await verifySecret(loaded!, '482913'), true)
    assert.equal(await verifySecret(loaded!, '000000'), false)
    assert.equal(await db.outbox.count(), 0, 'the lock was queued for cloud sync')

    const rows = await db.settings.toArray()
    assert.ok(
      !JSON.stringify(rows).includes('482913'),
      'the PIN was written to the database in the clear',
    )
  })

  await check('a malformed stored credential is ignored rather than locking the till', async () => {
    await reset()
    await db.settings.put({
      id: 'bad',
      key: 'security.credential',
      value: '{"v":1,"kind":"pin","length":6}',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      deviceId: 'd',
    })
    assert.equal(await loadCredential(), null, 'a damaged credential blocked the app')
  })

  await check('a new secret and removing the lock both drop biometrics', async () => {
    await saveBiometric({ credentialId: 'cred-1', userHandle: 'user-1' })
    assert.equal((await loadBiometric())?.credentialId, 'cred-1')

    await saveCredential('password', 'open sesame')
    assert.equal((await loadCredential())?.kind, 'password')
    assert.equal(await loadBiometric(), null, 'a new secret left the old finger enrolled')

    await saveBiometric({ credentialId: 'cred-2', userHandle: 'user-2' })
    await removeBiometric()
    assert.equal(await loadBiometric(), null)

    await saveBiometric({ credentialId: 'cred-3', userHandle: 'user-3' })
    await removeCredential()
    assert.equal(await loadCredential(), null, 'the lock was not removed')
    assert.equal(await loadBiometric(), null, 'biometrics outlived the lock')
  })

  await check('a legacy lock becomes the owner account without losing biometrics', async () => {
    await reset()
    const legacy = await saveCredential('password', 'owner-pass-123')
    await saveBiometric({ credentialId: 'cred-1', userHandle: 'user-1' })

    const staff = await loadStaff()
    assert.equal(staff.length, 1, 'migration created more than one account')
    const owner = staff[0]!
    assert.equal(owner.id, OWNER_ACCOUNT_ID)
    assert.equal(owner.role, 'owner')
    assert.equal(owner.name, 'Owner')
    assert.equal(await verifySecret(owner.credential, 'owner-pass-123'), true)
    assert.equal((await loadCredential())?.hash, legacy.hash, 'the legacy lock changed')
    assert.equal((await loadBiometric())?.credentialId, 'cred-1', 'migration dropped biometrics')
    assert.equal(await db.outbox.count(), 0, 'the roster was queued for cloud sync')
    assert.equal((await loadStaff()).length, 1, 'a second boot duplicated the owner')
  })

  await check('the owner is forced onto a password before a cashier can be added', async () => {
    await reset()
    await saveCredential('pin', '482913')
    await assert.rejects(addCashier('Thabo', 'pin', '246813'), /owner password/i)

    const owner = (await loadStaff()).find((a) => a.role === 'owner')!
    await assert.rejects(
      changeStaffSecret({
        accountId: owner.id,
        currentSecret: '482913',
        kind: 'pin',
        secret: '111111',
      }),
      /owner must use a password/i,
    )

    await changeStaffSecret({
      accountId: owner.id,
      currentSecret: '482913',
      kind: 'password',
      secret: 'owner-pass-123',
    })
    const upgraded = (await loadStaff()).find((a) => a.role === 'owner')!
    assert.equal(upgraded.credential.kind, 'password')
    assert.equal(await verifySecret(upgraded.credential, 'owner-pass-123'), true)
    assert.equal(await verifySecret(upgraded.credential, '482913'), false)

    const cashier = await addCashier('Thabo', 'pin', '246813')
    assert.equal(cashier.role, 'cashier')
    const roster = await loadStaff()
    assert.equal(roster.length, 2)
    assert.equal(roster[1]!.name, 'Thabo')
    assert.equal(await db.outbox.count(), 0, 'a staff account was queued for cloud sync')
    assert.ok(!JSON.stringify(await db.settings.toArray()).includes('246813'))
  })

  await check('the owner can reset a cashier and remove the last one', async () => {
    await reset()
    await createOwner('Owner', 'owner-pass-123')
    const cashier = await addCashier('Thabo', 'pin', '246813')

    await changeStaffSecret({ accountId: cashier.id, kind: 'pin', secret: '135724' })
    const after = (await loadStaff()).find((a) => a.id === cashier.id)!
    assert.equal(await verifySecret(after.credential, '135724'), true)
    assert.equal(await verifySecret(after.credential, '246813'), false)

    await assert.rejects(removeAllStaff('owner-pass-123'), /cashier/i)
    await removeCashier(cashier.id)
    assert.equal((await loadStaff()).length, 1)

    await assert.rejects(removeAllStaff('wrong-password'), /incorrect/i)
    await removeAllStaff('owner-pass-123')
    assert.equal((await loadStaff()).length, 0)
    assert.equal(await loadCredential(), null, 'the legacy lock outlived the roster')
    assert.equal(await db.outbox.count(), 0)
  })

  await check('a sale records the cashier and the export names the cashier', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    const sale = await commitSale({
      lines: [await lineFor('6001234567892', 1)],
      paymentMethod: 'cash',
      amountTendered: 200000,
      cashierName: '  Thabo  ',
    })
    assert.equal(sale.cashierName, 'Thabo')

    const csv = await (await exportSalesCsv([businessDate()])).text()
    assert.match(csv, /^date,receipt_no,time,cashier,/m)
    assert.match(csv, /,Thabo,/)

    const data = await loadBooksData()
    const tables = buildBookPack(data, [businessDate()])
    const journal = tables.find((t) => t.title === 'Sales journal')!
    assert.equal(journal.columns.at(-1), 'Cashier')
    assert.equal(journal.rows.at(-1)?.at(-1), 'Thabo')
  })

  await check('the recovery backup carries records but no lock or sync secrets', async () => {
    await reset()
    await importProducts(csvFile(CSV))
    await saveShopName('Maluti Traders')
    await saveCredential('pin', '482913')
    await saveBiometric({ credentialId: 'cred-1', userHandle: 'user-1' })
    await saveSyncConfig({
      url: 'https://demo.supabase.co',
      anonKey: 'anon',
      email: 'shop@example.com',
    })
    await db.outbox.add({
      entity: 'settings',
      entityId: 'security.staff',
      op: 'upsert',
      payload: JSON.stringify({ key: 'security.staff', value: 'secret-staff-hash' }),
      createdAt: Date.now(),
      attempts: 0,
      lastError: null,
    })

    const backup = await buildBackup()
    assert.equal(backup.tables.products.length, 3, 'products missing from the backup')
    const keys = backup.tables.settings.map((s) => s.key)
    assert.ok(keys.includes('report.shopName'), 'business settings were dropped')
    assert.ok(!keys.includes('sync.config'), 'the sync token was included')
    assert.ok(!keys.some((key) => key.startsWith('security.')), 'lock settings were included')
    assert.ok(
      backup.tables.outbox.every((item) => !item.payload.includes('security.staff')),
      'a queued lock setting leaked into the outbox backup',
    )

    const raw = JSON.stringify(backup)
    assert.ok(!raw.includes('482913'), 'the PIN leaked into the backup')
    assert.ok(!raw.includes('shop@example.com'), 'the shop login leaked into the backup')
    assert.ok(!raw.includes('secret-staff-hash'), 'a queued secret leaked into the backup')
  })

  console.log('shops')

  await check('a new shop is a separate database seeded with the owner only', async () => {
    await reset()
    assert.equal(getActiveDbName(), 'till-pos', 'shop A must keep the existing database')

    await createOwner('Owner', 'owner-pass-123')
    await addCashier('Cashier A', 'pin', '1234')
    const ownerA = (await loadStaff()).find((a) => a.role === 'owner')!
    await importProducts(csvFile(CSV))

    const profile = await addShop({ name: 'Second Shop', code: 'shop-b-test' })
    assert.equal(profile.id, 'shop-b-test')
    assert.equal(profile.dbName, 'till-pos-shop-b-test')
    assert.ok(
      listShops().some((shop) => shop.id === 'shop-b-test'),
      'the new shop was not added to the picker',
    )

    const second = new TillDatabase(profile.dbName)
    try {
      await second.open()
      assert.equal(await second.products.count(), 0, 'shop A products were copied')
      assert.equal(await second.sales.count(), 0, 'shop A sales were copied')

      const staffRow = await second.settings.where('key').equals(STAFF_KEY).first()
      assert.ok(staffRow, 'the new shop has no staff roster')
      const staff = parseStaffRoster(staffRow.value)
      assert.equal(staff.length, 1, 'a cashier or extra owner was copied')
      assert.equal(staff[0]!.role, 'owner')
      assert.notEqual(staff[0]!.id, ownerA.id, 'the owner id was reused across shops')
      assert.equal(
        staff[0]!.credential.hash,
        ownerA.credential.hash,
        'the owner password was not copied',
      )
      assert.equal(
        await verifySecret(staff[0]!.credential, 'owner-pass-123'),
        true,
        'the owner password does not open the new shop',
      )

      const nameRow = await second.settings.where('key').equals('report.shopName').first()
      assert.equal(nameRow?.id, 'report.shopName', 'the shop name row key is not stable')
      assert.equal(nameRow?.value, 'Second Shop')
      assert.equal(await second.outbox.count(), 1, 'the shop name was not queued for sync')
    } finally {
      second.close()
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
  await db.close()
}

main().catch((err) => {
  console.error('FAIL  test harness crashed')
  console.error(err)
  process.exitCode = 1
})
