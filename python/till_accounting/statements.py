"""Financial statements built from the posting journal."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable

from .chart import (
    ACCOUNT_NAMES,
    PROFIT_AND_LOSS_ACCOUNTS,
    Account,
)
from .journal import (
    JournalEntry,
    JournalError,
    balances,
    build_journal,
    validate_journal,
)
from .models import LedgerData, as_int, as_text
from .rules import RuleViolation, validate_source


@dataclass(frozen=True)
class AccountBalance:
    account: Account
    balance: int

    @property
    def name(self) -> str:
        return ACCOUNT_NAMES[self.account]


@dataclass
class TrialBalance:
    rows: list[AccountBalance] = field(default_factory=list)
    difference: int = 0


@dataclass
class IncomeStatement:
    revenue: int = 0
    returns: int = 0
    net_revenue: int = 0
    cogs: int = 0
    gross_profit: int = 0
    purchase_variance: int = 0
    stock_adjust: int = 0
    expenses: int = 0
    bad_debts: int = 0
    net_profit: int = 0
    sale_count: int = 0
    items_sold: int = 0


@dataclass
class BalanceSheet:
    cash: int = 0
    stock_value: int = 0
    receivables: int = 0
    total_assets: int = 0
    loans: int = 0
    customer_credits: int = 0
    capital_in: int = 0
    contributed_stock: int = 0
    retained_profit: int = 0
    drawings: int = 0
    total_equity: int = 0
    check: int = 0


@dataclass
class CashFlow:
    opening: int = 0
    operating_in: int = 0
    operating_out: int = 0
    financing_in: int = 0
    financing_out: int = 0
    tab_in: int = 0
    tab_out: int = 0
    net: int = 0
    closing: int = 0


@dataclass
class FinancialStatements:
    trial_balance: TrialBalance
    income_statement: IncomeStatement
    balance_sheet: BalanceSheet
    cash_flow: CashFlow
    validation: list[RuleViolation] = field(default_factory=list)
    journal_errors: list[JournalError] = field(default_factory=list)
    dates: list[str] = field(default_factory=list)


def date_window(dates: list[str] | None) -> tuple[int, int] | None:
    if not dates:
        return None
    ordered = sorted(day for day in dates if day)
    if not ordered:
        return None
    start = _local_midnight_ms(ordered[0])
    end = _local_midnight_ms(ordered[-1]) + 86_400_000
    return start, end


def in_range(timestamp: int, window: tuple[int, int] | None) -> bool:
    return window is None or window[0] <= timestamp < window[1]


def _local_midnight_ms(day: str) -> int:
    return int(datetime.fromisoformat(f"{day}T00:00:00").timestamp() * 1000)


def _account_total(
    entries: Iterable[JournalEntry],
    account: Account,
) -> int:
    total = 0
    for entry in entries:
        for posting in entry.postings:
            if posting.account == account:
                total += posting.amount
    return total


def trial_balance(data: LedgerData) -> TrialBalance:
    journal = build_journal(data)
    account_balances = balances(journal.entries)
    rows = [
        AccountBalance(account, balance)
        for account, balance in sorted(account_balances.items(), key=lambda pair: int(pair[0]))
        if balance != 0
    ]
    return TrialBalance(rows=rows, difference=sum(row.balance for row in rows))


def income_statement(data: LedgerData, dates: list[str] | None = None) -> IncomeStatement:
    journal = build_journal(data)
    windowed_entries = (
        [entry for entry in journal.entries if entry.date in dates]
        if dates
        else journal.entries
    )

    revenue = -_account_total(windowed_entries, Account.SALES)
    returns = _account_total(windowed_entries, Account.RETURNS)
    cogs = _account_total(windowed_entries, Account.COGS)
    expenses = _account_total(windowed_entries, Account.EXPENSES)
    bad_debts = _account_total(windowed_entries, Account.BAD_DEBTS)
    purchase_variance = -_account_total(windowed_entries, Account.PURCHASE_VARIANCE)
    stock_adjust = _account_total(
        [
            entry
            for entry in journal.entries
            if entry.kind == "stock"
            and entry.meta.get("reason") == "adjust"
            and in_range(entry.created_at, date_window(dates))
        ],
        Account.STOCK_ADJUST,
    )

    windowed_sales = (
        [sale for sale in data.sales if as_text(sale.get("businessDate")) in dates]
        if dates
        else data.sales
    )
    completed = [sale for sale in windowed_sales if sale.get("status") == "completed"]
    completed_ids = {as_text(sale.get("id")) for sale in completed}
    items_sold = sum(
        as_int(line.get("qty"), 0)
        for line in data.sale_lines
        if as_text(line.get("saleId")) in completed_ids
    )

    net_revenue = revenue - returns
    net_profit = (
        net_revenue - cogs - expenses - bad_debts + purchase_variance - stock_adjust
    )
    return IncomeStatement(
        revenue=revenue,
        returns=returns,
        net_revenue=net_revenue,
        cogs=cogs,
        gross_profit=net_revenue - cogs,
        purchase_variance=purchase_variance,
        stock_adjust=stock_adjust,
        expenses=expenses,
        bad_debts=bad_debts,
        net_profit=net_profit,
        sale_count=len(completed),
        items_sold=items_sold,
    )


def balance_sheet(data: LedgerData) -> BalanceSheet:
    journal = build_journal(data)
    account_balances = balances(journal.entries)

    def balance(account: Account) -> int:
        return account_balances.get(account, 0)

    cash = balance(Account.CASH)
    stock_value = sum(
        as_int(product.get("stockQty"), 0)
        * (
            as_int(product.get("cost"), 0)
            if product.get("cost") is not None
            else as_int(product.get("price"), 0)
        )
        for product in data.products
    )
    receivables = balance(Account.RECEIVABLES)
    loans = -balance(Account.LOANS)
    customer_credits = -balance(Account.CUSTOMER_CREDITS)
    capital_in = -balance(Account.CAPITAL)
    contributed_stock = -balance(Account.CONTRIBUTED)
    drawings = -balance(Account.DRAWINGS)
    retained_profit = -sum(balance(account) for account in PROFIT_AND_LOSS_ACCOUNTS)
    total_equity = capital_in + contributed_stock + retained_profit + drawings

    return BalanceSheet(
        cash=cash,
        stock_value=stock_value,
        receivables=receivables,
        total_assets=cash + stock_value + receivables,
        loans=loans,
        customer_credits=customer_credits,
        capital_in=capital_in,
        contributed_stock=contributed_stock,
        retained_profit=retained_profit,
        drawings=drawings,
        total_equity=total_equity,
        check=cash
        + stock_value
        + receivables
        - (loans + customer_credits + total_equity),
    )


def cash_flow(data: LedgerData, dates: list[str] | None = None) -> CashFlow:
    movements = data.cash_movements
    window = (
        [movement for movement in movements if as_text(movement.get("businessDate")) in dates]
        if dates
        else movements
    )

    sales_in = sum(
        as_int(movement.get("delta"), 0)
        for movement in window
        if movement.get("reason") in {"sale", "void", "credit_payment"}
    )
    operating_out = -sum(
        as_int(movement.get("delta"), 0)
        for movement in window
        if movement.get("reason") in {"purchase", "expense"}
    )
    financing_in = sum(
        as_int(movement.get("delta"), 0)
        for movement in window
        if movement.get("reason") in {"float", "cash_in"}
    )
    financing_out = -sum(
        as_int(movement.get("delta"), 0)
        for movement in window
        if movement.get("reason") in {"drawing", "loan_repay"}
    )
    tab_in = sum(
        as_int(movement.get("delta"), 0)
        for movement in window
        if movement.get("reason") == "tab_credit"
    )
    tab_out = -sum(
        as_int(movement.get("delta"), 0)
        for movement in window
        if movement.get("reason") == "tab_payout"
    )

    all_time = sum(as_int(movement.get("delta"), 0) for movement in movements)
    opening = all_time - sum(as_int(movement.get("delta"), 0) for movement in window)
    net = sales_in - operating_out + financing_in - financing_out + tab_in - tab_out
    return CashFlow(
        opening=opening,
        operating_in=sales_in,
        operating_out=operating_out,
        financing_in=financing_in,
        financing_out=financing_out,
        tab_in=tab_in,
        tab_out=tab_out,
        net=net,
        closing=opening + net,
    )


def financial_statements(
    data: LedgerData,
    dates: list[str] | None = None,
) -> FinancialStatements:
    journal = build_journal(data)
    return FinancialStatements(
        trial_balance=trial_balance(data),
        income_statement=income_statement(data, dates),
        balance_sheet=balance_sheet(data),
        cash_flow=cash_flow(data, dates),
        validation=validate_source(data),
        journal_errors=validate_journal(journal),
        dates=list(dates or []),
    )
