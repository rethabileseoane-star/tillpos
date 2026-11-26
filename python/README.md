# Python accounting companion

A standalone accountant's tool for a Till POS JSON backup. It builds the same
double-entry journal as the app, validates the rows, and prints a trial balance,
profit & loss, balance sheet and cash-flow statement.

It is deliberately separate from the web app:

- pure Python 3.10+ standard library, no packages to install;
- reads the backup file, never the live IndexedDB or Supabase project;
- integer tambala, no floating-point money;
- original implementation. Beancount was used only as research; no Beancount
  source, GPL code, plain-text ledger or plugin model is included.

## Quick start

### 1. Export a backup

On the till that holds the history, unlock the app and open:

**Settings -> Security -> Backup (JSON)**

Copy the downloaded file to the computer that will run this tool.

### 2. Run the statements

From the repository root:

```powershell
python python/run_accounting.py path\to\till-backup-2026-11-26.json
```

Or from the `python` directory:

```powershell
cd python
python -m till_accounting ..\till-backup-2026-11-26.json
```

Limit the P&L and cash-flow window:

```powershell
python python/run_accounting.py backup.json --dates 2026-11-01 2026-11-30
```

Get machine-readable output for a spreadsheet or another program:

```powershell
python python/run_accounting.py backup.json --json > statements.json
```

The command exits with code `1` when a source rule or journal entry fails, so it
can be used in a check script. Warnings do not fail the run.

### 3. Optional install

```powershell
cd python
python -m pip install -e .
till-accounting ..\till-backup.json
```

## What it reports

- **Trial balance** - every account touched by the journal, with debits and
  credits. The difference must be zero.
- **Income statement** - gross sales, refunds, net revenue, cost of goods sold,
  gross profit, purchase variance, stock adjustments, expenses, bad debts and
  net profit.
- **Balance sheet** - cash, stock at recorded cost, receivables, loans, customer
  credits and tabs, capital, contributed stock, retained profit, drawings and the
  `check` line that must be zero.
- **Cash flow** - opening cash, operating, financing and tab movements, net
  movement and closing cash.

The trial balance, P&L and balance sheet all consume the same journal. A report
cannot quietly use a different definition of profit.

## Accounting rules

Positive postings are debits; negative postings are credits. Every journal entry
must add to zero.

| Event | Debit | Credit | Note |
| --- | --- | --- | --- |
| Cash sale | Cash | Sales | A tab tender reduces cash and the customer-credit liability; change kept reverses that leg. |
| Credit sale | Receivables | Sales | The customer owes the full sale. Later payments are separate entries. |
| Void | Sales returns | Cash / Receivables | A void reverses the sale and the remaining receivable. |
| Credit payment | Cash | Receivables | Never revenue again. An unmatched payment becomes a customer credit. |
| Bad debt | Bad debts | Receivables | Capped at the unpaid balance after later payments. |
| Purchase | Inventory, purchase variance | Cash | Variance is paid minus booked cost. |
| Opening stock / import | Inventory | Contributed stock | Stock brought into the business is capital, not profit. |
| Stock take | Inventory or stock adjustment | Inventory or stock adjustment | A shortage is an expense; a surplus reverses it. |
| Tab deposit | Cash | Customer credits | The shop owes the customer. |
| Tab payout | Customer credits | Cash | The shop returns money it was holding. |
| Expense | Expenses | Cash | Operating cost, not an owner drawing. |
| Drawing | Owner drawings | Cash | Reduces equity, never profit. |
| Loan in | Cash | Loans | Borrowed money is a liability. |
| Loan repayment | Loans | Cash | Repays the liability. |
| Opening float / money in | Cash | Capital | Own money is equity, not revenue. |

The account codes match `src/features/ledger/chart.ts`:

| Code | Account |
| --- | --- |
| 1100 | Cash in drawer |
| 1200 | Stock in the shop |
| 1300 | Customers who owe (credit) |
| 2400 | Customer credits and tabs |
| 2500 | Loans owed |
| 3100 | Owner capital |
| 3110 | Stock brought in |
| 3200 | Owner drawings |
| 4100 | Sales revenue |
| 4200 | Sales returns |
| 5100 | Cost of goods sold |
| 6000 | Expenses paid |
| 6100 | Bad debts |
| 7210 | Purchase variance |
| 7300 | Stock adjustments |

## Validation

`validate_source()` checks the backup before the statements are built:

- duplicate ids inside each table;
- integer tambala amounts and valid `YYYY-MM-DD` business dates;
- `lineTotal == qty * unitPrice` and sale lines adding to the sale subtotal;
- credit sales naming a customer, and write-offs not exceeding the sale total;
- cash, stock and tab rows pointing at their sale, product, tab or cash row;
- stock movements matching the product's cached `stockQty`;
- tab balances and customer-credit signs.

`validate_journal()` checks every journal entry for balance. A non-zero trial
balance usually means an event arrived without its other side, for example a
cash row whose sale has not synced yet.

## Backup shape

The tool accepts the app's backup root (`{ "tables": { ... } }`) and either
camelCase or snake_case table names:

- `products`
- `sales`
- `saleLines` / `sale_lines`
- `stockMovements` / `stock_movements`
- `cashMovements` / `cash_movements`
- `customerTabs` / `customer_tabs`
- `tabEntries` / `tab_entries`

Only those business tables are needed. Settings, outbox and sync bookkeeping are
ignored.

A small example is in `examples/sample_backup.json`:

```powershell
python python/run_accounting.py python/examples/sample_backup.json
```

## Tests

From the repository root:

```powershell
python -m unittest discover -s python/tests -t python -v
```

The tests cover a cash sale, a credit sale with payment and write-off, a tab sale
with kept change and its void, purchase variance, a stock-take adjustment, orphan
cash, bad line arithmetic, date windows and the backup loader.

## Current limits

- Stock is valued at each product's current recorded cost, exactly like the app.
  FIFO/lot cost is not implemented yet, so a cost edit can move historical COGS
  and stock value. The balance-sheet `check` line exposes the difference.
- The tool reads a static backup. It does not sync, write to the app or connect to
  Supabase.
- The Python package is an offline reporting companion. The till app remains the
  system of record and continues to use its own TypeScript journal.
