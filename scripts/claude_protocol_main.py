#!/usr/bin/env python3
"""Claude platform 协议注册。

用法：
    python main.py -e user@mail.com -p mail_password \
        --card-number 4242424242424242 --card-expiry 0330 --card-cvv 123 \
        --proxy http://user:pass@host:port \
        --yescaptcha-key YOUR_KEY

    # 不充值，仅登录 + 建 Key：
    python main.py -e user@mail.com -p mail_password

    # Outlook 邮箱：
    python main.py -e user@outlook.com --email-source outlook \
        --outlook-client-id xxx --outlook-refresh-token "0.ABC..."
"""

import argparse
import logging
import sys

from claude_protocol.console_flow import ConsoleArgs, run_console_flow


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    p = argparse.ArgumentParser(description="Claude Platform 协议版自动化")
    p.add_argument("-e", "--email", required=True, help="邮箱地址")
    p.add_argument("-p", "--password", default="", help="mail.com 邮箱密码")
    p.add_argument("--email-source", default="mailcom", choices=["mailcom", "outlook"])
    p.add_argument("--outlook-client-id", default="")
    p.add_argument("--outlook-refresh-token", default="")
    p.add_argument("--card-number", default="", help="卡号")
    p.add_argument("--card-expiry", default="", help="有效期 MMYY 或 MM/YY")
    p.add_argument("--card-cvv", default="", help="CVV")
    p.add_argument("--amount", type=float, default=5.0, help="充值金额（默认 5）")
    p.add_argument("--proxy", default="", help="代理 URL")
    p.add_argument("--key-name", default="auto-key", help="API Key 名称")
    p.add_argument("--yescaptcha-key", default="", help="YesCaptcha API key（绑卡必需）")
    args = p.parse_args()

    console_args = ConsoleArgs(
        email=args.email,
        password=args.password,
        email_source=args.email_source,
        outlook_client_id=args.outlook_client_id,
        outlook_refresh_token=args.outlook_refresh_token,
        card_number=args.card_number,
        card_expiry=args.card_expiry,
        card_cvv=args.card_cvv,
        amount=args.amount,
        proxy=args.proxy,
        key_name=args.key_name,
        yescaptcha_key=args.yescaptcha_key,
    )

    login_mode = "mail.com" if args.email_source == "mailcom" else "Outlook"
    print("=" * 60)
    print(f"  邮箱: {args.email}  ({login_mode})")
    print(f"  充值: ${args.amount}" if args.card_number else "  充值: 跳过")
    print("=" * 60)

    result = run_console_flow(console_args)

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
        print(f"\n[FAIL] {result.error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
