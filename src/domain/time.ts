/**
 * Calendar dates and clock times in the device's local timezone.
 *
 * Business dates, report timestamps and exported file names all describe what
 * happened at this counter, so they must follow the same clock the operator
 * sees. Using `toISOString()` here would shift transactions around midnight.
 */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local calendar day as YYYY-MM-DD. */
export function localDate(value: number | Date = Date.now()): string {
  const d = value instanceof Date ? value : new Date(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local clock time as HH:MM:SS. */
export function localTime(value: number | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
