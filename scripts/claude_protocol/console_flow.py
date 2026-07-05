"""Claude platform console 全流程：登录 → onboarding → 绑卡充值 → 建 API Key。"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from typing import Optional

from .fingerprint import create_session
from .platform_login import PlatformLogin
from .platform_api import PlatformAPI
from .stripe_fingerprint import StripeFingerprint

log = logging.getLogger(__name__)

FALLBACK_ADDRESSES = [
    {"line1": "1234 NW Everett St", "city": "Portland", "state": "OR", "postal_code": "97209", "country": "US"},
    {"line1": "742 SW Morrison St", "city": "Portland", "state": "OR", "postal_code": "97205", "country": "US"},
    {"line1": "300 E Main St", "city": "Bozeman", "state": "MT", "postal_code": "59715", "country": "US"},
    {"line1": "100 Market St", "city": "Portsmouth", "state": "NH", "postal_code": "03801", "country": "US"},
    {"line1": "800 N King St", "city": "Wilmington", "state": "DE", "postal_code": "19801", "country": "US"},
]


@dataclass
class ConsoleArgs:
    email: str
    password: str = ""
    email_source: str = "mailcom"
    outlook_client_id: str = ""
    outlook_refresh_token: str = ""
    card_number: str = ""
    card_expiry: str = ""
    card_cvv: str = ""
    amount: float = 5.0
    proxy: str = ""
    key_name: str = "auto-key"
    yescaptcha_key: str = ""


@dataclass
class FlowResult:
    success: bool = False
    api_key: str = ""
    amount: float = 0.0
    error: str = ""
    session_key: str = ""
    org_id: str = ""
    card_last4: str = ""
    proxy_raw: str = ""


def run_console_flow(args: ConsoleArgs) -> FlowResult:
    result = FlowResult(proxy_raw=args.proxy)
    proxies = {"http": args.proxy, "https": args.proxy} if args.proxy else None

    # TLS 指纹 session
    session, imp, ua = create_session(args.proxy)
    log.info("TLS 指纹: %s, UA: %s...", imp, ua[:50])

    # 1. 登录
    log.info("==== 步骤 1: Magic Link 登录 ====")
    login = PlatformLogin(session, proxies)

    from .mail import poll_magic_link_mailcom, poll_magic_link_outlook
    _magic_link_sent_at = time.time()

    def get_magic_link() -> str:
        if args.email_source == "outlook":
            return poll_magic_link_outlook(
                args.outlook_client_id, args.outlook_refresh_token,
                max_wait=120, interval=5, after_ts=_magic_link_sent_at,
            )
        return poll_magic_link_mailcom(args.email, args.password, max_wait=120, interval=5, after_ts=_magic_link_sent_at)

    try:
        login_result = login.login(args.email, get_magic_link)
    except Exception as e:
        result.error = f"登录失败: {e}"
        log.error(result.error)
        return result

    result.session_key = login_result.session_key
    result.org_id = login_result.org_id
    log.info("登录成功: org_id=%s", result.org_id)

    # API client
    proxy_key = args.proxy or "direct"
    api = PlatformAPI(
        session, login_result.session_key, login_result.org_id, proxies,
        build_sha=getattr(login, '_build_sha', ''),
        device_id=getattr(login, '_device_id', ''),
        activity_session_id=getattr(login, '_activity_session_id', ''),
        proxy_key=proxy_key,
    )

    try:
        pua = StripeFingerprint.fetch_payment_user_agent(session, proxies)
        if pua:
            api._stripe_fp.payment_user_agent = pua
    except Exception:
        pass

    # 2. Onboarding
    log.info("==== 步骤 2: Onboarding ====")
    try:
        api.complete_onboarding(account_uuid=login_result.account_uuid)
        result.org_id = api.org_id
    except Exception as e:
        log.warning("Onboarding 失败: %s", e)

    # 3. 绑卡充值
    if args.card_number:
        log.info("==== 步骤 3: 绑卡 + 充值 $%s ====", args.amount)
        address = random.choice(FALLBACK_ADDRESSES)

        try:
            api.bind_card_full(
                card_number=args.card_number,
                card_expiry=args.card_expiry,
                card_cvc=args.card_cvv,
                address=address,
                name="Auto User",
                yescaptcha_key=args.yescaptcha_key,
            )
            result.card_last4 = args.card_number[-4:]
            log.info("绑卡成功: ****%s", result.card_last4)
        except Exception as e:
            result.error = f"绑卡失败: {e}"
            log.error(result.error)
            return result

        if args.amount > 0:
            try:
                api.upgrade_to_prepaid(address=address)
            except Exception as e:
                log.warning("prepaid upgrade（非致命）: %s", e)
            try:
                api.purchase_credits(args.amount)
                result.amount = args.amount
                log.info("充值成功: $%s", args.amount)
            except Exception as e:
                log.warning("充值失败（非致命）: %s", e)
    else:
        log.info("==== 步骤 3: 跳过绑卡 ====")

    balance = api.get_balance()
    if balance > 0:
        log.info("当前余额: $%.2f", balance)
        result.amount = balance

    # 4. 创建 API Key
    log.info("==== 步骤 4: 创建 API Key ====")
    try:
        result.api_key = api.create_api_key(args.key_name)
        log.info("API Key: %s...", result.api_key[:25])
    except Exception as e:
        result.error = f"创建 API Key 失败: {e}"
        log.error(result.error)
        return result

    result.success = True
    log.info("==== 全流程完成 ====")
    return result
