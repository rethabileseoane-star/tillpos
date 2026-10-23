import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { db } from '@/db'
import type { Product } from '@/db/types'
import { barcodeVariants } from '@/domain/barcode'
import {
  addAdHoc,
  cartCount,
  cartSubtotal,
  emptyCart,
  mergeProduct,
  removeLine,
  setQty,
  type CartLine,
} from './cartStore'

interface CartContextValue {
  lines: CartLine[]
  subtotal: number
  count: number
  lastScan: { code: string; name: string; price: number; at: number } | null
  unknownCode: string | null
  addProduct: (product: Product) => void
  addAdHocLine: (input: { barcode: string; name: string; unitPrice: number; qty?: number }) => void
  changeQty: (key: string, qty: number) => void
  remove: (key: string) => void
  clear: () => void
  dismissUnknown: () => void
}

const CartContext = createContext<CartContextValue | null>(null)

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(emptyCart)
  const [lastScan, setLastScan] = useState<CartContextValue['lastScan']>(null)
  const [unknownCode, setUnknownCode] = useState<string | null>(null)

  /**
   * Resolve a scanned code.
   *
   * The lookup is a single indexed IndexedDB read, which keeps the scanner
   * instant regardless of catalog size. A code we do not recognise is surfaced
   * rather than dropped, so a new product never blocks a checkout.
   */
  const addProduct = useCallback(async (product: Product) => {
    setLines((prev) => mergeProduct(prev, product))
    setLastScan({
      code: product.barcode,
      name: product.name,
      price: product.price,
      at: Date.now(),
    })
    setUnknownCode(null)
  }, [])

  const addAdHocLine = useCallback(
    (input: { barcode: string; name: string; unitPrice: number; qty?: number }) => {
      setLines((prev) => addAdHoc(prev, input))
      setLastScan({ code: input.barcode, name: input.name, price: input.unitPrice, at: Date.now() })
      setUnknownCode(null)
    },
    [],
  )

  const changeQty = useCallback((key: string, qty: number) => {
    setLines((prev) => setQty(prev, key, qty))
  }, [])

  const remove = useCallback((key: string) => {
    setLines((prev) => removeLine(prev, key))
  }, [])

  const clear = useCallback(() => {
    setLines(emptyCart())
    setLastScan(null)
    setUnknownCode(null)
  }, [])

  const dismissUnknown = useCallback(() => setUnknownCode(null), [])

  const value = useMemo<CartContextValue>(
    () => ({
      lines,
      subtotal: cartSubtotal(lines),
      count: cartCount(lines),
      lastScan,
      unknownCode,
      addProduct,
      addAdHocLine,
      changeQty,
      remove,
      clear,
      dismissUnknown,
    }),
    [lines, lastScan, unknownCode, addProduct, addAdHocLine, changeQty, remove, clear, dismissUnknown],
  )

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used inside CartProvider')
  return ctx
}

/** Indexed by barcode for the scanner hot path. */
export async function lookupProduct(rawCode: string): Promise<Product | undefined> {
  const variants = barcodeVariants(rawCode)
  if (variants.length === 0) return undefined

  for (const code of variants) {
    // Primary barcode first, then any alias the product carries.
    const hit =
      (await db.products.where('barcode').equals(code).first()) ??
      (await db.products.where('barcodes').equals(code).first())
    if (hit) return hit
  }

  // Fall back to a prefix scan so a truncated read can still resolve — but only
  // when exactly one product matches. Returning the first of many silently put
  // an arbitrary item in the cart (with a green confirmation) on a partial scan.
  const prefix = variants[0]!
  if (prefix.length < 8) return undefined
  const near = await db.products.where('barcode').startsWith(prefix).limit(2).toArray()
  return near.length === 1 ? near[0] : undefined
}

export type { CartLine }