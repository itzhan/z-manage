"""platform.claude.com 后端 API 封装：Onboarding / Billing / API Key 管理。

从 claude_console_go/internal/flow/claude.go 的浏览器操作
反推并转译为纯 HTTP API 调用。

端点来源（2026-07-05 JS 逆向确认）：
  - Onboarding:     GET/POST /api/organizations/{org}/console_onboarding
  - Stripe Intent:  POST /api/stripe/{org}/intent
  - Payment Method: POST /api/organizations/{org}/payment_method/update_latest
  - Purchase:       POST /api/organizations/{org}/prepaid/credits
  - API Keys:       POST /api/console/organizations/{org}/workspaces/default/api_keys
  - Balance:        GET  /api/organizations/{org}/prepaid/credits
  - Stripe Region:  GET  /api/billing/stripe_region
"""

from __future__ import annotations

import json
import logging
import random
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from .stripe_fingerprint import StripeFingerprint, StripeDevice

log = logging.getLogger(__name__)

PLATFORM_BASE = "https://platform.claude.com"

FIRST_NAMES = [
    "James", "Robert", "John", "Michael", "David",
    "William", "Thomas", "Christopher", "Daniel", "Matthew",
]
LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones",
    "Miller", "Davis", "Wilson", "Taylor", "Anderson",
]

API_KEY_RE = re.compile(r"sk-ant-[a-zA-Z0-9_-]+")


class PlatformAPI:
    """Anthropic Console 后端 API 封装。"""

    def __init__(self, session, session_key: str = "", org_id: str = "",
                 proxies=None, build_sha: str = "", device_id: str = "",
                 activity_session_id: str = "", state_dir: str = "",
                 proxy_key: str = ""):
        self.session = session
        self.session_key = session_key
        self.org_id = org_id
        self.proxies = proxies
        self._stripe_pk = ""
        self._build_sha = build_sha
        self._device_id = device_id
        self._activity_session_id = activity_session_id
        self._anonymous_id = str(uuid.uuid4())
        self._proxy_key = proxy_key
        self._stripe_fp = StripeFingerprint(
            state_dir=state_dir,
            ua=session.headers.get("User-Agent", ""),
        )
        self._stripe_device: Optional[StripeDevice] = None

    def _headers(self, extra: Optional[dict] = None, referer: str = "/dashboard") -> dict:
        h: dict = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": PLATFORM_BASE,
            "Referer": f"{PLATFORM_BASE}{referer}",
            "anthropic-client-platform": "web_console",
        }
        if self.session_key:
            h["Authorization"] = f"Bearer {self.session_key}"
        if self._build_sha:
            h["anthropic-client-sha"] = self._build_sha
            h["anthropic-client-version"] = "unknown"
        if self._device_id:
            h["anthropic-device-id"] = self._device_id
        if self._activity_session_id:
            h["x-activity-session-id"] = self._activity_session_id
        if self._anonymous_id:
            h["anthropic-anonymous-id"] = self._anonymous_id
        if extra:
            h.update(extra)
        return h

    def _get(self, path: str, **kwargs) -> Any:
        h = self._headers()
        h.pop("Content-Type", None)
        r = self.session.get(
            f"{PLATFORM_BASE}{path}",
            headers=h, proxies=self.proxies, timeout=30, **kwargs,
        )
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, body: Any = None,
              extra_headers: Optional[dict] = None,
              referer: str = "/dashboard") -> Any:
        h = self._headers(extra_headers, referer=referer)
        r = self.session.post(
            f"{PLATFORM_BASE}{path}",
            headers=h,
            data=json.dumps(body) if body else None,
            proxies=self.proxies, timeout=30,
        )
        r.raise_for_status()
        try:
            return r.json()
        except Exception:
            return {"status": "ok", "status_code": r.status_code}

    # ==================================================================
    # Onboarding（对齐 Go 版 Onboarding()）
    # ==================================================================

    def complete_onboarding(self, full_name: str = "", account_uuid: str = "") -> dict:
        """Console onboarding（AdsPower 173 抓包对齐 /create → Individual 路径）。

        真实调用链：
        1. POST /api/accounts/{account_uuid}/organizations/create — 选 Individual 创建 org
        2. PATCH /api/account/settings — {"has_finished_console_onboarding": false}
        """
        name = full_name or self._random_name()
        display_name = name.split()[0] if " " in name else name

        # 步骤 1: 创建 Individual 组织
        if not self.org_id and account_uuid:
            log.info("[onboarding] 1/2 创建 Individual org...")
            org_body = {
                "name": f"{display_name}'s Individual Org",
                "is_individual": True,
            }
            try:
                r = self.session.post(
                    f"{PLATFORM_BASE}/api/accounts/{account_uuid}/organizations/create",
                    headers=self._headers(referer="/create"),
                    data=json.dumps(org_body),
                    proxies=self.proxies, timeout=30,
                )
                if r.status_code == 200:
                    data = r.json()
                    self.org_id = data.get("uuid", "")
                    log.info("[onboarding] org 创建成功: %s", self.org_id)
                else:
                    log.warning("[onboarding] org 创建失败: %d %s", r.status_code, r.text[:200])
            except Exception as e:
                log.warning("[onboarding] org 创建异常: %s", e)

        # 兜底：从 API 获取 org_id
        if not self.org_id:
            self._refresh_org_id()

        # 步骤 2: 标记 console onboarding 状态
        log.info("[onboarding] 2/2 PATCH account/settings...")
        try:
            r = self.session.patch(
                f"{PLATFORM_BASE}/api/account/settings",
                headers=self._headers(referer="/create"),
                data=json.dumps({"has_finished_console_onboarding": False}),
                proxies=self.proxies, timeout=30,
            )
            log.info("[onboarding] PATCH settings: %d", r.status_code)
        except Exception as e:
            log.warning("[onboarding] PATCH settings 失败: %s", e)

        return {"org_id": self.org_id}

    def _refresh_org_id(self):
        """从 API 获取当前用户的 org_id。"""
        try:
            data = self._get("/api/organizations")
            orgs = data if isinstance(data, list) else data.get("data", [])
            if orgs:
                self.org_id = orgs[0].get("uuid") or orgs[0].get("id") or ""
                log.info("[org] org_id = %s", self.org_id)
        except Exception as e:
            log.warning("[org] 获取 org 失败: %s", e)

    @staticmethod
    def _random_name() -> str:
        return f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"

    # ==================================================================
    # Billing: Stripe 绑卡 + 充值
    # 端点来自 JS 逆向（2026-07-05 确认）：
    #   POST /api/stripe/{org_uuid}/intent          → 创建 SetupIntent
    #   POST /api/organizations/{org}/payment_method/update_latest → 通知后端绑卡完成
    #   POST /api/organizations/{org}/prepaid/credits → 充值
    # ==================================================================

    def get_stripe_config(self) -> dict:
        """获取 Stripe 区域配置（含 publishable key）。"""
        try:
            data = self._get(f"/api/billing/stripe_region?organization_uuid={self.org_id}")
            pk = data.get("stripe_publishable_key") or data.get("publishable_key", "")
            if pk:
                self._stripe_pk = pk
            return data
        except Exception as e:
            log.debug("[billing] stripe_region 失败: %s", e)
            return {}

    def get_stripe_pk(self) -> str:
        """获取 Stripe publishable key。"""
        if self._stripe_pk:
            return self._stripe_pk

        cfg = self.get_stripe_config()
        if self._stripe_pk:
            return self._stripe_pk

        # 从 dashboard 页面提取
        try:
            r = self.session.get(
                f"{PLATFORM_BASE}/dashboard",
                headers=self._headers(),
                proxies=self.proxies, timeout=20,
            )
            m = re.search(r"pk_live_[a-zA-Z0-9]+", r.text)
            if m:
                self._stripe_pk = m.group(0)
                log.info("[billing] Stripe PK: %s...%s", self._stripe_pk[:15], self._stripe_pk[-4:])
                return self._stripe_pk
        except Exception as e:
            log.warning("[billing] 提取 Stripe PK 失败: %s", e)

        raise RuntimeError("无法获取 Stripe publishable key")

    def create_setup_intent(self) -> dict:
        """创建 Stripe SetupIntent。

        端点: POST /api/stripe/{org_uuid}/intent
        """
        if not self.org_id:
            self._refresh_org_id()
        return self._post(f"/api/stripe/{self.org_id}/intent")

    def stripe_tokenize_card(self, card_number: str, exp_month: int,
                             exp_year: int, cvc: str,
                             address: Optional[Dict] = None,
                             name: str = "") -> str:
        """通过 Stripe API 将卡号 tokenize 为 tok_xxx。

        address 格式: {"line1": "...", "city": "...", "state": "OR", "postal_code": "97210", "country": "US"}
        """
        stripe_pk = self.get_stripe_pk()
        guid, muid, sid = self._get_stripe_triple()
        pua = self._stripe_fp.payment_user_agent
        addr = address or {}

        data = {
            "key": stripe_pk,
            "card[number]": card_number,
            "card[exp_month]": str(exp_month),
            "card[exp_year]": str(exp_year),
            "card[cvc]": cvc,
            "card[address_country]": addr.get("country", "US"),
            "card[address_line1]": addr.get("line1", ""),
            "card[address_city]": addr.get("city", ""),
            "card[address_state]": addr.get("state", ""),
            "card[address_zip]": addr.get("postal_code", ""),
            "payment_user_agent": pua,
            "time_on_page": str(random.randint(25000, 75000)),
            "guid": guid,
            "muid": muid,
            "sid": sid,
            "referrer": PLATFORM_BASE,
        }
        if name:
            data["card[name]"] = name
        # 移除空值避免 Stripe 校验报错
        data = {k: v for k, v in data.items() if v}

        r = self.session.post(
            "https://api.stripe.com/v1/tokens",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://js.stripe.com",
                "Referer": "https://js.stripe.com/",
                "Accept": "application/json",
            },
            data=data,
            proxies=self.proxies, timeout=30,
        )
        if r.status_code != 200:
            try:
                err = r.json()
                err_msg = err.get("error", {}).get("message", "")
                err_code = err.get("error", {}).get("code", "")
                log.error("[stripe_token] %d: code=%s msg=%s", r.status_code, err_code, err_msg)
            except Exception:
                log.error("[stripe_token] %d: %s", r.status_code, r.text[:500])
        r.raise_for_status()
        resp = r.json()
        token_id = resp.get("id", "")
        if not token_id:
            raise RuntimeError(f"Stripe token 创建失败: {resp}")
        return token_id

    def stripe_confirm_setup(self, client_secret: str,
                             card_number: str, exp_month: int, exp_year: int,
                             cvc: str, address: Optional[Dict] = None,
                             name: str = "",
                             hcaptcha_token: str = "") -> dict:
        """直接在 confirm 中传卡号（2026-07-06 AdsPower 173 抓包完全对齐）。

        对比真实 Stripe.js Payment Element confirm 请求：
          - 无 Authorization header / 无 key / 无 client_secret / 无 use_stripe_sdk
          - 有 client_context / client_attribution_metadata / allow_redisplay
          - 有 radar_options[hcaptcha_token]（关键，缺失会被 Radar 拒）
          - payment_user_agent 带 '; deferred-intent' 后缀
          - card[number] 带空格（每 4 位）
        """
        stripe_pk = self.get_stripe_pk()
        guid, muid, sid = self._get_stripe_triple()
        pua = self._stripe_fp.payment_user_agent
        if "deferred-intent" not in pua:
            pua += "; deferred-intent"
        seti_id = client_secret.split("_secret_")[0]
        addr = address or {}

        # 卡号每 4 位加空格（真实 Payment Element 行为）
        cn = card_number.replace(" ", "")
        card_spaced = " ".join(cn[i:i+4] for i in range(0, len(cn), 4))

        session_uuid = str(uuid.uuid4())
        elements_session_id = f"elements_session_{uuid.uuid4().hex[:11]}"

        data = {
            "return_url": f"{PLATFORM_BASE}/settings/billing/{self.org_id}?action=setup_payment_info",
            "payment_method_data[type]": "card",
            "payment_method_data[card][number]": card_spaced,
            "payment_method_data[card][cvc]": cvc,
            "payment_method_data[card][exp_year]": str(exp_year)[-2:],
            "payment_method_data[card][exp_month]": f"{exp_month:02d}",
            "payment_method_data[allow_redisplay]": "unspecified",
            "payment_method_data[billing_details][address][postal_code]": addr.get("postal_code", ""),
            "payment_method_data[billing_details][address][country]": addr.get("country", "US"),
            "payment_method_data[billing_details][address][line1]": addr.get("line1", ""),
            "payment_method_data[billing_details][address][city]": addr.get("city", ""),
            "payment_method_data[billing_details][address][state]": addr.get("state", ""),
            "payment_method_data[billing_details][name]": name,
            "payment_method_data[billing_details][phone]": "",
            "payment_method_data[pasted_fields]": "number",
            "payment_method_data[payment_user_agent]": pua,
            "payment_method_data[referrer]": PLATFORM_BASE,
            "payment_method_data[time_on_page]": str(random.randint(50000, 200000)),
            "payment_method_data[client_attribution_metadata][client_session_id]": session_uuid,
            "payment_method_data[client_attribution_metadata][merchant_integration_source]": "elements",
            "payment_method_data[client_attribution_metadata][merchant_integration_subtype]": "payment-element",
            "payment_method_data[client_attribution_metadata][merchant_integration_version]": "2021",
            "payment_method_data[client_attribution_metadata][payment_intent_creation_flow]": "deferred",
            "payment_method_data[client_attribution_metadata][payment_method_selection_flow]": "merchant_specified",
            "payment_method_data[client_attribution_metadata][elements_session_id]": elements_session_id,
            "payment_method_data[client_attribution_metadata][elements_session_config_id]": str(uuid.uuid4()),
            "payment_method_data[client_attribution_metadata][merchant_integration_additional_elements][0]": "address",
            "payment_method_data[client_attribution_metadata][merchant_integration_additional_elements][1]": "payment",
            "payment_method_data[guid]": guid,
            "payment_method_data[muid]": muid,
            "payment_method_data[sid]": sid,
            "expected_payment_method_type": "card",
            "client_context[currency]": "usd",
            "client_context[mode]": "setup",
            "client_context[payment_method_types][0]": "card",
            "client_context[payment_method_types][1]": "link",
            "client_context[setup_future_usage]": "off_session",
            "key": stripe_pk,
            "client_secret": client_secret,
        }

        if hcaptcha_token:
            data["radar_options[hcaptcha_token]"] = hcaptcha_token

        r = self.session.post(
            f"https://api.stripe.com/v1/setup_intents/{seti_id}/confirm",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
                "Origin": "https://js.stripe.com",
                "Referer": "https://js.stripe.com/",
            },
            data=data,
            proxies=self.proxies, timeout=30,
        )
        if r.status_code != 200:
            try:
                err = r.json()
                err_msg = err.get("error", {}).get("message", "")
                err_code = err.get("error", {}).get("code", "")
                err_decline = err.get("error", {}).get("decline_code", "")
                log.error("[stripe_confirm] %d: code=%s decline=%s msg=%s",
                          r.status_code, err_code, err_decline, err_msg)
            except Exception:
                log.error("[stripe_confirm] %d: %s", r.status_code, r.text[:500])
        r.raise_for_status()
        return r.json()

    def finalize_payment_method(self, payment_method_id: str) -> dict:
        """通知 Anthropic 后端确认绑卡。

        端点: POST /api/organizations/{org}/payment_method/update_latest
        """
        if not self.org_id:
            self._refresh_org_id()
        return self._post(
            f"/api/organizations/{self.org_id}/payment_method/update_latest",
            {"payment_method_id": payment_method_id},
        )

    def upgrade_to_prepaid(self, address: Optional[Dict] = None) -> None:
        """绑卡后升级 plan + 设置 org physical address + prepaid upgrade。

        173 抓包确认的完整调用链：
        1. PUT /api/organizations/{org}/profile — 设置 physical_address
        2. PATCH /api/account/settings — console onboarding 完成
        3. POST /api/organizations/{org}/prepaid/upgrade — 升级到 prepaid
        """
        if not self.org_id:
            self._refresh_org_id()
        addr = address or {}
        if addr:
            try:
                profile_body = {
                    "physical_address": {
                        "line1": addr.get("line1", "1234 NW Everett St"),
                        "line2": None,
                        "city": addr.get("city", "Portland"),
                        "state": addr.get("state", "OR"),
                        "country": addr.get("country", "US"),
                        "postal_code": addr.get("postal_code", "97209"),
                    },
                    "remove_tax_id": True,
                }
                r = self.session.put(
                    f"{PLATFORM_BASE}/api/organizations/{self.org_id}/profile",
                    headers=self._headers(referer="/settings/organization"),
                    data=json.dumps(profile_body),
                    proxies=self.proxies, timeout=15,
                )
                log.info("[upgrade] PUT profile (physical_address): %d", r.status_code)
            except Exception as e:
                log.warning("[upgrade] PUT profile 失败: %s", e)
        try:
            r = self.session.patch(
                f"{PLATFORM_BASE}/api/account/settings",
                headers=self._headers(referer="/create/credits"),
                data=json.dumps({"has_finished_console_onboarding": True}),
                proxies=self.proxies, timeout=15,
            )
            log.info("[upgrade] PATCH console_onboarding=true: %d", r.status_code)
        except Exception as e:
            log.warning("[upgrade] PATCH settings 失败: %s", e)
        try:
            r = self.session.post(
                f"{PLATFORM_BASE}/api/organizations/{self.org_id}/prepaid/upgrade",
                headers=self._headers(referer="/create/credits"),
                data=json.dumps({}),
                proxies=self.proxies, timeout=15,
            )
            log.info("[upgrade] prepaid/upgrade: %d", r.status_code)
        except Exception as e:
            log.warning("[upgrade] prepaid/upgrade 失败: %s", e)

    def purchase_credits(self, amount_usd: float) -> dict:
        """充值 credits 并验证到账。

        端点: POST /api/organizations/{org}/prepaid/credits
        返回 200 不代表扣款成功——需要检查 stripe_invoice_id 和实际余额。
        """
        if not self.org_id:
            self._refresh_org_id()
        path = f"/api/organizations/{self.org_id}/prepaid/credits"
        body = {"amount": int(amount_usd * 100)}
        h = self._headers(referer="/create/credits")
        r = self.session.post(
            f"{PLATFORM_BASE}{path}",
            headers=h,
            data=json.dumps(body),
            proxies=self.proxies, timeout=30,
        )
        if r.status_code != 200:
            try:
                err = r.json()
                err_msg = err.get("error", {}).get("message", "")
                err_details = err.get("error", {}).get("details", {})
                log.error("[purchase] %d: msg=%s details=%s body_sent=%s",
                          r.status_code, err_msg, err_details, body)
            except Exception:
                log.error("[purchase] %d: %s", r.status_code, r.text[:500])
        r.raise_for_status()

        try:
            resp = r.json()
        except Exception:
            resp = {}

        payment_status = resp.get("payment_status", "")
        invoice_id = resp.get("stripe_invoice_id", "")
        log.info("[purchase] payment_status=%s stripe_invoice_id=%s",
                 payment_status, invoice_id or "(空)")

        if payment_status in ("pending_invoice", "pending"):
            log.info("[purchase] invoice pending，轮询等待 paid...")
            paid = self._poll_invoice_paid(max_wait=90, interval=5)
            if paid:
                log.info("[purchase] invoice 已 paid，余额: $%.2f", self.get_balance())
                resp["_verified"] = True
                return resp
            bal = self.get_balance()
            if bal > 0:
                log.info("[purchase] 余额已到账: $%.2f（invoice 状态可能延迟）", bal)
                resp["_verified"] = True
                return resp
            log.error("[purchase] 90s 超时，invoice 未 paid，余额 $0 — 卡扣款可能失败")
            raise RuntimeError(
                f"充值未到账: payment_status={payment_status}, "
                f"stripe_invoice_id={invoice_id or '空'} — 卡可能被发卡行拒绝"
            )

        return resp

    def _poll_invoice_paid(self, max_wait: int = 90, interval: int = 5) -> bool:
        """轮询 /api/organizations/{org}/invoices 直到最新 invoice 变为 paid。"""
        if not self.org_id:
            return False
        for i in range(max_wait // interval):
            time.sleep(interval)
            try:
                h = self._headers()
                h.pop("Content-Type", None)
                r = self.session.get(
                    f"{PLATFORM_BASE}/api/organizations/{self.org_id}/invoices",
                    headers=h, proxies=self.proxies, timeout=15,
                )
                if r.status_code == 200:
                    data = r.json()
                    invoices = data.get("invoices", [])
                    if invoices:
                        latest = invoices[0]
                        status = latest.get("invoice_status", "")
                        log.info("[purchase] 轮询 [%ds] invoice_status=%s",
                                 (i + 1) * interval, status)
                        if status == "paid":
                            return True
                        if status in ("void", "uncollectible", "failed"):
                            log.error("[purchase] invoice 终态: %s", status)
                            return False
            except Exception as e:
                log.debug("[purchase] 轮询异常: %s", e)
        return False

    STRIPE_HCAPTCHA_SITEKEY = "463b917e-e264-403f-ad34-34af0ee10294"
    STRIPE_HCAPTCHA_URL = "https://js.stripe.com"

    def _solve_hcaptcha(self, yescaptcha_key: str) -> str:
        """通过 YesCaptcha 求解 Stripe invisible hCaptcha。"""
        import requests as req_lib
        log.info("[hcaptcha] 创建任务 sitekey=%s...", self.STRIPE_HCAPTCHA_SITEKEY[:16])
        create = req_lib.post("https://api.yescaptcha.com/createTask", json={
            "clientKey": yescaptcha_key,
            "task": {
                "type": "HCaptchaTaskProxyless",
                "websiteURL": self.STRIPE_HCAPTCHA_URL,
                "websiteKey": self.STRIPE_HCAPTCHA_SITEKEY,
                "isInvisible": True,
            },
        }).json()
        task_id = create.get("taskId")
        if not task_id:
            raise RuntimeError(f"hCaptcha 创建任务失败: {create}")
        log.info("[hcaptcha] taskId=%s, 等待求解...", task_id[:16])

        for i in range(50):
            time.sleep(3)
            result = req_lib.post("https://api.yescaptcha.com/getTaskResult", json={
                "clientKey": yescaptcha_key,
                "taskId": task_id,
            }).json()
            if result.get("status") == "ready":
                token = result.get("solution", {}).get("gRecaptchaResponse", "")
                log.info("[hcaptcha] 求解成功 (%ds), token=%s...", (i+1)*3, token[:30])
                return token
        raise RuntimeError("hCaptcha 求解超时 (150s)")

    def bind_card_full(self, card_number: str, card_expiry: str,
                       card_cvc: str, address: dict, name: str = "",
                       yescaptcha_key: str = "") -> dict:
        """一站式绑卡：hCaptcha → setup_intent → confirm（直传卡号）→ finalize。

        card_expiry: "MMYY" 或 "MM/YY"
        yescaptcha_key: YesCaptcha API key，用于求解 Stripe invisible hCaptcha（必需）。
        """
        exp = card_expiry.replace("/", "")
        exp_month = int(exp[:2])
        exp_year = int("20" + exp[2:]) if len(exp) == 4 else int(exp[2:])

        # 0. 预热 Stripe 设备指纹 + 动态获取 Stripe.js 版本 + 求解 hCaptcha
        log.info("[绑卡 0/4] 预热 Stripe 设备指纹 + 求解 hCaptcha...")
        self._ensure_stripe_device()
        self._stripe_fp.ensure_payment_user_agent(self.session, self.proxies)

        hcaptcha_token = ""
        if yescaptcha_key:
            hcaptcha_token = self._solve_hcaptcha(yescaptcha_key)
        else:
            log.warning("[绑卡] 未提供 yescaptcha_key，无 hCaptcha token（极可能被 Radar 拒绝）")

        time.sleep(random.uniform(1.0, 2.0))

        # 1. SetupIntent
        log.info("[绑卡 1/4] create_setup_intent ...")
        si = self.create_setup_intent()
        client_secret = si.get("client_secret") or si.get("clientSecret", "")
        if not client_secret:
            raise RuntimeError(f"SetupIntent 未返回 client_secret: {si}")
        log.info("[绑卡 1/4] OK, seti=%s", client_secret.split("_secret_")[0])

        time.sleep(random.uniform(2.0, 4.0))

        # 2. Confirm SetupIntent（直传卡号 + hCaptcha token）
        log.info("[绑卡 2/4] stripe_confirm_setup ...")
        confirm = self.stripe_confirm_setup(
            client_secret,
            card_number=card_number,
            exp_month=exp_month, exp_year=exp_year, cvc=card_cvc,
            address=address, name=name,
            hcaptcha_token=hcaptcha_token,
        )
        pm_id = confirm.get("payment_method") or ""
        if isinstance(pm_id, dict):
            pm_id = pm_id.get("id", "")
        if not pm_id:
            raise RuntimeError(f"Stripe confirm 未返回 payment_method: {confirm}")
        log.info("[绑卡 2/4] OK, pm_id=%s", pm_id)

        # 3. Finalize
        log.info("[绑卡 3/4] finalize_payment_method ...")
        result = self.finalize_payment_method(pm_id)
        log.info("[绑卡 3/4] OK")
        return result

    def _ensure_stripe_device(self) -> StripeDevice:
        """每次注册都创建全新的 Stripe 设备指纹。

        force_new=True 确保每个注册账号对 Stripe 都是一台新设备。
        """
        if self._stripe_device and self._stripe_device.guid:
            return self._stripe_device

        self._stripe_device = self._stripe_fp.get_device(
            self.session, self._proxy_key, self.proxies, force_new=True
        )
        return self._stripe_device

    def _get_stripe_triple(self) -> tuple:
        """返回 (guid, muid, sid) 三要素，正确分离。"""
        dev = self._ensure_stripe_device()
        return dev.guid, dev.muid, dev.sid

    # ==================================================================
    # API Key 管理（对齐 Go 版 CreateAPIKey()）
    # 端点: POST /api/console/organizations/{org}/workspaces/default/api_keys
    #    或 POST /api/organizations/{org}/admin_api_keys
    # ==================================================================

    def create_api_key(self, name: str = "auto-key") -> str:
        """创建 API Key，返回 sk-ant-xxx 格式的 key。"""
        if not self.org_id:
            self._refresh_org_id()

        endpoints = [
            f"/api/console/organizations/{self.org_id}/workspaces/default/api_keys",
            f"/api/organizations/{self.org_id}/admin_api_keys",
            f"/api/organizations/{self.org_id}/api_keys",
        ]

        for endpoint in endpoints:
            try:
                result = self._post(endpoint, {"name": name})
                key = self._extract_key(result)
                if key:
                    log.info("[api_key] 创建成功: %s...", key[:25])
                    return key
            except Exception as e:
                log.debug("[api_key] %s 失败: %s", endpoint, e)
                continue

        raise RuntimeError("所有 API Key 创建端点均失败")

    def _extract_key(self, data: Any) -> str:
        """从创建 API Key 响应中提取完整的 sk-ant-xxx key。

        响应格式（2026-07-06 确认）：
          {"raw_key": "sk-ant-api03-...-wrJr0AAA", "partial_key_hint": "sk-ant-api03-psy...0AAA", ...}
        raw_key 是完整 key，partial_key_hint 是截断的（含 ...），必须排除。
        """
        if isinstance(data, dict):
            # 优先取 raw_key（完整 key，不含 ...）
            raw = data.get("raw_key", "")
            if isinstance(raw, str) and raw.startswith("sk-ant-") and "..." not in raw:
                return raw
            # 其他可能的字段
            for f in ["key", "api_key", "apiKey", "sensitive_id", "secret"]:
                val = data.get(f)
                if isinstance(val, str) and val.startswith("sk-ant-") and "..." not in val:
                    return val
                if isinstance(val, dict):
                    for sub in ["raw_key", "sensitive_id", "key", "value", "secret"]:
                        sv = val.get(sub, "")
                        if isinstance(sv, str) and sv.startswith("sk-ant-") and "..." not in sv:
                            return sv
            # fallback: 全文搜索，排除含 ... 的截断 key
            txt = json.dumps(data)
            for m in API_KEY_RE.finditer(txt):
                candidate = m.group(0)
                if "..." not in candidate and len(candidate) > 40:
                    return candidate
        if isinstance(data, str):
            m = API_KEY_RE.search(data)
            if m and "..." not in m.group(0):
                return m.group(0)
        return ""

    # ==================================================================
    # 查询接口
    # ==================================================================

    def get_balance(self) -> float:
        """查询当前 credits 余额（单位: USD）。

        端点: GET /api/organizations/{org}/prepaid/credits
        响应: {"amount":500,"currency":"USD","balance_credits":5,...}
          amount = 美分, balance_credits = 美元
        """
        if not self.org_id:
            self._refresh_org_id()
        try:
            data = self._get(f"/api/organizations/{self.org_id}/prepaid/credits")
            bc = data.get("balance_credits")
            if bc is not None:
                return float(bc)
            amount = data.get("amount") or 0
            if amount:
                return float(amount) / 100.0
            return 0.0
        except Exception:
            return 0.0

    def get_payment_methods(self) -> list:
        """查询已绑定的支付方式。"""
        if not self.org_id:
            self._refresh_org_id()
        try:
            data = self._get(f"/api/organizations/{self.org_id}/payment_method")
            return data if isinstance(data, list) else [data] if data else []
        except Exception:
            return []

    def get_auto_recharge(self) -> dict:
        """查询自动充值配置。"""
        if not self.org_id:
            self._refresh_org_id()
        try:
            return self._get(f"/api/organizations/{self.org_id}/prepaid/auto_recharge")
        except Exception:
            return {}
