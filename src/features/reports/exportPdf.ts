import { jsPDF } from 'jspdf'
import Papa from 'papaparse'

/**
 * A plain A4 PDF for a table of figures.
 *
 * Exports are opened on a phone far more often than on a laptop, so the layout
 * is deliberately quiet: a readable title, a ruled table, and a summary block.
 * Wide accountant tables switch to landscape automatically instead of squeezing
 * seventeen columns into portrait width.
 */

export interface PdfTable {
  title: string
  subtitle?: string
  columns: string[]
  rows: Array<Array<string | number>>
  notes?: string[]
  orientation?: 'portrait' | 'landscape'
}

const MARGIN = 12
const PAD = 1.2
const LINE = 3.2
const BODY_FONT = 7.4
const HEADER_FONT = 7.4

/** Turn `unit_price_mwk` into `Unit Price (MWK)` for the printed header. */
function labelFor(column: string): string {
  const money = column.endsWith('_mwk')
  const base = money ? column.slice(0, -4) : column
  const words = base.split(/[_\s]+/).filter(Boolean)
  const text = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
  return money ? `${text} (MWK)` : text
}

const NUMERIC_COLUMNS = new Set([
  'qty',
  'delta',
  'stock_qty',
  'entries',
  'count',
])

function isRightAligned(
  column: string,
  rows: Array<Array<string | number>>,
  index: number,
): boolean {
  if (column.endsWith('_mwk') || NUMERIC_COLUMNS.has(column)) return true
  const values = rows
    .map((row) => String(row[index] ?? '').trim())
    .filter((value) => value !== '')
  return values.length > 0 && values.every((value) => /^-?\d+(\.\d+)?$/.test(value))
}

function wrap(doc: jsPDF, text: string, width: number, maxLines: number): string[] {
  if (!text) return ['']
  const lines = doc.splitTextToSize(text, Math.max(2, width)) as string[]
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/\s+$/, '')}…`
  return kept
}

function columnWidths(
  doc: jsPDF,
  columns: string[],
  rows: Array<Array<string | number>>,
  usable: number,
): number[] {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(BODY_FONT)
  const sample = rows.slice(0, 80)
  const weights = columns.map((column, index) => {
    let widest = Math.max(doc.getTextWidth(labelFor(column)), 12)
    for (const row of sample) {
      widest = Math.max(widest, Math.min(doc.getTextWidth(String(row[index] ?? '')), 70))
    }
    return Math.min(Math.max(widest, 14), 70)
  })
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1
  const minimum = 10
  if (minimum * columns.length >= usable) {
    return weights.map((weight) => (weight / total) * usable)
  }
  const remaining = usable - minimum * columns.length
  return weights.map((weight) => minimum + (weight / total) * remaining)
}

export function tableToPdf(table: PdfTable): Blob {
  const columns = table.columns.length > 0 ? table.columns : ['Result']
  const rows =
    table.rows.length > 0 ? table.rows : [['No records for this period.']]
  const orientation =
    table.orientation ?? (columns.length > 7 ? 'landscape' : 'portrait')
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const usable = pageW - MARGIN * 2
  const widths = columnWidths(doc, columns, rows, usable)
  const right = columns.map((column, index) => isRightAligned(column, rows, index))
  const labels = columns.map(labelFor)
  const bottom = pageH - MARGIN - 10
  const tableTop = MARGIN + 17

  let y = tableTop

  const drawTitle = () => {
    doc.setTextColor(0, 0, 0)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(15)
    doc.text(table.title, MARGIN, MARGIN + 5)
    if (table.subtitle) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8.5)
      doc.setTextColor(80, 80, 80)
      doc.text(table.subtitle, MARGIN, MARGIN + 10.5)
    }
    doc.setTextColor(0, 0, 0)
    doc.setDrawColor(60, 60, 60)
    doc.setLineWidth(0.4)
    doc.line(MARGIN, MARGIN + 14, MARGIN + usable, MARGIN + 14)
  }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(HEADER_FONT)
  const headerLines = labels.map((label, index) =>
    wrap(doc, label, widths[index]! - PAD * 2, 2),
  )
  const headerHeight =
    Math.max(1, ...headerLines.map((lines) => lines.length)) * LINE + PAD * 2

  const drawHeader = () => {
    if (y + headerHeight > bottom) {
      doc.addPage()
      drawTitle()
      y = tableTop
    }
    doc.setFillColor(235, 235, 235)
    doc.rect(MARGIN, y, usable, headerHeight, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(HEADER_FONT)
    doc.setTextColor(0, 0, 0)
    let x = MARGIN
    headerLines.forEach((lines, index) => {
      const width = widths[index]!
      const textX = right[index] ? x + width - PAD : x + PAD
      lines.forEach((line, lineIndex) => {
        doc.text(line, textX, y + PAD + 2.4 + lineIndex * LINE, {
          align: right[index] ? 'right' : 'left',
        })
      })
      x += width
    })
    doc.setDrawColor(180, 180, 180)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, y + headerHeight, MARGIN + usable, y + headerHeight)
    y += headerHeight
  }

  drawTitle()
  drawHeader()

  rows.forEach((row, rowIndex) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(BODY_FONT)
    const cells = columns.map((_, index) => String(row[index] ?? ''))
    const cellLines = cells.map((cell, index) =>
      wrap(doc, cell, widths[index]! - PAD * 2, 3),
    )
    const rowHeight =
      Math.max(1, ...cellLines.map((lines) => lines.length)) * LINE + PAD * 2

    if (y + rowHeight > bottom) {
      doc.addPage()
      drawTitle()
      y = tableTop
      drawHeader()
    }

    if (rowIndex % 2 === 1) {
      doc.setFillColor(247, 247, 247)
      doc.rect(MARGIN, y, usable, rowHeight, 'F')
    }

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(BODY_FONT)
    doc.setTextColor(0, 0, 0)
    let x = MARGIN
    cellLines.forEach((lines, index) => {
      const width = widths[index]!
      const textX = right[index] ? x + width - PAD : x + PAD
      lines.forEach((line, lineIndex) => {
        doc.text(line, textX, y + PAD + 2.4 + lineIndex * LINE, {
          align: right[index] ? 'right' : 'left',
        })
      })
      x += width
    })

    doc.setDrawColor(215, 215, 215)
    doc.setLineWidth(0.15)
    doc.line(MARGIN, y + rowHeight, MARGIN + usable, y + rowHeight)
    y += rowHeight
  })

  if (table.notes && table.notes.length > 0) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.6)
    const noteLines = table.notes.flatMap((note) =>
      wrap(doc, note, usable, 200),
    )

    if (y + 8 + noteLines.length * LINE > bottom) {
      doc.addPage()
      drawTitle()
      y = tableTop
    } else {
      y += 4
    }

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(0, 0, 0)
    doc.text('Summary & notes', MARGIN, y + 3)
    y += 7

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.6)
    doc.setTextColor(40, 40, 40)
    for (const line of noteLines) {
      if (y > bottom) {
        doc.addPage()
        drawTitle()
        y = tableTop
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7.6)
        doc.setTextColor(40, 40, 40)
      }
      doc.text(line, MARGIN, y + 2.5)
      y += LINE
    }
  }

  const totalPages = doc.getNumberOfPages()
  const generated = new Date().toLocaleString()
  for (let page = 1; page <= totalPages; page++) {
    doc.setPage(page)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(90, 90, 90)
    doc.text(`Generated ${generated}`, MARGIN, pageH - 6)
    doc.text(`Page ${page} of ${totalPages}`, pageW - MARGIN, pageH - 6, {
      align: 'right',
    })
  }

  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' })
}

/**
 * Read one of the existing CSV exports and print it as a PDF.
 *
 * The CSV builders stay the single source of the figures (and the spreadsheet
 * export remains available to other callers); this only changes the shape the
 * person at the till receives.
 */
export async function csvBlobToPdf(
  blob: Blob,
  options: { title: string; subtitle?: string; orientation?: 'portrait' | 'landscape' },
): Promise<Blob> {
  const text = await blob.text()
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' })
  const rows = parsed.data.filter((row) => row.length > 0)
  const noteStart = rows.findIndex((row) =>
    String(row[0] ?? '').trim().startsWith('#'),
  )
  const dataRows = noteStart === -1 ? rows : rows.slice(0, noteStart)
  const notes =
    noteStart === -1
      ? []
      : rows
          .slice(noteStart)
          .map((row) => row.join(', ').replace(/^#\s?/, '').trim())
          .filter(Boolean)

  const header = dataRows[0]
  if (!header || header.length === 0) {
    return tableToPdf({
      title: options.title,
      subtitle: options.subtitle,
      columns: ['Result'],
      rows: [['No records for this period.']],
      notes,
      orientation: options.orientation,
    })
  }

  return tableToPdf({
    title: options.title,
    subtitle: options.subtitle,
    columns: header.map(String),
    rows: dataRows
      .slice(1)
      .map((row) => header.map((_, index) => String(row[index] ?? ''))),
    notes,
    orientation: options.orientation,
  })
}
