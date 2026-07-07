"""可选的 SQLite 读写（state/db.sqlite）。

对齐 claude_console_go/internal/db/db.go。
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from typing import Optional


@dataclass
class Card:
    id: str
    card_number: str
    account_id: Optional[str]
    claude_platform_used_count: int
    claude_platform_max_usage: int


@dataclass
class PaymentAccount:
    id: str
    name: str
    balance: float


class DB:
    def __init__(self, state_dir: str):
        self.path = os.path.join(state_dir, "db.sqlite")
        if not os.path.isfile(self.path):
            raise FileNotFoundError(f"SQLite 不存在: {self.path}")

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    def get_card(self, card_id: str) -> Card:
        conn = self._conn()
        try:
            row = conn.execute(
                "SELECT id, cardNumber, accountId, "
                "COALESCE(claudePlatformUsedCount, 0), "
                "COALESCE(claudePlatformMaxUsage, 3) "
                "FROM cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if not row:
                raise LookupError(f"卡 {card_id} 不存在")
            return Card(
                id=row[0],
                card_number=row[1] or "",
                account_id=row[2],
                claude_platform_used_count=row[3],
                claude_platform_max_usage=row[4],
            )
        finally:
            conn.close()

    def set_card_used_count(self, card_id: str, count: int) -> None:
        conn = self._conn()
        try:
            conn.execute(
                "UPDATE cards SET claudePlatformUsedCount = ? WHERE id = ?",
                (count, card_id),
            )
            conn.commit()
        finally:
            conn.close()

    def set_card_status(self, card_id: str, status: str) -> None:
        conn = self._conn()
        try:
            conn.execute(
                "UPDATE cards SET status = ? WHERE id = ?",
                (status, card_id),
            )
            conn.commit()
        finally:
            conn.close()

    def get_payment_account(self, account_id: str) -> PaymentAccount:
        conn = self._conn()
        try:
            row = conn.execute(
                "SELECT id, name, balance FROM payment_accounts WHERE id = ?",
                (account_id,),
            ).fetchone()
            if not row:
                raise LookupError(f"支付账户 {account_id} 不存在")
            return PaymentAccount(id=row[0], name=row[1] or "", balance=row[2] or 0.0)
        finally:
            conn.close()

    def set_payment_account_balance(self, account_id: str, balance: float) -> None:
        conn = self._conn()
        try:
            conn.execute(
                "UPDATE payment_accounts SET balance = ? WHERE id = ?",
                (balance, account_id),
            )
            conn.commit()
        finally:
            conn.close()
