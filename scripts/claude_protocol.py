"""Claude Platform 协议脚本: 登录 → Add funds → 创建 Key
用法: python3 claude_protocol.py --email xxx --password xxx --card-number xxx --card-expiry 0728 --card-cvv xxx --proxy http://user:pass@host:port --address '{"address1":"...","city":"...","state":"OR","zip":"97210"}'
输出: JSON {"success":true,"key":"sk-ant-...","email":"...","balance":5} 或 {"success":false,"error":"..."}
"""
import time, json, logging, sys, re, random, subprocess, argparse
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("protocol")

def random_name():
    f = random.choice(["James","Robert","John","Michael","David","William","Thomas","Richard","Joseph","Daniel","Matthew","Anthony","Mark","Steven"])
    l = random.choice(["Smith","Johnson","Williams","Brown","Jones","Miller","Davis","Wilson","Moore","Taylor","Anderson","Thomas","Jackson","White"])
    return f"{f} {l}"

def get_magic_link_mailcom(email, password, master_url, api_key, timeout=120):
    """通过 z-manage API 读邮件获取 magic link"""
    import urllib.request
    start = time.time()
    attempt = 0
    while time.time() - start < timeout:
        attempt += 1
        try:
            url = f"{master_url}/api/mailcom/inbox?email={email}"
            req = urllib.request.Request(url, headers={"X-API-Key": api_key})
            resp = json.loads(urllib.request.urlopen(req, timeout=20).read())
            for m in resp.get("mails", []):
                subj = m.get("subject", "")
                if "claude" in subj.lower() or "anthropic" in subj.lower() or "magic" in subj.lower():
                    mail_id = m.get("id")
                    url2 = f"{master_url}/api/mailcom/inbox?email={email}&mailId={mail_id}"
                    req2 = urllib.request.Request(url2, headers={"X-API-Key": api_key})
                    body = json.loads(urllib.request.urlopen(req2, timeout=20).read()).get("body", "")
                    match = re.search(r"https://platform\.claude\.com/magic-link#[^\s\"<']+", body)
                    if match:
                        return match.group(0)
        except Exception as e:
            log.debug(f"轮询 #{attempt} 异常: {e}")
        time.sleep(5 if attempt > 2 else 8)
    raise RuntimeError(f"magic link 轮询超时 ({timeout}s)")

def get_magic_link_outlook(email, client_id, refresh_token, timeout=120):
    """通过 Outlook API 读邮件获取 magic link"""
    import urllib.request, urllib.parse
    start = time.time()
    attempt = 0
    ol_refresh = refresh_token
    while time.time() - start < timeout:
        attempt += 1
        try:
            token_data = urllib.parse.urlencode({"client_id": client_id, "grant_type": "refresh_token", "refresh_token": ol_refresh}).encode()
            token_req = urllib.request.Request("https://login.live.com/oauth20_token.srf", data=token_data)
            token_resp = json.loads(urllib.request.urlopen(token_req, timeout=15).read())
            access = token_resp.get("access_token", "")
            if token_resp.get("refresh_token"):
                ol_refresh = token_resp["refresh_token"]
            if not access:
                raise RuntimeError("Outlook token 刷新失败")
            mail_req = urllib.request.Request(
                "https://outlook.office.com/api/v2.0/me/messages?$top=5&$select=Subject,Body,From&$orderby=ReceivedDateTime%20desc",
                headers={"Authorization": f"Bearer {access}"}
            )
            mail_resp = json.loads(urllib.request.urlopen(mail_req, timeout=15).read())
            for msg in mail_resp.get("value", []):
                from_addr = msg.get("From", {}).get("EmailAddress", {}).get("Address", "")
                subj = msg.get("Subject", "")
                if "anthropic" not in from_addr.lower() and "claude" not in subj.lower():
                    continue
                body = msg.get("Body", {}).get("Content", "")
                match = re.search(r"https://platform\.claude\.com/magic-link#[^\s\"<']+", body)
                if match:
                    return match.group(0)
        except Exception as e:
            log.debug(f"轮询 #{attempt} 异常: {e}")
        time.sleep(5 if attempt > 2 else 8)
    raise RuntimeError(f"magic link 轮询超时 ({timeout}s)")

def run(args):
    from cloakbrowser import launch

    email = args.email
    proxy_url = args.proxy
    card = {"number": args.card_number, "expiry": args.card_expiry, "cvv": args.card_cvv}
    address = json.loads(args.address) if args.address else {"address1": "4821 NW Everett St", "city": "Portland", "state": "OR", "zip": "97210"}
    amount = args.amount

    log.info(f"邮箱: {email}")
    log.info(f"代理: {proxy_url}")
    log.info(f"卡号: ****{card['number'][-4:]}")

    browser = launch(headless=True, proxy=proxy_url, geoip=True, humanize=True)
    page = browser.new_page()

    try:
        # Step 1: 登录
        log.info("Step 1: 登录")
        page.goto("https://platform.claude.com/login", timeout=30000)
        page.wait_for_selector("input[type=email]", timeout=15000)
        page.locator("input[type=email]").click()
        page.locator("input[type=email]").type(email, delay=random.randint(40, 80))
        time.sleep(random.uniform(0.5, 1.5))
        page.click('button:has-text("Continue with email")')
        log.info(f"已提交邮箱: {email}")
        time.sleep(5)

        err = page.evaluate("(() => {var e=document.querySelector('[role=alert]');return e?e.textContent.trim():''})()")
        if err and "not available" in err.lower():
            raise RuntimeError(f"邮箱被拒: {err}")

        log.info("轮询获取 magic link...")
        if args.email_source == "outlook":
            magic_link = get_magic_link_outlook(email, args.outlook_client_id, args.outlook_refresh_token)
        else:
            magic_link = get_magic_link_mailcom(email, args.password, args.master_url, args.master_api_key)
        log.info(f"获取到 magic link: {magic_link[:70]}...")

        page.goto(magic_link, timeout=30000, wait_until="domcontentloaded")
        for i in range(30):
            time.sleep(1)
            if "magic-link" not in page.url:
                break
        log.info(f"magic link 跳转后: {page.url}")

        # 检测封号
        cur = page.url.lower()
        if "/login" in cur and "logout" in cur:
            raise RuntimeError(f"[BANNED] 账号已被封禁: {email}")
        if "/restricted" in cur:
            raise RuntimeError(f"[BANNED] 账号已被封禁: {email}")

        # 处理引导流程
        for step in range(10):
            time.sleep(3)
            cur = page.url or ""
            if "/dashboard" in cur or "/settings" in cur:
                break
            if "/onboarding" in cur:
                fn = page.query_selector("[name=fullname]")
                if fn:
                    name = random_name()
                    page.locator("[name=fullname]").click()
                    page.locator("[name=fullname]").type(name, delay=random.randint(40, 70))
                    time.sleep(0.5)
                    dn = page.query_selector("[name=displayname]")
                    if dn:
                        page.locator("[name=displayname]").click()
                        page.locator("[name=displayname]").type(name.split()[0], delay=random.randint(40, 70))
                    page.evaluate('(() => {var cb=document.querySelector("[data-testid=\\"terms-checkbox\\"]");if(cb&&cb.getAttribute("aria-checked")!=="true")cb.click()})()')
                    time.sleep(1)
                    for _w in range(10):
                        enabled = page.evaluate('(() => {var bs=document.querySelectorAll("button[type=submit]");for(var b of bs){if(b.textContent.includes("Continue")&&!b.disabled)return true}return false})()')
                        if enabled: break
                        time.sleep(1)
                    page.evaluate('(() => {var bs=document.querySelectorAll("button[type=submit]");for(var b of bs){if(b.textContent.includes("Continue")&&!b.disabled){b.click();return}}})()')
                    log.info(f"onboarding: {name}")
                    continue
            if "/create" in cur and "/credits" not in cur:
                page.evaluate('(() => {var bs=document.querySelectorAll("button");for(var b of bs){if(b.textContent.includes("Individual")){b.click();return}}})()')
                log.info("点击 Individual")
                time.sleep(5)
                continue
            if "/create/credits" in cur:
                page.evaluate('(() => {var bs=document.querySelectorAll("button");for(var b of bs){if(b.textContent.includes("Skip")){b.click();return}}})()')
                log.info("点击 Skip")
                time.sleep(5)
                continue
            if "/org-discovery" in cur:
                page.evaluate('document.querySelectorAll("a,button,[role=button]").forEach(e=>{if(e.textContent.includes("Create a new organization"))e.click()})')
                log.info("点击 Create org")
                time.sleep(3)
                continue

        # Step 2: Add funds
        log.info("Step 2: Add funds")
        page.goto("https://platform.claude.com/dashboard", timeout=15000)
        time.sleep(5)

        body = page.evaluate("document.body.innerText")
        m = re.search(r"Credits\s*\$?([\d,.]+)", body)
        balance = float(m.group(1).replace(",", "")) if m else 0
        if balance > 0:
            log.info(f"已有余额 ${balance}")
        else:
            page.evaluate('(() => {var els=document.querySelectorAll("button,a,[role=button],[data-cds=TextLink]");for(var e of els){var t=e.textContent.trim();if(t==="Add funds"||t==="Add credits"||t==="Buy credits"){e.click();return}}})()')
            log.info("已点击 Add funds")
            time.sleep(5)

            # 选 USD 5
            page.evaluate(r'(() => {var bs=document.querySelectorAll("button[aria-pressed]");for(var b of bs){var t=b.textContent.trim();if(t.match(/USD\s*5$/)||t==="$5"){b.click();return}}})()')
            time.sleep(2)
            page.evaluate('(() => {document.querySelectorAll("button[aria-expanded=\\"false\\"]").forEach(b=>{var t=b.textContent.trim();if(t.includes("Billing")||t.includes("Credit")||t.includes("address")||t.includes("card"))b.click()})})()')
            time.sleep(3)

            # 填地址
            for selector in ["iframe[src*='componentName=address'][src*='mode=billing']", "iframe[title='Secure address input frame']"]:
                try:
                    fl = page.frame_locator(selector).first
                    fl.locator("[name=addressLine1]").wait_for(timeout=5000)
                    name_field = fl.locator("[name=name]")
                    if name_field.count() > 0:
                        name_field.fill(random_name())
                    fl.locator("[name=addressLine1]").fill(address["address1"])
                    time.sleep(2)
                    fl.locator("[name=locality]").fill(address["city"])
                    sel = fl.locator("select[name=administrativeArea]")
                    if sel.count() > 0:
                        sel.select_option(address["state"])
                    fl.locator("[name=postalCode]").fill(address["zip"])
                    log.info(f"地址: {address['address1']}, {address['state']}")
                    break
                except Exception:
                    continue

            # 填卡
            for selector in ["iframe[src*='componentName=payment']", "iframe[title='Secure payment input frame']"]:
                try:
                    fl = page.frame_locator(selector).first
                    fl.locator("[id*=numberInput]").first.wait_for(timeout=5000)
                    fl.locator("[id*=numberInput]").first.click()
                    fl.locator("[id*=numberInput]").first.type(card["number"], delay=random.randint(50, 80))
                    fl.locator("[id*=expiryInput]").first.click()
                    fl.locator("[id*=expiryInput]").first.type(card["expiry"], delay=random.randint(50, 80))
                    fl.locator("[id*=cvcInput]").first.click()
                    fl.locator("[id*=cvcInput]").first.type(card["cvv"], delay=random.randint(50, 80))
                    log.info(f"卡: ****{card['number'][-4:]}")
                    break
                except Exception:
                    continue

            time.sleep(3)
            # Buy
            for _w in range(15):
                btn = page.evaluate('(() => {var b=document.querySelector("[data-testid=\\"final-continue-button\\"]");return b?{disabled:b.disabled}:null})()')
                if btn and not btn.get("disabled"): break
                time.sleep(2)
            page.evaluate('(() => {var b=document.querySelector("[data-testid=\\"final-continue-button\\"]");if(b&&!b.disabled)b.click()})()')
            log.info("已点击 Buy credits")

            for i in range(60):
                time.sleep(2)
                try:
                    body_now = page.evaluate("document.body.innerText")
                except Exception:
                    continue
                if "auto-reload" in body_now.lower(): break
                err_text = page.evaluate('(() => {var els=document.querySelectorAll("[role=alert]");return Array.from(els).map(e=>e.textContent.trim()).filter(t=>t.length>0&&t.length<200).join("|")})()')
                if err_text:
                    log.error(f"支付错误: {err_text}")
                    break
                m2 = re.search(r"Credits\s*\$?([\d,.]+)", body_now)
                if m2 and float(m2.group(1).replace(",", "")) > 0: break
                if not page.evaluate('!!document.querySelector("[role=dialog]")'): break

            page.evaluate('document.querySelectorAll("button").forEach(b=>{if(b.textContent.includes("Skip"))b.click()})')
            time.sleep(2)

            for check in range(3):
                if check > 0:
                    page.goto("https://platform.claude.com/dashboard", timeout=15000)
                    time.sleep(5)
                body = page.evaluate("document.body.innerText")
                m = re.search(r"Credits\s*\$?([\d,.]+)", body)
                balance = float(m.group(1).replace(",", "")) if m else 0
                if balance > 0: break
                time.sleep(3)

        if balance <= 0:
            raise RuntimeError(f"充值失败: 余额 ${balance}")
        log.info(f"余额: ${balance}")

        # Step 3: 创建 Key
        log.info("Step 3: 创建 API Key")
        page.goto("https://platform.claude.com/settings/workspaces/default/keys", timeout=15000)
        time.sleep(5)
        page.evaluate('(() => {var bs=document.querySelectorAll("button");for(var b of bs){if(b.textContent.includes("Create")&&b.textContent.includes("key")){b.click();return}}})()')
        time.sleep(3)
        name_inp = page.query_selector('[role=dialog] input')
        if name_inp:
            name_inp.fill(f"auto-{int(time.time()) % 10000}")
            time.sleep(0.5)
        page.evaluate('(() => {var d=document.querySelector("[role=dialog]");if(!d)return;var bs=d.querySelectorAll("button");for(var b of bs){var t=b.textContent.trim();if(t==="Add"||t==="Create"||t==="Create key"){b.click();return}}})()')
        time.sleep(5)

        api_key = ""
        dialog = page.query_selector('[role=dialog]')
        if dialog:
            text = dialog.inner_text()
            m = re.search(r"(sk-ant-[a-zA-Z0-9_-]+)", text)
            if m:
                api_key = m.group(1)
                page.evaluate('(() => {var d=document.querySelector("[role=dialog]");if(!d)return;var bs=d.querySelectorAll("button");for(var b of bs){if(b.textContent.trim()==="Done"){b.click();return}}})()')

        if api_key:
            log.info(f"完整流程成功! API Key: {api_key}")
            print(json.dumps({"success": True, "key": api_key, "email": email, "balance": balance}))
        else:
            raise RuntimeError("未获取到 API Key")

    except Exception as e:
        log.error(f"流程失败: {e}")
        print(json.dumps({"success": False, "error": str(e), "email": email}))
        sys.exit(1)
    finally:
        browser.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", default="")
    parser.add_argument("--email-source", default="mailcom", choices=["mailcom", "outlook"])
    parser.add_argument("--outlook-client-id", default="")
    parser.add_argument("--outlook-refresh-token", default="")
    parser.add_argument("--card-number", required=True)
    parser.add_argument("--card-expiry", required=True)
    parser.add_argument("--card-cvv", required=True)
    parser.add_argument("--proxy", required=True)
    parser.add_argument("--address", default="")
    parser.add_argument("--amount", type=float, default=5)
    parser.add_argument("--master-url", default="http://localhost:3203")
    parser.add_argument("--master-api-key", default="ab123168")
    run(parser.parse_args())
