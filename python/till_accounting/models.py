"""Loading the till backup into plain record dictionaries.

The app's backup is intentionally a readable JSON archive. Keeping the Python
side on dictionaries makes this tool tolerant of optional fields that older
backups do not have yet.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Mapping


Record = dict[str, Any]

TABLE_ALIASES: dict[str, str] = {
    "products": "products",
    "sales": "sales",
    "saleLines": "sale_lines",
    "sale_lines": "sale_lines",
    "stockMovements": "stock_movements",
    "stock_movements": "stock_movements",
    "cashMovements": "cash_movements",
    "cash_movements": "cash_movements",
    "customerTabs": "customer_tabs",
    "customer_tabs": "customer_tabs",
    "tabEntries": "tab_entries",
    "tab_entries": "tab_entries",
    "settings": "settings",
    "outbox": "outbox",
}


@dataclass
class LedgerData:
    products: list[Record] = field(default_factory=list)
    sales: list[Record] = field(default_factory=list)
    sale_lines: list[Record] = field(default_factory=list)
    stock_movements: list[Record] = field(default_factory=list)
    cash_movements: list[Record] = field(default_factory=list)
    customer_tabs: list[Record] = field(default_factory=list)
    tab_entries: list[Record] = field(default_factory=list)
    app: str = ""
    version: int = 1
    exported_at: str = ""

    @classmethod
    def from_mapping(cls, payload: Mapping[str, Any]) -> "LedgerData":
        source: Mapping[str, Any] = payload
        tables = payload.get("tables")
        if isinstance(tables, Mapping):
            source = tables

        data = cls(
            app=str(payload.get("app", "")),
            version=_as_int(payload.get("version"), 1),
            exported_at=str(payload.get("exportedAt", payload.get("exported_at", ""))),
        )

        for raw_name, records in source.items():
            name = TABLE_ALIASES.get(str(raw_name))
            if name is None:
                continue
            if not isinstance(records, list):
                continue
            cleaned = [dict(record) for record in records if isinstance(record, Mapping)]
            if hasattr(data, name):
                setattr(data, name, cleaned)

        return data

    def table(self, name: str) -> list[Record]:
        if not hasattr(self, name):
            raise KeyError(f"unknown ledger table {name!r}")
        return list(getattr(self, name))

    def tables(self) -> dict[str, list[Record]]:
        return {
            "products": self.products,
            "sales": self.sales,
            "sale_lines": self.sale_lines,
            "stock_movements": self.stock_movements,
            "cash_movements": self.cash_movements,
            "customer_tabs": self.customer_tabs,
            "tab_entries": self.tab_entries,
        }


def load_backup(path: str | Path) -> LedgerData:
    """Read a till backup JSON file."""

    with Path(path).open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, Mapping):
        raise ValueError("backup root must be a JSON object")
    return LedgerData.from_mapping(payload)


def parse_backup(payload: Mapping[str, Any]) -> LedgerData:
    """Parse an already-decoded backup or table dictionary."""

    return LedgerData.from_mapping(payload)


def records_by_id(records: Iterable[Record]) -> dict[str, Record]:
    return {
        str(record["id"]): record
        for record in records
        if record.get("id") is not None
    }


def record_id(record: Record) -> str:
    return str(record.get("id", ""))


def as_int(value: Any, default: int = 0) -> int:
    return _as_int(value, default)


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def as_text(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def is_deleted(record: Record) -> bool:
    return record.get("deletedAt") is not None or record.get("deleted_at") is not None


def valid_business_date(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _as_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(round(value))
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return default
