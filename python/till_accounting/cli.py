"""Command-line accountant for a till backup JSON file."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from typing import Any, Sequence

from .models import LedgerData, load_backup, valid_business_date
from .statements import FinancialStatements, financial_statements


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    whole, fraction = divmod(abs(cents), 100)
    return f"{sign}M{whole:,}.{fraction:02d}"


def statements_to_dict(statements: FinancialStatements) -> dict[str, Any]:
    balance = statements.balance_sheet
    income = statements.income_statement
    cash = statements.cash_flow
    trial = statements.trial_balance
    return {
        "dates": statements.dates,
        "validation": [asdict(violation) for violation in statements.validation],
        "journal_errors": [asdict(error) for error in statements.journal_errors],
        "trial_balance": {
            "rows": [
                {
                    "account": int(row.account),
                    "name": row.name,
                    "balance": row.balance,
                }
                for row in trial.rows
            ],
            "difference": trial.difference,
        },
        "income_statement": asdict(income),
        "balance_sheet": asdict(balance),
        "cash_flow": asdict(cash),
    }


def _print_validation(statements: FinancialStatements) -> int:
    errors = [
        violation
        for violation in statements.validation
        if violation.severity == "error"
    ]
    warnings = [
        violation
        for violation in statements.validation
        if violation.severity != "error"
    ]
    print("VALIDATION")
    if not errors and not warnings and not statements.journal_errors:
        print("  OK: no accounting-rule violations.")
        return 0

    for violation in [*errors, *warnings]:
        print(
            f"  {violation.severity.upper():7} {violation.table}/{violation.record_id}: "
            f"{violation.message} [{violation.code}]"
        )
    for error in statements.journal_errors:
        print(f"  ERROR   journal/{error.entry_id or error.source_id}: {error.message} [{error.code}]")
    return len(errors) + len(statements.journal_errors)


def _print_trial_balance(statements: FinancialStatements) -> None:
    trial = statements.trial_balance
    print("\nTRIAL BALANCE")
    print(f"  {'Account':8}  {'Name':52}  {'Debit':>14}  {'Credit':>14}")
    total_debit = 0
    total_credit = 0
    for row in trial.rows:
        if row.balance > 0:
            total_debit += row.balance
            print(f"  {int(row.account):<8}  {row.name:52}  {money(row.balance):>14}  {'':>14}")
        else:
            total_credit += -row.balance
            print(f"  {int(row.account):<8}  {row.name:52}  {'':>14}  {money(-row.balance):>14}")
    print(f"  {'':8}  {'TOTAL':52}  {money(total_debit):>14}  {money(total_credit):>14}")
    if trial.difference != 0:
        print(f"  Difference: {money(trial.difference)}")


def _print_income_statement(statements: FinancialStatements) -> None:
    income = statements.income_statement
    period = ", ".join(statements.dates) if statements.dates else "all time"
    print(f"\nINCOME STATEMENT ({period})")
    print(f"  Sales (gross, before refunds)          {money(income.revenue):>14}")
    print(f"  Less: refunds (voided sales)            {money(-income.returns):>14}")
    print(f"  NET REVENUE                             {money(income.net_revenue):>14}")
    print(f"  Cost of goods sold                      {money(-income.cogs):>14}")
    print(f"  GROSS PROFIT                            {money(income.gross_profit):>14}")
    if income.purchase_variance:
        print(f"  Purchase variance                       {money(income.purchase_variance):>14}")
    if income.stock_adjust:
        print(f"  Stock adjustments                       {money(-income.stock_adjust):>14}")
    print(f"  Expenses                                {money(-income.expenses):>14}")
    print(f"  Bad debts written off                   {money(-income.bad_debts):>14}")
    print(f"  NET PROFIT                              {money(income.net_profit):>14}")
    print(f"  Completed sales: {income.sale_count} | items sold: {income.items_sold}")


def _print_balance_sheet(statements: FinancialStatements) -> None:
    sheet = statements.balance_sheet
    print("\nBALANCE SHEET")
    print(f"  Cash in drawer                          {money(sheet.cash):>14}")
    print(f"  Stock in the shop                       {money(sheet.stock_value):>14}")
    print(f"  Customers who owe                       {money(sheet.receivables):>14}")
    print(f"  TOTAL ASSETS                            {money(sheet.total_assets):>14}")
    print(f"  Loans owed                              {money(sheet.loans):>14}")
    print(f"  Customer credits and tabs               {money(sheet.customer_credits):>14}")
    print(f"  Owner capital                           {money(sheet.capital_in):>14}")
    print(f"  Stock brought in                        {money(sheet.contributed_stock):>14}")
    print(f"  Retained profit                         {money(sheet.retained_profit):>14}")
    print(f"  Owner drawings                          {money(sheet.drawings):>14}")
    print(f"  TOTAL EQUITY                            {money(sheet.total_equity):>14}")
    print(f"  Check (must be 0)                       {money(sheet.check):>14}")


def _print_cash_flow(statements: FinancialStatements) -> None:
    cash = statements.cash_flow
    print("\nCASH FLOW")
    print(f"  Opening cash                            {money(cash.opening):>14}")
    print(f"  Sales and credit collections            {money(cash.operating_in):>14}")
    print(f"  Stock and expenses                      {money(-cash.operating_out):>14}")
    print(f"  Capital and loans in                    {money(cash.financing_in):>14}")
    print(f"  Drawings and loan repayments            {money(-cash.financing_out):>14}")
    print(f"  Tab money in                            {money(cash.tab_in):>14}")
    print(f"  Tab money out                           {money(-cash.tab_out):>14}")
    print(f"  NET MOVEMENT                            {money(cash.net):>14}")
    print(f"  CLOSING CASH                            {money(cash.closing):>14}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="till-accounting",
        description=(
            "Validate a till JSON backup and print trial balance, P&L, "
            "balance sheet and cash flow in integer tambala."
        ),
    )
    parser.add_argument("backup", help="path to a till-backup-YYYY-MM-DD.json file")
    parser.add_argument(
        "--dates",
        nargs="+",
        metavar="YYYY-MM-DD",
        help="business dates for the P&L and cash-flow window (default: all time)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print the statements as JSON instead of text",
    )
    args = parser.parse_args(argv)

    bad_dates = [day for day in (args.dates or []) if not valid_business_date(day)]
    if bad_dates:
        parser.error(
            "--dates must be YYYY-MM-DD; invalid: " + ", ".join(bad_dates)
        )

    data: LedgerData = load_backup(args.backup)
    statements = financial_statements(data, list(args.dates or []))

    if args.json:
        print(json.dumps(statements_to_dict(statements), indent=2))
        failures = sum(
            1
            for violation in statements.validation
            if violation.severity == "error"
        ) + len(statements.journal_errors)
    else:
        failures = _print_validation(statements)
        _print_trial_balance(statements)
        _print_income_statement(statements)
        _print_balance_sheet(statements)
        _print_cash_flow(statements)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
