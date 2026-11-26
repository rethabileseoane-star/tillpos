"""Chart of accounts and posting primitives.

Amounts are integer tambala, exactly like the TypeScript app. Positive is a
debit and negative is a credit. Keeping the chart in one place means the Python
statements use the same account codes as the till.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum


class Account(IntEnum):
    CASH = 1100
    INVENTORY = 1200
    RECEIVABLES = 1300
    CUSTOMER_CREDITS = 2400
    LOANS = 2500
    CAPITAL = 3100
    CONTRIBUTED = 3110
    DRAWINGS = 3200
    SALES = 4100
    RETURNS = 4200
    COGS = 5100
    EXPENSES = 6000
    BAD_DEBTS = 6100
    PURCHASE_VARIANCE = 7210
    STOCK_ADJUST = 7300


# The TypeScript side calls the chart ``ACCOUNTS``. Keep the same spelling for
# script authors while the class remains the typed version.
ACCOUNTS = Account


ACCOUNT_NAMES: dict[Account, str] = {
    Account.CASH: "Cash in drawer",
    Account.INVENTORY: "Stock in the shop",
    Account.RECEIVABLES: "Customers who owe (credit)",
    Account.CUSTOMER_CREDITS: "Customer credits and tabs (cash held for customers)",
    Account.LOANS: "Loans owed",
    Account.CAPITAL: "Owner capital (cash put in)",
    Account.CONTRIBUTED: "Stock brought in",
    Account.DRAWINGS: "Owner drawings",
    Account.SALES: "Sales revenue",
    Account.RETURNS: "Sales returns (voids)",
    Account.COGS: "Cost of goods sold",
    Account.EXPENSES: "Expenses paid",
    Account.BAD_DEBTS: "Bad debts written off",
    Account.PURCHASE_VARIANCE: "Purchase variance",
    Account.STOCK_ADJUST: "Stock adjustments",
}

AccountType = str
ACCOUNT_TYPES: dict[Account, AccountType] = {
    Account.CASH: "asset",
    Account.INVENTORY: "asset",
    Account.RECEIVABLES: "asset",
    Account.CUSTOMER_CREDITS: "liability",
    Account.LOANS: "liability",
    Account.CAPITAL: "equity",
    Account.CONTRIBUTED: "equity",
    Account.DRAWINGS: "equity",
    Account.SALES: "income",
    Account.RETURNS: "expense",
    Account.COGS: "expense",
    Account.EXPENSES: "expense",
    Account.BAD_DEBTS: "expense",
    Account.PURCHASE_VARIANCE: "expense",
    Account.STOCK_ADJUST: "expense",
}

PROFIT_AND_LOSS_ACCOUNTS: tuple[Account, ...] = (
    Account.SALES,
    Account.RETURNS,
    Account.COGS,
    Account.EXPENSES,
    Account.BAD_DEBTS,
    Account.PURCHASE_VARIANCE,
    Account.STOCK_ADJUST,
)


@dataclass(frozen=True)
class Posting:
    """One side of a transaction. Positive debit, negative credit."""

    account: Account
    amount: int

    def __post_init__(self) -> None:
        if not isinstance(self.amount, int):
            raise TypeError("posting amounts must be integer tambala")
