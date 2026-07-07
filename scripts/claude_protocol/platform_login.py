"""platform.claude.com magic link 协议登录。

从 claude_console_go/internal/flow/claude.go 的浏览器 Login 流程转译为纯 HTTP：

浏览器版流程：
  1. Navigate platform.claude.com/login
  2. 输入 email → 点 "Continue with email"
  3. 轮询邮箱获取 magic link (https://platform.claude.com/magic-link#token)
  4. Navigate magic link → 浏览器自动处理 auth callback → 获得 session cookie

协议版流程：
  1. GET /login → 获取初始 cookie（activitySessionId, anthropic-device-id）
  2. POST /api/auth/send_magic_link → 触发 magic link 邮件
  3. 轮询 mail.com / Outlook 获取 magic link
  4. 从 magic link fragment 提取 nonce → POST /api/auth/verify_magic_link → 获取 session

实测验证的请求格式（2026-07-05）：
  send_magic_link: {email_address, source:"console", utc_offset}
  verify_magic_link: {credentials:{method:"nonce", nonce, encoded_email_address}, source:"console"}
"""

from __future__ import annotations

import base64
import datetime
import json
import logging
import random
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

log = logging.getLogger(__name__)

PLATFORM_BASE = "https://platform.claude.com"


@dataclass
class LoginResult:
    session_key: str = ""
    org_id: str = ""
    workspace_id: str = ""
    email: str = ""
    account_uuid: str = ""
    cookies: dict = field(default_factory=dict)


class PlatformLogin:
    """纯协议完成 platform.claude.com 的 magic link 登录。"""

    def __init__(self, session, proxies=None):
        self.session = session
        self.proxies = proxies
        self._activity_session_id = ""
        self._device_id = ""
        self._anonymous_id = str(uuid.uuid4())
        self._build_sha = ""

    def _anthropic_headers(self, referer: str = "/login") -> dict:
        """构建 Anthropic 专有请求头（从前端 JS 逆向确认）。"""
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": PLATFORM_BASE,
            "Referer": f"{PLATFORM_BASE}{referer}",
        }
        if self._activity_session_id:
            h["x-activity-session-id"] = self._activity_session_id
        if self._device_id:
            h["anthropic-device-id"] = self._device_id
        if self._anonymous_id:
            h["anthropic-anonymous-id"] = self._anonymous_id
        if self._build_sha:
            h["anthropic-client-sha"] = self._build_sha
            h["anthropic-client-version"] = "unknown"
        h["anthropic-client-platform"] = "web_console"
        return h

    def login(self, email: str, get_magic_link: Callable[[], str]) -> LoginResult:
        """执行完整 magic link 登录流程。

        Args:
            email: 登录邮箱
            get_magic_link: 回调函数，轮询邮箱返回 magic link URL

        Returns:
            LoginResult 含 session_key 和 org 信息
        """

        # ---- 1. 访问登录页，获取初始 cookies ----
        log.info("1/4 访问登录页")
        r = self.session.get(
            f"{PLATFORM_BASE}/login",
            proxies=self.proxies, timeout=20, allow_redirects=True,
        )
        log.info("  登录页: %d, URL=%s", r.status_code, r.url[:80])

        self._extract_initial_state(r)

        # ---- 2. 提交邮箱，触发 magic link 发送 ----
        log.info("2/4 提交邮箱: %s", email)

        utc_offset = -int(
            datetime.datetime.now().astimezone().utcoffset().total_seconds() / 60
        )
        send_body = {
            "email_address": email,
            "source": "console",
            "utc_offset": utc_offset,
        }

        r = self.session.post(
            f"{PLATFORM_BASE}/api/auth/send_magic_link",
            headers=self._anthropic_headers("/login"),
            data=json.dumps(send_body),
            proxies=self.proxies, timeout=30,
        )
        log.info("  send_magic_link: %d", r.status_code)

        if r.status_code >= 400:
            error_msg = ""
            try:
                err_data = r.json()
                error_msg = err_data.get("error", {}).get("message", "")
            except Exception:
                error_msg = r.text[:300]
            raise RuntimeError(f"提交邮箱失败: {r.status_code} {error_msg}")

        try:
            resp_data = r.json()
            if resp_data.get("sso_url"):
                raise RuntimeError(f"邮箱要求 SSO 登录: {resp_data['sso_url']}")
            log.info("  magic link 已发送 (sent=%s)", resp_data.get("sent"))
        except (ValueError, KeyError):
            pass

        # ---- 3. 等待 magic link ----
        log.info("3/4 等待 magic link ...")
        magic_link = get_magic_link()
        if not magic_link:
            raise RuntimeError("magic link 获取超时")
        log.info("  获取到 magic link: %s...", magic_link[:60])

        # ---- 4. 验证 magic link token → 获取 session ----
        log.info("4/4 验证 magic link token")
        return self._verify_magic_link(magic_link, email)

    def _extract_initial_state(self, response) -> None:
        """从登录页响应中提取 cookie 和 build SHA。"""
        try:
            for cookie in self.session.cookies.jar:
                if cookie.name == "activitySessionId":
                    self._activity_session_id = cookie.value
                elif cookie.name == "anthropic-device-id":
                    self._device_id = cookie.value
        except Exception:
            self._activity_session_id = self.session.cookies.get("activitySessionId", "")
            self._device_id = self.session.cookies.get("anthropic-device-id", "")

        m = re.search(r'data-build-id="([a-f0-9]+)"', response.text)
        if m:
            self._build_sha = m.group(1)
            log.info("  build SHA: %s", self._build_sha[:20])

    def _verify_magic_link(self, magic_link: str, email: str) -> LoginResult:
        """从 magic link 提取 nonce 并验证。

        magic link 格式: https://platform.claude.com/magic-link#<nonce>
        fragment (#后面) 不会发送给服务器，需要自行提取后 POST 到验证端点。

        verify 请求体（实测确认）：
        {
            "credentials": {
                "method": "nonce",
                "nonce": "<fragment_token>",
                "encoded_email_address": "<base64_standard_email>"
            },
            "source": "console"
        }
        """
        result = LoginResult(email=email)

        # 提取 fragment — 格式: <hex_nonce>:<base64_email>
        fragment = ""
        if "#" in magic_link:
            fragment = magic_link.split("#", 1)[1]
        if not fragment:
            raise RuntimeError("magic link 中未找到 token fragment")

        # 分离 nonce 和 encoded_email
        if ":" in fragment:
            nonce, encoded_email = fragment.split(":", 1)
        else:
            nonce = fragment
            encoded_email = base64.b64encode(email.encode()).decode()

        log.info("  nonce=%s..., encoded_email=%s...", nonce[:16], encoded_email[:16])

        verify_body = {
            "credentials": {
                "method": "nonce",
                "nonce": nonce,
                "encoded_email_address": encoded_email,
            },
            "source": "console",
        }

        r = self.session.post(
            f"{PLATFORM_BASE}/api/auth/verify_magic_link",
            headers=self._anthropic_headers("/magic-link"),
            data=json.dumps(verify_body),
            proxies=self.proxies, timeout=30,
        )
        log.info("  verify_magic_link: %d", r.status_code)

        if r.status_code >= 400:
            error_msg = ""
            try:
                err_data = r.json()
                error_msg = err_data.get("error", {}).get("message", "")
            except Exception:
                error_msg = r.text[:300]
            raise RuntimeError(f"magic link 验证失败: {r.status_code} {error_msg}")

        # 从响应中提取 session 信息
        try:
            data = r.json()
            result.session_key = (
                data.get("session_key")
                or data.get("sessionKey")
                or data.get("token")
                or data.get("access_token")
                or ""
            )
            result.org_id = data.get("org_id") or data.get("organization_id") or ""
            result.workspace_id = data.get("workspace_id") or ""
            # 保存 account_uuid（onboarding 创建 org 时需要）
            account = data.get("account", {})
            if isinstance(account, dict):
                result.account_uuid = account.get("uuid", "")
        except Exception:
            pass

        # 从 cookie 中提取 session（如果 JSON 中没有）
        if not result.session_key:
            result.session_key = self._extract_session_cookie()

        # 如果还是没有，尝试访问 dashboard 看 cookie 是否已设置
        if not result.session_key:
            log.info("  从 dashboard cookie 获取 session")
            self.session.get(
                f"{PLATFORM_BASE}/dashboard",
                headers=self._anthropic_headers("/dashboard"),
                proxies=self.proxies, timeout=20, allow_redirects=True,
            )
            result.session_key = self._extract_session_cookie()

        if not result.session_key:
            log.warning("未获取到 session_key，后续操作可能依赖 cookie 自动传递")

        # 获取 org 信息
        if not result.org_id:
            self._fetch_org_info(result)

        log.info("登录成功: org_id=%s", result.org_id or "(via cookie)")
        return result

    def _extract_session_cookie(self) -> str:
        """从 session cookies 中提取认证 token。"""
        candidate_names = [
            "sessionKey", "sessionKeyLC", "session_key", "__session",
            "sb-api-auth-token",
        ]
        try:
            for cookie in self.session.cookies.jar:
                if cookie.name in candidate_names and cookie.value:
                    return cookie.value
        except Exception:
            for name in candidate_names:
                try:
                    val = self.session.cookies.get(name)
                    if val:
                        return val
                except Exception:
                    continue
        return ""

    def _fetch_org_info(self, result: LoginResult) -> None:
        """登录后获取 org_id 等信息。

        优先级：
        1. cookie lastActiveOrg（onboarding 完成后浏览器会设置）
        2. GET /api/organizations 返回的列表
        """
        # 从 cookie 获取（最可靠 — onboarding skip 后自动设置）
        try:
            for cookie in self.session.cookies.jar:
                if cookie.name == "lastActiveOrg" and cookie.value:
                    result.org_id = cookie.value
                    log.info("org_id (from cookie): %s", result.org_id)
                    return
        except Exception:
            val = self.session.cookies.get("lastActiveOrg", "")
            if val:
                result.org_id = val
                log.info("org_id (from cookie): %s", result.org_id)
                return

        # 从 API 获取
        try:
            headers = self._anthropic_headers("/dashboard")
            if result.session_key:
                headers["Authorization"] = f"Bearer {result.session_key}"

            r = self.session.get(
                f"{PLATFORM_BASE}/api/organizations",
                headers=headers,
                proxies=self.proxies, timeout=15,
            )
            if r.status_code == 200:
                data = r.json()
                orgs = data if isinstance(data, list) else data.get("data", [])
                if orgs:
                    result.org_id = orgs[0].get("uuid") or orgs[0].get("id") or ""
        except Exception as e:
            log.warning("获取 org 信息失败: %s", e)
