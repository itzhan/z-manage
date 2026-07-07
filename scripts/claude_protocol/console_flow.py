"""platform.claude.com Console 全流程编排。

对齐 claude_console_go/main.go runFlow：
  magic link 登录 → onboarding → 绑卡充值 → 创建 API Key
  → 保存 claude_platform_keys.json → Hub 同步 → 标记邮箱 used → 扣卡额度

与 Go 版的核心差异：Go 版通过浏览器操作 Stripe iframe 填卡号；
Python 协议版直接调 Stripe API（/v1/tokens + /v1/setup_intents），
不经过 Stripe.js iframe。
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .fingerprint import create_session
from .platform_login import PlatformLogin, LoginResult
from .platform_api import PlatformAPI
from .mail import poll_magic_link_mailcom, poll_magic_link_outlook
from .config import Config
from .store import Store, ClaudePlatformKey, Proxy
from .hub import sync_claude_key
from .db import DB
from .stripe_fingerprint import StripeFingerprint

log = logging.getLogger(__name__)


@dataclass
class ConsoleArgs:
    """CLI 参数，对齐 claude_console_go/main.go args。"""
    email: str
    password: str = ""              # mail.com 密码
    email_source: str = "mailcom"   # mailcom / outlook
    outlook_client_id: str = ""
    outlook_refresh_token: str = ""
    card_number: str = ""
    card_expiry: str = ""           # MMYY 或 MM/YY
    card_cvv: str = ""
    card_id: str = ""               # 卡 ID（用于 SQLite 记账）
    amount: float = 5.0
    proxy: str = ""                 # 直接指定代理 URL
    proxy_pool: str = "static"      # static / residential
    key_name: str = "auto-key"
    yescaptcha_key: str = ""        # YesCaptcha API key（Stripe hCaptcha 求解）


class ErrorType:
    """错误分类常量。"""
    LOGIN_SEND_MAGIC_LINK = "login_send_magic_link"     # 发送 magic link 失败
    LOGIN_MAIL_FETCH = "login_mail_fetch"               # 读取邮箱获取 magic link 失败
    LOGIN_VERIFY = "login_verify"                       # magic link 验证失败（含 429 限速）
    LOGIN_RATE_LIMIT = "login_rate_limit"               # 登录限速 429
    ONBOARDING = "onboarding"                           # onboarding / org 创建失败
    CARD_DECLINED = "card_declined"                     # Stripe 绑卡被拒（Radar/发卡行）
    CARD_HCAPTCHA = "card_hcaptcha"                     # hCaptcha 求解失败
    CARD_SETUP_INTENT = "card_setup_intent"             # SetupIntent 创建失败
    CARD_CONFIRM = "card_confirm"                       # Stripe confirm 失败（非 decline）
    CARD_BIND_OTHER = "card_bind_other"                 # 绑卡其他错误
    UPGRADE_FAILED = "upgrade_failed"                   # plan 升级失败
    PURCHASE_INVOICE_FAILED = "purchase_invoice_failed" # 充值 invoice 未 paid（卡扣款失败）
    PURCHASE_API_ERROR = "purchase_api_error"           # 充值接口返回错误
    CREATE_KEY_FAILED = "create_key_failed"             # API Key 创建失败


@dataclass
class FlowResult:
    success: bool = False
    api_key: str = ""
    amount: float = 0.0
    error: str = ""
    error_type: str = ""
    session_key: str = ""
    org_id: str = ""
    card_last4: str = ""
    proxy_raw: str = ""


def run_console_flow(args: ConsoleArgs, cfg: Optional[Config] = None) -> FlowResult:
    """一站式执行 Claude platform console 全流程。"""
    result = FlowResult()

    # ---- 基础设施初始化 ----
    st = Store(cfg.state_dir) if cfg else None
    database: Optional[DB] = None
    if cfg:
        try:
            database = DB(cfg.state_dir)
        except FileNotFoundError:
            pass

    # ---- 启动前验证卡使用次数 ----
    if args.card_id and database:
        try:
            card = database.get_card(args.card_id)
            max_usage = card.claude_platform_max_usage or 3
            if card.claude_platform_used_count >= max_usage:
                result.error = (
                    f"卡 ****{card.card_number[-4:]} 已达上限 "
                    f"{card.claude_platform_used_count}/{max_usage}，跳过"
                )
                log.error(result.error)
                return result
        except Exception:
            pass

    # ---- 代理 ----
    proxy_url = args.proxy
    proxy_obj: Optional[Proxy] = None
    if not proxy_url and st and cfg:
        try:
            proxy_obj = st.pick_proxy(cfg.base_dir, args.proxy_pool)
            proxy_url = proxy_obj.to_url()
            result.proxy_raw = proxy_obj.raw()
            log.info("随机代理: %s:%s", proxy_obj.host, proxy_obj.port)
        except Exception as e:
            log.warning("代理池加载失败: %s", e)
    elif proxy_url:
        result.proxy_raw = proxy_url

    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None

    # ---- 创建 Session（TLS 指纹伪装）----
    session, imp, ua = create_session(proxy_url)
    log.info("TLS 指纹: %s, UA: %s...", imp, ua[:50])

    # ---- 1. 登录 ----
    log.info("==== 步骤 1: Magic Link 登录 ====")
    login = PlatformLogin(session, proxies)

    email_source = args.email_source.lower()

    def get_magic_link() -> str:
        if email_source == "outlook":
            return poll_magic_link_outlook(
                args.outlook_client_id, args.outlook_refresh_token,
                max_wait=120, interval=5,
            )
        else:
            return poll_magic_link_mailcom(
                args.email, args.password,
                max_wait=120, interval=5,
            )

    try:
        login_result = login.login(args.email, get_magic_link)
    except Exception as e:
        err_str = str(e)
        if "429" in err_str or "rate limit" in err_str.lower():
            result.error_type = ErrorType.LOGIN_RATE_LIMIT
        elif "magic link" in err_str.lower() and "验证" in err_str:
            result.error_type = ErrorType.LOGIN_VERIFY
        elif "mail" in err_str.lower() or "邮箱" in err_str:
            result.error_type = ErrorType.LOGIN_MAIL_FETCH
        else:
            result.error_type = ErrorType.LOGIN_VERIFY
        result.error = f"登录失败: {e}"
        log.error("[%s] %s", result.error_type, result.error)
        _mark_used(st, args.email)
        return result

    result.session_key = login_result.session_key
    result.org_id = login_result.org_id
    log.info("登录成功: org_id=%s", result.org_id)

    # ---- API client（传递 login 阶段获得的 Anthropic headers + Stripe 指纹配置） ----
    state_dir = cfg.state_dir if cfg else ""
    proxy_key_str = f"{proxy_obj.host}:{proxy_obj.port}" if proxy_obj else (proxy_url or "direct")

    api = PlatformAPI(
        session, login_result.session_key, login_result.org_id, proxies,
        build_sha=getattr(login, '_build_sha', ''),
        device_id=getattr(login, '_device_id', ''),
        activity_session_id=getattr(login, '_activity_session_id', ''),
        state_dir=state_dir,
        proxy_key=proxy_key_str,
    )

    # payment_user_agent 由 StripeFingerprint.ensure_payment_user_agent() 在绑卡时自动获取

    # ---- 2. Onboarding ----
    log.info("==== 步骤 2: Onboarding ====")

    # 从 login_result 中获取 account_uuid（用于创建 org）
    account_uuid = login_result.account_uuid

    # 如果没从 verify 响应拿到，尝试从 bootstrap 获取
    if not account_uuid:
        try:
            h = api._headers(referer="/onboarding")
            h.pop("Content-Type", None)
            r_bs = session.get(
                "https://platform.claude.com/api/bootstrap",
                headers=h, proxies=proxies, timeout=15,
            )
            if r_bs.status_code == 200:
                bs_data = r_bs.json()
                account_uuid = bs_data.get("account", {}).get("uuid", "")
        except Exception:
            pass

    try:
        api.complete_onboarding(account_uuid=account_uuid)
        result.org_id = api.org_id
    except Exception as e:
        log.warning("Onboarding 失败: %s", e)

    # ---- 3. 绑卡充值 ----
    if args.card_number:
        log.info("==== 步骤 3: 绑卡 + 充值 $%s ====", args.amount)
        try:
            address = _pick_address(st)
            api.bind_card_full(
                card_number=args.card_number,
                card_expiry=args.card_expiry,
                card_cvc=args.card_cvv,
                address=address,
                name="Auto User",
                yescaptcha_key=args.yescaptcha_key,
            )
            result.card_last4 = args.card_number[-4:] if len(args.card_number) >= 4 else args.card_number
            log.info("绑卡成功: ****%s", result.card_last4)
        except Exception as e:
            err_str = str(e).lower()
            if "declined" in err_str or "拒" in str(e) or "generic_decline" in err_str:
                result.error_type = ErrorType.CARD_DECLINED
            elif "hcaptcha" in err_str or "captcha" in err_str:
                result.error_type = ErrorType.CARD_HCAPTCHA
            elif "setup_intent" in err_str or "SetupIntent" in str(e):
                result.error_type = ErrorType.CARD_SETUP_INTENT
            elif "confirm" in err_str or "402" in err_str or "401" in err_str:
                result.error_type = ErrorType.CARD_CONFIRM
            else:
                result.error_type = ErrorType.CARD_BIND_OTHER
            result.error = f"绑卡失败: {e}"
            log.error("[%s] %s", result.error_type, result.error)
            if result.error_type == ErrorType.CARD_DECLINED:
                if args.card_id and database:
                    try:
                        database.set_card_status(args.card_id, "disabled")
                        log.info("卡 ****%s 已标记为冻结", result.card_last4)
                    except Exception:
                        pass
            _mark_used(st, args.email)
            return result

        # 升级 plan（api_evaluation → prepaid）+ 充值
        if args.amount > 0:
            try:
                api.upgrade_to_prepaid(address=address)
            except Exception as e:
                log.warning("prepaid upgrade（非致命）: %s", e)
            try:
                purchase = api.purchase_credits(args.amount)
                result.amount = args.amount
                log.info("充值成功: $%s", args.amount)
            except Exception as e:
                err_str = str(e).lower()
                if "未到账" in str(e) or "invoice" in err_str:
                    result.error_type = ErrorType.PURCHASE_INVOICE_FAILED
                else:
                    result.error_type = ErrorType.PURCHASE_API_ERROR
                log.warning("[%s] 充值失败: %s", result.error_type, e)
    else:
        log.info("==== 步骤 3: 跳过绑卡（未提供卡号）====")

    # 检查余额
    balance = api.get_balance()
    if balance > 0:
        log.info("当前余额: $%.2f", balance)
        result.amount = balance

    # ---- 4. 创建 API Key ----
    log.info("==== 步骤 4: 创建 API Key ====")
    try:
        api_key = api.create_api_key(args.key_name)
        result.api_key = api_key
        log.info("API Key: %s...", api_key[:25])
    except Exception as e:
        result.error_type = ErrorType.CREATE_KEY_FAILED
        result.error = f"创建 API Key 失败: {e}"
        log.error("[%s] %s", result.error_type, result.error)
        _mark_used(st, args.email)
        return result

    # ---- 5. 保存 + Hub 同步 + 标记 + 记账 ----
    result.success = True

    if st:
        entry = ClaudePlatformKey(
            id=f"cpk_{int(time.time())}",
            email=args.email,
            api_key=result.api_key,
            card_last4=result.card_last4,
            amount=result.amount,
            proxy_raw=result.proxy_raw,
            status="active",
            created_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
        )
        try:
            lst, idx = st.append_claude_key(entry)
        except Exception as e:
            log.warning("保存 claude_platform_keys.json 失败（忽略）: %s", e)
            lst, idx = None, -1

        if lst is not None and cfg:
            if sync_claude_key(
                session, cfg.settings.resource_hub,
                entry.email, entry.api_key,
                max_retries=3, proxies=proxies,
            ):
                now = time.strftime("%Y-%m-%dT%H:%M:%S")
                lst[idx]["exported"] = True
                lst[idx]["exported_at"] = now
                lst[idx]["auto_uploaded"] = True
                lst[idx]["auto_uploaded_at"] = now
                try:
                    st.save_claude_keys(lst)
                except Exception:
                    pass

    _mark_used(st, args.email)

    if args.card_id and database:
        _deduct_card(database, args.card_id, result.amount)

    log.info("==== 全流程完成 ====")
    return result


def _pick_address(st: Optional[Store]) -> dict:
    """从地址池取随机免税州地址。"""
    if st:
        try:
            addr = st.take_address()
            return {
                "line1": addr.address1, "city": addr.city,
                "state": addr.state, "postal_code": addr.zip, "country": "US",
            }
        except Exception as e:
            log.warning("地址池不可用，使用兜底地址: %s", e)
    return {
        "line1": "1234 NW Everett St", "city": "Portland",
        "state": "OR", "postal_code": "97209", "country": "US",
    }


def _mark_used(st: Optional[Store], email: str):
    if st:
        try:
            st.mark_mail_used(email)
        except Exception:
            pass


def _deduct_card(database: DB, card_id: str, amount: float):
    """扣卡使用次数 + 扣关联支付账户余额。"""
    try:
        card = database.get_card(card_id)
        max_usage = card.claude_platform_max_usage or 3
        if card.claude_platform_used_count >= max_usage:
            log.info("卡 ****%s 已达上限 %d/%d，不再扣减",
                     card.card_number[-4:], card.claude_platform_used_count, max_usage)
            return
        new_count = card.claude_platform_used_count + 1
        database.set_card_used_count(card_id, new_count)
        log.info("卡 ****%s claudePlatformUsedCount → %d", card.card_number[-4:], new_count)

        if card.account_id:
            try:
                pa = database.get_payment_account(card.account_id)
                new_bal = max(0.0, pa.balance - amount)
                database.set_payment_account_balance(pa.id, new_bal)
                log.info("账户 %s 余额 → $%s", pa.name, new_bal)
            except Exception:
                pass
    except Exception as e:
        log.warning("扣卡额度失败（忽略，需 state/db.sqlite）: %s", e)
