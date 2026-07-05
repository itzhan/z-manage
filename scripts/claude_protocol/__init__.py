"""claude_protocol — platform.claude.com 纯协议自动化。

curl_cffi TLS 指纹伪装 + 直调后端 API，无需浏览器。
流程：magic-link 登录 → onboarding → 绑卡充值 → 建 API Key。
"""

from .fingerprint import create_session
from .platform_login import PlatformLogin, LoginResult
from .platform_api import PlatformAPI
from .stripe_fingerprint import StripeFingerprint, StripeDevice
