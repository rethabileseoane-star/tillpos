import Papa from 'papaparse'

/**
 * Spreadsheet-safe CSV writing.
 *
 * A CSV cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is
 * a formula to Excel, LibreOffice and Google Sheets. A product name or a note
 * such as `=HYPERLINK("http://attacker","click")` therefore turns into a live
 * formula when an accountant opens the export, and older Excel builds can go
 * further. This is the "CSV injection" class (OWASP: CSV Injection).
 *
 * Every string cell is prefixed with an apostrophe when it could be read as a
 * formula. Plain numbers (including negative money like `-12.50`) are left
 * alone so the accountant still gets numeric columns. The apostrophe is the
 * standard mitigation: spreadsheets treat the cell as text and do not run it.
 */

/** Characters that make a spreadsheet treat the cell as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/** A value that is unambiguously numeric, e.g. `-12.50`, `7`, `.5`. */
const PLAIN_NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/

export function neutralizeCell(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return value
  if (!FORMULA_LEAD.test(value)) return value
  if (PLAIN_NUMBER.test(value)) return value
  return `'${value}`
}

function neutralizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(neutralizeValue)
  return neutralizeCell(value)
}

/**
 * Copy rows with formula-looking strings neutralised. Object rows (the shape
 * Papa uses with `columns`) and array rows are both supported.
 */
export function neutralizeRows<T>(rows: T[]): T[] {
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row
    if (Array.isArray(row)) return neutralizeValue(row) as T
    const copy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      copy[key] = neutralizeValue(value)
    }
    return copy as T
  })
}

/** `Papa.unparse` with the CSV-injection guard applied. */
export function unparseSafe(rows: unknown[], config?: Papa.UnparseConfig): string {
  return Papa.unparse(neutralizeRows(rows) as Record<string, unknown>[], config)
}
