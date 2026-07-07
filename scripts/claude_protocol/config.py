"""读取 config/settings.json，只解析本流程需要的字段。

对齐 claude_console_go/internal/config/config.go。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


@dataclass
class ResourceHub:
    base_url: str = ""
    api_key: str = ""
    machine_id: str = ""


@dataclass
class Cards:
    claude_platform_max_per_card: int = 2


@dataclass
class Settings:
    resource_hub: ResourceHub = field(default_factory=ResourceHub)
    cards: Cards = field(default_factory=Cards)


@dataclass
class Config:
    base_dir: str = ""
    settings: Settings = field(default_factory=Settings)

    @property
    def state_dir(self) -> str:
        return os.path.join(self.base_dir, "state")

    @property
    def config_dir(self) -> str:
        return os.path.join(self.base_dir, "config")


def load_config(base_dir: str) -> Config:
    """从 base_dir/config/settings.json 读取配置。"""
    path = os.path.join(base_dir, "config", "settings.json")
    raw: dict = {}
    if os.path.isfile(path):
        with open(path) as f:
            raw = json.load(f)

    rh = raw.get("resource_hub", {})
    cards = raw.get("cards", {})
    settings = Settings(
        resource_hub=ResourceHub(
            base_url=rh.get("base_url", ""),
            api_key=rh.get("api_key", ""),
            machine_id=rh.get("machine_id", ""),
        ),
        cards=Cards(
            claude_platform_max_per_card=cards.get("claude_platform_max_per_card", 2),
        ),
    )

    os.makedirs(os.path.join(base_dir, "state"), exist_ok=True)
    return Config(base_dir=base_dir, settings=settings)
