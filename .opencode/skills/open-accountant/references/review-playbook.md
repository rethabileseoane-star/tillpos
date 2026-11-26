# Open Accountant Review Playbook

Use this after loading the `open-accountant` skill. The goal is a defensible
review: every figure traceable, every failed proof explained, nothing changed.

## 1. Prepare the source

1. Identify the backup file and its `exportedAt` value.
2. Confirm it came from the till that holds the history. A secondary device may
   only have what it has pulled so far.
3. Keep the backup read-only. If you need a working copy, copy it somewhere else
   and never write to the original.
4. Record the period the user wants:
   - all time, or
   - selected business dates.

Do not use the live Supabase project as the source for an accountant's report.
Do not ask for or use a `service_role` key.

## 2. Validate first

Text report:

```bash
python python/run_accounting.py <backup.json>
```

Machine-readable report:

```bash
python python/run_accounting.py <backup.json> --json
```

Period window:

```bash
python python/run_accounting.py <backup.json> --dates 2026-11-01 2026-11-30
```

Exit code `1` means at least one source error or journal error. Warnings are
reported but do not fail the run. Read both lists before calculating anything.

## 3. Prove the journal

For every journal entry:

```text
sum(debits) + sum(credits) = 0
```

For the whole journal:

```text
trial-balance difference = sum(every posting) = 0
```

A non-zero difference means an event is missing its other side. Common causes:

- a cash row arrived without its sale;
- a tab entry arrived without its cash movement;
- a sale arrived before its lines;
- a row belongs to another shop or device and was not meant to be here.

Do not add a balancing entry to hide it. Name the source row and explain which
side is missing.

## 4. Reconcile cash

The drawer is the sum of every cash movement:

```text
cash = sum(cash_movements.delta)
```

For a period:

```text
opening = all_time_cash - window_cash
closing = opening + net_window_movement
```

`closing` must equal the cash-flow statement and account 1100. Classify:

- operating in: `sale`, `void`, `credit_payment`;
- operating out: `purchase`, `expense`;
- financing in: `float`, `cash_in`;
- financing out: `drawing`, `loan_repay`;
- tab in: `tab_credit`;
- tab out: `tab_payout`.

If the drawer does not tie, look for a missing cash row or an event whose other
side is missing.

## 5. Reconcile stock

For each product:

```text
stockQty cache = sum(stock_movements.delta for that product)
```

Warn when the cache and the movement ledger disagree. The app rebuilds the cache
from the ledger on boot, so a mismatch usually means a stale or partial sync.

Stock value on the balance sheet is:

```text
sum(product.stockQty * (product.cost ?? product.price))
```

The balance-sheet `check` line can be non-zero after a product cost edit because
historical COGS and current stock value disagree. Report the amount and the
likely cause; do not silently revalue history.

## 6. Reconcile credit sales

For a completed credit sale:

```text
outstanding = max(0, total - payments - effective_write_off)
```

where:

```text
payments = sum(cash_movements.delta)
           for reason = credit_payment and refId = sale.id

effective_write_off = min(stored_write_off,
                          max(0, total - payments))
```

Rules:

- Only `paymentMethod = credit` and `status = completed` can owe money.
- A voided sale owes nothing; its revenue and remaining receivable are reversed.
- Writing off a debt is an expense, not a cash movement.
- A payment after a write-off reduces the bad-debt loss; it does not create a
  negative receivable.
- An overpayment becomes a customer credit, not revenue.

Show the open credit sales oldest first when the user asks for a debt book.

## 7. Reconcile customer tabs

A tab is money the shop owes the customer:

```text
tab balance = sum(tab_entries.amount for that tab)
```

Positive means the shop owes the customer. Negative means the customer owes the
shop, for example after an over-payout or an unrecorded correction.

Check:

- a tab entry with `cashMovementId` must point at a `tab_credit` or `tab_payout`
  cash movement;
- a sale-linked tab entry must point at an existing sale;
- tab cash must not be counted twice by the sale and by the standalone tab loop;
- total tab liability is the sum of all tab balances.

Tabs are a liability (account 2400), separate from credit-sale receivables
(account 1300).

## 8. Read the profit and loss

The app's definitions:

```text
net revenue = gross sales - refunds
gross profit = net revenue - cost of goods sold
net profit = net revenue
             - cost of goods sold
             - expenses
             - bad debts
             + purchase variance
             - stock adjustment
```

Notes:

- Gross sales bills every completed and voided sale in the window.
- Refunds reverse voided sales; a sale and its void net to zero.
- COGS uses each item's recorded cost, or its selling price when cost is missing.
- Purchase variance is positive when the shop paid less than the booked stock
  cost, and negative when it paid more.
- Stock adjustment is positive for stock lost and negative for stock found.
- Stock adjustments are selected by their source timestamp, not an edited
  business date.
- A write-off is dated by `writeOffDate`, then `writtenOffAt`, then the sale's
  business date.

## 9. Read the balance sheet

```text
assets = cash + stock value + receivables
liabilities = loans + customer credits and tabs
equity = capital in + contributed stock + retained profit + drawings
check = assets - (liabilities + equity)
```

`check` must be zero. If it is not:

1. Look for an unposted cost edit.
2. Look for a missing sync row or orphan event.
3. Check whether tabs were counted twice.
4. Explain the amount; do not call the books balanced.

## 10. Triage warnings and errors

### Journal errors

- `orphan-sale-cash` - cash exists, sale is missing.
- `orphan-tab-cash` - tab cash exists, tab entry is missing.
- `missing-sale-for-tab` - tab entry points at a sale that is absent.
- `tab-entry-without-cash` - standalone tab entry has no cash movement.
- `purchase-stock-without-payment` - purchase stock has no payment row.
- `unbalanced-entry` - one event's postings do not add to zero.

### Source warnings

- `stock-cache-mismatch` - product cache differs from its movement ledger.
- `writeoff-capped` - later payments reduced the effective write-off.
- `unattached-credit-payment` - payment points at a missing sale; it is held as
  a customer credit.
- `credit-sale-without-customer` - a credit sale is missing a customer name.
- `cash-without-tab` - tab cash points at neither a tab entry nor a sale.

Warnings must still appear in the report. They often explain a difference that
would otherwise look like a calculation bug.

## 11. Period rules

- P&L and cash flow use `businessDate` for sales, cash and tab entries.
- COGS uses the sale's business date.
- A void remains on the original sale's business date.
- A write-off uses its own write-off date.
- Cash-flow opening is all-time cash minus the selected window's cash.
- The balance sheet is always "as of now" from the rows in the backup.

State which period each statement covers.

## 12. Report and escalate

Use `references/report-template.md`.

For every exception, include:

- the code or warning;
- the table and record id;
- the amount, if relevant;
- the likely cause;
- the safe next action.

Never recommend editing the database to make a statement tie. Recommend a sync
check, data repair, or an owner decision first.

## 13. If the tool itself needs changing

Change the Python rule and the TypeScript rule together, or explain why one side
is intentionally different. Add a regression test. Run:

```bash
npm run test:py
npm test
npm run build
```

Keep historical rows intact. A code fix is not permission to rewrite the books.
