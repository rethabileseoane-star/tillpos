import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { db, withSyncMeta } from '@/db'
import type { Product, ProductDraft } from '@/db/types'
import { parseAmount, type Cents } from '@/domain/money'
import { normalizeBarcode, isValidBarcode } from '@/domain/barcode'
import { queueEntity } from '@/sync/outbox'

export interface ImportResult {
  created: number
  updated: number
  skipped: number
  errors: { row: number; barcode: string; reason: string }[]
  /** Barcodes seen more than once in the file. */
  duplicates: string[]
}

const COLUMN_ALIASES: Record<keyof ProductDraft | 'barcodes' | 'details' | 'barcode', string[]> = {
  barcode: ['barcode', 'ean', 'ean13', 'upc', 'upca', 'code', 'sku', 'item code'],
  barcodes: ['barcodes', 'additional barcodes', 'alias barcodes', 'other barcodes'],
  name: ['name', 'item', 'product', 'description', 'item name'],
  details: ['details', 'product details', 'description', 'notes', 'item details'],
  price: ['price', 'amount', 'unit price', 'selling price', 'rate'],
  cost: ['cost', 'cost price', 'unit cost', 'buy price', 'purchase price', 'what we paid'],
  stockQty: ['stock', 'qty', 'quantity', 'stock qty', 'on hand', 'count'],
  lowStockThreshold: ['low stock', 'lowstock', 'reorder', 'min', 'threshold'],
  category: ['category', 'cat', 'group', 'department', 'section'],
}

/** Accept the obvious header spellings so most files work with no mapping UI. */
function mapHeaders(fields: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const raw of fields) {
    const normalized = String(raw).toLowerCase().replace(/[_\s]+/g, ' ').trim()
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.some((a) => a.replace(/[_\s]+/g, ' ') === normalized)) {
        map[key] = raw
        break
      }
    }
  }
  return map
}

function rowsToDrafts(rows: Record<string, unknown>[]): {
  drafts: ProductDraft[]
  errors: ImportResult['errors']
  duplicates: string[]
} {
  const first = rows[0] ?? {}
  const headerMap = mapHeaders(Object.keys(first))
  const errors: ImportResult['errors'] = []
  const drafts: ProductDraft[] = []
  const seen = new Map<string, number>()
  const seenDuplicates = new Set<string>()

  const registerBarcode = (barcode: string, rowNo: number): boolean => {
    if (!barcode || !isValidBarcode(barcode)) return false
    if (seen.has(barcode)) {
      seenDuplicates.add(barcode)
      errors.push({ row: rowNo, barcode, reason: `duplicate of row ${seen.get(barcode)}` })
      return false
    }
    seen.set(barcode, rowNo)
    return true
  }

  rows.forEach((row, i) => {
    const rowNo = i + 2 // +1 for the header, +1 for 1-based
    const get = (key: keyof ProductDraft): unknown =>
      headerMap[key] ? row[headerMap[key]] : (row[key as string] ?? undefined)

    const barcode = normalizeBarcode(String(get('barcode') ?? ''))
    if (!barcode || !isValidBarcode(barcode)) {
      errors.push({ row: rowNo, barcode, reason: 'missing or invalid barcode' })
      return
    }
    if (!registerBarcode(barcode, rowNo)) return

    // Additional barcodes from a "barcodes" column, semicolon or comma separated.
    const extraRaw = headerMap['barcodes'] ? String(get('barcodes') ?? '') : ''
    const extraBarcodes = extraRaw
      .split(/[;,]/)
      .map((b) => normalizeBarcode(b.trim()))
      .filter(Boolean)
    for (const bc of extraBarcodes) {
      if (!registerBarcode(bc, rowNo)) return
    }

    const name = String(get('name') ?? '').trim()
    if (!name) {
      errors.push({ row: rowNo, barcode, reason: 'missing name' })
      return
    }

    const price = parseAmount(String(get('price') ?? ''))
    if (price === null) {
      errors.push({ row: rowNo, barcode, reason: `bad price "${String(get('price') ?? '')}"` })
      return
    }

    const stockRaw = get('stockQty')
    const stockQty = stockRaw === undefined || stockRaw === null || stockRaw === ''
      ? 0
      : Number(stockRaw)
    const thresholdRaw = get('lowStockThreshold')

    let cost: Cents | null = null
    if (headerMap['cost']) {
      const raw = String(get('cost') ?? '')
      const parsed = parseAmount(raw)
      if (parsed === null) {
        errors.push({ row: rowNo, barcode, reason: `bad cost "${raw}"` })
        return
      }
      cost = parsed
    }

    drafts.push({
      barcode,
      barcodes: extraBarcodes.length > 0 ? [barcode, ...extraBarcodes] : [barcode],
      name,
      details: headerMap['details'] ? String(get('details') ?? '').trim() || undefined : undefined,
      price,
      cost,
      stockQty: Number.isFinite(stockQty) ? Math.round(stockQty) : 0,
      lowStockThreshold:
        thresholdRaw === undefined || thresholdRaw === null || thresholdRaw === ''
          ? null
          : Math.max(0, Number(thresholdRaw) || 0),
      category: String(get('category') ?? '').trim() || 'Uncategorised',
    })
  })

  return { drafts, errors, duplicates: [...seenDuplicates] }
}

/** Read a .csv, .xlsx, or .xls file into raw row objects. */
export async function readTabularFile(file: File): Promise<Record<string, unknown>[]> {
  const name = file.name.toLowerCase()
  const buffer = await file.arrayBuffer()

  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = new TextDecoder('utf-8').decode(buffer)
    const parsed = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    })
    if (parsed.errors.length) {
      // Non-fatal: report but continue with whatever parsed.
      console.warn('CSV parse warnings', parsed.errors)
    }
    return parsed.data
  }

  const wb = XLSX.read(buffer, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]!]
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
}

/**
 * Import products.
 *
 * Existing barcodes are updated rather than duplicated, and a re-import with a
 * stock number is recorded as an `import` movement so the ledger explains the
 * change. Overwriting stock silently would make the movement history useless.
 */
export async function importProducts(file: File): Promise<ImportResult> {
  const rows = await readTabularFile(file)
  const { drafts, errors, duplicates } = rowsToDrafts(rows)

  const result: ImportResult = {
    created: 0,
    updated: 0,
    skipped: errors.length,
    errors,
    duplicates,
  }

  await db.transaction('rw', db.products, db.stockMovements, db.outbox, async () => {
    for (const draft of drafts) {
      const existing = await db.products.where('barcode').equals(draft.barcode).first()

      if (!existing) {
        const product = withSyncMeta(undefined, {
          ...draft,
          cost: draft.cost ?? draft.price,
          lowStockThreshold: draft.lowStockThreshold ?? 0,
          active: true,
        }) as Product
        await db.products.put(product)
        await queueEntity('products', product.id, 'upsert', product)

        if (draft.stockQty !== 0) {
          const movement = withSyncMeta(undefined, {
            productId: product.id,
            delta: draft.stockQty,
            reason: 'import' as const,
            refId: null,
            note: `Opening stock from ${file.name}`,
          })
          await db.stockMovements.put(movement)
          await queueEntity('stock_movements', movement.id, 'upsert', movement)
        }
        result.created++
        continue
      }

      // Update price and name. Stock moves only when the file states a figure.
      const stockChanged = draft.stockQty !== existing.stockQty
      const updated = withSyncMeta(existing, {
        ...existing,
        barcodes: draft.barcodes ?? [draft.barcode],
        name: draft.name,
        details: draft.details ?? existing.details,
        price: draft.price,
        cost: draft.cost ?? existing.cost ?? draft.price,
        category: draft.category || existing.category,
        lowStockThreshold: draft.lowStockThreshold ?? existing.lowStockThreshold,
        stockQty: draft.stockQty,
        active: true,
      }) as Product
      await db.products.put(updated)
      await queueEntity('products', existing.id, 'upsert', updated)

      if (stockChanged) {
        const movement = withSyncMeta(undefined, {
          productId: existing.id,
          delta: draft.stockQty - existing.stockQty,
          reason: 'import' as const,
          refId: null,
          note: `Reconciled from ${file.name}`,
        })
        await db.stockMovements.put(movement)
        await queueEntity('stock_movements', movement.id, 'upsert', movement)
      }
      result.updated++
    }
  })

  return result
}

/** CSV of the current catalog, for round-tripping through Excel. */
export async function exportProductsCsv(): Promise<Blob> {
  const products = await db.products.orderBy('name').toArray()
  const rows = products.map((p) => ({
    barcode: p.barcode,
    barcodes: (p.barcodes ?? [p.barcode]).join('; '),
    name: p.name,
    details: p.details ?? '',
    price: (p.price / 100).toFixed(2),
    cost: ((p.cost ?? p.price) / 100).toFixed(2),
    stockQty: p.stockQty,
    lowStockThreshold: p.lowStockThreshold,
    category: p.category,
  }))
  return new Blob([Papa.unparse(rows)], { type: 'text/csv;charset=utf-8' })
}

/** Trigger a browser download without a server round-trip. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}