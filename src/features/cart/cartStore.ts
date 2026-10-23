import type { Cents } from '@/domain/money'
import type { Product } from '@/db/types'

export interface CartLine {
  /** Stable key: productId, or a generated id for ad-hoc lines. */
  key: string
  productId: string | null
  barcode: string
  name: string
  unitPrice: Cents
  qty: number
  adHoc: boolean
  /** Stock at the time of adding, for the low-stock warning. */
  stockAtAdd: number | null
}

export const emptyCart = (): CartLine[] => []

export function cartSubtotal(lines: CartLine[]): Cents {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0)
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.qty, 0)
}

export function lineTotal(line: CartLine): Cents {
  return line.unitPrice * line.qty
}

/**
 * Merge a scanned product into the cart.
 *
 * Scanning the same barcode again increments the existing line rather than
 * appending a duplicate. This is the expected behaviour at a till: the cashier
 * holds the item in front of the lens and the same code fires several times.
 *
 * The most recently scanned line always moves to the top of the list, so the
 * cashier can see what just went in without scrolling to the bottom.
 */
export function mergeProduct(
  lines: CartLine[],
  product: Product,
  qty = 1,
): CartLine[] {
  const barcode = product.barcode
  const existing = lines.find((l) => l.barcode === barcode && !l.adHoc)
  if (existing) {
    return [
      { ...existing, qty: existing.qty + qty },
      ...lines.filter((l) => l.key !== existing.key),
    ]
  }
  return [
    {
      key: product.id,
      productId: product.id,
      barcode,
      name: product.name,
      unitPrice: product.price,
      qty,
      adHoc: false,
      stockAtAdd: product.stockQty,
    },
    ...lines,
  ]
}

export function addAdHoc(
  lines: CartLine[],
  input: { barcode: string; name: string; unitPrice: Cents; qty?: number },
): CartLine[] {
  const qty = input.qty ?? 1
  const existing = lines.find((l) => l.adHoc && l.barcode === input.barcode)
  if (existing) {
    return [
      { ...existing, qty: existing.qty + qty },
      ...lines.filter((l) => l.key !== existing.key),
    ]
  }
  return [
    {
      key: crypto.randomUUID(),
      productId: null,
      barcode: input.barcode,
      name: input.name,
      unitPrice: input.unitPrice,
      qty,
      adHoc: true,
      stockAtAdd: null,
    },
    ...lines,
  ]
}

export function setQty(lines: CartLine[], key: string, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((l) => l.key !== key)
  return lines.map((l) => (l.key === key ? { ...l, qty } : l))
}

export function removeLine(lines: CartLine[], key: string): CartLine[] {
  return lines.filter((l) => l.key !== key)
}

/**
 * Which lines would push stock negative.
 *
 * Stock is deducted at checkout, not at scan time, so the cart may legitimately
 * exceed available quantity mid-sale. We surface this as a warning on the
 * checkout button and block only if the seller insists.
 */
export function linesExceedingStock(lines: CartLine[]): CartLine[] {
  return lines.filter(
    (l) => l.productId !== null && l.stockAtAdd !== null && l.qty > l.stockAtAdd,
  )
}