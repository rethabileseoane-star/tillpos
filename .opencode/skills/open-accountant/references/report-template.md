# Accountant's Report Template

Use this shape for a review. Drop sections that do not apply, but keep the source,
period and validation status.

## Shop accounting review

**Source:** `till-backup-YYYY-MM-DD.json`
**Exported:** YYYY-MM-DD HH:MM
**Period:** all time / YYYY-MM-DD to YYYY-MM-DD
**Status:** validated / validated with warnings / blocked by errors

## Validation

- Source errors: N
- Source warnings: N
- Journal errors: N
- Trial-balance difference: `M0.00`
- Balance-sheet check: `M0.00`

List each error or warning:

| Code | Table | Record | Amount | Meaning |
| --- | --- | --- | --- | --- |
| ... | ... | ... | ... | ... |

If a proof fails, say so plainly here. Do not continue with a "balanced" claim.

## Key figures

| Item | Amount |
| --- | ---: |
| Gross sales | M |
| Refunds | M |
| Net revenue | M |
| Cost of goods sold | M |
| Gross profit | M |
| Expenses | M |
| Bad debts | M |
| Purchase variance | M |
| Stock adjustment | M |
| Net profit | M |

## Balance sheet

| Item | Amount |
| --- | ---: |
| Cash in drawer | M |
| Stock in the shop | M |
| Customers who owe | M |
| **Total assets** | **M** |
| Loans owed | M |
| Customer credits and tabs | M |
| Owner capital | M |
| Stock brought in | M |
| Retained profit | M |
| Owner drawings | M |
| **Total equity** | **M** |
| **Check (must be 0)** | **M** |

## Cash flow

| Item | Amount |
| --- | ---: |
| Opening cash | M |
| Sales and credit collections | M |
| Stock and expenses | M |
| Capital and loans in | M |
| Drawings and loan repayments | M |
| Tab money in | M |
| Tab money out | M |
| **Net movement** | **M** |
| **Closing cash** | **M** |

## Exceptions and causes

1. **Code** - table/record, amount. Plain-language cause. Safe next action.
2. ...

## Owner actions

- [ ] Sync the history-holding till, then re-export if the backup is partial.
- [ ] Check the named record in the app before changing anything.
- [ ] Ask the accountant/owner to decide on a write-off or correction.
- [ ] Re-run the review after the fix.

## Limitations

- Stock is valued at current recorded cost; FIFO/lot costing is not implemented.
- A later cost edit can move historical COGS and current stock value.
- The report reflects only the rows in this backup; unsynced tills are not included.
- This is an accounting review of the recorded data, not a tax or legal opinion.
