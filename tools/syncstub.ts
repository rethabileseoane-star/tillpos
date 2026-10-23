/**
 * Sync transport check.
 *
 * `tools/itest.ts` proves the merge rules, but it never opens a connection, so
 * a wrong query or a wrong request shape would still ship. This runs the real
 * engine — the real Supabase client, the real outbox, the real Dexie database —
 * against a stub that speaks the same HTTP surface as Supabase/PostgREST:
 *
 *   POST /auth/v1/token?grant_type=password   -> a session
 *   POST /rest/v1/<table>                     -> upsert (merge-duplicates)
 *   GET  /rest/v1/<table>?select=*&...        -> rows above a cursor, ordered
 *
 * What it pins down:
 *   - a queued row reaches the right table, parents before children
 *   - an upsert is idempotent, so a re-run is harmless
 *   - a pull applies another device's row and recomputes cached stock from the
 *     merged movement ledger
 *   - a pulled row is never queued back, and the cursor stops a second pull
 *
 * Run with: npm run test:sync
 */
import './setup-env'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { db, withSyncMeta } from '../src/db'
import type { Product, Sale, SaleLine, StockMovement } from '../src/db/types'
import { queueEntity } from '../src/sync/outbox'
import { saveSyncConfig } from '../src/sync/config'
import { getClient, forgetClient, signIn } from '../src/sync/client'
import { syncNow } from '../src/sync/engine'

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

// ---------------------------------------------------------------------------
// A stub PostgREST + GoTrue
// ---------------------------------------------------------------------------

interface StoredRow extends Record<string, unknown> {
  id: string
  serverSeq: number
}

const tables = new Map<string, Map<string, StoredRow>>()
/** Table names in the order writes arrived, to prove parent-before-child. */
const writeOrder: string[] = []
/** Every query string the app asked for, to check the pull really filters. */
const queries: string[] = []
let sequence = 0

function tableOf(name: string): Map<string, StoredRow> {
  let t = tables.get(name)
  if (!t) {
    t = new Map()
    tables.set(name, t)
  }
  return t
}

/** Simulate another device writing a row straight into the cloud. */
function deviceWrite(name: string, row: Record<string, unknown>): void {
  sequence += 1
  tableOf(name).set(String(row.id), {
    ...row,
    serverSeq: sequence,
    serverUpdatedAt: new Date().toISOString(),
  } as StoredRow)
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = body === null ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const SESSION = {
  access_token: 'stub-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'stub-refresh-token',
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'shop@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: new Date().toISOString(),
  },
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub')

  if (url.pathname.startsWith('/auth/v1/token')) {
    return reply(res, 200, SESSION)
  }
  if (url.pathname === '/auth/v1/user') {
    return reply(res, 200, SESSION.user)
  }
  if (url.pathname === '/auth/v1/logout') {
    return reply(res, 204, null)
  }

  const match = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)
  if (!match) return reply(res, 404, { message: 'not found' })

  const name = match[1]!
  queries.push(`${req.method} ${name}?${url.searchParams.toString()}`)

  if (req.method === 'GET') {
    const raw = url.searchParams.get('serverSeq') ?? ''
    const cursor = raw.startsWith('gt.') ? Number(raw.slice(3)) : 0
    const limit = Number(url.searchParams.get('limit') ?? '1000')
    const rows = [...tableOf(name).values()]
      .filter((row) => row.serverSeq > cursor)
      .sort((a, b) => a.serverSeq - b.serverSeq)
      .slice(0, limit)
    return reply(res, 200, rows)
  }

  if (req.method === 'POST') {
    const body = await readBody(req)
    const rows = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[]
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const id = String(row.id)
      const existing = tableOf(name).get(id)
      sequence += 1
      // Upsert semantics: merge by primary key, then re-stamp the cursor.
      tableOf(name).set(id, {
        ...(existing ?? {}),
        ...row,
        serverSeq: sequence,
        serverUpdatedAt: new Date().toISOString(),
      } as StoredRow)
      writeOrder.push(name)
    }
    return reply(res, 201, null)
  }

  return reply(res, 405, { message: 'method not allowed' })
})

// ---------------------------------------------------------------------------

async function resetLocal(): Promise<void> {
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

const DAY = '2026-01-05'

async function seedThisDevice(): Promise<void> {
  const product = withSyncMeta(undefined, {
    barcode: '6001234567892',
    barcodes: ['6001234567892'],
    name: 'Sugar 1kg',
    price: 150000,
    cost: 140000,
    stockQty: 0,
    lowStockThreshold: 10,
    category: 'Grocery',
    active: true,
  }) as Product
  product.stockQty = 40
  await db.products.put(product)
  await queueEntity('products', product.id, 'upsert', product)

  const sale = withSyncMeta(undefined, {
    receiptNo: 'A-0001',
    businessDate: DAY,
    subtotal: 3 * 150000,
    total: 3 * 150000,
    paymentMethod: 'cash' as const,
    amountTendered: 500000,
    change: 500000 - 3 * 150000,
    status: 'completed' as const,
    voidedAt: null,
    note: '',
  }) as Sale
  await db.sales.put(sale)
  await queueEntity('sales', sale.id, 'upsert', sale)

  const line = withSyncMeta(undefined, {
    saleId: sale.id,
    productId: product.id,
    barcode: '6001234567892',
    name: 'Sugar 1kg',
    unitPrice: 150000,
    qty: 3,
    lineTotal: 450000,
    adHoc: false,
  }) as SaleLine
  await db.saleLines.put(line)
  await queueEntity('sale_lines', line.id, 'upsert', line)

  const movement = withSyncMeta(undefined, {
    productId: product.id,
    delta: 40,
    reason: 'opening' as const,
    refId: null,
    note: 'Opening stock',
  }) as StockMovement
  await db.stockMovements.put(movement)
  await queueEntity('stock_movements', movement.id, 'upsert', movement)
}

async function main() {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  await resetLocal()
  await saveSyncConfig({
    url: `http://127.0.0.1:${port}`,
    anonKey: 'stub-anon-key',
    email: 'shop@example.com',
  })
  forgetClient()

  console.log('sign in')
  await check('the shop account signs in and the session survives', async () => {
    const result = await signIn('shop@example.com', 'correct horse')
    assert.equal(result.ok, true, result.error)
    const client = await getClient()
    const { data } = await client!.auth.getSession()
    assert.equal(data.session?.user.email, 'shop@example.com')
  })

  console.log('push')
  await check('a sync sends this device’s queued rows and empties the queue', async () => {
    await seedThisDevice()
    const outcome = await syncNow()
    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(outcome.pushed, 4)
    assert.equal(await db.outbox.count(), 0, 'the queue was not emptied')
    assert.equal(tableOf('products').size, 1)
    assert.equal(tableOf('sales').size, 1)
    assert.equal(tableOf('sale_lines').size, 1)
    assert.equal(tableOf('stock_movements').size, 1)
  })

  await check('a sale lands before its lines, so the foreign key holds', () => {
    const sale = writeOrder.indexOf('sales')
    const line = writeOrder.indexOf('sale_lines')
    assert.ok(sale !== -1 && line !== -1, `missing writes: ${writeOrder.join(', ')}`)
    assert.ok(sale < line, `sale_lines was written first: ${writeOrder.join(', ')}`)
  })

  await check('the pull asks only for rows above the cursor, in order', () => {
    const pulls = queries.filter((q) => q.startsWith('GET'))
    assert.ok(pulls.length > 0, 'no pull was issued')
    for (const query of pulls) {
      assert.match(query, /select=\*/, `pull did not select every column: ${query}`)
      assert.match(query, /serverSeq=gt\.\d+/, `pull did not filter by cursor: ${query}`)
      assert.match(query, /order=serverSeq\.asc/, `pull did not order by cursor: ${query}`)
    }
  })

  console.log('pull')
  await check('another device’s new row arrives and its stock is rebuilt from the ledger', async () => {
    // Device B adds a product with a stale cache and one opening movement.
    const remote = withSyncMeta(undefined, {
      barcode: '6009999999999',
      barcodes: ['6009999999999'],
      name: 'Remote salt',
      price: 80000,
      cost: 70000,
      stockQty: 0, // deliberately wrong; the ledger says 5
      lowStockThreshold: 0,
      category: 'Grocery',
      active: true,
    }) as Product
    deviceWrite('products', remote)
    deviceWrite('stock_movements', {
      id: 'remote-move-1',
      productId: remote.id,
      delta: 5,
      reason: 'opening',
      refId: null,
      note: 'Opening stock',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      deviceId: 'device-b',
    })

    const outcome = await syncNow()
    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(outcome.pulled, 2, `expected 2 rows, pulled ${outcome.pulled}`)

    const pulled = await db.products.get(remote.id)
    assert.ok(pulled, 'the other device’s product did not arrive')
    assert.equal(pulled!.name, 'Remote salt')
    assert.equal(pulled!.stockQty, 5, 'cached stock was not rebuilt from the merged ledger')
  })

  await check('another device’s newer edit wins', async () => {
    const local = (await db.products.where('barcode').equals('6001234567892').first())!
    const newer = {
      ...local,
      name: 'Sugar 1kg (new bag)',
      updatedAt: local.updatedAt + 5000,
      rev: local.rev + 1,
      deviceId: 'device-b',
    }
    deviceWrite('products', newer as unknown as Record<string, unknown>)

    const outcome = await syncNow()
    assert.equal(outcome.ok, true, outcome.error)
    const after = (await db.products.get(local.id))!
    assert.equal(after.name, 'Sugar 1kg (new bag)', 'the newest remote edit did not win')
  })

  await check('an older remote copy loses to a newer local edit', async () => {
    const local = (await db.products.where('barcode').equals('6001234567892').first())!
    // This device edits after the other one did. The other device's copy is
    // therefore still in the cloud, older, waiting to be pulled.
    const newerLocal = { ...local, name: 'Sugar 1kg (mine)', updatedAt: local.updatedAt + 5000, rev: local.rev + 1 }
    await db.products.put(newerLocal)

    const stale = {
      ...local,
      name: 'Sugar (stale)',
      updatedAt: local.updatedAt + 1000,
      rev: local.rev + 1,
      deviceId: 'device-b',
    }
    deviceWrite('products', stale as unknown as Record<string, unknown>)

    await syncNow()
    const after = (await db.products.get(local.id))!
    assert.equal(after.name, 'Sugar 1kg (mine)', 'an older remote copy overwrote a newer local edit')
  })

  await check('a pulled row is never queued back, and the cursor stops a re-pull', async () => {
    assert.equal(await db.outbox.count(), 0, 'the pull leaked rows into the outbox')

    const before = tableOf('products').size + tableOf('stock_movements').size
    const again = await syncNow()
    assert.equal(again.ok, true, again.error)
    assert.equal(again.pulled, 0, 'the same rows were pulled twice')
    assert.equal(again.pushed, 0, 'a pulled row was pushed back to the cloud')
    assert.equal(tableOf('products').size + tableOf('stock_movements').size, before)
    assert.equal(await db.outbox.count(), 0)
  })

  await check('a re-sync of the same rows is idempotent', async () => {
    const productCount = tableOf('products').size
    const local = await db.products.toArray()
    for (const row of local) await queueEntity('products', row.id, 'upsert', row)
    const outcome = await syncNow()
    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(tableOf('products').size, productCount, 'an upsert created a duplicate row')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1

  await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.close()
}

main().catch((err) => {
  console.error('FAIL  sync check crashed')
  console.error(err)
  process.exitCode = 1
  server.close()
})
