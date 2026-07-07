"""mail.com Android OAuth PKCE + Outlook Graph API 收取 Claude magic link。

从 claude_console_go/internal/mail/ 的 Go 版本逐行转译为 Python。
支持两种邮箱来源：
  - mail.com：Android OAuth PKCE 登录 → 列信 → 取正文 → 提取 magic link
  - Outlook：Microsoft Graph refresh_token → 读 inbox/junk → 提取 magic link
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import time
import urllib.parse
from dataclasses import dataclass
from typing import List, Optional, Tuple

from curl_cffi import requests as curl_requests

# ---- mail.com 常量（对齐 Go 版 mailcom.go）----

OAUTH_BASE_URL = "https://oauth2.mail.com"
MOBSI_BASE_URL = "https://mobsi.mail.com/rest/MobSI"
HSP2_BASE_URL = "https://hsp2.mail.com/service"

APP_USER_AGENT = (
    "mailcom.android.androidmail/9.8.0 Dalvik/2.1.0 "
    "(Linux; U; Android 13; SM-S908E Build/TQ2B.230505.005.A1)"
)
WEBVIEW_USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; SM-S908E Build/TQ2B.230505.005.A1; wv) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 "
    "Mobile Safari/537.36 [APPNME/mailcom.android.androidmail;APPVS/9.8.0;APPTNME/andall]"
)
ANDROID_CLIENT_ID = "mailcom_mailapp_android"
ANDROID_REDIRECT_URI = "com.mail.androidmail.redirect://authorization_code_grant"
ANDROID_BASIC_AUTH = (
    "Basic bWFpbGNvbV9tYWlsYXBwX2FuZHJvaWQ6a2luMmxTU2tVUXRRQ0NsWG9YZklOaEp1bUc2SmQwM0taNVdMN05KOQ=="
)
FULL_ACCESS_SCOPE = (
    "mailbox_user_full_access mailbox_user_status_access hsp_user_full_access "
    "onlinestorage_user_meta_read onlinestorage_user_meta_write foo bar"
)

APP_HEADERS = {
    "Accept-Charset": "utf-8",
    "Accept-Language": "en-IN,en-GB;q=0.9,en;q=0.8",
    "User-Agent": APP_USER_AGENT,
    "X-Ui-App": "mailcom.android.androidmail/9.8.0",
}

MIME_FOLDERS = "application/vnd.ui.trinity.folders-v5+json"
MIME_MESSAGES = "application/vnd.ui.trinity.messages+json"
MIME_BODY_HTML = "text/vnd.ui.insecure+html; removeCharsetMetaInfo=true"

EXCLUDED_FOLDER_TYPES = {"TRASH", "DRAFTS", "OUTBOX"}

MAGIC_LINK_RE = re.compile(r"https://platform\.claude\.com/magic-link#[^\s\"'<]+")

# ---- Outlook 常量 ----

MS_TOKEN_URL = "https://login.live.com/oauth20_token.srf"
MS_MAIL_LIST_URL = "https://outlook.office.com/api/v2.0/me/messages"
MAGIC_LINK_REGEX = re.compile(r"https://platform\.claude\.com/magic-link#[^\s\"'<]+")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


# =====================================================================
# mail.com Client（对齐 Go mailcom.go）
# =====================================================================

@dataclass
class MailMeta:
    id: str
    from_addr: str
    subject: str
    date: int


class CookieJar:
    """简化版 cookie jar，不区分域名。"""

    def __init__(self):
        self.values: dict[str, str] = {}

    def header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.values.items())

    def absorb(self, headers: dict):
        for key, val in headers.items():
            if key.lower() == "set-cookie":
                vals = val if isinstance(val, list) else [val]
                for cookie in vals:
                    pair = cookie.split(";", 1)[0]
                    eq = pair.find("=")
                    if eq > 0:
                        self.values[pair[:eq].strip()] = pair[eq + 1:]


class MailComClient:
    """mail.com Android OAuth PKCE 客户端。"""

    def __init__(self, email: str, password: str, timeout: int = 30):
        self.email = email
        self.password = password
        self.timeout = timeout
        self.access_token = ""
        self._http = curl_requests.Session()
        self._http.headers.update(APP_HEADERS)

    def _mailbox_base(self) -> str:
        return f"{HSP2_BASE_URL}/msgsrv/Mailbox/primaryMailbox"

    def login(self) -> None:
        """Android OAuth PKCE 登录流程。"""
        verifier = _b64url(secrets.token_bytes(48))
        challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
        state = _b64url(secrets.token_bytes(48))
        jar = CookieJar()

        # 1. authorize
        params = urllib.parse.urlencode({
            "client_id": ANDROID_CLIENT_ID,
            "redirect_uri": ANDROID_REDIRECT_URI,
            "response_type": "code",
            "state": state,
            "code_challenge": challenge,
            "login_hint": self.email,
            "code_challenge_method": "S256",
        })
        authorize_url = f"{OAUTH_BASE_URL}/authorize?{params}"
        resp = self._webview_request("GET", authorize_url, jar)
        login_app_url = resp.headers.get("Location", "")
        if not login_app_url:
            raise RuntimeError("mail.com authorize 未返回 Location")

        parsed = urllib.parse.urlparse(login_app_url)
        qs = urllib.parse.parse_qs(parsed.query)
        authcode_context = qs.get("authcode-context", [""])[0]
        if not authcode_context:
            raise RuntimeError("mail.com 未返回 authcode-context")

        # 2. GET loginApp
        self._webview_request("GET", login_app_url, jar)

        # 3. POST login
        login_failed_url = (
            "https://auth.mail.com/loginapp/oauth2?"
            + urllib.parse.urlencode({
                "status": "login_failed",
                "login_hint": self.email,
                "authcode-context": authcode_context,
            })
        )
        login_form = urllib.parse.urlencode({
            "password": self.password,
            "service": "oauth2",
            "successURL": f"{OAUTH_BASE_URL}/authcode?authcode-context={authcode_context}",
            "loginFailedURL": login_failed_url,
            "loginErrorURL": "https://auth.mail.com/login/error",
            "statistics": "",
            "username": self.email,
        })
        login_resp = self._webview_request(
            "POST", "https://login.mail.com/login", jar,
            body=login_form, referer=login_app_url,
            content_type="application/x-www-form-urlencoded",
        )
        authcode_url = login_resp.headers.get("Location", "")
        if not authcode_url:
            raise RuntimeError("mail.com login 未返回 Location（可能密码错误）")

        # 4. GET authcode → redirect
        authcode_resp = self._webview_request("GET", authcode_url, jar)
        app_redirect = authcode_resp.headers.get("Location", "")
        if not app_redirect:
            raise RuntimeError("mail.com authcode 未返回 Location")

        redirect_parsed = urllib.parse.urlparse(app_redirect)
        redirect_qs = urllib.parse.parse_qs(redirect_parsed.query)
        code = redirect_qs.get("code", [""])[0]
        if not code:
            raise RuntimeError("mail.com 未返回 authorization code")
        if redirect_qs.get("state", [""])[0] != state:
            raise RuntimeError("mail.com OAuth state 不匹配")

        # 5. token exchange
        token_data = self._oauth_token({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": ANDROID_REDIRECT_URI,
            "client_id": ANDROID_CLIENT_ID,
            "code_verifier": verifier,
        })
        refresh_token = token_data.get("refresh_token", "")
        if not refresh_token:
            raise RuntimeError("mail.com OAuth 未返回 refresh_token")

        # 6. refresh → full scope access_token
        refreshed = self._oauth_token({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": FULL_ACCESS_SCOPE,
        })
        at = refreshed.get("access_token", "")
        if not at:
            raise RuntimeError("mail.com refresh 未返回 access_token")
        self.access_token = at

    def _webview_request(self, method: str, url: str, jar: CookieJar,
                         body: str = "", referer: str = "",
                         content_type: str = "") -> curl_requests.Response:
        headers: dict = {
            "User-Agent": WEBVIEW_USER_AGENT,
            "Accept-Language": "en-IN,en-GB;q=0.9,en;q=0.8",
        }
        if content_type:
            headers["Content-Type"] = content_type
        if referer:
            headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            headers["Origin"] = "https://auth.mail.com"
            headers["Referer"] = referer
        cookie_str = jar.header()
        if cookie_str:
            headers["Cookie"] = cookie_str

        resp = self._http.request(
            method, url, headers=headers,
            data=body.encode() if body else None,
            timeout=self.timeout, allow_redirects=False,
        )
        jar.absorb(dict(resp.headers))
        return resp

    def _oauth_token(self, form: dict) -> dict:
        headers = dict(APP_HEADERS)
        headers["Accept"] = "*/*"
        headers["Authorization"] = ANDROID_BASIC_AUTH
        headers["Content-Type"] = 'application/x-www-form-urlencoded;charset="UTF-8"'

        resp = self._http.post(
            f"{OAUTH_BASE_URL}/token",
            headers=headers,
            data=urllib.parse.urlencode(form),
            timeout=self.timeout,
        )
        data = resp.json()
        if resp.status_code < 200 or resp.status_code >= 300:
            msg = data.get("error_description") or data.get("error") or str(data)
            raise RuntimeError(f"mail.com token 请求失败 [{resp.status_code}]: {msg}")
        return data

    def _auth_get(self, url: str, accept: str) -> str:
        headers = dict(APP_HEADERS)
        headers["Accept"] = accept
        headers["Authorization"] = f"Bearer {self.access_token}"
        resp = self._http.get(url, headers=headers, timeout=self.timeout)
        if resp.status_code < 200 or resp.status_code >= 300:
            raise RuntimeError(f"GET {url} 失败 [{resp.status_code}]: {resp.text[:200]}")
        return resp.text

    def list_incoming(self, amount_per_folder: int = 10) -> List[MailMeta]:
        """汇总所有非排除文件夹里的邮件，按时间倒序。"""
        body = self._auth_get(
            f"{self._mailbox_base()}/folders?absoluteURI=false", MIME_FOLDERS
        )
        data = json.loads(body)
        folders = self._flatten_folders(data.get("folders", []))

        mails: List[MailMeta] = []
        for f in folders:
            fid = f.get("folderIdentifier", "")
            ftype = (f.get("attribute") or {}).get("folderType", "")
            if not fid or not ftype or ftype.upper() in EXCLUDED_FOLDER_TYPES:
                continue
            try:
                mails.extend(self._list_by_folder(fid, amount_per_folder))
            except Exception:
                continue

        mails.sort(key=lambda m: m.date, reverse=True)
        return mails

    def _list_by_folder(self, folder_id: str, amount: int) -> List[MailMeta]:
        params = urllib.parse.urlencode({
            "absoluteURI": "false",
            "orderBy": "INTERNALDATE desc",
            "amount": str(amount),
            "tagsShowAll": "true",
        })
        url = f"{self._mailbox_base()}/Folder/{urllib.parse.quote(folder_id, safe='')}/Mail?{params}"
        body = self._auth_get(url, MIME_MESSAGES)
        data = json.loads(body)
        result = []
        for m in data.get("mail", []):
            mid = (m.get("attribute") or {}).get("mailIdentifier", "")
            if not mid and m.get("mailURI"):
                mid = self._normalize_mail_id(m["mailURI"])
            if not mid:
                continue
            hdr = m.get("mailHeader", {})
            result.append(MailMeta(
                id=mid,
                from_addr=hdr.get("from", ""),
                subject=hdr.get("subject", ""),
                date=hdr.get("date", 0),
            ))
        return result

    def get_body(self, mail_id: str) -> str:
        mid = self._normalize_mail_id(mail_id)
        url = f"{self._mailbox_base()}/Mail/{urllib.parse.quote(mid, safe='')}/Body?absoluteURI=false"
        return self._auth_get(url, MIME_BODY_HTML)

    @staticmethod
    def _normalize_mail_id(raw: str) -> str:
        decoded = urllib.parse.unquote(raw.strip())
        m = re.search(r"(?:^|/)Mail/([^/?#]+)", decoded)
        if m:
            return m.group(1)
        decoded = decoded.lstrip("../").lstrip("Mail/").lstrip("/")
        return decoded

    @staticmethod
    def _flatten_folders(nodes: list) -> list:
        out = []
        for n in nodes:
            out.append(n)
            out.extend(MailComClient._flatten_folders(n.get("folders", [])))
        return out


# =====================================================================
# Outlook Client（对齐 Go outlook.go）
# =====================================================================

class OutlookClient:
    """通过 MS OAuth refresh_token 读取 Outlook 收件箱找 magic link。"""

    def __init__(self, client_id: str, refresh_token: str, timeout: int = 20):
        self.client_id = client_id
        self.refresh_token = refresh_token
        self.access_token = ""
        self.timeout = timeout
        self._token_fetched = False
        self._http = curl_requests.Session()

    def _refresh_access_token(self) -> None:
        if self._token_fetched:
            return
        form = urllib.parse.urlencode({
            "client_id": self.client_id,
            "grant_type": "refresh_token",
            "refresh_token": self.refresh_token,
        })
        resp = self._http.post(
            MS_TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data=form, timeout=self.timeout,
        )
        data = resp.json()
        at = data.get("access_token", "")
        if not at:
            raise RuntimeError(
                f"Outlook token 刷新失败: {data.get('error')} {data.get('error_description')}"
            )
        self.access_token = at
        if data.get("refresh_token"):
            self.refresh_token = data["refresh_token"]
        self._token_fetched = True

    def find_magic_link(self) -> str:
        """从最近邮件中搜索 Claude Platform magic link。"""
        if not self.access_token:
            self._refresh_access_token()

        params = urllib.parse.urlencode({
            "$top": "5",
            "$select": "Subject,Body",
            "$orderby": "ReceivedDateTime desc",
            "$filter": "contains(Subject,'Claude') or contains(Subject,'magic') or contains(Subject,'Anthropic')",
        })
        resp = self._http.get(
            f"{MS_MAIL_LIST_URL}?{params}",
            headers={"Authorization": f"Bearer {self.access_token}"},
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Outlook 收件箱 HTTP {resp.status_code}: {resp.text[:200]}")

        data = resp.json()
        for msg in data.get("value", []):
            content = (msg.get("Body") or {}).get("Content", "")
            link = MAGIC_LINK_REGEX.search(content)
            if link:
                return link.group(0)
        return ""


# =====================================================================
# 统一轮询接口
# =====================================================================

def poll_magic_link_mailcom(email: str, password: str,
                            max_wait: int = 120, interval: int = 5) -> str:
    """轮询 mail.com 收件箱获取 Claude magic link。"""
    mc = MailComClient(email, password)
    for attempt in range(max_wait // interval):
        try:
            mc.login()
            mails = mc.list_incoming(10)
            for m in mails[:5]:
                body = mc.get_body(m.id)
                link = MAGIC_LINK_RE.search(body)
                if link:
                    return link.group(0)
        except Exception as e:
            if attempt < 3:
                print(f"[mail] mail.com 登录/读信异常（重试 {attempt + 1}）: {e}")
        time.sleep(interval if attempt > 2 else 8)
    return ""


def poll_magic_link_outlook(client_id: str, refresh_token: str,
                            max_wait: int = 120, interval: int = 5) -> str:
    """轮询 Outlook 收件箱获取 Claude magic link。"""
    oc = OutlookClient(client_id, refresh_token)
    for attempt in range(max_wait // interval):
        try:
            link = oc.find_magic_link()
            if link:
                return link
        except Exception as e:
            if attempt < 3:
                print(f"[mail] Outlook 读邮件异常（重试 {attempt + 1}）: {e}")
        time.sleep(interval if attempt > 2 else 8)
    return ""
