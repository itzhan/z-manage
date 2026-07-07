"""Chrome TLS 指纹池。

每个注册线程随机选取浏览器指纹，保证 impersonate / User-Agent / sec-ch-ua
三要素一致，避免被 TLS 指纹检测拦截。

参考 references/tls-fingerprint.md。
"""

from __future__ import annotations

import random
from typing import Tuple

from curl_cffi import requests

CHROME_PROFILES = [
    {
        "impersonate": "chrome131",
        "sec_ch_ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "build": 6778, "patch_range": (69, 205),
    },
    {
        "impersonate": "chrome133a",
        "sec_ch_ua": '"Google Chrome";v="133", "Not(A:Brand";v="99", "Chromium";v="133"',
        "build": 6943, "patch_range": (33, 150),
    },
    {
        "impersonate": "chrome136",
        "sec_ch_ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
        "build": 7103, "patch_range": (48, 175),
    },
    {
        "impersonate": "chrome131",
        "sec_ch_ua": '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"',
        "build": 6778, "patch_range": (100, 230),
    },
    {
        "impersonate": "chrome133a",
        "sec_ch_ua": '"Chromium";v="133", "Google Chrome";v="133", "Not(A:Brand";v="99"',
        "build": 6943, "patch_range": (80, 200),
    },
    {
        "impersonate": "chrome136",
        "sec_ch_ua": '"Google Chrome";v="136", "Chromium";v="136", "Not.A/Brand";v="99"',
        "build": 7103, "patch_range": (100, 220),
    },
]

PLATFORM_ORIGINS = [
    "https://platform.claude.com",
]


def get_random_profile() -> Tuple[str, str, str]:
    """返回 (impersonate, user_agent, sec_ch_ua)。

    UA 统一用 Mac 版 Chrome — 与 Stripe 指纹中的 platform:"MacIntel" 保持一致。
    """
    p = random.choice(CHROME_PROFILES)
    patch = random.randint(*p["patch_range"])
    ver_num = p["impersonate"].replace("chrome", "").rstrip("a")
    ver = f"{ver_num}.0.{p['build']}.{patch}"
    ua = (
        f"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{ver} Safari/537.36"
    )
    return p["impersonate"], ua, p["sec_ch_ua"]


def create_session(proxy: str = "") -> Tuple[requests.Session, str, str]:
    """创建带 TLS 指纹伪装的 Session。

    返回 (session, impersonate_id, user_agent)。
    Session 默认 headers 对齐真实 Chrome 访问 platform.claude.com 时的表现。
    """
    imp, ua, sec_ch_ua = get_random_profile()
    session = requests.Session(impersonate=imp)
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}
    session.headers.update({
        "User-Agent": ua,
        "sec-ch-ua": sec_ch_ua,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-ch-ua-arch": '"arm"',
        "sec-ch-ua-bitness": '"64"',
        "sec-ch-ua-full-version-list": sec_ch_ua,
        "sec-ch-ua-platform-version": '"15.5.0"',
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "gzip, deflate, br, zstd",
        "Upgrade-Insecure-Requests": "1",
        "DNT": "1",
    })
    return session, imp, ua
