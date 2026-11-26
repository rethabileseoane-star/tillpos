"""Double-entry posting engine for the till backup.

Every till event becomes one or more balanced journal entries. This is a port of
the TypeScript journal in ``src/features/ledger/journal.ts`` so an accountant
working in Python sees the same rules as the app.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable, Mapping

from .chart import Account, Posting
from .models import LedgerData, Record, as_int, as_text, records_by_id


@dataclass(frozen=True)
class JournalError:
    code: str
    message: str
    entry_id: str | None = None
    source_id: str | None = None


@dataclass
class JournalEntry:
    id: str
    kind: str
    date: str
    created_at: int
    source_id: str
    postings: list[Posting]
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return sum(posting.amount for posting in self.postings)


@dataclass
class Journal:
    entries: list[JournalEntry] = field(default_factory=list)
    errors: list[JournalError] = field(default_factory=list)


def post(account: Account, amount: int) -> Posting:
    return Posting(account, int(amount))


def cost_of(products: Mapping[str, Record], product_id: str, fallback: int) -> int:
    product = products.get(product_id)
    if not product:
        return fallback
    cost = as_int(product.get("cost"), 0)
    if product.get("cost") is None:
        cost = as_int(product.get("price"), fallback)
    return cost


def local_date(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000).date().isoformat()


def latest_business_date(movements: Iterable[Record], fallback: str) -> str:
    latest = fallback
    for movement in movements:
        day = as_text(movement.get("businessDate"))
        if day > latest:
            latest = day
    return latest


def latest_timestamp(movements: Iterable[Record], fallback: int) -> int:
    latest = fallback
    for movement in movements:
        timestamp = as_int(movement.get("createdAt"), fallback)
        if timestamp > latest:
            latest = timestamp
    return latest


def _push(mapping: dict[str, list[Record]], key: str, value: Record) -> None:
    mapping.setdefault(key, []).append(value)


def _sum_values(values: Iterable[int]) -> int:
    return sum(values)


def _sum_delta(movements: Iterable[Record]) -> int:
    return _sum_values(as_int(movement.get("delta"), 0) for movement in movements)


def _sum_tab_amounts(entries: Iterable[Record]) -> int:
    return _sum_values(as_int(entry.get("amount"), 0) for entry in entries)


def effective_write_off_amount(sale: Record, paid: int) -> int:
    if sale.get("paymentMethod") != "credit" or sale.get("status") != "completed":
        return 0
    written = as_int(sale.get("writtenOffAmount"), 0)
    if written <= 0:
        return 0
    total = as_int(sale.get("total"), 0)
    return min(written, max(0, total - paid))


def _pick_int(record: Record, *keys: str, default: int = 0) -> int:
    for key in keys:
        value = record.get(key)
        if value is not None:
            return as_int(value, default)
    return default


def write_off_date(sale: Record) -> str | None:
    explicit = sale.get("writeOffDate")
    if isinstance(explicit, str) and explicit:
        return explicit
    timestamp = as_int(sale.get("writtenOffAt"), 0)
    if timestamp:
        return local_date(timestamp)
    return None


def build_journal(data: LedgerData) -> Journal:
    entries: list[JournalEntry] = []
    errors: list[JournalError] = []

    sale_by_id = records_by_id(data.sales)
    product_by_id = records_by_id(data.products)
    cash_by_id = records_by_id(data.cash_movements)

    cash_by_sale: dict[str, list[Record]] = {}
    credit_payments_by_sale: dict[str, list[Record]] = {}
    tabs_by_sale: dict[str, list[Record]] = {}

    for movement in data.cash_movements:
        ref_id = as_text(movement.get("refId"))
        if not ref_id:
            continue
        reason = movement.get("reason")
        if reason in {"sale", "void", "tab_credit"} and ref_id in sale_by_id:
            _push(cash_by_sale, ref_id, movement)
        if reason == "credit_payment" and ref_id in sale_by_id:
            _push(credit_payments_by_sale, ref_id, movement)

    for tab_entry in data.tab_entries:
        sale_id = as_text(tab_entry.get("saleId"))
        if sale_id and sale_id in sale_by_id:
            _push(tabs_by_sale, sale_id, tab_entry)

    used_cash: set[str] = set()
    used_tabs: set[str] = set()
    used_stock: set[str] = set()

    for sale in data.sales:
        sale_id = as_text(sale.get("id"))
        sale_cash = cash_by_sale.get(sale_id, [])
        original_cash = [
            movement
            for movement in sale_cash
            if movement.get("reason") in {"sale", "tab_credit"}
        ]
        void_cash = [
            movement for movement in sale_cash if movement.get("reason") == "void"
        ]
        sale_tabs = tabs_by_sale.get(sale_id, [])
        original_tabs = [
            tab_entry
            for tab_entry in sale_tabs
            if tab_entry.get("kind") in {"sale", "credit"}
        ]
        void_tabs = [
            tab_entry for tab_entry in sale_tabs if tab_entry.get("kind") == "void"
        ]

        for movement in original_cash:
            used_cash.add(as_text(movement.get("id")))
        for tab_entry in original_tabs:
            used_tabs.add(as_text(tab_entry.get("id")))

        total = as_int(sale.get("total"), 0)
        original_postings = [post(Account.SALES, -total)]
        if sale.get("paymentMethod") == "credit":
            original_postings.append(post(Account.RECEIVABLES, total))
        else:
            cash_in = _sum_delta(original_cash)
            tab_net = _sum_tab_amounts(original_tabs)
            if cash_in:
                original_postings.append(post(Account.CASH, cash_in))
            if tab_net:
                original_postings.append(post(Account.CUSTOMER_CREDITS, -tab_net))

        entries.append(
            JournalEntry(
                id=f"sale:{sale_id}",
                kind="sale",
                date=as_text(sale.get("businessDate")),
                created_at=as_int(sale.get("createdAt"), 0),
                source_id=sale_id,
                postings=original_postings,
                meta={
                    "receiptNo": as_text(sale.get("receiptNo")),
                    "paymentMethod": as_text(sale.get("paymentMethod")),
                },
            )
        )

        received = _sum_delta(credit_payments_by_sale.get(sale_id, []))

        if sale.get("status") == "voided":
            for movement in void_cash:
                used_cash.add(as_text(movement.get("id")))
            for tab_entry in void_tabs:
                used_tabs.add(as_text(tab_entry.get("id")))

            reversal = [post(Account.RETURNS, total)]
            if sale.get("paymentMethod") == "credit":
                refunded = -_sum_delta(void_cash)
                held = received - refunded
                reversal.append(post(Account.RECEIVABLES, -(total - received)))
                if void_cash:
                    reversal.append(post(Account.CASH, -refunded))
                if held:
                    reversal.append(post(Account.CUSTOMER_CREDITS, -held))
            else:
                cash_out = _sum_delta(void_cash)
                tab_net = _sum_tab_amounts(void_tabs)
                if cash_out:
                    reversal.append(post(Account.CASH, cash_out))
                if tab_net:
                    reversal.append(post(Account.CUSTOMER_CREDITS, -tab_net))

            entries.append(
                JournalEntry(
                    id=f"sale-void:{sale_id}",
                    kind="void",
                    date=as_text(sale.get("businessDate")),
                    created_at=_pick_int(sale, "voidedAt", "updatedAt"),
                    source_id=sale_id,
                    postings=reversal,
                    meta={"receiptNo": as_text(sale.get("receiptNo"))},
                )
            )

        written = effective_write_off_amount(sale, received)
        if written > 0:
            day = write_off_date(sale) or as_text(sale.get("businessDate"))
            entries.append(
                JournalEntry(
                    id=f"sale-writeoff:{sale_id}",
                    kind="writeoff",
                    date=day,
                    created_at=_pick_int(sale, "writtenOffAt", "updatedAt"),
                    source_id=sale_id,
                    postings=[
                        post(Account.BAD_DEBTS, written),
                        post(Account.RECEIVABLES, -written),
                    ],
                    meta={"receiptNo": as_text(sale.get("receiptNo"))},
                )
            )

        if sale.get("paymentMethod") == "credit" and sale.get("status") == "completed":
            overpaid = max(0, received - total)
            if overpaid > 0:
                payments = credit_payments_by_sale.get(sale_id, [])
                entries.append(
                    JournalEntry(
                        id=f"sale-overpayment:{sale_id}",
                        kind="overpayment",
                        date=latest_business_date(
                            payments, as_text(sale.get("businessDate"))
                        ),
                        created_at=latest_timestamp(
                            payments, as_int(sale.get("createdAt"), 0)
                        ),
                        source_id=sale_id,
                        postings=[
                            post(Account.RECEIVABLES, overpaid),
                            post(Account.CUSTOMER_CREDITS, -overpaid),
                        ],
                        meta={"receiptNo": as_text(sale.get("receiptNo"))},
                    )
                )

    for tab_entry in data.tab_entries:
        tab_entry_id = as_text(tab_entry.get("id"))
        if tab_entry_id in used_tabs:
            continue

        linked_cash = cash_by_id.get(as_text(tab_entry.get("cashMovementId")))
        amount = as_int(tab_entry.get("amount"), 0)
        postings = [post(Account.CUSTOMER_CREDITS, -amount)]

        if linked_cash and linked_cash.get("reason") in {"tab_credit", "tab_payout"}:
            postings.append(post(Account.CASH, as_int(linked_cash.get("delta"), 0)))
            used_cash.add(as_text(linked_cash.get("id")))
        else:
            sale_id = as_text(tab_entry.get("saleId"))
            code = (
                "missing-sale-for-tab"
                if sale_id and sale_id not in sale_by_id
                else "tab-entry-without-cash"
            )
            errors.append(
                JournalError(
                    code,
                    (
                        f"Tab entry {tab_entry_id} points at sale {sale_id}, "
                        "which is not in this backup."
                        if code == "missing-sale-for-tab"
                        else f"Tab entry {tab_entry_id} has no cash movement behind it."
                    ),
                    entry_id=f"tab:{tab_entry_id}",
                    source_id=tab_entry_id,
                )
            )

        entries.append(
            JournalEntry(
                id=f"tab:{tab_entry_id}",
                kind="tab",
                date=as_text(tab_entry.get("businessDate")),
                created_at=as_int(tab_entry.get("createdAt"), 0),
                source_id=tab_entry_id,
                postings=postings,
                meta={
                    "tabId": as_text(tab_entry.get("tabId")),
                    "kind": as_text(tab_entry.get("kind")),
                },
            )
        )

    for movement in data.cash_movements:
        movement_id = as_text(movement.get("id"))
        if movement_id in used_cash:
            continue

        reason = movement.get("reason")
        delta = as_int(movement.get("delta"), 0)
        postings: list[Posting] = []
        kind = "cash"

        if reason == "credit_payment":
            postings.append(post(Account.CASH, delta))
            sale = sale_by_id.get(as_text(movement.get("refId")))
            if sale and sale.get("paymentMethod") == "credit":
                postings.append(post(Account.RECEIVABLES, -delta))
            else:
                postings.append(post(Account.CUSTOMER_CREDITS, -delta))
            kind = "credit"
        elif reason == "float":
            postings.extend(
                [post(Account.CASH, delta), post(Account.CAPITAL, -delta)]
            )
        elif reason == "cash_in":
            account = (
                Account.LOANS if movement.get("kind") == "loan" else Account.CAPITAL
            )
            postings.extend([post(Account.CASH, delta), post(account, -delta)])
        elif reason == "purchase":
            purchase_moves = [
                stock_move
                for stock_move in data.stock_movements
                if stock_move.get("reason") == "purchase"
                and as_text(stock_move.get("refId")) == movement_id
            ]
            for stock_move in purchase_moves:
                used_stock.add(as_text(stock_move.get("id")))
            booked = _sum_values(
                as_int(stock_move.get("delta"), 0)
                * cost_of(
                    product_by_id,
                    as_text(stock_move.get("productId")),
                    0,
                )
                for stock_move in purchase_moves
            )
            paid = abs(delta)
            postings.extend(
                [
                    post(Account.CASH, delta),
                    post(Account.INVENTORY, booked),
                    post(Account.PURCHASE_VARIANCE, paid - booked),
                ]
            )
            kind = "purchase"
        elif reason == "drawing":
            postings.extend(
                [post(Account.CASH, delta), post(Account.DRAWINGS, -delta)]
            )
        elif reason == "expense":
            postings.extend(
                [post(Account.CASH, delta), post(Account.EXPENSES, -delta)]
            )
        elif reason == "loan_repay":
            postings.extend([post(Account.CASH, delta), post(Account.LOANS, -delta)])
        elif reason in {"sale", "void"}:
            postings.append(post(Account.CASH, delta))
            errors.append(
                JournalError(
                    "orphan-sale-cash",
                    f"Cash movement {movement_id} points at a sale not in this backup.",
                    entry_id=f"cash:{movement_id}",
                    source_id=movement_id,
                )
            )
        elif reason in {"tab_credit", "tab_payout"}:
            postings.append(post(Account.CASH, delta))
            errors.append(
                JournalError(
                    "orphan-tab-cash",
                    f"Cash movement {movement_id} has no tab entry behind it.",
                    entry_id=f"cash:{movement_id}",
                    source_id=movement_id,
                )
            )
        else:
            postings.append(post(Account.CASH, delta))
            errors.append(
                JournalError(
                    "unknown-cash-reason",
                    f"Cash movement {movement_id} has unknown reason {reason!r}.",
                    entry_id=f"cash:{movement_id}",
                    source_id=movement_id,
                )
            )

        entries.append(
            JournalEntry(
                id=f"cash:{movement_id}",
                kind=kind,
                date=as_text(movement.get("businessDate")),
                created_at=as_int(movement.get("createdAt"), 0),
                source_id=movement_id,
                postings=postings,
                meta={"reason": reason},
            )
        )

    for line in data.sale_lines:
        sale = sale_by_id.get(as_text(line.get("saleId")))
        if not sale or sale.get("status") != "completed":
            continue
        qty = as_int(line.get("qty"), 0)
        unit_price = as_int(line.get("unitPrice"), 0)
        cost = cost_of(
            product_by_id,
            as_text(line.get("productId")),
            unit_price,
        )
        amount = qty * cost
        entries.append(
            JournalEntry(
                id=f"cogs:{as_text(line.get('id'))}",
                kind="cogs",
                date=as_text(sale.get("businessDate")),
                created_at=as_int(sale.get("createdAt"), 0),
                source_id=as_text(line.get("id")),
                postings=[
                    post(Account.COGS, amount),
                    post(Account.INVENTORY, -amount),
                ],
                meta={
                    "saleId": as_text(line.get("saleId")),
                    "productId": as_text(line.get("productId")),
                },
            )
        )

    for stock_move in data.stock_movements:
        stock_move_id = as_text(stock_move.get("id"))
        if stock_move_id in used_stock:
            continue

        reason = stock_move.get("reason")
        if reason == "purchase":
            errors.append(
                JournalError(
                    "purchase-stock-without-payment",
                    f"Purchase stock movement {stock_move_id} has no cash payment.",
                    source_id=stock_move_id,
                )
            )
            continue
        if reason in {"sale", "void"}:
            continue

        value = as_int(stock_move.get("delta"), 0) * cost_of(
            product_by_id,
            as_text(stock_move.get("productId")),
            0,
        )
        if reason == "adjust":
            postings = [
                post(Account.INVENTORY, value),
                post(Account.STOCK_ADJUST, -value),
            ]
        elif reason in {"import", "opening"}:
            postings = [
                post(Account.INVENTORY, value),
                post(Account.CONTRIBUTED, -value),
            ]
        else:
            postings = [
                post(Account.INVENTORY, value),
                post(Account.CONTRIBUTED, -value),
            ]
            errors.append(
                JournalError(
                    "unknown-stock-reason",
                    f"Stock movement {stock_move_id} has unknown reason {reason!r}.",
                    source_id=stock_move_id,
                )
            )

        entries.append(
            JournalEntry(
                id=f"stock:{stock_move_id}",
                kind="stock",
                date=local_date(as_int(stock_move.get("createdAt"), 0)),
                created_at=as_int(stock_move.get("createdAt"), 0),
                source_id=stock_move_id,
                postings=postings,
                meta={
                    "reason": reason,
                    "productId": as_text(stock_move.get("productId")),
                },
            )
        )

    entries.sort(key=lambda entry: (entry.date, entry.created_at, entry.id))
    return Journal(entries, errors)


def balances(entries: Iterable[JournalEntry]) -> dict[Account, int]:
    result: dict[Account, int] = {}
    for entry in entries:
        for posting in entry.postings:
            result[posting.account] = result.get(posting.account, 0) + posting.amount
    return result


def difference(entries: Iterable[JournalEntry]) -> int:
    return sum(posting.amount for entry in entries for posting in entry.postings)


def validate_journal(journal: Journal) -> list[JournalError]:
    errors = list(journal.errors)
    for entry in journal.entries:
        total = entry.total
        if total != 0:
            errors.append(
                JournalError(
                    "unbalanced-entry",
                    f"Journal entry {entry.id} is out by {total} tambala.",
                    entry_id=entry.id,
                    source_id=entry.source_id,
                )
            )
    return errors


def validate_ledger(data: LedgerData) -> list[JournalError]:
    return validate_journal(build_journal(data))
