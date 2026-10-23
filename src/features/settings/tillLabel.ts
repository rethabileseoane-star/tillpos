import { getSetting, setSetting } from '@/db'

/**
 * A short label for this till, printed in front of every receipt number.
 *
 * With more than one device, "count of today's sales + 1" hands out the same
 * numbers on every till. Each device therefore counts only its own sales and
 * stamps its own label, so a day reads A-0001, B-0001, A-0002 and no two
 * receipts share a number. A device that has never been labelled keeps the old
 * plain numbering, which is what existing shops already have on paper.
 *
 * This is device-local on purpose: it identifies this counter, not the shop.
 */

const KEY = 'device.label'

/** Uppercase letters and digits only, so a label is safe on a printed receipt. */
export function cleanTillLabel(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6)
}

export async function loadTillLabel(): Promise<string> {
  const raw = await getSetting(KEY)
  return raw ? cleanTillLabel(raw) : ''
}

export async function saveTillLabel(label: string): Promise<string> {
  const clean = cleanTillLabel(label)
  await setSetting(KEY, clean)
  return clean
}
