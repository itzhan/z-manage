"""支付成功后把 Claude key 同步到 Resource Hub（失败重试）。

对齐 claude_console_go/internal/hub/hub.go。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Optional

from .config import ResourceHub

log = logging.getLogger(__name__)


def sync_claude_key(
    session,
    cfg: ResourceHub,
    email: str,
    api_key: str,
    max_retries: int = 3,
    proxies: Optional[dict] = None,
) -> bool:
    """把一条 Claude key 同步到 Hub，失败重试 max_retries 次。"""
    if not cfg.base_url or not cfg.api_key:
        return False

    url = cfg.base_url.rstrip("/") + "/api/registered/import"
    payload = {
        "accounts": [{
            "email": email,
            "session_key": api_key,
            "status": "active",
            "platform": "claude-platform",
        }],
    }

    for attempt in range(1, max_retries + 1):
        try:
            r = session.post(
                url,
                headers={
                    "Content-Type": "application/json",
                    "X-API-Key": cfg.api_key,
                },
                data=json.dumps(payload),
                proxies=proxies,
                timeout=15,
            )
            if 200 <= r.status_code < 300:
                log.info("[HUB_SYNC] claude key 已同步到 Hub")
                return True
            body = r.text[:200] if r.text else ""
            log.warning("[HUB_SYNC] 第%d次上传失败 HTTP %d: %s", attempt, r.status_code, body)
        except Exception as e:
            log.warning("[HUB_SYNC] 第%d次上传异常: %s", attempt, e)

        if attempt < max_retries:
            time.sleep(3 * attempt)

    log.warning("[HUB_SYNC] claude key 同步失败（%d次重试）", max_retries)
    return False
