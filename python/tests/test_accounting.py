from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from till_accounting.chart import Account  # noqa: E402
from till_accounting.journal import (  # noqa: E402
    build_journal,
    difference,
    validate_ledger,
    validate_journal,
)
from till_accounting.models import LedgerData, load_backup, parse_backup  # noqa: E402
from till_accounting.rules import rule_accounts_exist, validate_source  # noqa: E402
from till_accounting.statements import (  # noqa: E402
    balance_sheet,
    cash_flow,
    income_statement,
    trial_balance,
)


def record(**over):
    base = {
        "createdAt": 1,
        "updatedAt": 1,
        "deletedAt": None,
        "rev": 1,
        "deviceId": "d",
    }
    base.update(over)
    return base


def product(**over):
    base = record(
        id="p1",
        barcode="S1",
        name="Sugar",
        price=1500,
        cost=1400,
        stockQty=9,
        lowStockThreshold=0,
        category="",
        active=True,
    )
    base.update(over)
    return base


def sale(**over):
    base = record(
        id="s1",
        receiptNo="0001",
        businessDate="2026-10-12",
        subtotal=1500,
        total=1500,
        paymentMethod="cash",
        amountTendered=1500,
        change=0,
        status="completed",
        voidedAt=None,
        note="",
        cashierName="Owner",
        customerName=None,
        createdAt=2,
        updatedAt=2,
    )
    base.update(over)
    return base


def line(**over):
    base = record(
        id="l1",
        saleId="s1",
        productId="p1",
        barcode="S1",
        name="Sugar",
        unitPrice=1500,
        qty=1,
        lineTotal=1500,
        adHoc=False,
    )
    base.update(over)
    return base


def cash(**over):
    base = record(
        id="c1",
        reason="sale",
        delta=1500,
        refId="s1",
        businessDate="2026-10-12",
        note="",
        createdAt=2,
    )
    base.update(over)
    return base


def stock(**over):
    base = record(
        id="m1",
        productId="p1",
        delta=1,
        reason="opening",
        refId=None,
        note="",
        createdAt=1,
    )
    base.update(over)
    return base


def tab(**over):
    base = record(id="t1", name="Customer A", phone=None, note=None, createdAt=1, updatedAt=1)
    base.update(over)
    return base


def tab_entry(**over):
    base = record(
        id="te1",
        tabId="t1",
        kind="credit",
        amount=2000,
        saleId=None,
        cashMovementId=None,
        businessDate="2026-10-12",
        note="",
        createdAt=2,
    )
    base.update(over)
    return base


def base_data(**over) -> LedgerData:
    values = {
        "products": [product()],
        "sales": [sale()],
        "sale_lines": [line()],
        "stock_movements": [
            stock(id="open", delta=10, reason="opening", refId=None),
            stock(id="sold", delta=-1, reason="sale", refId="s1", createdAt=2),
        ],
        "cash_movements": [
            cash(id="float", reason="float", delta=10000, refId=None),
            cash(id="sale-cash", reason="sale", delta=1500, refId="s1"),
        ],
        "customer_tabs": [],
        "tab_entries": [],
    }
    values.update(over)
    return LedgerData(**values)


def errors_only(violations):
    return [violation for violation in violations if violation.severity == "error"]


class AccountingTests(unittest.TestCase):
    def test_cash_sale_and_tab_deposit_balance(self):
        data = base_data(
            customer_tabs=[tab()],
            cash_movements=[
                cash(id="float", reason="float", delta=10000, refId=None),
                cash(id="sale-cash", reason="sale", delta=1500, refId="s1"),
                cash(id="tab-cash", reason="tab_credit", delta=2000, refId="te1"),
            ],
            tab_entries=[
                tab_entry(id="te1", cashMovementId="tab-cash"),
            ],
        )

        journal = build_journal(data)
        self.assertEqual(validate_journal(journal), [])
        self.assertEqual(validate_ledger(data), [])
        self.assertEqual(difference(journal.entries), 0)
        self.assertEqual(validate_source(data), [])

        tb = trial_balance(data)
        self.assertEqual(tb.difference, 0)
        balances = {row.account: row.balance for row in tb.rows}
        self.assertEqual(balances[Account.CASH], 13500)
        self.assertEqual(balances[Account.INVENTORY], 12600)
        self.assertEqual(balances[Account.CUSTOMER_CREDITS], -2000)

        income = income_statement(data)
        self.assertEqual(income.revenue, 1500)
        self.assertEqual(income.cogs, 1400)
        self.assertEqual(income.net_profit, 100)

        sheet = balance_sheet(data)
        self.assertEqual(sheet.check, 0)
        self.assertEqual(sheet.cash, 13500)
        self.assertEqual(sheet.stock_value, 12600)
        self.assertEqual(sheet.customer_credits, 2000)
        self.assertEqual(sheet.retained_profit, 100)

    def test_credit_sale_payment_and_writeoff(self):
        data = base_data(
            products=[product(cost=1000, price=5000)],
            sales=[
                sale(
                    total=5000,
                    subtotal=5000,
                    paymentMethod="credit",
                    amountTendered=None,
                    change=None,
                    customerName="Customer A",
                    writtenOffAmount=3000,
                    writeOffDate="2026-10-20",
                    writtenOffAt=20,
                )
            ],
            sale_lines=[line(unitPrice=5000, lineTotal=5000)],
            cash_movements=[
                cash(id="float", reason="float", delta=10000, refId=None),
                cash(id="pay", reason="credit_payment", delta=2000, refId="s1", businessDate="2026-10-15"),
            ],
            stock_movements=[
                stock(id="open", delta=10, reason="opening", refId=None),
                stock(id="sold", delta=-1, reason="sale", refId="s1", createdAt=2),
            ],
        )

        self.assertEqual(validate_ledger(data), [])
        self.assertEqual(errors_only(validate_source(data)), [])
        tb = trial_balance(data)
        self.assertEqual(tb.difference, 0)

        income = income_statement(data)
        self.assertEqual(income.revenue, 5000)
        self.assertEqual(income.cogs, 1000)
        self.assertEqual(income.bad_debts, 3000)
        self.assertEqual(income.net_profit, 1000)

        sheet = balance_sheet(data)
        self.assertEqual(sheet.receivables, 0)
        self.assertEqual(sheet.cash, 12000)
        self.assertEqual(sheet.stock_value, 9000)
        self.assertEqual(sheet.total_assets, 21000)
        self.assertEqual(sheet.check, 0)

    def test_tab_sale_and_void_reverse_each_other(self):
        data = base_data(
            products=[product(stockQty=10)],
            sales=[
                sale(
                    total=10000,
                    subtotal=10000,
                    status="voided",
                    voidedAt=3,
                    tabApplied=3000,
                    tabChangeKept=500,
                )
            ],
            sale_lines=[line(unitPrice=10000, lineTotal=10000, qty=1)],
            cash_movements=[
                cash(id="float", reason="float", delta=10000, refId=None),
                cash(id="sale-cash", reason="sale", delta=7000, refId="s1"),
                cash(id="kept-cash", reason="tab_credit", delta=500, refId="s1"),
                cash(id="void-cash", reason="void", delta=-7500, refId="s1"),
            ],
            stock_movements=[
                stock(id="open", delta=10, reason="opening", refId=None),
                stock(id="sold", delta=-1, reason="sale", refId="s1", createdAt=2),
                stock(id="voided", delta=1, reason="void", refId="s1", createdAt=3),
            ],
            customer_tabs=[tab()],
            tab_entries=[
                tab_entry(id="sale-tab", kind="sale", amount=-3000, saleId="s1"),
                tab_entry(
                    id="kept-tab",
                    kind="credit",
                    amount=500,
                    saleId="s1",
                    cashMovementId="kept-cash",
                ),
                tab_entry(id="void-restore", kind="void", amount=3000, saleId="s1", createdAt=3),
                tab_entry(id="void-remove", kind="void", amount=-500, saleId="s1", createdAt=3),
            ],
        )

        journal = build_journal(data)
        self.assertEqual(validate_journal(journal), [])
        self.assertEqual(difference(journal.entries), 0)
        self.assertEqual(errors_only(validate_source(data)), [])

        income = income_statement(data)
        self.assertEqual(income.revenue, 10000)
        self.assertEqual(income.returns, 10000)
        self.assertEqual(income.net_revenue, 0)
        self.assertEqual(income.cogs, 0)
        self.assertEqual(income.net_profit, 0)

        sheet = balance_sheet(data)
        self.assertEqual(sheet.customer_credits, 0)
        self.assertEqual(sheet.check, 0)

    def test_orphan_cash_is_reported(self):
        data = LedgerData(cash_movements=[cash(id="orphan", reason="sale", delta=500, refId=None)])
        journal = build_journal(data)
        errors = validate_journal(journal)
        self.assertTrue(any(error.code == "orphan-sale-cash" for error in errors))
        self.assertTrue(any(error.code == "unbalanced-entry" for error in errors))
        self.assertEqual(difference(journal.entries), 500)
        self.assertEqual(trial_balance(data).difference, 500)

    def test_source_rules_catch_bad_line_total(self):
        data = base_data(sale_lines=[line(lineTotal=1400)])
        codes = {violation.code for violation in validate_source(data)}
        self.assertIn("line-total-mismatch", codes)
        self.assertIn("sale-lines-do-not-add-up", codes)

    def test_purchase_variance_and_stock_adjustment_are_named(self):
        data = LedgerData(
            products=[product(cost=1000, price=1500, stockQty=14)],
            cash_movements=[
                cash(id="float", reason="float", delta=10000, refId=None),
                cash(id="buy", reason="purchase", delta=-4000, refId=None),
            ],
            stock_movements=[
                stock(id="open", delta=10, reason="opening", refId=None),
                stock(id="buy-stock", delta=5, reason="purchase", refId="buy"),
                stock(id="short", delta=-1, reason="adjust", refId=None, createdAt=5),
            ],
        )

        self.assertEqual(validate_ledger(data), [])
        self.assertEqual(errors_only(validate_source(data)), [])
        self.assertEqual(trial_balance(data).difference, 0)

        income = income_statement(data)
        self.assertEqual(income.revenue, 0)
        self.assertEqual(income.purchase_variance, 1000)
        self.assertEqual(income.stock_adjust, 1000)
        self.assertEqual(income.net_profit, 0)

        sheet = balance_sheet(data)
        self.assertEqual(sheet.cash, 6000)
        self.assertEqual(sheet.stock_value, 14000)
        self.assertEqual(sheet.check, 0)

    def test_cash_flow_window_matches_drawer(self):
        data = LedgerData(
            cash_movements=[
                cash(id="float", reason="float", delta=10000, refId=None, businessDate="2026-10-12"),
                cash(id="sale-cash", reason="sale", delta=1500, refId="s1", businessDate="2026-10-13"),
            ]
        )
        all_time = cash_flow(data)
        self.assertEqual(all_time.opening, 0)
        self.assertEqual(all_time.net, 11500)
        self.assertEqual(all_time.closing, 11500)

        day = cash_flow(data, ["2026-10-13"])
        self.assertEqual(day.opening, 10000)
        self.assertEqual(day.operating_in, 1500)
        self.assertEqual(day.net, 1500)
        self.assertEqual(day.closing, 11500)

    def test_loader_accepts_camel_and_snake_table_names(self):
        camel = parse_backup(
            {
                "app": "till-pos",
                "tables": {
                    "saleLines": [line()],
                    "stockMovements": [stock()],
                    "cashMovements": [cash()],
                },
            }
        )
        self.assertEqual(len(camel.sale_lines), 1)
        self.assertEqual(len(camel.stock_movements), 1)
        self.assertEqual(len(camel.cash_movements), 1)

        snake = parse_backup({"sale_lines": [line()], "tab_entries": [tab_entry()]})
        self.assertEqual(len(snake.sale_lines), 1)
        self.assertEqual(len(snake.tab_entries), 1)

    def test_sample_backup_is_clean(self):
        path = Path(__file__).resolve().parents[1] / "examples" / "sample_backup.json"
        data = load_backup(path)
        self.assertEqual(validate_source(data), [])
        self.assertEqual(validate_ledger(data), [])
        self.assertEqual(trial_balance(data).difference, 0)
        self.assertEqual(balance_sheet(data).check, 0)

    def test_every_documented_rule_uses_a_real_account(self):
        self.assertEqual(rule_accounts_exist(), [])


if __name__ == "__main__":
    unittest.main()
