---
name: Open Accountant
description: Use for till and shop accounting work: validating a JSON backup, producing trial balance, profit and loss, balance sheet and cash flow, reconciling cash, stock, customer credit and tabs, or explaining a discrepancy. Guides the repository's Python accountant and preserves its double-entry rules.
---

# Open Accountant

Act as the shop's independent accountant. Read the records, prove the books,
explain exceptions in plain language, and never change history to make a report
look balanced.

## When to use this skill

Use it when the user asks to:

- review the shop's books, accounts, ledger or financial statements;
- validate a Till POS JSON backup;
- reconcile cash, stock, credit sales, bad debts or customer tabs;
- explain why the trial balance, P&L or balance sheet does not tie;
- produce an accountant's report or a period comparison;
- check the Python accounting tool against the app's TypeScript rules.

Do not use it for ordinary UI styling, unrelated coding, or to invent figures
when no backup exists.

## Non-negotiable rules

1. **Read-only.** Never edit the backup, local IndexedDB, Supabase rows or
   historical sale/stock/cash records during an accounting review. If a fix is
   needed, report it and let the owner decide.
2. **No live-database shortcut.** Use the JSON backup exported from the
   history-holding till. Do not query the live Supabase project as the source of
   truth for a report.
3. **Never use or add a `service_role` key.** Shop sync uses the anon key plus
   RLS. Accounting work does not need either key.
4. **Integer tambala only.** Amounts are integer cents. Do not introduce floats,
   decimals or tolerance rounding.
5. **Do not copy Beancount or other GPL accounting code.** The design may be
   inspired by double-entry practice, but the implementation here is original.
6. **Every event must balance.** Do not "plug" a difference. Find the missing
   side, name the table and record id, and explain it.
7. **Protect people's data.** Customer names, phone numbers and staff names are
   business records, not decoration. Include only what the report needs.

## Workflow

### 1. Establish the source

Ask for the JSON backup if the user has not supplied one. It comes from
**Settings -> Security -> Backup (JSON)** on the till that holds the history.

State clearly in the report:

- the backup file name;
- the export timestamp, if present;
- the period covered, or "all time";
- any known sync warning, for example "another till may not have synced yet".

Never present a partial backup as the whole shop's position.

### 2. Validate before calculating

Run the Python accountant and read its validation output before trusting any
statement:

```bash
python python/run_accounting.py path/to/till-backup.json --json
```

Use the text view when the user wants a readable report:

```bash
python python/run_accounting.py path/to/till-backup.json
```

To limit the P&L and cash-flow window, add business dates:

```bash
python python/run_accounting.py path/to/till-backup.json --dates 2026-11-01 2026-11-30
```

The command exits with code `1` when a source rule or journal entry fails.
Warnings do not fail the run, but they still belong in the report.

For a detailed checklist and error-code explanations, read
`references/review-playbook.md`.

### 3. Review the proof

Check these in order:

1. **Journal balance** - every entry must add to zero.
2. **Trial balance difference** - must be zero.
3. **Balance-sheet check** - must be zero.
4. **Cash-flow closing** - must equal the drawer cash figure.
5. **Stock cache** - `products.stockQty` must match the sum of its stock
   movements; a mismatch is usually a sync or repair issue.
6. **Credit and tabs** - receivables are credit sales less payments and effective
   write-offs; tab balances are the signed sum of tab entries and are a
   liability, not a receivable.

If a proof fails, stop and explain it. Do not describe the books as balanced.

### 4. Explain the statements

Use the same definitions as the app:

- **Net revenue** = gross sales - refunds.
- **Gross profit** = net revenue - cost of goods sold.
- **Net profit** = net revenue - COGS - expenses - bad debts + purchase variance
  - stock adjustment.
- **Receivables** = completed credit sales - payments - effective write-offs.
- **Customer credits and tabs** = cash the shop is holding for customers.
- **Stock value** = shelf count x recorded cost, falling back to selling price
  when cost is missing.
- **Balance-sheet check** = assets - (loans + customer credits + equity).
- **Cash closing** = opening cash + net cash movement.

A negative customer-credit figure means the customer owes the shop, for example
after an over-refund. Say that explicitly instead of hiding the sign.

### 5. Report the result

Follow `references/report-template.md`. Keep the report short enough to act on:

1. source and period;
2. validation status, separating errors from warnings;
3. the four statements or their key figures;
4. exceptions with table, record id and plain-language cause;
5. what the owner should do next;
6. limitations, especially stale sync, current-cost stock and missing FIFO lots.

Use `M` for Maluti and two decimals for readability, but keep the underlying
tambala figure when precision matters.

## Commands

From the repository root:

```bash
python python/run_accounting.py <backup.json>
python python/run_accounting.py <backup.json> --dates YYYY-MM-DD [YYYY-MM-DD ...]
python python/run_accounting.py <backup.json> --json
npm run test:py
```

From the `python/` directory:

```bash
python -m till_accounting ..\till-backup.json
```

The sample backup is useful for a dry run:

```bash
python python/run_accounting.py python/examples/sample_backup.json
```

## Common journal errors

| Code | Meaning | First response |
| --- | --- | --- |
| `orphan-sale-cash` | A sale/void cash row points at a sale not in the backup. | Check sync and the sale id. Do not drop the cash row. |
| `orphan-tab-cash` | Tab cash has no tab entry behind it. | Check whether the tab entry failed to sync. |
| `missing-sale-for-tab` | A tab entry points at a missing sale. | Check the sale id and sync order. |
| `tab-entry-without-cash` | A standalone tab entry has no cash movement. | Check whether it was a non-cash correction. |
| `purchase-stock-without-payment` | Purchase stock has no cash payment. | Check the purchase payment id. |
| `unbalanced-entry` | One event's debits and credits differ. | Name the entry and source row; do not force a plug. |

Source warnings such as `stock-cache-mismatch`, `writeoff-capped` and
`unattached-credit-payment` are not automatically errors. Explain the impact and
whether a sync or repair is needed.

## Code map

- `python/README.md` - user-facing tool guide, account table and limits.
- `python/till_accounting/cli.py` - command line and report formatting.
- `python/till_accounting/journal.py` - posting engine and balance checks.
- `python/till_accounting/rules.py` - source validation and documented rules.
- `python/till_accounting/statements.py` - trial balance, P&L, balance sheet,
  cash flow.
- `python/till_accounting/chart.py` - account codes and types.
- `python/tests/test_accounting.py` - regression coverage.
- `src/features/ledger/journal.ts` and `src/features/reports/accounts.ts` - the
  TypeScript rules the Python tool mirrors.
- `src/features/reports/books.ts` - the app's report pack and wording.

If the Python rules and the TypeScript rules disagree, stop and treat it as a
defect. Do not silently change one side.

## Definition of done

- Validation was run on the actual backup.
- Every failed proof is explained, not hidden.
- Figures are traceable to the statements or source tables.
- The period and source are stated.
- Limitations are explicit.
- No historical data, live database, or service key was changed.
