"""claude_protocol —— platform.claude.com Console 纯协议自动化（Python 版）。

对照 claude_console_go（go-rod 浏览器方案），本包走 **纯 HTTP 协议**：
用 curl_cffi 伪装 TLS 指纹，直接调 platform 后端 API，
无需拉起浏览器即可完成 magic-link 登录 → onboarding → 绑卡充值 → 建 API Key。

运营基础设施（对齐 Go 版）：
- config:      settings.json 配置读取
- store:       代理池 / 地址池 / 邮箱账号池 / claude_platform_keys.json
- db:          可选 SQLite（卡片记账 / 支付账户余额扣减）
- hub:         Resource Hub API Key 同步
- fingerprint: Chrome TLS 指纹池（curl_cffi impersonate + UA + sec-ch-ua 三要素）
- mail:        mail.com Android OAuth PKCE + Outlook Graph API 读取 magic link

实测验证的 API 端点（2026-07-05 JS 逆向 + HTTP 探测）：
- POST /api/auth/send_magic_link   — body: {email_address, source:"console", utc_offset}
- POST /api/auth/verify_magic_link — body: {credentials:{method:"nonce", nonce, encoded_email_address}, source}
- POST /api/stripe/{org}/intent    — 创建 Stripe SetupIntent
- POST /api/organizations/{org}/payment_method/update_latest — 绑卡完成
- POST /api/organizations/{org}/prepaid/credits — 充值
- POST /api/console/organizations/{org}/workspaces/default/api_keys — 创建 Key
- 必需 Headers: anthropic-client-platform, anthropic-client-sha, anthropic-device-id, anthropic-anonymous-id
"""

from .fingerprint import create_session, get_random_profile
from .config import Config, load_config
from .store import Store, Proxy, Address, ClaudePlatformKey
from .platform_login import PlatformLogin, LoginResult
from .platform_api import PlatformAPI
from .stripe_fingerprint import StripeFingerprint, StripeDevice
from .console_flow import ErrorType, FlowResult

__all__ = [
    "create_session", "get_random_profile",
    "Config", "load_config",
    "Store", "Proxy", "Address", "ClaudePlatformKey",
    "PlatformLogin", "LoginResult", "PlatformAPI",
    "StripeFingerprint", "StripeDevice",
    "ErrorType", "FlowResult",
]
