/**
 * All money in this app is an integer count of Maluti (MWK).
 *
 * 1 Maluti === 100 "tambala". MWK notes below 100 are rare in practice, but we
 * still store 2 decimals to stay correct if a price of M0.50 ever shows up.
 *
 * Never use a float for money. `0.1 + 0.2 !== 0.3` in IEEE754, and at a till
 * counter a rounding error means the drawer will not reconcile at end of day.
 */

/** Smallest stored unit. M100 is stored as 10000. */
export type Cents = number

export const MWK = 'MWK'

export const fromMaluti = (m: number): Cents => Math.round(m * 100)

export const toMaluti = (c: Cents): number => c / 100

/**
 * Format for display. Maluti are whole numbers in practice, so trailing .00 is
 * dropped, but we keep two decimals for anything that is not whole so the till
 * never silently hides a fractional price.
 */
export function formatMaluti(c: Cents, opts: { symbol?: boolean } = {}): string {
  const symbol = opts.symbol ?? true
  const negative = c < 0
  const abs = Math.abs(c)
  const whole = Math.floor(abs / 100)
  const frac = abs % 100
  const body = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`
  return `${negative ? '-' : ''}${symbol ? 'M' : ''}${groupThousands(body)}`
}

/** 1234.5 -> "1,234.50" */
export function groupThousands(value: string): string {
  const [whole, frac] = value.split('.')
  const withCommas = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac ? `${withCommas}.${frac}` : withCommas
}

/**
 * Parse user input into cents. Accepts "100", "100.50", "1,234.50", "M100".
 * Returns null when the input is not a usable amount, so callers can reject
 * rather than silently recording a zero price.
 */
export function parseAmount(input: string): Cents | null {
  const cleaned = input.replace(/[^\d.\-]/g, '').trim()
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

/**
 * Maluti coins and notes in tambala: the 50-lisente coin, then M1, M2, M5, M10,
 * M20, M50, M100 and M200. Sub-50-lisente coins are not worth offering.
 */
export const MWK_DENOMINATIONS: Cents[] = [
  50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000,
]

/** The increments a cashier rounds up to, in tambala: M1, M5, M10 … M1,000. */
const ROUND_TO: Cents[] = [100, 500, 1000, 2000, 5000, 10000, 50000, 100000]

/**
 * Quick-tender amounts for a total: the exact figure, then the next round
 * Maluti increments, then the next actual coins/notes above it.
 *
 * The earlier version mixed units — it treated denominations written in
 * tambala as if they were whole Maluti and multiplied by 100 again, so a M0.50
 * gum offered M100 / M500 / M1,000 buttons. Everything here is tambala, so a
 * M0.50 total offers M1, M2, M5, M10.
 */
export function suggestTender(amount: Cents, max = 5): Cents[] {
  const out = new Set<Cents>([amount])

  for (const d of ROUND_TO) {
    const rounded = Math.ceil(amount / d) * d
    if (rounded > amount) out.add(rounded)
  }
  for (const d of MWK_DENOMINATIONS) {
    if (d > amount) out.add(d)
  }

  return [...out].sort((a, b) => a - b).slice(0, max)
}