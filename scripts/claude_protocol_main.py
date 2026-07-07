#!/usr/bin/env python3
"""claude_protocol 协议版 CLI 入口。

对齐 claude_console_go/main.go 的参数和流程。

用法（mail.com 邮箱）：
    python main.py -e user@mail.com -p mail_password \\
        --card-number 4242424242424242 --card-expiry 0330 --card-cvv 123

用法（Outlook 邮箱）：
    python main.py -e user@outlook.com \\
        --email-source outlook \\
        --outlook-client-id xxx --outlook-refresh-token "0.ABC..." \\
        --card-number 4242424242424242 --card-expiry 0330 --card-cvv 123

用法（不充值，仅登录 + 建 Key）：
    python main.py -e user@mail.com -p mail_password

用法（从 mail.com 账号池自动取下一个未使用的邮箱）：
    python main.py --auto-pick \\
        --card-number 4242424242424242 --card-expiry 0330 --card-cvv 123
"""

import argparse
import logging
import os
import sys

from claude_protocol.console_flow import ConsoleArgs, FlowResult, run_console_flow
from claude_protocol.config import load_config
from claude_protocol.store import Store


def _project_base_dir() -> str:
    """定位项目根目录（与 Go 版 projectBaseDir 对齐）。"""
    exe_dir = os.path.dirname(os.path.abspath(__file__))
    if os.path.isfile(os.path.join(exe_dir, "config", "settings.json")):
        return exe_dir
    cwd = os.getcwd()
    if os.path.isfile(os.path.join(cwd, "config", "settings.json")):
        return cwd
    # 回退到父目录（共享 config）
    parent = os.path.dirname(exe_dir)
    if os.path.isfile(os.path.join(parent, "config", "settings.json")):
        return parent
    return exe_dir


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(
        description="Claude Platform Console 协议版自动化"
    )

    # 账号参数
    parser.add_argument("-e", "--email", default="", help="mail.com / Outlook 邮箱地址")
    parser.add_argument("-p", "--password", default="", help="mail.com 邮箱密码")
    parser.add_argument("--email-source", default="mailcom",
                        choices=["mailcom", "outlook"],
                        help="邮箱来源（默认 mailcom）")
    parser.add_argument("--outlook-client-id", default="",
                        help="Outlook OAuth client_id（email-source=outlook 时）")
    parser.add_argument("--outlook-refresh-token", default="",
                        help="Outlook OAuth refresh_token（email-source=outlook 时）")

    # 自动取号
    parser.add_argument("--auto-pick", action="store_true",
                        help="从 state/mailcom_accounts.json 自动取下一个未使用邮箱")

    # 卡信息
    parser.add_argument("--card-number", default="", help="卡号")
    parser.add_argument("--card-expiry", default="", help="有效期 MMYY 或 MM/YY")
    parser.add_argument("--card-cvv", default="", help="CVV")
    parser.add_argument("--card-id", default="", help="卡 ID（用于 SQLite 记账）")
    parser.add_argument("--amount", type=float, default=5.0, help="充值金额（默认 5）")

    # 通用参数
    parser.add_argument("--proxy", default="", help="代理 URL（优先于代理池）")
    parser.add_argument("--proxy-pool", default="static",
                        choices=["static", "residential"],
                        help="代理池（默认 static）")
    parser.add_argument("--key-name", default="auto-key", help="API Key 名称")
    parser.add_argument("--yescaptcha-key", default="",
                        help="YesCaptcha API key（Stripe hCaptcha 求解，绑卡必需）")

    args = parser.parse_args()

    base_dir = _project_base_dir()
    cfg = load_config(base_dir)

    # 自动取号
    email = args.email
    password = args.password
    if args.auto_pick and not email:
        try:
            st = Store(cfg.state_dir)
            acct = st.next_available_mail_account()
            email = acct.email
            password = acct.password
            print(f"[AUTO] 自动选取邮箱: {email}")
        except Exception as e:
            print(f"[ERROR] 自动取号失败: {e}")
            sys.exit(1)

    if not email:
        parser.error("必须提供 -e/--email 或使用 --auto-pick")

    console_args = ConsoleArgs(
        email=email,
        password=password,
        email_source=args.email_source,
        outlook_client_id=args.outlook_client_id,
        outlook_refresh_token=args.outlook_refresh_token,
        card_number=args.card_number,
        card_expiry=args.card_expiry,
        card_cvv=args.card_cvv,
        card_id=args.card_id,
        amount=args.amount,
        proxy=args.proxy,
        proxy_pool=args.proxy_pool,
        key_name=args.key_name,
        yescaptcha_key=args.yescaptcha_key,
    )

    login_mode = "mail.com" if args.email_source == "mailcom" else "Outlook"
    print("=" * 60)
    print("  Claude Platform Console 协议版")
    print(f"  邮箱: {email}")
    print(f"  来源: {login_mode}")
    if args.card_number:
        print(f"  充值: ${args.amount}")
    else:
        print("  充值: 跳过（未提供卡号）")
    print("=" * 60)
    print()

    result = run_console_flow(console_args, cfg)

    if result.success:
        print(f"\n[OK] 全流程成功")
        print(f"  API Key: {result.api_key}")
        if result.amount > 0:
            print(f"  充值额: ${result.amount}")
        if result.org_id:
            print(f"  org_id: {result.org_id}")
        if result.card_last4:
            print(f"  卡尾号: ****{result.card_last4}")
        if result.proxy_raw:
            print(f"  代理: {result.proxy_raw}")
    else:
        print(f"\n[FAIL] 流程失败")
        print(f"  错误类型: {result.error_type}")
        print(f"  错误信息: {result.error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
