"""Accounting rules and source-data validation.

The journal is the enforcement mechanism; this module documents the rules in
plain language and checks the rows before they reach the statements.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable

from .chart import ACCOUNT_NAMES, Account
from .models import (
    LedgerData,
    Record,
    as_int,
    as_text,
    records_by_id,
    valid_business_date,
)


CASH_REASONS = {
    "sale",
    "void",
    "float",
    "cash_in",
    "purchase",
    "drawing",
    "expense",
    "loan_repay",
    "credit_payment",
    "tab_credit",
    "tab_payout",
}
STOCK_REASONS = {"sale", "void", "import", "adjust", "opening", "purchase"}
TAB_KINDS = {"credit", "sale", "payout", "void"}


@dataclass(frozen=True)
class AccountingRule:
    code: str
    event: str
    debit: tuple[Account, ...]
    credit: tuple[Account, ...]
    note: str


RULES: tuple[AccountingRule, ...] = (
    AccountingRule(
        "CASH_SALE",
        "A cash sale bills revenue and puts cash in the drawer.",
        (Account.CASH,),
        (Account.SALES,),
        "A tab tender reduces cash and the customer-credit liability; kept change does the reverse.",
    ),
    AccountingRule(
        "CREDIT_SALE",
        "A credit sale bills revenue and raises a receivable.",
        (Account.RECEIVABLES,),
        (Account.SALES,),
        "The customer owes the full sale; later payments are separate entries.",
    ),
    AccountingRule(
        "VOID",
        "A void reverses the sale and returns the asset.",
        (Account.RETURNS,),
        (Account.CASH, Account.RECEIVABLES),
        "Cash sales refund cash; credit sales reverse the remaining receivable.",
    ),
    AccountingRule(
        "CREDIT_PAYMENT",
        "Collecting a debt moves cash and reduces the receivable.",
        (Account.CASH,),
        (Account.RECEIVABLES,),
        "Never revenue again. An unmatched payment becomes a customer credit.",
    ),
    AccountingRule(
        "BAD_DEBT",
        "Writing off a debt books the loss and clears the receivable.",
        (Account.BAD_DEBTS,),
        (Account.RECEIVABLES,),
        "The write-off cannot exceed the unpaid balance after later payments.",
    ),
    AccountingRule(
        "PURCHASE",
        "Buying stock posts inventory at recorded cost and cash out.",
        (Account.INVENTORY, Account.PURCHASE_VARIANCE),
        (Account.CASH,),
        "Variance is positive when you paid more than the booked cost.",
    ),
    AccountingRule(
        "OPENING_STOCK",
        "Opening stock and imports are contributed capital, not profit.",
        (Account.INVENTORY,),
        (Account.CONTRIBUTED,),
        "The owner brought stock into the business.",
    ),
    AccountingRule(
        "STOCK_ADJUST",
        "A stock take writes inventory up or down.",
        (Account.INVENTORY, Account.STOCK_ADJUST),
        (Account.INVENTORY, Account.STOCK_ADJUST),
        "A shortage is a stock-adjustment expense; a surplus reverses it.",
    ),
    AccountingRule(
        "TAB_DEPOSIT",
        "Cash held for a customer creates a customer-credit liability.",
        (Account.CASH,),
        (Account.CUSTOMER_CREDITS,),
        "The shop owes the customer, the opposite direction from a credit sale.",
    ),
    AccountingRule(
        "TAB_PAYOUT",
        "Returning tab money reduces cash and the liability.",
        (Account.CUSTOMER_CREDITS,),
        (Account.CASH,),
        "The customer takes back money the shop was holding.",
    ),
    AccountingRule(
        "EXPENSE",
        "A paid expense reduces cash and profit.",
        (Account.EXPENSES,),
        (Account.CASH,),
        "Expenses are operating costs, separate from owner drawings.",
    ),
    AccountingRule(
        "DRAWING",
        "Owner drawings reduce equity, never profit.",
        (Account.DRAWINGS,),
        (Account.CASH,),
        "The owner takes money out of the business.",
    ),
    AccountingRule(
        "LOAN_IN",
        "Borrowed money is a liability.",
        (Account.CASH,),
        (Account.LOANS,),
        "Repayments reverse the entry and cannot overshoot the loan.",
    ),
    AccountingRule(
        "LOAN_REPAY",
        "A loan repayment reduces cash and the loan liability.",
        (Account.LOANS,),
        (Account.CASH,),
        "The cash leaves the drawer.",
    ),
    AccountingRule(
        "CAPITAL",
        "The opening float and owner money in are capital.",
        (Account.CASH,),
        (Account.CAPITAL,),
        "Own money is equity, not revenue.",
    ),
)


@dataclass(frozen=True)
class RuleViolation:
    code: str
    message: str
    table: str
    record_id: str
    severity: str = "error"


def _violation(
    code: str,
    message: str,
    table: str,
    record: Record,
    severity: str = "error",
) -> RuleViolation:
    return RuleViolation(
        code=code,
        message=message,
        table=table,
        record_id=as_text(record.get("id")),
        severity=severity,
    )


def _duplicate_ids(
    table: str,
    records: Iterable[Record],
    violations: list[RuleViolation],
) -> None:
    counts = Counter(as_text(record.get("id")) for record in records)
    for record_id, count in counts.items():
        if record_id and count > 1:
            violations.append(
                RuleViolation(
                    "duplicate-id",
                    f"{count} rows share id {record_id!r}.",
                    table,
                    record_id,
                )
            )


def validate_source(data: LedgerData, check_stock_cache: bool = True) -> list[RuleViolation]:
    """Check the source rows against the till's accounting rules."""

    violations: list[RuleViolation] = []
    tables = data.tables()
    for table, records in tables.items():
        _duplicate_ids(table, records, violations)

    sale_by_id = records_by_id(data.sales)
    product_by_id = records_by_id(data.products)
    tab_by_id = records_by_id(data.customer_tabs)
    tab_entry_by_id = records_by_id(data.tab_entries)
    cash_by_id = records_by_id(data.cash_movements)

    lines_by_sale: dict[str, list[Record]] = defaultdict(list)
    for line in data.sale_lines:
        lines_by_sale[as_text(line.get("saleId"))].append(line)

    paid_by_sale: dict[str, int] = defaultdict(int)
    for movement in data.cash_movements:
        if movement.get("reason") == "credit_payment":
            ref_id = as_text(movement.get("refId"))
            if ref_id:
                paid_by_sale[ref_id] += as_int(movement.get("delta"), 0)

    for product in data.products:
        price = product.get("price")
        cost = product.get("cost")
        stock_qty = product.get("stockQty")
        if not isinstance(price, int) or price < 0:
            violations.append(
                _violation("bad-price", "Product price must be a non-negative integer (tambala).", "products", product)
            )
        if cost is not None and (not isinstance(cost, int) or cost < 0):
            violations.append(
                _violation("bad-cost", "Product cost must be a non-negative integer (tambala).", "products", product)
            )
        if not isinstance(stock_qty, int):
            violations.append(
                _violation("bad-stock-cache", "Product stockQty must be an integer.", "products", product)
            )

    for sale in data.sales:
        sale_id = as_text(sale.get("id"))
        total = sale.get("total")
        subtotal = sale.get("subtotal")
        if not isinstance(total, int) or total < 0:
            violations.append(
                _violation("bad-sale-total", "Sale total must be a non-negative integer.", "sales", sale)
            )
        if not isinstance(subtotal, int) or subtotal < 0:
            violations.append(
                _violation("bad-sale-subtotal", "Sale subtotal must be a non-negative integer.", "sales", sale)
            )
        if isinstance(total, int) and isinstance(subtotal, int) and total != subtotal:
            violations.append(
                _violation("sale-total-mismatch", "Sale subtotal and total must agree.", "sales", sale)
            )
        if sale.get("paymentMethod") not in {"cash", "credit"}:
            violations.append(
                _violation("bad-payment-method", "Sale paymentMethod must be cash or credit.", "sales", sale)
            )
        if sale.get("status") not in {"completed", "voided"}:
            violations.append(
                _violation("bad-sale-status", "Sale status must be completed or voided.", "sales", sale)
            )
        if not valid_business_date(sale.get("businessDate")):
            violations.append(
                _violation("bad-date", "Sale businessDate must be YYYY-MM-DD.", "sales", sale)
            )
        if sale.get("paymentMethod") == "credit" and not as_text(sale.get("customerName")):
            violations.append(
                _violation(
                    "credit-sale-without-customer",
                    "A credit sale should name the customer.",
                    "sales",
                    sale,
                    "warning",
                )
            )

        lines = lines_by_sale.get(sale_id, [])
        if lines and isinstance(subtotal, int):
            line_sum = sum(as_int(line.get("lineTotal"), 0) for line in lines)
            if line_sum != subtotal:
                violations.append(
                    _violation(
                        "sale-lines-do-not-add-up",
                        f"Sale lines add to {line_sum} but subtotal is {subtotal}.",
                        "sales",
                        sale,
                    )
                )

        written = as_int(sale.get("writtenOffAmount"), 0)
        if written < 0:
            violations.append(
                _violation("negative-writeoff", "writtenOffAmount cannot be negative.", "sales", sale)
            )
        if written > 0:
            total_cents = as_int(total, 0)
            outstanding = max(0, total_cents - paid_by_sale.get(sale_id, 0))
            if written > total_cents:
                violations.append(
                    _violation(
                        "writeoff-too-large",
                        f"Write-off {written} exceeds the sale total {total_cents}.",
                        "sales",
                        sale,
                    )
                )
            elif written > outstanding:
                # Later payments can arrive after the write-off was recorded.
                # The journal caps the effective write-off at the remaining
                # balance, so this is a note rather than a broken book.
                violations.append(
                    _violation(
                        "writeoff-capped",
                        f"Later payments reduce the effective write-off from {written} to {outstanding}.",
                        "sales",
                        sale,
                        "warning",
                    )
                )
            if sale.get("paymentMethod") != "credit":
                violations.append(
                    _violation(
                        "writeoff-not-credit",
                        "A write-off only applies to a credit sale; the journal ignores this one.",
                        "sales",
                        sale,
                        "warning",
                    )
                )
            if sale.get("writeOffDate") is not None and not valid_business_date(sale.get("writeOffDate")):
                violations.append(
                    _violation("bad-writeoff-date", "writeOffDate must be YYYY-MM-DD.", "sales", sale)
                )

    for line in data.sale_lines:
        sale_id = as_text(line.get("saleId"))
        if sale_id not in sale_by_id:
            violations.append(
                _violation("orphan-sale-line", "Sale line points at a missing sale.", "sale_lines", line)
            )
        qty = line.get("qty")
        unit_price = line.get("unitPrice")
        line_total = line.get("lineTotal")
        if not isinstance(qty, int) or qty <= 0:
            violations.append(
                _violation("bad-quantity", "Sale line qty must be a positive integer.", "sale_lines", line)
            )
        if not isinstance(unit_price, int) or unit_price < 0:
            violations.append(
                _violation("bad-unit-price", "Sale line unitPrice must be a non-negative integer.", "sale_lines", line)
            )
        if (
            isinstance(qty, int)
            and isinstance(unit_price, int)
            and isinstance(line_total, int)
            and line_total != qty * unit_price
        ):
            violations.append(
                _violation(
                    "line-total-mismatch",
                    f"Line total {line_total} does not equal {qty} x {unit_price}.",
                    "sale_lines",
                    line,
                )
            )
        product_id = as_text(line.get("productId"))
        if product_id and product_id not in product_by_id:
            violations.append(
                _violation(
                    "missing-line-product",
                    "Sale line points at a product that is not in the backup.",
                    "sale_lines",
                    line,
                    "warning",
                )
            )

    for movement in data.cash_movements:
        reason = movement.get("reason")
        delta = movement.get("delta")
        if reason not in CASH_REASONS:
            violations.append(
                _violation("bad-cash-reason", f"Unknown cash reason {reason!r}.", "cash_movements", movement)
            )
        if not isinstance(delta, int) or delta == 0:
            violations.append(
                _violation("bad-cash-delta", "Cash delta must be a non-zero integer.", "cash_movements", movement)
            )
        if not valid_business_date(movement.get("businessDate")):
            violations.append(
                _violation("bad-date", "Cash businessDate must be YYYY-MM-DD.", "cash_movements", movement)
            )
        ref_id = as_text(movement.get("refId"))
        if reason in {"sale", "void"} and ref_id and ref_id not in sale_by_id:
            violations.append(
                _violation(
                    "cash-without-sale",
                    "Sale/void cash points at a sale that is not in the backup.",
                    "cash_movements",
                    movement,
                )
            )
        if reason == "credit_payment" and ref_id and ref_id not in sale_by_id:
            violations.append(
                _violation(
                    "unattached-credit-payment",
                    "Credit payment points at a missing sale; it will be treated as a customer credit.",
                    "cash_movements",
                    movement,
                    "warning",
                )
            )
        if reason in {"tab_credit", "tab_payout"} and ref_id:
            if ref_id not in tab_entry_by_id and ref_id not in sale_by_id:
                violations.append(
                    _violation(
                        "cash-without-tab",
                        "Tab cash points at neither a tab entry nor a sale.",
                        "cash_movements",
                        movement,
                        "warning",
                    )
                )

    for movement in data.stock_movements:
        reason = movement.get("reason")
        if reason not in STOCK_REASONS:
            violations.append(
                _violation("bad-stock-reason", f"Unknown stock reason {reason!r}.", "stock_movements", movement)
            )
        if not isinstance(movement.get("delta"), int) or movement.get("delta") == 0:
            violations.append(
                _violation("bad-stock-delta", "Stock delta must be a non-zero integer.", "stock_movements", movement)
            )
        product_id = as_text(movement.get("productId"))
        if product_id not in product_by_id:
            violations.append(
                _violation(
                    "missing-stock-product",
                    "Stock movement points at a missing product.",
                    "stock_movements",
                    movement,
                )
            )
        ref_id = as_text(movement.get("refId"))
        if reason == "purchase" and ref_id and ref_id not in cash_by_id:
            violations.append(
                _violation(
                    "purchase-without-cash",
                    "Purchase stock points at a missing cash payment.",
                    "stock_movements",
                    movement,
                )
            )
        if reason in {"sale", "void"} and ref_id and ref_id not in sale_by_id:
            violations.append(
                _violation(
                    "stock-without-sale",
                    "Sale/void stock points at a missing sale.",
                    "stock_movements",
                    movement,
                )
            )

    for tab_entry in data.tab_entries:
        tab_id = as_text(tab_entry.get("tabId"))
        if tab_id not in tab_by_id:
            violations.append(
                _violation("orphan-tab-entry", "Tab entry points at a missing customer tab.", "tab_entries", tab_entry)
            )
        if tab_entry.get("kind") not in TAB_KINDS:
            violations.append(
                _violation("bad-tab-kind", "Tab entry kind is not recognised.", "tab_entries", tab_entry)
            )
        if not isinstance(tab_entry.get("amount"), int) or tab_entry.get("amount") == 0:
            violations.append(
                _violation("bad-tab-amount", "Tab amount must be a non-zero integer.", "tab_entries", tab_entry)
            )
        sale_id = as_text(tab_entry.get("saleId"))
        if sale_id and sale_id not in sale_by_id:
            violations.append(
                _violation("tab-missing-sale", "Tab entry points at a missing sale.", "tab_entries", tab_entry)
            )
        cash_id = as_text(tab_entry.get("cashMovementId"))
        if cash_id and cash_id not in cash_by_id:
            violations.append(
                _violation("tab-missing-cash", "Tab entry points at a missing cash movement.", "tab_entries", tab_entry)
            )

    if check_stock_cache:
        movement_totals: dict[str, int] = defaultdict(int)
        for movement in data.stock_movements:
            movement_totals[as_text(movement.get("productId"))] += as_int(
                movement.get("delta"), 0
            )
        for product in data.products:
            product_id = as_text(product.get("id"))
            cached = as_int(product.get("stockQty"), 0)
            ledger_qty = movement_totals.get(product_id, 0)
            if cached != ledger_qty:
                violations.append(
                    _violation(
                        "stock-cache-mismatch",
                        f"Product stock cache is {cached} but the stock ledger adds to {ledger_qty}.",
                        "products",
                        product,
                        "warning",
                    )
                )

    return violations


def rule_accounts_exist() -> list[str]:
    """Return any rule that references an account missing from the chart."""

    missing: list[str] = []
    for rule in RULES:
        for account in (*rule.debit, *rule.credit):
            if account not in ACCOUNT_NAMES:
                missing.append(f"{rule.code}:{int(account)}")
    return missing
