"""Stripe 设备指纹管理：m.stripe.com/6 交互 + 三要素分离 + 按代理持久化。

Stripe.js 风控链：
  1. POST m.stripe.com/6（带 browser fingerprint payload）→ 获得 {muid, guid, sid}
  2. 后续 /v1/tokens 和 /v1/setup_intents/confirm 中分别传入 guid/muid/sid
  3. guid = 持久设备 ID（Set-Cookie m=）, muid = 用户 ID, sid = session ID

关键（2026-07-06 逆向 out-4.5.45.js 确认）：
  真实浏览器发给 m.stripe.com/6 的 **不是** form-urlencoded 的 fingerprintjs2 JSON，
  而是 `base64( encodeURIComponent( JSON.stringify(payload) ) )` 的原始文本 body，
  Content-Type: text/plain;charset=UTF-8。

  采集脚本链：js.stripe.com/v3 → m-outer-*.html → m.stripe.network/inner.html
             → m.stripe.network/out-<ver>.js（真正的采集器）

  payload 结构：
    {
      v2: 1, id: <md5(所有特征值以空格连接)>, t: <总耗时ms>,
      tag: "$npm_package_version", src: "js",
      i: <canvas toDataURL 字符串>,
      a: { a..o: {v: 特征值, t: 耗时[, at: 异步活跃耗时]} },   # 15 个采集器（顺序固定）
      b: <browserFeatures：referrer/url/title 经 URL 哈希 + 各种能力位>,
      h: <10 字节 hex nonce>
    }

  15 个采集器顺序（→ a.a ~ a.o）：
    CookieSupport / DoNotTrack / Language / Platform / Plugins / ScreenSize /
    TimeZoneOffset / TouchSupport / AvailableStorage / Fonts(位串) /
    GraphicsConfiguration(空) / UserAgent / FlashVersion(空) / HasAdBlocker / CanvasId

本模块负责：
  - 按真实格式生成 payload（Mac Chrome 一致性设备）
  - 调用 m.stripe.com/6 获取真实的三要素
  - 按代理 IP 持久化，同一 IP 复用同一设备指纹
  - 指纹模板多样性池（screen/GPU/canvas 组合）
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import random
import re
import struct
import time
import urllib.parse
import zlib
from dataclasses import dataclass
from typing import Optional, Tuple

log = logging.getLogger(__name__)

# out-4.5.45.js 内 URL_SALT（sha256WithSalt 用），以及 URL 分段哈希限制
STRIPE_URL_SALT = "7766e861-8279-424d-87a1-07a6022fd8cd"
_DEFAULT_FULL_HASH_LIMIT = 10
_TOTAL_PARTS_LIMIT = 40
_PATH_PARTS_LIMIT = 30
_PARTIAL_HASH_LEN = 6

# encodeURIComponent 不转义的字符集（A-Za-z0-9 及以下），交给 urllib.parse.quote 的 safe
_URI_SAFE = "!~*'()-_."

# ---- 指纹模板池 ----

# 真实 Mac Chrome 设备指纹（从无痕 Chrome 149 抓取）
SCREEN_PROFILES = [
    {"resolution": "2560,1440", "available": "2560,1353", "colorDepth": 24, "pixelRatio": 2},
    {"resolution": "1920,1080", "available": "1920,1055", "colorDepth": 24, "pixelRatio": 2},
    {"resolution": "2560,1600", "available": "2560,1505", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "1728,1117", "available": "1728,1055", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "1512,982", "available": "1512,918", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "1440,900", "available": "1440,831", "colorDepth": 24, "pixelRatio": 2},
    {"resolution": "1680,1050", "available": "1680,981", "colorDepth": 24, "pixelRatio": 2},
    {"resolution": "2880,1800", "available": "2880,1705", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "3024,1964", "available": "3024,1895", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "3456,2234", "available": "3456,2169", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "1792,1120", "available": "1792,1055", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "2048,1152", "available": "2048,1083", "colorDepth": 24, "pixelRatio": 2},
    {"resolution": "1470,956", "available": "1470,893", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "1800,1169", "available": "1800,1105", "colorDepth": 30, "pixelRatio": 2},
    {"resolution": "2056,1329", "available": "2056,1265", "colorDepth": 30, "pixelRatio": 2},
]

GPU_PROFILES = [
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Ultra, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
    {"renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Ultra, Unspecified Version)", "vendor": "Google Inc. (Apple)"},
]

# out-4.5.45.js 内的 fontsToDetect 顺序（55 项），FontsExtractor 输出为每项
# "是否检测到" 的 0/1 位串（长度 55）。下面标注每种字体在 macOS 上的典型可见性。
_FONTS_TO_DETECT = [
    ("Andale Mono", 1), ("Arial Black", 1), ("Arial Hebrew", 1), ("Arial MT", 0),
    ("Arial Narrow", 1), ("Arial Rounded MT Bold", 1), ("Arial Unicode MS", 1),
    ("Arial", 1), ("Bitstream Vera Sans Mono", 0), ("Book Antiqua", 0),
    ("Bookman Old Style", 0), ("Calibri", 0), ("Cambria", 0), ("Century Gothic", 0),
    ("Century Schoolbook", 0), ("Century", 0), ("Comic Sans MS", 1), ("Comic Sans", 0),
    ("Consolas", 0), ("Courier New", 1), ("Courier", 1), ("Garamond", 0),
    ("Georgia", 1), ("Helvetica Neue", 1), ("Helvetica", 1), ("Impact", 1),
    ("Lucida Fax", 0), ("Lucida Handwriting", 0), ("Lucida Sans Typewriter", 0),
    ("Lucida Sans Unicode", 0), ("Lucida Sans", 0), ("MS Gothic", 0), ("MS Outlook", 0),
    ("MS PGothic", 0), ("MS Reference Sans Serif", 0), ("MS Serif", 0),
    ("MYRIAD PRO", 0), ("MYRIAD", 0), ("Microsoft Sans Serif", 0), ("Monaco", 1),
    ("Monotype Corsiva", 0), ("Palatino Linotype", 0), ("Palatino", 1),
    ("Segoe Script", 0), ("Segoe UI Semibold", 0), ("Segoe UI Symbol", 0),
    ("Segoe UI", 0), ("Tahoma", 0), ("Times New Roman PS", 0), ("Times New Roman", 1),
    ("Times", 1), ("Trebuchet MS", 1), ("Verdana", 1), ("Wingdings 3", 0),
    ("Wingdings", 0),
]

# 真实 Chrome navigator.plugins（5 个内置 PDF 查看器，filename 均为 internal-pdf-viewer，
# 每个含 application/pdf + text/pdf 两个 mimeType，suffix 均为 pdf）。
_CHROME_PLUGIN_NAMES = [
    "PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer",
    "Microsoft Edge PDF Viewer", "WebKit built-in PDF",
]

# 时区 → 7 月（夏令时）下的 (-getTimezoneOffset()/60) 值，与美国代理 IP 对应
_US_TIMEZONES = [
    ("America/New_York", -4, 300),
    ("America/Chicago", -5, 360),
    ("America/Denver", -6, 420),
    ("America/Los_Angeles", -7, 480),
]

HARDWARE_PROFILES = [
    {"memory": 16, "concurrency": 10},
    {"memory": 32, "concurrency": 14},
    {"memory": 16, "concurrency": 8},
    {"memory": 32, "concurrency": 12},
    {"memory": 8, "concurrency": 8},
    {"memory": 8, "concurrency": 4},
    {"memory": 16, "concurrency": 12},
    {"memory": 32, "concurrency": 16},
    {"memory": 24, "concurrency": 12},
    {"memory": 64, "concurrency": 16},
    {"memory": 16, "concurrency": 14},
    {"memory": 8, "concurrency": 10},
    {"memory": 32, "concurrency": 10},
    {"memory": 24, "concurrency": 8},
]

STRIPE_M_OUTER_VERSION = "m-outer-3437aaddcdf6922d623e172c2d6f9278"
# payment_user_agent 中的 hash = js.stripe.com/v3 内 STRIPE_JS_BUILD_SALT 后的版本串（bp.h）
DEFAULT_PAYMENT_USER_AGENT = "stripe.js/03270cb259; stripe-js-v3/03270cb259; payment-element"
# Stripe.js 运行页面（billing 页），用于 payload 的 url / referrer 字段
STRIPE_PAGE_URL = "https://platform.claude.com/create/credits"
STRIPE_PAGE_REFERRER = "https://platform.claude.com/"
STRIPE_PAGE_TITLE = "Anthropic Console"
# AdsPower 173 真实 StripeM 抓包中的 feature id。真实请求里 a=null，
# 因此 id 必须保持为该浏览器已采集出的稳定设备 id。
ADSPOWER_173_FEATURE_ID = "5514c496cb43fb8e129f465527b98efb"


@dataclass
class StripeDevice:
    """一台虚拟设备的 Stripe 三要素 + 元数据。"""
    guid: str = ""
    muid: str = ""
    sid: str = ""
    fingerprint_seed: str = ""
    created_at: str = ""
    last_used_at: str = ""
    use_count: int = 0


class StripeFingerprint:
    """Stripe 设备指纹管理器。"""

    def __init__(self, ua: str = ""):
        self._ua = ua or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/136.0.7103.100 Safari/537.36"
        )
        self._payment_user_agent = DEFAULT_PAYMENT_USER_AGENT

    @property
    def payment_user_agent(self) -> str:
        return self._payment_user_agent

    @payment_user_agent.setter
    def payment_user_agent(self, val: str):
        self._payment_user_agent = val

    def get_device(self, session, proxy_key: str, proxies: Optional[dict] = None,
                   force_new: bool = False) -> StripeDevice:
        """每次创建全新设备指纹，确保每个注册账号在 Stripe 看来都是不同设备。"""
        unique_seed = f"{proxy_key}_{int(time.time())}_{random.getrandbits(32)}"
        device = self._create_new_device(session, unique_seed, proxies)
        log.info("[stripe_fp] 全新设备: guid=%s..., seed=%s",
                 device.guid[:12], unique_seed[:20])
        return device

    def _create_new_device(self, session, proxy_key: str,
                           proxies: Optional[dict] = None) -> StripeDevice:
        """调用 m.stripe.com/6 生成新设备指纹。"""
        seed = proxy_key or str(random.getrandbits(64))
        fp_payload = self._build_fingerprint_payload(seed)

        try:
            r = session.post(
                "https://m.stripe.com/6",
                headers={
                    # 真实浏览器 XHR 发字符串 body → 默认 text/plain;charset=UTF-8
                    "Content-Type": "text/plain;charset=UTF-8",
                    "Origin": "https://m.stripe.network",
                    "Referer": "https://m.stripe.network/",
                    "User-Agent": self._ua,
                },
                data=fp_payload,
                proxies=proxies,
                timeout=10,
            )
            if r.status_code == 200:
                data = r.json()
                return StripeDevice(
                    guid=data.get("guid", ""),
                    muid=data.get("muid", ""),
                    sid=data.get("sid", ""),
                    fingerprint_seed=seed,
                    created_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                    last_used_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                    use_count=1,
                )
        except Exception as e:
            log.warning("[stripe_fp] m.stripe.com/6 请求失败: %s", e)

        # fallback：生成格式化的 UUID（非理想但不会阻塞流程）
        return StripeDevice(
            guid=self._fake_stripe_id(),
            muid=self._fake_stripe_id(),
            sid=self._fake_stripe_id(),
            fingerprint_seed=seed,
            created_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            last_used_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
            use_count=1,
        )

    def _build_fingerprint_payload(self, seed: str) -> str:
        """构建发给 m.stripe.com/6 的指纹 body（逆向 out-4.5.45.js 的真实格式）。

        返回 `base64( encodeURIComponent( JSON.stringify(payload) ) )` 文本，
        以 Content-Type: text/plain;charset=UTF-8 发送。

        AdsPower 173 实测：collector 复用本地 MStorage 中的 feature id 时，
        上传的 payload 为 a=null，不包含 canvas/fonts/plugins 等 15 个 extractor 细节。
        这比合成完整 extractor 更接近真实浏览器的二次/稳定设备请求。
        """
        rng = random.Random(hashlib.md5(seed.encode()).hexdigest())

        # ---- browserFeatures (b) ----
        nonce = self._nonce(rng)
        now_ms = int(time.time() * 1000)
        loaded_time = int(rng.uniform(900, 2600))
        b_obj = {
            "a": self._hash_url(STRIPE_PAGE_REFERRER),      # referrer 分段哈希
            "b": self._hash_url(STRIPE_PAGE_URL),            # url 分段哈希
            "c": self._sha256_salt(STRIPE_PAGE_TITLE),       # title
            "d": "",                                          # muid（新设备为空）
            "e": "",                                          # sid（新设备为空）
            "f": False,                                        # audioMozSrcObjectCheck (Chrome)
            "g": True,                                         # arrayBufferRequiresNew (Chrome)
            "h": True,                                         # arrayDotFromSupport (Chrome)
            "i": ["location"],                                 # AdsPower 173 真实值
            "j": [],                                           # Object.keys(navigator)
            "n": loaded_time,                                  # loadedTime
            "u": self._url_domain(STRIPE_PAGE_URL),
            "v": self._url_domain(STRIPE_PAGE_REFERRER),
            "w": f"{now_ms}:{hashlib.sha256((nonce + str(now_ms + 1)).encode()).hexdigest()}",
        }

        payload = {
            "v2": 1,
            "id": ADSPOWER_173_FEATURE_ID,
            "t": round(rng.uniform(12.0, 34.0), 1),
            "tag": "$npm_package_version",
            "src": "js",
            "a": None,
            "b": b_obj,
            "h": nonce,
        }

        raw = json.dumps(payload, separators=(",", ":"))
        return base64.b64encode(
            urllib.parse.quote(raw, safe=_URI_SAFE).encode()
        ).decode()

    # ---- 指纹辅助 ----

    @staticmethod
    def _plugins_string() -> str:
        """复刻 PluginsExtractor 输出：5 个内置 PDF 查看器展平后的逗号串。"""
        parts = []
        mime = "application/pdf,pdf++text/pdf,pdf"
        for name in _CHROME_PLUGIN_NAMES:
            parts.extend([name, "internal-pdf-viewer", mime])
        return ", ".join(parts)

    @staticmethod
    def _fonts_bitstring(rng: random.Random) -> str:
        """复刻 FontsExtractor 输出：fontsToDetect 每项是否命中的 0/1 位串（长度 55）。

        以 macOS 典型可见性为基准，对少数“边界字体”做轻微抖动，制造设备差异。
        """
        bits = []
        borderline = {2, 5, 6, 20, 47}  # Arial Hebrew / Arial Rounded / Arial Unicode / Courier / Tahoma
        for idx, (_name, present) in enumerate(_FONTS_TO_DETECT):
            v = present
            if idx in borderline and rng.random() < 0.35:
                v = 1 - v
            bits.append(str(v))
        return "".join(bits)

    @staticmethod
    def _nonce(rng: random.Random) -> str:
        """entropyBitsInNonce=80 → 10 字节 → 20 位 hex。"""
        return "".join(f"{rng.getrandbits(8):02x}" for _ in range(10))

    @staticmethod
    def _sha256_salt(text: str) -> str:
        """out-4.5.45.js 的 sha256WithSalt。

        真实输出为 URL-safe base64（去掉 = padding），不是 hex。
        """
        if not text:
            return text
        digest = hashlib.sha256((text + STRIPE_URL_SALT).encode()).digest()
        return base64.urlsafe_b64encode(digest).decode().rstrip("=")

    @staticmethod
    def _partition_url(url: str) -> dict:
        """按 out-4.5.45.js 的 PartitionedUrl（RFC3986 分段），authority 去 userinfo。"""
        m = re.match(r"^(?:([^:/?#]+):)?(?://([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?", url)
        scheme = (m.group(1) + ":") if m.group(1) else ""
        authority = ("//" + m.group(2)) if m.group(2) is not None else ""
        if authority:
            at = authority.rfind("@")
            if at != -1:
                authority = "//" + authority[at + 1:]
        return {
            "scheme": scheme,
            "authority": authority,
            "path": m.group(3) or "",
            "query": ("?" + m.group(4)) if m.group(4) else "",
            "fragment": ("#" + m.group(5)) if m.group(5) else "",
        }

    def _hash_url(self, url: str, full_hash_limit: int = _DEFAULT_FULL_HASH_LIMIT) -> str:
        """复刻 hashUrlWithAuthorityCheck → hashUrl：对 authority/path/query/fragment
        分段做 sha256WithSalt 替换（非 stripe 域，全部走哈希）。"""
        if not url:
            return url
        parts = self._partition_url(url)
        remaining = [_TOTAL_PARTS_LIMIT]

        def full_limit_for(kind: str) -> int:
            return _TOTAL_PARTS_LIMIT if kind == "authority" else full_hash_limit

        def total_for(kind: str) -> int:
            if kind == "authority":
                return _TOTAL_PARTS_LIMIT
            if kind == "path":
                return max(1, min(_PATH_PARTS_LIMIT, remaining[0]))
            return max(1, remaining[0])  # query / fragment

        def split_and_hash(s: str, kind: str, sep: str) -> str:
            if not s:
                return s
            full_limit = full_limit_for(kind)
            total = total_for(kind)
            state = {"s": s, "cur": 0, "hashed": 0}

            def replace(tok: str):
                n = state["s"].index(tok, state["cur"])
                t = tok
                is_last = state["hashed"] == total - 1
                if is_last:
                    t = state["s"][n:]
                r = self._sha256_salt(t)
                if (not is_last) and state["hashed"] >= full_limit:
                    r = r[:_PARTIAL_HASH_LEN]
                state["s"] = state["s"][:n] + r + state["s"][n + len(t):]
                state["cur"] = n + len(r)
                state["hashed"] += 1

            for tok in re.split(sep, s):
                if tok and state["hashed"] < total:
                    replace(tok)
            remaining[0] -= state["hashed"]
            return state["s"]

        parts["authority"] = split_and_hash(parts["authority"], "authority", r"[/.:]")
        parts["path"] = split_and_hash(parts["path"], "path", r"[/#?!&+,=]")
        parts["query"] = split_and_hash(parts["query"], "query", r"[/#?!&+,=]")
        parts["fragment"] = split_and_hash(parts["fragment"], "fragment", r"[/#?!&+,=]")
        return parts["scheme"] + parts["authority"] + parts["path"] + parts["query"] + parts["fragment"]

    @staticmethod
    def _url_domain(url: str) -> str:
        """getUrlDomain：authority 去 '//' 前缀与端口。"""
        m = re.match(r"^(?:[^:/?#]+:)?(?://([^/?#]*))?", url)
        auth = m.group(1) if m and m.group(1) else ""
        at = auth.rfind("@")
        if at != -1:
            auth = auth[at + 1:]
        return auth.split(":")[0]

    def _canvas_dataurl(self, rng: random.Random, gpu_renderer: str) -> str:
        """生成合法的 canvas toDataURL（data:image/png;base64,...）。

        真实采集器画 400x60 的文本+两个色块。这里生成一张同尺寸、以 GPU/seed 决定
        像素扰动的合法 PNG：大面积留白利于压缩（体积与真实 toDataURL 相当，几 KB），
        且不同设备 md5 不同，避免跨账号 canvas 完全一致的强关联信号。
        """
        w, h = 400, 60
        # 以 GPU renderer + 随机 seed 派生像素扰动种子
        pix_seed = int(hashlib.sha256(f"{gpu_renderer}_{rng.getrandbits(64)}".encode()).hexdigest(), 16)
        pr = random.Random(pix_seed)

        white = (0xFF, 0xFF, 0xFF)
        orange = (0xFF, 0x66, 0x00)
        green = (0x66, 0xCC, 0x00)

        raw = bytearray()
        for y in range(h):
            raw.append(0)  # 每行 filter type 0
            for x in range(w):
                if 1 <= y <= 20 and 125 <= x < 187:
                    r, g, b = orange
                elif 24 <= y <= 52 and 4 <= x < 260 and ((x + y) % 7 == 0):
                    r, g, b = green            # 模拟半透明绿字笔画
                elif 4 <= y <= 18 and 2 <= x < 240 and ((x * 3 + y) % 11 == 0):
                    r, g, b = (0x00, 0x66, 0x99)  # 模拟深蓝字
                else:
                    r, g, b = white
                # GPU/驱动级亚像素抖动：极少量像素 ±1，肉眼不可见但改变 md5
                if pr.random() < 0.0015:
                    r = min(255, max(0, r + pr.choice((-1, 1))))
                    g = min(255, max(0, g + pr.choice((-1, 1))))
                    b = min(255, max(0, b + pr.choice((-1, 1))))
                raw += bytes((r, g, b))

        png = self._encode_png(w, h, bytes(raw))
        return "data:image/png;base64," + base64.b64encode(png).decode()

    @staticmethod
    def _encode_png(w: int, h: int, raw_rgb: bytes) -> bytes:
        """最小 PNG 编码器（RGB, 8-bit, 无依赖）。"""
        def chunk(tag: bytes, data: bytes) -> bytes:
            c = tag + data
            return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

        sig = b"\x89PNG\r\n\x1a\n"
        ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # color type 2 = RGB
        idat = zlib.compress(raw_rgb, 9)
        return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

    @staticmethod
    def _fake_stripe_id() -> str:
        """生成 Stripe 风格的 ID（UUID + 6 位 hex 后缀）。"""
        import uuid
        base = str(uuid.uuid4())
        suffix = "".join(random.choices("0123456789abcdef", k=6))
        return f"{base}{suffix}"

    @staticmethod
    def fetch_payment_user_agent(session, proxies: Optional[dict] = None) -> str:
        """从 js.stripe.com/v3/ 源码提取 payment_user_agent 的版本 hash。

        真实构造（js.stripe.com/v3 内）：
            bp.h = /*! STRIPE_JS_BUILD_SALT <salt>*/ "<hash>"
            Ap  = "stripe.js/" + bp.h
            Sp  = Ap + "; stripe-js-v3/" + bp.h
        payment-element 场景最终为：
            "stripe.js/<hash>; stripe-js-v3/<hash>; payment-element"
        """
        try:
            r = session.get("https://js.stripe.com/v3/", proxies=proxies, timeout=15)
            if r.status_code != 200:
                return DEFAULT_PAYMENT_USER_AGENT

            # 精确匹配 STRIPE_JS_BUILD_SALT 后紧跟的版本 hash（即 bp.h）
            m = re.search(r"STRIPE_JS_BUILD_SALT\s+[0-9a-f]+\*/\s*\"([0-9a-f]{8,20})\"", r.text)
            if not m:
                # 退化匹配：形如  .h=function(){return r}});var r=...\"<hash>\"
                m = re.search(r"n\.d\(t,\{h:[^}]+\}\);var r=[^\"]*\"([0-9a-f]{8,20})\"", r.text)
            if m:
                h = m.group(1)
                pua = f"stripe.js/{h}; stripe-js-v3/{h}; payment-element"
                log.info("[stripe_fp] payment_user_agent: %s", pua)
                return pua
        except Exception as e:
            log.debug("[stripe_fp] 获取 Stripe.js 版本失败: %s", e)

        return DEFAULT_PAYMENT_USER_AGENT
