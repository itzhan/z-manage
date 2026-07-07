"""state/ 下的 JSON/CSV 文件读写：免税州地址池、代理池、邮箱账号池、claude platform key 记录。

对齐 claude_console_go/internal/store/store.go。
"""

from __future__ import annotations

import json
import os
import random
import time
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Tuple

TAX_FREE_STATES = {"OR", "MT", "NH", "DE", "AK"}


@dataclass
class Address:
    id: int = 0
    address1: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    used: bool = False


@dataclass
class Proxy:
    host: str = ""
    port: str = ""
    user: str = ""
    password: str = ""

    def raw(self) -> str:
        return f"{self.host}:{self.port}:{self.user}:{self.password}"

    def to_url(self, scheme: str = "socks5") -> str:
        if self.user and self.password:
            return f"{scheme}://{self.user}:{self.password}@{self.host}:{self.port}"
        return f"{scheme}://{self.host}:{self.port}"


@dataclass
class MailAccount:
    email: str = ""
    password: str = ""
    used: bool = False
    token_status: str = ""
    token_error: str = ""


@dataclass
class ClaudePlatformKey:
    id: str = ""
    email: str = ""
    api_key: str = ""
    card_last4: str = ""
    amount: float = 0.0
    proxy_raw: str = ""
    status: str = "active"
    created_at: str = ""
    exported: bool = False
    exported_at: str = ""
    auto_uploaded: bool = False
    auto_uploaded_at: str = ""


class Store:
    def __init__(self, state_dir: str):
        self.state_dir = state_dir
        os.makedirs(state_dir, exist_ok=True)

    # ---- 地址池 ----

    def take_address(self) -> Address:
        """从地址池里随机挑一个免税州地址。"""
        path = os.path.join(self.state_dir, "addresses.json")
        if not os.path.isfile(path):
            raise FileNotFoundError(f"地址池不存在: {path}")
        with open(path) as f:
            all_addrs = json.load(f)
        pool = [a for a in all_addrs if a.get("state", "") in TAX_FREE_STATES]
        if not pool:
            raise RuntimeError("没有可用的免税州地址")
        a = random.choice(pool)
        return Address(
            id=a.get("id", 0),
            address1=a.get("address1", ""),
            city=a.get("city", ""),
            state=a.get("state", ""),
            zip=a.get("zip", ""),
            used=a.get("used", False),
        )

    # ---- 代理池 ----

    def load_proxies(self, base_dir: str, pool: str = "static") -> List[Proxy]:
        if pool == "residential":
            path = os.path.join(self.state_dir, "residential_proxies.json")
            if not os.path.isfile(path):
                raise FileNotFoundError(f"代理文件不存在: {path}")
            with open(path) as f:
                all_proxies = json.load(f)
            return [
                Proxy(host=p["host"], port=str(p["port"]),
                      user=p.get("user", ""), password=p.get("pass", ""))
                for p in all_proxies
                if not p.get("bad") and not p.get("deleted")
            ]

        path = os.path.join(base_dir, "proxy2.csv")
        if not os.path.isfile(path):
            raise FileNotFoundError(
                f"代理文件不存在 {path}（参考 proxy2.csv.example 创建 proxy2.csv）"
            )
        proxies = []
        with open(path) as f:
            for line in f:
                line = line.strip().lstrip("# ").strip()
                if not line:
                    continue
                parts = line.split(":")
                if len(parts) >= 4:
                    proxies.append(Proxy(
                        host=parts[0], port=parts[1],
                        user=parts[2], password=parts[3],
                    ))
        return proxies

    def pick_proxy(self, base_dir: str, pool: str = "static") -> Proxy:
        proxies = self.load_proxies(base_dir, pool)
        if not proxies:
            raise RuntimeError("没有可用的代理IP")
        return random.choice(proxies)

    # ---- mail.com 账号池 ----

    def _mail_pool_path(self) -> str:
        return os.path.join(self.state_dir, "mailcom_accounts.json")

    def load_mail_accounts(self) -> List[MailAccount]:
        path = self._mail_pool_path()
        if not os.path.isfile(path):
            return []
        with open(path) as f:
            raw = json.load(f)
        return [
            MailAccount(
                email=a.get("email", ""),
                password=a.get("password", ""),
                used=a.get("used", False),
                token_status=a.get("tokenStatus", ""),
                token_error=a.get("tokenError", ""),
            )
            for a in raw
        ]

    def next_available_mail_account(self, exclude: Optional[set] = None) -> MailAccount:
        exclude = exclude or set()
        for m in self.load_mail_accounts():
            if m.used:
                continue
            if m.token_status and m.token_status != "ok":
                continue
            if m.email.lower() in exclude:
                continue
            return m
        raise RuntimeError("没有可用的 mail.com 邮箱")

    def mark_mail_used(self, email: str) -> None:
        path = self._mail_pool_path()
        if not os.path.isfile(path):
            return
        try:
            with open(path) as f:
                accounts = json.load(f)
        except (json.JSONDecodeError, ValueError):
            return
        for acct in accounts:
            if isinstance(acct, dict) and acct.get("email", "").lower() == email.lower():
                acct["used"] = True
                break
        self._write_json(path, accounts)

    # ---- Claude platform keys ----

    def append_claude_key(self, key: ClaudePlatformKey) -> Tuple[List[dict], int]:
        path = os.path.join(self.state_dir, "claude_platform_keys.json")
        lst: List[dict] = []
        if os.path.isfile(path):
            try:
                with open(path) as f:
                    lst = json.load(f)
            except (json.JSONDecodeError, ValueError):
                lst = []
        lst.append(asdict(key))
        self._write_json(path, lst)
        return lst, len(lst) - 1

    def save_claude_keys(self, lst: List[dict]) -> None:
        self._write_json(os.path.join(self.state_dir, "claude_platform_keys.json"), lst)

    def _write_json(self, path: str, data) -> None:
        with open(path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
