"""
Test Antigravity Google OAuth flow via Playwright (headful Chromium).
Runs standalone - no camoufox needed, no project imports needed.

Usage:
    python scripts/auth/test_antigravity_oauth.py audijemi37@daoseed.com cloudin123
"""

import asyncio
import base64
import hashlib
import secrets
import sys
from urllib.parse import parse_qs, quote, urlparse

from playwright.async_api import async_playwright

#  Same constants as antigravity.py

CLIENT_ID = "ANTIGRAVITY_CLIENT_ID_PLACEHOLDER"
SCOPES = " ".join(
    [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ]
)
REDIRECT_URI = "http://localhost:1930/oauth-callback"
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
SCREENSHOTS_DIR = "scripts/auth/oauth_debug_screenshots"


def generate_pkce():
    verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def build_auth_url(verifier, challenge):
    state = base64.urlsafe_b64encode(verifier.encode()).decode().rstrip("=")
    return (
        f"{GOOGLE_AUTH_URL}?"
        f"response_type=code&"
        f"client_id={CLIENT_ID}&"
        f"redirect_uri={quote(REDIRECT_URI, safe='')}&"
        f"scope={quote(SCOPES, safe='')}&"
        f"state={state}&"
        f"code_challenge={challenge}&"
        f"code_challenge_method=S256&"
        f"access_type=offline&"
        f"prompt=consent"
    )


async def screenshot(page, name, label):
    import os

    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
    path = f"{SCREENSHOTS_DIR}/{name}.png"
    await page.screenshot(path=path, full_page=True)
    print(f"  [screenshot] [{label}] -> {path}")
    print(f"     URL: {page.url[:120]}")


async def test_oauth(email: str, password: str):
    verifier, challenge = generate_pkce()
    auth_url = build_auth_url(verifier, challenge)

    print(f"\n{'=' * 60}")
    print(f"Testing Google OAuth for: {email}")
    print(f"Redirect URI: {REDIRECT_URI}")
    print(f"Auth URL built: {auth_url[:100]}...")
    print(f"{'=' * 60}\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,  # Visible window
            slow_mo=300,
        )
        ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
        page = await ctx.new_page()
        page.set_default_timeout(15000)

        #  Step 1: Navigate to auth URL
        print("Step 1: Navigating to Google OAuth URL...")
        await page.goto(auth_url, wait_until="domcontentloaded", timeout=20000)
        await asyncio.sleep(2)
        await screenshot(page, "01_initial", "initial load")

        #  Step 2: Check what page we landed on
        url = page.url
        print(f"\nStep 2: Current URL after load:")
        print(f"  {url}")

        if "accounts.google.com" not in url:
            print(f"    NOT on Google accounts page! Something went wrong.")
            content = await page.content()
            print(f"  Page content (first 1000 chars):\n{content[:1000]}")
            await browser.close()
            return

        #  Step 3: Fill email
        print(f"\nStep 3: Looking for email input...")
        email_sel = None
        for sel in ["#identifierId", 'input[name="identifier"]', 'input[type="email"]']:
            try:
                el = await page.wait_for_selector(sel, state="visible", timeout=3000)
                if el:
                    email_sel = sel
                    print(f"   Found email input: {sel}")
                    break
            except:
                print(f"   Not found: {sel}")

        if not email_sel:
            print("   No email input found!")
            await screenshot(page, "03_no_email_input", "no email input")
            content = await page.content()
            # Show first 2000 chars and all input elements
            inputs = await page.query_selector_all("input")
            print(f"  All inputs on page: {len(inputs)}")
            for inp in inputs:
                itype = await inp.get_attribute("type")
                iname = await inp.get_attribute("name")
                iid = await inp.get_attribute("id")
                print(f"    input type={itype} name={iname} id={iid}")
            await browser.close()
            return

        # Fill and submit email
        await page.fill(email_sel, email)
        await asyncio.sleep(0.5)
        await screenshot(page, "03_email_filled", "email filled")
        print(f"  Filled email: {email}")

        # Click Next
        next_clicked = False
        for next_sel in [
            "#identifierNext button",
            "#identifierNext",
            'button:has-text("Next")',
            'button:has-text("Berikutnya")',
            'div[id="identifierNext"]',
        ]:
            try:
                btn = await page.query_selector(next_sel)
                if btn:
                    await btn.click()
                    next_clicked = True
                    print(f"   Clicked Next: {next_sel}")
                    break
            except:
                pass

        if not next_clicked:
            await page.keyboard.press("Enter")
            print(f"  Pressed Enter (no Next button found)")

        await asyncio.sleep(3)
        await screenshot(page, "04_after_email_next", "after email next")
        print(f"  URL after email next: {page.url[:120]}")

        # Check for errors after email
        error_el = await page.query_selector(
            '[aria-live="assertive"], .o6cuMc, .dEOOab, [data-error="true"]'
        )
        if error_el:
            error_text = await error_el.text_content()
            print(f"    Error after email: {error_text}")

        #  Step 4: Fill password
        print(f"\nStep 4: Looking for password input...")
        pwd_sel = None
        for sel in [
            'input[name="Passwd"]',
            'input[type="password"]',
            "#password input",
        ]:
            try:
                el = await page.wait_for_selector(sel, state="visible", timeout=5000)
                if el:
                    pwd_sel = sel
                    print(f"   Found password input: {sel}")
                    break
            except:
                print(f"   Not found: {sel}")

        if not pwd_sel:
            print("   No password input found!")
            await screenshot(page, "04_no_password", "no password input")
            # Show all inputs
            inputs = await page.query_selector_all("input")
            print(f"  All inputs on page: {len(inputs)}")
            for inp in inputs:
                itype = await inp.get_attribute("type")
                iname = await inp.get_attribute("name")
                iid = await inp.get_attribute("id")
                visible = await inp.is_visible()
                print(f"    input type={itype} name={iname} id={iid} visible={visible}")
            # Check for challenge page
            url = page.url
            if "/challenge/" in url:
                print(f"\n    CHALLENGE PAGE DETECTED: {url}")
                print(f"  This account may require 2FA or phone verification")
            await browser.close()
            return

        # Fill and submit password
        await page.fill(pwd_sel, password)
        await asyncio.sleep(0.5)
        await screenshot(page, "05_password_filled", "password filled")
        print(f"  Filled password: {'*' * len(password)}")

        # Click Next/Sign in
        signed_in = False
        for next_sel in [
            "#passwordNext button",
            "#passwordNext",
            'button:has-text("Next")',
            'button:has-text("Sign in")',
            'button:has-text("Berikutnya")',
            'button:has-text("Masuk")',
        ]:
            try:
                btn = await page.query_selector(next_sel)
                if btn:
                    await btn.click()
                    signed_in = True
                    print(f"   Clicked: {next_sel}")
                    break
            except:
                pass

        if not signed_in:
            await page.keyboard.press("Enter")
            print(f"  Pressed Enter (no button found)")

        await asyncio.sleep(3)
        await screenshot(page, "06_after_password_next", "after password next")
        print(f"  URL after password: {page.url[:120]}")

        #  Step 5: Wait for redirect/consent
        print(f"\nStep 5: Waiting for OAuth redirect or consent page...")
        for i in range(30):
            await asyncio.sleep(1)
            url = page.url
            print(f"  Tick {i + 1:2d}: {url[:100]}")

            # Success: callback received
            if "localhost:1930" in url and "code=" in url:
                qs = parse_qs(urlparse(url).query)
                code = qs.get("code", [None])[0]
                print(f"\n{'=' * 60}")
                print(f" SUCCESS! OAuth callback received")
                print(f"   Code: {(code or '')[:40]}...")
                print(f"{'=' * 60}")
                await screenshot(page, "07_success_callback", "success callback")
                await browser.close()
                return

            # Check backend for code (backend may have already captured it)
            import urllib.request

            try:
                state_b64 = (
                    base64.urlsafe_b64encode(verifier.encode()).decode().rstrip("=")
                )
                poll_url = (
                    f"http://localhost:1930/api/oauth-callback/poll?state={state_b64}"
                )
                with urllib.request.urlopen(poll_url, timeout=2) as resp:
                    import json

                    data = json.loads(resp.read())
                    if data.get("code"):
                        print(f"\n{'=' * 60}")
                        print(f" SUCCESS! Code captured by backend poll")
                        print(f"   Code: {data['code'][:40]}...")
                        print(f"{'=' * 60}")
                        await screenshot(page, "07_success_polled", "success polled")
                        await browser.close()
                        return
            except:
                pass

            # Consent page
            if "accounts.google.com" in url and (
                "/consent" in url or "/signin/oauth" in url or "/firstparty" in url
            ):
                print(f"   Consent page - clicking Allow/Login...")
                try:
                    clicked = await page.evaluate("""() => {
                        const ALLOW = ['allow','continue','lanjutkan','izinkan','login','sign in','masuk','authorize','grant'];
                        const DENY = ['batal','cancel','deny','back','kembali'];
                        for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                            const txt = (btn.textContent || btn.value || '').trim().toLowerCase();
                            if (!txt || btn.offsetParent === null) continue;
                            if (DENY.some(d => txt === d || txt.startsWith(d))) continue;
                            if (ALLOW.some(a => txt === a || txt.includes(a))) {
                                btn.click(); return txt;
                            }
                        }
                        return null;
                    }""")
                    if clicked:
                        print(f"    Clicked consent button: '{clicked}'")
                        await asyncio.sleep(3)
                        await screenshot(
                            page, f"06b_after_consent_{i}", "after consent"
                        )
                    else:
                        print(f"    No consent button matched, all visible buttons:")
                        btns = await page.query_selector_all("button")
                        for btn in btns[:10]:
                            txt = await btn.text_content()
                            vis = await btn.is_visible()
                            print(
                                f"      button: '{(txt or '').strip()[:40]}' visible={vis}"
                            )
                except Exception as e:
                    print(f"    Consent handling error: {e}")
                continue

            # Challenge page
            if "accounts.google.com" in url and "/challenge/" in url:
                print(f"\n    CHALLENGE PAGE: {url}")
                await screenshot(page, f"challenge_{i}", "challenge page")
                print(f"  This account requires additional verification (2FA/phone)")
                print(f"  Challenge type: {url.split('/challenge/')[-1][:50]}")
                await asyncio.sleep(5)  # Wait a bit to see it
                break

        print(f"\n TIMEOUT - No callback received after 30 seconds")
        await screenshot(page, "08_timeout", "timeout")
        print(f"  Final URL: {page.url}")
        await browser.close()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python scripts/auth/test_antigravity_oauth.py <email> <password>")
        print(
            "Example: python scripts/auth/test_antigravity_oauth.py user@gmail.com mypass123"
        )
        sys.exit(1)

    asyncio.run(test_oauth(sys.argv[1], sys.argv[2]))
