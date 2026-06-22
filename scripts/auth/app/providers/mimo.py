from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import ssl
import time
from typing import Any
from urllib.parse import urlparse

import aiohttp

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

MIMO_CONSOLE_URL = "https://platform.xiaomimimo.com/console/api-keys"
MIMO_BASE_URL = "https://platform.xiaomimimo.com"
MIMO_BASE_URL_REF = "https://platform.xiaomimimo.com?ref=M8C7QK"  # referral link for new accounts ($2 credits)
MIMO_REFERRAL_CODE = os.environ.get("MIMO_REFERRAL_CODE", "M8C7QK")
MIMO_API_URL = "https://api.xiaomimimo.com/v1"

_XIAOMI_REG_PASSWORD = "MiMo@Pool2026!"


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_MIMO_DEBUG", "false").lower() == "true":
        print(f"[mimo-auth] {msg}", flush=True)


# ── Google OAuth helpers ────────────────────────────────────────────────────


async def _wait_for_google_email_transition(target: Any) -> bool:
    try:
        await target.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const visible = (sels) => sels.some(s => Array.from(document.querySelectorAll(s)).some(e => e.offsetParent !== null));
                const hasEmail = visible(['#identifierId', 'input[name="identifier"]', 'input[type="email"]']);
                const hasPassword = visible(['input[name="Passwd"]', 'input[type="password"]']);
                if (!host.includes('accounts.google.com')) return true;
                if (hasPassword) return true;
                return !hasEmail;
            }""",
            timeout=10000,
        )
        return True
    except Exception:
        return False


async def _wait_for_google_password_transition(target: Any) -> bool:
    try:
        await target.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const hasPassword = Array.from(document.querySelectorAll('input[name="Passwd"], input[type="password"]')).some(e => e.offsetParent !== null);
                if (!host.includes('accounts.google.com')) return true;
                if (!path.includes('/challenge/pwd')) return true;
                return !hasPassword;
            }""",
            timeout=12000,
        )
        return True
    except Exception:
        return False


async def _is_email_step(page: Any) -> bool:
    try:
        return bool(
            await page.evaluate("""() => {
            for (const el of document.querySelectorAll('#identifierId, input[type="email"], input[name="identifier"]')) {
                if (el.offsetParent !== null) return true;
            }
            return false;
        }""")
        )
    except Exception:
        return False


async def _is_password_step(page: Any) -> bool:
    try:
        return bool(
            await page.evaluate("""() => {
            for (const el of document.querySelectorAll('input[name="Passwd"], input[type="password"]')) {
                if (el.offsetParent !== null) return true;
            }
            return false;
        }""")
        )
    except Exception:
        return False


async def _click_google_next(page: Any) -> bool:
    try:
        return bool(
            await page.evaluate("""() => {
            const btn = document.querySelector('#identifierNext button, #passwordNext button');
            if (btn && btn.offsetParent !== null) { btn.click(); return true; }
            for (const el of document.querySelectorAll('div.VfPpkd-RLmnJb, button, div[role="button"]')) {
                const p = el.closest('button, div[role="button"]') || el;
                if (p && p.offsetParent !== null) { p.click(); return true; }
            }
            return false;
        }""")
        )
    except Exception:
        return False


async def _fill_google_email(page: Any, email: str) -> bool:
    for sel in ["#identifierId", 'input[name="identifier"]', 'input[type="email"]']:
        try:
            await page.wait_for_selector(sel, state="visible", timeout=2000)
            break
        except Exception:
            pass
    loc = page.locator("#identifierId").first
    if await loc.count() == 0:
        loc = page.locator('input[name="identifier"]').first
    try:
        if await loc.count() == 0 or not await loc.is_visible():
            return False
        await loc.scroll_into_view_if_needed()
        await loc.click(force=True)
        await asyncio.sleep(0.2)
        await loc.press("Control+a")
        await loc.press("Backspace")
        await loc.press_sequentially(email, delay=60)
        await asyncio.sleep(0.5)
        val = await loc.input_value()
        if email.lower() != str(val).lower().strip():
            return False
        if not await _click_google_next(page):
            await loc.press("Enter")
        await _wait_for_google_email_transition(page)
        await asyncio.sleep(1.5)  # extra buffer for Google SPA to unmount #identifierId
        return True
    except Exception:
        return False


async def _fill_google_password(page: Any, password: str) -> bool:
    for selector in ['input[name="Passwd"]', 'input[type="password"]']:
        try:
            await page.wait_for_selector(selector, state="visible", timeout=3000)
        except Exception:
            pass
        loc = page.locator(selector).first
        try:
            if await loc.count() == 0 or not await loc.is_visible():
                continue
            await loc.scroll_into_view_if_needed()
            await loc.click(force=True)
            await asyncio.sleep(0.2)
            await loc.press("Control+a")
            await loc.press("Backspace")
            await loc.press_sequentially(password, delay=70)
            await asyncio.sleep(0.5)
            if not await _click_google_next(page):
                await loc.press("Enter")
            await _wait_for_google_password_transition(page)
            return True
        except Exception:
            continue
    return False


async def _handle_gaplustos(page: Any) -> bool:
    try:
        url = page.url
    except Exception:
        return False
    if "/speedbump/gaplustos" not in url:
        return False
    try:
        await page.wait_for_selector(
            '#confirm, input[name="confirm"], input[type="submit"]',
            state="visible",
            timeout=5000,
        )
    except Exception:
        pass
    for sel in [
        "#confirm",
        'input[name="confirm"]',
        'input[type="submit"]',
    ]:
        loc = page.locator(sel).first
        try:
            if await loc.count() > 0 and await loc.is_visible():
                await loc.click(force=True)
                return True
        except Exception:
            continue
    try:
        return bool(
            await page.evaluate("""() => {
            for (const el of document.querySelectorAll('input[type="submit"], button')) {
                if (!el || el.offsetParent === null) continue;
                const txt = (el.value || el.textContent || '').toLowerCase();
                if (txt.includes('agree') || txt.includes('understand') || txt.includes('confirm') || txt.includes('mengerti')) {
                    el.click(); return true;
                }
            }
            return false;
        }""")
        )
    except Exception:
        return False


async def _handle_consent(page: Any) -> bool:
    try:
        url = page.url
    except Exception:
        return False
    if "accounts.google.com" not in url:
        return False
    if "/signin/oauth" not in url and "/consent" not in url:
        return False
    try:
        clicked = await page.evaluate("""() => {
            for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                const txt = (btn.textContent || '').trim().toLowerCase();
                if (!txt || btn.offsetParent === null) continue;
                if (txt === 'continue' || txt.includes('allow') || txt.includes('lanjut')) {
                    btn.click(); return true;
                }
            }
            const submits = document.querySelectorAll('input[type="submit"], button[type="submit"]');
            for (const btn of submits) {
                if (btn.offsetParent !== null) { btn.click(); return true; }
            }
            return false;
        }""")
        if clicked:
            await asyncio.sleep(2)
        return bool(clicked)
    except Exception:
        return False


async def _is_xiaomi_registration_page(page: Any) -> bool:
    """True when we are on the Xiaomi set-password / register page post-Google-OAuth."""
    try:
        url = page.url
    except Exception:
        return False
    if "xiaomi.com" not in url:
        return False
    path = urlparse(url).path.lower()
    return any(p in path for p in ("/register", "/set-password", "/setpassword"))


async def _handle_xiaomi_registration(page: Any) -> bool:
    """Fill and submit the Xiaomi new-account password form."""
    try:
        try:
            await page.wait_for_selector(
                'input[type="password"]', state="visible", timeout=5000
            )
        except Exception:
            pass

        filled = await page.evaluate(
            """(pwd) => {
            const inputs = Array.from(document.querySelectorAll('input[type="password"]'))
                .filter(el => el.offsetParent !== null);
            if (inputs.length === 0) return false;
            inputs.forEach(el => {
                el.focus();
                el.value = pwd;
                el.dispatchEvent(new Event('input', {bubbles: true}));
                el.dispatchEvent(new Event('change', {bubbles: true}));
            });
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (!cb.checked && cb.offsetParent !== null) cb.click();
            });
            return true;
        }""",
            _XIAOMI_REG_PASSWORD,
        )
        if not filled:
            return False

        await asyncio.sleep(0.5)

        clicked = await page.evaluate("""() => {
            const keywords = ['complete', 'submit', 'confirm', 'finish', 'next', 'done'];
            for (const btn of document.querySelectorAll('button, input[type="submit"]')) {
                if (btn.offsetParent === null) continue;
                const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
                if (keywords.some(k => txt.includes(k))) { btn.click(); return true; }
            }
            const fallback = document.querySelector('button[type="submit"], input[type="submit"]');
            if (fallback && fallback.offsetParent !== null) { fallback.click(); return true; }
            return false;
        }""")
        return bool(clicked)
    except Exception:
        return False


async def _dismiss_overlays(page: Any) -> None:
    """Best-effort dismissal of cookie banners and modals before page interaction."""
    try:
        await page.evaluate("""() => {
            for (const el of document.querySelectorAll(
                '[class*="close"], [aria-label*="close" i], [aria-label*="dismiss" i], ' +
                'button[class*="cookie"], button[class*="modal"]'
            )) {
                if (el.offsetParent !== null) { el.click(); return; }
            }
            const closeKw = ['close', 'dismiss', 'accept', 'ok', 'got it', 'agree', 'allow all'];
            for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                if (btn.offsetParent === null) continue;
                const txt = (btn.textContent || '').toLowerCase().trim();
                if (closeKw.some(k => txt === k)) { btn.click(); return; }
            }
        }""")
    except Exception:
        pass


async def _click_continue(page: Any) -> None:
    try:
        await page.evaluate("""() => {
            const kw = ['next','continue','accept','i understand','agree','ok','got it','login','sign in'];
            for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
                if (txt && kw.some(k => txt.includes(k)) && btn.offsetParent !== null) { btn.click(); return; }
            }
        }""")
    except Exception:
        pass


# ── Main adapter ───────────────────────────────────────────────────────────


class MimoAdapter(ProviderAdapter):
    name = "mimo"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = raw_line.strip().split(":", 1)
        if len(parts) < 2:
            parts = raw_line.strip().split("|", 1)
        if len(parts) < 2:
            raise NonRetryableBatcherError(
                ErrorCode.invalid_credentials,
                "expected email:password or email|password",
            )
        return NormalizedAccount(
            provider=self.name, identifier=parts[0].strip(), secret=parts[1].strip()
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            return {"stub": True}

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox

            # Firefox prefs for OAuth redirect chains + reduced bot detection
            _MIMO_FF_PREFS = {
                "browser.tabs.remote.useCrossOriginOpenerPolicy": False,
                "browser.tabs.remote.useCrossOriginEmbedderPolicy": False,
                "fission.autostart": False,
                "fission.webContentIsolationStrategy": 0,
                "toolkit.crashreporter.enabled": False,
                "browser.sessionstore.resume_from_crash": False,
                "browser.tabs.crashReporting.sendReport": False,
                "javascript.options.mem.gc_allocation_threshold_mb": 512,
                "javascript.options.mem.high_water_mark": 128,
                "app.update.enabled": False,
                "browser.safebrowsing.enabled": False,
                "browser.safebrowsing.malware.enabled": False,
                "network.http.connection-timeout": 60,
                "network.http.response.timeout": 120,
                "dom.ipc.processHangMonitor": False,
            }
            import random as _random

            _os_choices = ["windows", "windows", "windows", "macos", "linux"]
            _chosen_os = _random.choice(_os_choices)
            camoufox_kwargs: dict[str, Any] = {
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower()
                == "true",
                "os": _chosen_os,
                "block_webrtc": True,
                "humanize": False,
                "screen": Screen(max_width=1920, max_height=1080),
                "firefox_user_prefs": _MIMO_FF_PREFS,
                "disable_coop": True,
                "i_know_what_im_doing": True,
            }
            proxy_url = os.getenv("BATCHER_PROXY_URL", "")
            if proxy_url:
                parsed = urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {
                    "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
                }
                if parsed.username:
                    proxy_cfg["username"] = parsed.username
                if parsed.password:
                    proxy_cfg["password"] = parsed.password
                camoufox_kwargs["proxy"] = proxy_cfg
                camoufox_kwargs["geoip"] = True

            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(30000)

            await page.goto(
                MIMO_BASE_URL_REF, wait_until="domcontentloaded", timeout=20000
            )
            await asyncio.sleep(3)

            # Handle redirect: platform.xiaomimimo.com may redirect to account.xiaomi.com login page
            # Wait for page to settle after redirect
            for _ in range(10):
                current_url = page.url
                if "xiaomi.com" in current_url or "xiaomimimo.com" in current_url:
                    break
                await asyncio.sleep(1)

            current_url = page.url
            _debug(f"after goto, current url: {current_url}")

            # Wait for React to finish rendering — page is a React SPA, domcontentloaded
            # fires before React mounts. Wait for networkidle or a known element.
            try:
                await page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass
            await asyncio.sleep(1)

            # Wait explicitly for the Google button to appear in DOM
            _google_selectors = [
                'a[href*="google"]',
                'a:has-text("Sign in with Google")',
                'button:has-text("Google")',
                'li:has-text("Sign in with Google")',
                'span:has-text("Sign in with Google")',
            ]
            for _sel in _google_selectors:
                try:
                    await page.wait_for_selector(_sel, state="visible", timeout=5000)
                    _debug(f"Google button found via selector: {_sel}")
                    break
                except Exception:
                    pass

            # Click "Sign in with Google" button - works on both xiaomi.com and xiaomimimo.com
            google_clicked = False
            for attempt in range(8):
                try:
                    # Method 1: JS dispatchEvent — bypasses pointer-event interceptors and force-click timeouts
                    clicked = await page.evaluate("""() => {
                        const btns = Array.from(document.querySelectorAll('a, button, div[role="button"], li, span'));
                        const btn = btns.find(b =>
                            b.offsetParent !== null &&
                            (b.textContent || '').trim().toLowerCase().includes('sign in with google')
                        );
                        if (btn) {
                            btn.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
                            return 'dispatch:' + btn.tagName;
                        }
                        const btn2 = btns.find(b =>
                            b.offsetParent !== null &&
                            (b.textContent || '').toLowerCase().includes('google')
                        );
                        if (btn2) {
                            btn2.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
                            return 'dispatch-fallback:' + btn2.tagName;
                        }
                        return null;
                    }""")
                    if clicked:
                        google_clicked = True
                        _debug(
                            f"JS dispatchEvent-clicked Google button: {clicked} (attempt {attempt + 1})"
                        )
                        break

                    # Method 2: dispatch_event via Playwright locator (no timeout, no actionability check)
                    for _loc_sel in [
                        'a:has-text("Sign in with Google")',
                        'li:has-text("Sign in with Google")',
                        'button:has-text("Google")',
                        'a[href*="google"]',
                    ]:
                        loc = page.locator(_loc_sel).first
                        if await loc.count() > 0:
                            try:
                                await loc.dispatch_event("click")
                                google_clicked = True
                                _debug(
                                    f"dispatch_event-clicked Google via '{_loc_sel}' (attempt {attempt + 1})"
                                )
                                break
                            except Exception as _de:
                                _debug(f"dispatch_event failed for '{_loc_sel}': {_de}")
                    if google_clicked:
                        break
                except Exception as e:
                    _debug(f"Google button attempt {attempt + 1} failed: {e}")
                await asyncio.sleep(1.5)

            if not google_clicked:
                raise RetryableBatcherError(
                    ErrorCode.auth_temporary_failure,
                    "Could not find/click Sign in with Google button",
                )

            await asyncio.sleep(2)
            return {"manager": manager, "browser": browser, "page": page}

        except (RetryableBatcherError, NonRetryableBatcherError):
            raise
        except Exception as e:
            raise RetryableBatcherError(
                ErrorCode.auth_temporary_failure,
                f"bootstrap failed: {e}",
            )

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session and session.get("stub"):
            return {"authenticated": True, "stub": True}

        page = session.get("page")
        if page is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "no page in session"
            )

        email_deadline = 0.0
        pw_deadline = 0.0
        xiaomi_reg_done = False
        _blank_ticks = 0
        _last_url = ""
        _stuck_ticks = 0
        _pw_filled = (
            False  # True after password submitted; prevents re-firing fill on same page
        )

        # Capture SetSID URL with params at network level BEFORE redirect chain strips them.
        # page.url shows the URL AFTER redirect (params already consumed), so we intercept
        # the request event which fires before the browser follows the redirect.
        _setsid_captured: list[str] = []

        def _capture_setsid(request: Any) -> None:
            req_url = request.url
            if "SetSID" in req_url and (
                "continue=" in req_url or "es=" in req_url or "ssdc=" in req_url
            ):
                _setsid_captured.append(req_url)
                _debug(f"[net] captured SetSID with params: {req_url[:150]}")

        page.on("request", _capture_setsid)

        for _ in range(90):
            # Let the page settle before reading its state
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=3000)
            except Exception:
                pass

            try:
                url = page.url
            except Exception:
                raise RetryableBatcherError(
                    ErrorCode.browser_unexpected_state, "page lost"
                )

            # Track stuck/blank pages and recover by reload after 4 consecutive ticks
            if url == "about:blank" or url == "":
                _blank_ticks += 1
                _stuck_ticks = 0
                _debug(f"blank page tick {_blank_ticks}")
                if _blank_ticks >= 4:
                    _debug("blank page stuck 4 ticks, reloading...")
                    try:
                        await page.reload(wait_until="domcontentloaded", timeout=10000)
                    except Exception:
                        pass
                    _blank_ticks = 0
                await asyncio.sleep(1.5)
                continue
            else:
                _blank_ticks = 0

            # Track URL-stuck state (same URL for too many ticks on a non-terminal page)
            if url == _last_url:
                _stuck_ticks += 1
            else:
                _stuck_ticks = 0
            _last_url = url

            host = urlparse(url).netloc
            path = urlparse(url).path
            _debug(f"loop tick: host={host} path={path} stuck={_stuck_ticks}")

            # Reset _pw_filled once we've left accounts.google.com
            if _pw_filled and "accounts.google.com" not in host:
                _debug("left accounts.google.com — resetting _pw_filled")
                _pw_filled = False

            # Success: landed on platform.xiaomimimo.com and NOT on login/auth/sts page
            if (
                "xiaomimimo.com" in host
                and "code=" not in url
                and "/login" not in path
                and "/auth" not in path
                and "/signin" not in path
                and "/sts" not in path  # /sts is intermediate redirect, not success
            ):
                _debug(f"reached MiMo dashboard: {url}")
                return {"authenticated": True, "landing_url": url}

            if "SetSID" in url or "/accounts/set" in url.lower():
                _debug(f"Google SetSID cookie setter, extracting continue URL: {url}")
                parsed_setsid = urlparse(url)
                from urllib.parse import parse_qs, unquote

                qs = parse_qs(parsed_setsid.query)
                continue_url = qs.get("continue", [None])[0]

                # If page.url has no params, try the network-intercepted URL
                # (page.url is read AFTER redirect chain strips params)
                if not continue_url and _setsid_captured:
                    _full_setsid = _setsid_captured[-1]
                    _qs2 = parse_qs(urlparse(_full_setsid).query)
                    continue_url = _qs2.get("continue", [None])[0]
                    if continue_url:
                        _debug(
                            f"SetSID: using network-captured continue URL: {continue_url[:80]}"
                        )

                # Also check meta-refresh on the page
                if not continue_url:
                    try:
                        continue_url = await page.evaluate("""() => {
                            const m = document.querySelector('meta[http-equiv="refresh"]');
                            if (m) { const u = (m.getAttribute('content') || '').match(/url=(.*)/i); return u ? u[1] : null; }
                            return null;
                        }""")
                        if continue_url:
                            _debug(
                                f"SetSID: meta-refresh continue URL: {continue_url[:80]}"
                            )
                    except Exception:
                        pass

                if continue_url and continue_url.startswith("https://"):
                    _debug(f"SetSID: navigating to continue URL: {continue_url[:80]}")
                    try:
                        await page.goto(
                            continue_url, wait_until="domcontentloaded", timeout=20000
                        )
                    except Exception as e:
                        _debug(f"SetSID goto continue error: {e}")
                else:
                    # No continue URL anywhere — wait for auto JS redirect (max 10s)
                    _debug(
                        "SetSID: no continue URL found, waiting for auto JS redirect"
                    )
                    try:
                        await page.wait_for_load_state("networkidle", timeout=5000)
                    except Exception:
                        pass
                    for _setsid_wait in range(5):
                        await asyncio.sleep(1)
                        try:
                            _cur_url = page.url
                        except Exception:
                            break
                        if (
                            "SetSID" not in _cur_url
                            and "/accounts/set" not in _cur_url.lower()
                        ):
                            _debug(
                                f"SetSID redirected after {_setsid_wait + 1}s to: {_cur_url[:80]}"
                            )
                            break
                    else:
                        _debug("SetSID still stuck after 5s")
                continue

            if await _handle_gaplustos(page):
                _debug("accepted Google TOS")
                await asyncio.sleep(0.8)
                continue

            if await _handle_consent(page):
                _debug("accepted OAuth consent")
                await asyncio.sleep(0.8)
                continue

            # But first: skip STS/sns callback pages — these are intermediate redirects,
            # not login pages. Let them resolve automatically.
            if "xiaomi.com" in host and (
                "/pass/sns" in path or (path.endswith("/sts") or "/sts/" in path)
            ):
                _debug(f"Xiaomi STS callback, waiting for redirect: {url}")
                await asyncio.sleep(2)
                continue

            # Handle Xiaomi global SNS email confirmation page (new account linking)
            # Page: "Create a Xiaomi Account" — must check TOS checkbox first, then click Next
            if "xiaomi.com" in host and "/sns/login/email" in path:
                _debug(
                    f"Xiaomi SNS email confirmation page, trying to confirm: {url[:80]}"
                )
                try:
                    confirmed = await page.evaluate("""() => {
                        // Step 1: Check the TOS checkbox if not already checked
                        const checkboxes = Array.from(document.querySelectorAll(
                            'input[type="checkbox"], .ant-checkbox-input, .mi-checkbox input, [role="checkbox"]'
                        ));
                        for (const cb of checkboxes) {
                            if (!cb.checked) {
                                cb.click();
                            }
                        }
                        // Also try clicking the checkbox wrapper (Ant Design uses wrapper div)
                        const cbWrappers = Array.from(document.querySelectorAll(
                            '.ant-checkbox, .mi-checkbox, [class*="checkbox"]'
                        ));
                        for (const w of cbWrappers) {
                            const inner = w.querySelector('input');
                            if (inner && !inner.checked) {
                                w.click();
                            }
                        }
                        return 'checkbox-checked';
                    }""")
                    _debug(f"SNS email page: {confirmed}")
                    await asyncio.sleep(0.5)  # Let React update disabled state

                    # Step 2: Click Next button
                    clicked = await page.evaluate("""() => {
                        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                        // Find Next button (not disabled)
                        const btn = btns.find(b =>
                            b.offsetParent !== null &&
                            !b.disabled &&
                            /next|lanjut|continue|submit/i.test((b.textContent || b.value || '').trim())
                        );
                        if (btn) { btn.click(); return 'clicked:' + (btn.textContent || '').trim().substring(0, 20); }
                        // Fallback: click any visible non-disabled button
                        const anyBtn = btns.find(b => b.offsetParent !== null && !b.disabled);
                        if (anyBtn) { anyBtn.click(); return 'fallback:' + (anyBtn.textContent || '').trim().substring(0, 20); }
                        return null;
                    }""")
                    if clicked:
                        _debug(f"SNS email page: next clicked: {clicked}")
                    else:
                        _debug(
                            "SNS email page: Next button not found or still disabled"
                        )
                except Exception as _e:
                    _debug(f"SNS email page handler error: {_e}")
                await asyncio.sleep(2)
                continue

            # Handle Xiaomi "Create Account - Set Password" page
            if "xiaomi.com" in host and "/set-password" in path:
                _debug(f"Xiaomi set-password page, filling password: {url[:80]}")
                try:
                    filled = await page.evaluate(
                        """(pw) => {
                        const inputs = Array.from(document.querySelectorAll('input[type="password"], input[type="text"]'));
                        const pwInputs = inputs.filter(i => i.offsetParent !== null);
                        if (pwInputs.length === 0) return 'no-inputs';
                        // Fill first password field
                        const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        nativeInputSetter.call(pwInputs[0], pw);
                        pwInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                        pwInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
                        // Fill confirm field if present
                        if (pwInputs.length > 1) {
                            nativeInputSetter.call(pwInputs[1], pw);
                            pwInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
                            pwInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        return 'filled:' + pwInputs.length;
                    }""",
                        _XIAOMI_REG_PASSWORD,
                    )
                    _debug(f"set-password: {filled}")
                    await asyncio.sleep(0.8)

                    # Click Complete/Submit button
                    clicked = await page.evaluate("""() => {
                        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                        const btn = btns.find(b =>
                            b.offsetParent !== null && !b.disabled &&
                            /complete|submit|next|confirm|done|lanjut/i.test((b.textContent || b.value || '').trim())
                        );
                        if (btn) { btn.click(); return 'clicked:' + (btn.textContent || '').trim().substring(0, 20); }
                        // Fallback: any non-disabled visible button
                        const anyBtn = btns.find(b => b.offsetParent !== null && !b.disabled);
                        if (anyBtn) { anyBtn.click(); return 'fallback:' + (anyBtn.textContent || '').trim().substring(0, 20); }
                        return null;
                    }""")
                    if clicked:
                        _debug(f"set-password: clicked {clicked}")
                    else:
                        _debug("set-password: no button found")
                except Exception as _e:
                    _debug(f"set-password handler error: {_e}")
                await asyncio.sleep(2)
                continue

            if "xiaomi.com" in host:
                try:
                    google_clicked = await page.evaluate("""() => {
                        const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                        const btn = btns.find(b => b.textContent && b.textContent.toLowerCase().includes('google') && b.offsetParent !== null);
                        if (btn) { btn.click(); return true; }
                        return false;
                    }""")
                    if google_clicked:
                        _debug("clicked Google button on Xiaomi login page")
                        await asyncio.sleep(2.0)
                        continue
                except Exception as e:
                    _debug(f"Xiaomi Google button error: {e}")
                await asyncio.sleep(1.0)
                continue

            # Handle blank page — just wait
            if url == "about:blank":
                _debug(f"blank page detected, waiting...")
                await asyncio.sleep(1.5)
                continue

            # /sts? is part of valid redirect chain (xiaomi→platform) — do NOT navigate away, just wait
            if "/sts?" in url:
                _debug(
                    f"platform STS intermediate redirect, waiting for auto-resolve: {url}"
                )
                await asyncio.sleep(2)
                continue

            if "accounts.google.com" in host:
                # Bug 3: Handle Google account chooser page
                if "accountchooser" in url:
                    _debug(
                        "Google account chooser detected, clicking 'Use another account'"
                    )
                    try:
                        await page.evaluate("""() => {
                            const btn = document.querySelector('[data-identifier="use_another_account"], [jsname="rwl3qc"]');
                            if (btn && btn.offsetParent !== null) { btn.click(); return true; }
                            for (const el of document.querySelectorAll('li, div[role="link"], div[role="option"]')) {
                                const txt = (el.textContent || '').toLowerCase();
                                if (txt.includes('use another') || txt.includes('add account')) {
                                    el.click(); return true;
                                }
                            }
                            return false;
                        }""")
                    except Exception as e:
                        _debug(f"account chooser click error: {e}")
                    await asyncio.sleep(1.0)
                    continue

                now = time.monotonic()
                at_pw = await _is_password_step(page)
                at_email = await _is_email_step(page)

                if at_email and not at_pw:
                    if now < email_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_email(page, account.identifier):
                        _debug("entered email")
                        email_deadline = time.monotonic() + 12.0
                        await asyncio.sleep(1.0)
                        continue

                if at_pw:
                    if _pw_filled:
                        # Password already submitted — just wait for browser to redirect away
                        await asyncio.sleep(0.5)
                        continue
                    if now < pw_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_password(page, account.secret):
                        _debug("entered password")
                        _pw_filled = True
                        pw_deadline = time.monotonic() + 8.0
                        # Wait up to 5s for browser to leave accounts.google.com
                        _debug("waiting for browser to leave accounts.google.com...")
                        _left_google = False
                        for _pw_tick in range(5):
                            await asyncio.sleep(1.0)
                            try:
                                _cur = page.url
                            except Exception:
                                break
                            if "accounts.google.com" not in (_cur or ""):
                                _debug(f"left google after {_pw_tick + 1}s: {_cur}")
                                _left_google = True
                                break
                        if not _left_google:
                            _debug("still on google after 5s, continuing loop anyway")
                        continue

                if at_email or at_pw:
                    await asyncio.sleep(0.6)
                    continue

                # CAPTCHA / 2FA / device challenge — fail fast, don't spin
                _challenge_path = path.lower()
                if (
                    "/challenge/" in _challenge_path
                    and "/challenge/pwd" not in _challenge_path
                ):
                    if any(
                        x in _challenge_path
                        for x in ("recaptcha", "ipp", "totp", "dk", "sk")
                    ):
                        _debug(f"Google CAPTCHA/challenge detected: {path}")
                        raise RetryableBatcherError(
                            ErrorCode.auth_temporary_failure,
                            f"Google CAPTCHA/challenge at {path} — skipping account",
                        )
                    else:
                        # Unknown challenge type — wait and continue, may auto-resolve
                        _debug(f"Unknown Google challenge page: {path}, waiting...")
                        await asyncio.sleep(2.0)
                        continue

                # Google speedbump pages (ToS, workspace terms, etc.) — need to accept/click through
                if "/speedbump/" in path:
                    _debug(f"Google speedbump page, trying to accept: {path}")
                    try:
                        accepted = await page.evaluate("""() => {
                            // First try the specific gaplustosNext button (Google Workspace ToS)
                            const specific = document.getElementById('gaplustosNext');
                            if (specific) {
                                const btn = specific.querySelector('button');
                                if (btn && !btn.disabled) { btn.click(); return 'clicked:gaplustosNext'; }
                                // Button might be disabled until scroll — scroll down first
                                window.scrollTo(0, document.body.scrollHeight);
                                const scrollBtn = document.querySelector('[aria-label="Scroll down"], [aria-label*="scroll" i]');
                                if (scrollBtn) { scrollBtn.click(); return 'clicked:scroll-btn'; }
                            }
                            // Find accept/agree/confirm/understand button
                            const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                            // Try non-disabled first
                            const btn = btns.find(b =>
                                b.offsetParent !== null && !b.disabled &&
                                /accept|agree|confirm|continue|next|ok|yes|understand/i.test((b.textContent || b.value || '').trim())
                            );
                            if (btn) { btn.click(); return 'clicked:' + (btn.textContent || '').trim().substring(0, 30); }
                            // Scroll to bottom to unlock disabled buttons
                            window.scrollTo(0, document.body.scrollHeight);
                            const scrollable = document.querySelector('[role="main"], .yTaH4c, .MZArnb');
                            if (scrollable) scrollable.scrollTo(0, scrollable.scrollHeight);
                            return 'scrolled';
                        }""")
                        _debug(f"speedbump step: {accepted}")
                        await asyncio.sleep(1.5)
                        # Try clicking I understand after scroll
                        if accepted in ("scrolled", "clicked:scroll-btn", None):
                            accepted2 = await page.evaluate("""() => {
                                const specific = document.getElementById('gaplustosNext');
                                if (specific) {
                                    const btn = specific.querySelector('button');
                                    if (btn) { btn.click(); return 'clicked:gaplustosNext-after-scroll'; }
                                }
                                const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                                const btn = btns.find(b =>
                                    b.offsetParent !== null &&
                                    /accept|agree|confirm|continue|next|ok|yes|understand/i.test((b.textContent || b.value || '').trim())
                                );
                                if (btn) { btn.click(); return 'clicked:' + (btn.textContent || '').trim().substring(0, 30); }
                                return null;
                            }""")
                            _debug(f"speedbump after-scroll: {accepted2}")
                    except Exception as _spe:
                        _debug(f"speedbump handler error: {_spe}")
                    await asyncio.sleep(2.0)
                    continue

                # Google intermediate page (loading, "verify it's you", 2FA skip,
                # post-password blank screen, etc.) — still on accounts.google.com
                # but not email/pw/chooser. Just wait; loop will re-evaluate next tick.
                _debug(f"Google intermediate/loading page, waiting: path={path}")
                await asyncio.sleep(1.5)
                continue

            # Don't blindly click continue on Google/Xiaomi pages - can break flow
            _debug(f"unhandled state, url={url}")
            if "accounts.google.com" not in host and "xiaomi.com" not in host:
                await _click_continue(page)
            await asyncio.sleep(1.0)

        raise RetryableBatcherError(
            ErrorCode.auth_temporary_failure, "MiMo OAuth flow timed out"
        )

    async def fetch_tokens(
        self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any
    ) -> dict[str, str]:
        page = session.get("page") if session and not session.get("stub") else None
        if page is None:
            raise NonRetryableBatcherError(
                ErrorCode.auth_temporary_failure, "no browser page for keygen"
            )

        key_name = f"{account.identifier.split('@')[0].lower()[:20]}-opencode"

        # Wait for OAuth callback to settle — URL has ?code= while frontend processes auth
        _debug("waiting for OAuth callback to settle...")
        for _ in range(30):
            try:
                url = page.url
                if (
                    "xiaomimimo.com" in url
                    and "code=" not in url
                    and "/login" not in url
                    and "/signin" not in url
                ):
                    _debug(f"callback settled: {url}")
                    break
                await asyncio.sleep(1.0)
            except Exception:
                break
        await asyncio.sleep(2)

        # Accept Terms & Agreement modal if present
        try:
            await page.wait_for_selector(
                ".ant-modal-content", state="visible", timeout=5000
            )
            _debug("Terms modal detected, accepting...")
            await page.evaluate("""() => {
                const checkboxes = document.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => { if (!cb.checked) cb.click(); });
            }""")
            await asyncio.sleep(0.5)
            await page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(b => b.textContent?.trim() === 'Confirm');
                if (btn) btn.click();
            }""")
            await asyncio.sleep(2)
            _debug("Terms modal accepted")
        except Exception:
            pass

        # Navigate to API keys page if not already there
        try:
            current_url = page.url
            if "/console/api-keys" not in current_url:
                _debug(f"navigating to API keys page from {current_url}")
                await page.goto(
                    MIMO_CONSOLE_URL, wait_until="domcontentloaded", timeout=20000
                )
                await asyncio.sleep(2)
        except Exception as e:
            _debug(f"navigation to API keys page failed: {e}")

        # Accept Terms modal again if appeared after navigation
        try:
            await page.wait_for_selector(
                ".ant-modal-content", state="visible", timeout=5000
            )
            _debug("Terms modal appeared after navigation, accepting...")
            await page.evaluate("""() => {
                const checkboxes = document.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => { if (!cb.checked) cb.click(); });
            }""")
            await asyncio.sleep(0.5)
            await page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(b => b.textContent?.trim() === 'Confirm');
                if (btn) btn.click();
            }""")
            await asyncio.sleep(2)
        except Exception:
            pass

        # Extract cookies — need api-platform_ph (query param) and api-platform_serviceToken
        _debug("extracting cookies from browser context...")
        cookies: list[dict] = await page.context.cookies(
            "https://platform.xiaomimimo.com"
        )
        cookie_map: dict[str, str] = {c["name"]: c["value"] for c in cookies}

        ph = cookie_map.get("api-platform_ph", "").strip('"').strip()
        service_token = cookie_map.get("api-platform_serviceToken", "")

        # URL-encode ph for use as query param (base64 contains + and = that must be encoded)
        from urllib.parse import quote as _urlquote

        ph_encoded = _urlquote(ph, safe="")

        _debug(f"cookies found: {list(cookie_map.keys())}")

        if not ph:
            # Try localStorage fallback
            try:
                ph = await page.evaluate(
                    "() => localStorage.getItem('api-platform_ph') || ''"
                )
            except Exception:
                pass

        if not ph:
            raise RetryableBatcherError(
                ErrorCode.auth_temporary_failure,
                "keygen failed: api-platform_ph cookie not found after OAuth",
            )

        _debug(f"got ph: {ph[:10]}...")

        # Use browser's own fetch() to POST — avoids cookie auth issues
        # when extracting cookies manually and sending via aiohttp.
        # Browser context already has all valid cookies (including httpOnly ones).
        create_url = f"{MIMO_BASE_URL}/api/v1/apiKeys?api-platform_ph={ph_encoded}"
        payload = {"apiKeyName": key_name}

        try:
            result = await page.evaluate(
                """
                async ([url, payload]) => {
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify(payload),
                    });
                    const body = await resp.json().catch(() => ({}));
                    return { status: resp.status, body };
                }
            """,
                [create_url, payload],
            )

            status = result.get("status", 0)
            body = result.get("body", {})
            _debug(f"create response: status={status} body={str(body)[:300]}")

            # Handle 401: Xiaomi STS needs re-auth for new accounts
            # Follow the loginUrl from the 401 response, complete STS, then retry
            if status == 401 and body.get("loginUrl"):
                login_url = body["loginUrl"]
                # Fix http:// to https://
                login_url = login_url.replace("http://platform", "https://platform")
                _debug(f"401: following STS loginUrl: {login_url[:100]}")
                try:
                    await page.goto(
                        login_url, wait_until="domcontentloaded", timeout=20000
                    )
                    await asyncio.sleep(3)
                    _debug(f"STS re-auth landed: {page.url[:80]}")
                    # Wait for redirect back to platform
                    for _sts_tick in range(20):
                        _cur = page.url
                        if (
                            "xiaomimimo.com" in _cur
                            and "/sts" not in _cur
                            and "/login" not in _cur
                        ):
                            _debug(f"STS re-auth complete: {_cur[:80]}")
                            break
                        await asyncio.sleep(1)
                    await asyncio.sleep(2)
                    # Navigate to API keys page again after re-auth
                    await page.goto(
                        MIMO_CONSOLE_URL, wait_until="domcontentloaded", timeout=20000
                    )
                    await asyncio.sleep(2)
                    # Accept Terms modal if present
                    try:
                        await page.wait_for_selector(
                            ".ant-modal-content", state="visible", timeout=4000
                        )
                        await page.evaluate("""() => {
                            document.querySelectorAll('input[type="checkbox"]').forEach(cb => { if (!cb.checked) cb.click(); });
                        }""")
                        await asyncio.sleep(0.5)
                        await page.evaluate("""() => {
                            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Confirm');
                            if (btn) btn.click();
                        }""")
                        await asyncio.sleep(2)
                        _debug("Terms modal accepted after STS re-auth")
                    except Exception:
                        pass
                    # Retry the API call
                    result = await page.evaluate(
                        """
                        async ([url, payload]) => {
                            const resp = await fetch(url, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                credentials: 'include',
                                body: JSON.stringify(payload),
                            });
                            const body = await resp.json().catch(() => ({}));
                            return { status: resp.status, body };
                        }
                    """,
                        [create_url, payload],
                    )
                    status = result.get("status", 0)
                    body = result.get("body", {})
                    _debug(
                        f"retry create response: status={status} body={str(body)[:300]}"
                    )
                except Exception as _sts_err:
                    _debug(f"STS re-auth error: {_sts_err}")

            if status not in (200, 201):
                raise Exception(
                    f"browser fetch returned {status}: {body.get('message', body.get('msg', ''))}"
                )
        except Exception as _browser_err:
            _debug(f"browser fetch failed ({_browser_err}), falling back to aiohttp...")
            # Fallback: aiohttp with full cookie header
            cookie_header = "; ".join(f"{k}={v}" for k, v in cookie_map.items())
            headers = {
                "content-type": "application/json",
                "cookie": cookie_header,
                "origin": MIMO_BASE_URL,
                "referer": MIMO_CONSOLE_URL,
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            }
            async with aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(ssl=_SSL_CTX)
            ) as http:
                async with http.post(
                    create_url,
                    headers=headers,
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    body = await resp.json(content_type=None)
                    status = resp.status
                    _debug(f"aiohttp fallback: status={status} body={str(body)[:300]}")

        if status not in (200, 201):
            msg = body.get("message", body.get("msg", f"HTTP {status}"))
            raise RetryableBatcherError(
                ErrorCode.auth_temporary_failure,
                f"keygen failed: {msg}",
            )

        # Response may have apiKey directly or nested
        api_key: str = (
            body.get("apiKey")
            or body.get("api_key")
            or body.get("data", {}).get("apiKey")
            or body.get("data", {}).get("api_key")
            or body.get("data", {}).get("key")
            or ""
        )
        if not api_key or len(api_key) < 10:
            raise RetryableBatcherError(
                ErrorCode.auth_temporary_failure,
                f"keygen failed: unexpected response structure: {str(body)[:200]}",
            )

        _debug(f"generated API key: {api_key[:20]}...")

        # Bind referral code (non-critical — failure is logged and ignored)
        try:
            bind_url = (
                f"{MIMO_BASE_URL}/api/v1/invitation/bind?api-platform_ph={ph_encoded}"
            )
            bind_result = await page.evaluate(
                """
                async ([url, code]) => {
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ inviteCode: code }),
                    });
                    const body = await resp.json().catch(() => ({}));
                    return { status: resp.status, body };
                }
            """,
                [bind_url, MIMO_REFERRAL_CODE],
            )
            bind_status = bind_result.get("status", 0)
            bind_body = bind_result.get("body", {})
            if bind_status in (200, 201):
                _debug(f"referral bind success: status={bind_status}")
                print(
                    json.dumps(
                        {
                            "type": "progress",
                            "step": "referral_bind",
                            "message": f"Referral bind success OK (code: {MIMO_REFERRAL_CODE})",
                        }
                    ),
                    flush=True,
                )
            else:
                _safe_body = (
                    str(bind_body)[:200].encode("ascii", errors="replace").decode()
                )
                _debug(f"referral bind failed: status={bind_status} body={_safe_body}")
                _err_msg = bind_body.get("message", "") or bind_body.get(
                    "code", bind_status
                )
                _safe_err_msg = str(_err_msg).encode("ascii", errors="replace").decode()
                print(
                    json.dumps(
                        {
                            "type": "progress",
                            "step": "referral_bind",
                            "message": f"Referral bind failed: status={bind_status} — {_safe_err_msg}",
                        }
                    ),
                    flush=True,
                )
        except Exception as _bind_err:
            _safe_err = str(_bind_err).encode("ascii", errors="replace").decode()
            _debug(f"referral bind error (ignored): {_safe_err}")
            print(
                json.dumps(
                    {
                        "type": "progress",
                        "step": "referral_bind",
                        "message": f"Referral bind error: {_safe_err}",
                    }
                ),
                flush=True,
            )

        # Fetch this account's own invitation/referral code
        own_referral_code = ""
        try:
            invite_url = (
                f"{MIMO_BASE_URL}/api/v1/invitation/code?api-platform_ph={ph_encoded}"
            )
            invite_result = await page.evaluate(
                """
                async (url) => {
                    const resp = await fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                    });
                    const body = await resp.json().catch(() => ({}));
                    return { status: resp.status, body };
                }
            """,
                invite_url,
            )
            invite_status = invite_result.get("status", 0)
            invite_body = invite_result.get("body", {})
            if invite_status == 200 and invite_body.get("code") == 0:
                own_referral_code = invite_body.get("data", {}).get(
                    "invitationCode", ""
                )
                _debug(f"own referral code: {own_referral_code}")
        except Exception as _inv_err:
            _debug(f"fetch own referral code error (ignored): {_inv_err}")

        # Extract additional cookies needed for stateless API calls after login
        service_token = (
            cookie_map.get("api-platform_serviceToken", "").strip('"').strip()
        )
        user_id = cookie_map.get("userId", "")
        slh = cookie_map.get("api-platform_slh", "").strip('"').strip()

        return {
            "api_key": api_key,
            "email": account.identifier,
            "ph": ph,
            "referral_code": own_referral_code or MIMO_REFERRAL_CODE,
            "service_token": service_token,
            "user_id": user_id,
            "slh": slh,
        }

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
        page: Any = None,
    ) -> dict[str, Any] | None:
        api_key = tokens.get("api_key", "")
        if not api_key:
            return {"total": 0, "used": 0}

        # Resolve page from session if not passed directly
        if page is None and session and not session.get("stub"):
            page = session.get("page")

        # Try to fetch real balance via authenticated browser session
        if page is not None:
            try:
                from urllib.parse import quote as _urlquote

                cookies: list[dict] = await page.context.cookies(
                    "https://platform.xiaomimimo.com"
                )
                cookie_map: dict[str, str] = {c["name"]: c["value"] for c in cookies}
                ph = cookie_map.get("api-platform_ph", "").strip('"').strip()
                if ph:
                    ph_encoded = _urlquote(ph, safe="")

                    # Try multiple candidate balance endpoints
                    candidate_urls = [
                        f"{MIMO_BASE_URL}/api/v1/balance?api-platform_ph={ph_encoded}",
                        f"{MIMO_BASE_URL}/api/v1/user/balance?api-platform_ph={ph_encoded}",
                        f"{MIMO_BASE_URL}/api/v1/account/balance?api-platform_ph={ph_encoded}",
                        f"{MIMO_BASE_URL}/api/v1/wallet?api-platform_ph={ph_encoded}",
                    ]

                    for balance_url in candidate_urls:
                        try:
                            result = await page.evaluate(
                                """
                                async (url) => {
                                    const resp = await fetch(url, {
                                        method: 'GET',
                                        credentials: 'include',
                                    });
                                    const text = await resp.text();
                                    let body = {};
                                    try { body = JSON.parse(text); } catch (_) {}
                                    return { status: resp.status, body, text };
                                }
                            """,
                                balance_url,
                            )

                            status = result.get("status", 0)
                            body = result.get("body", {})
                            text = result.get("text", "")
                            _debug(
                                f"balance url={balance_url} status={status} body={text[:300]}"
                            )

                            if status == 200 and body:
                                _debug(
                                    f"fetch_quota balance response: {str(body)[:200]}"
                                )
                                # Response shape: {"code":0,"data":{"balance":"10.72",...}}
                                amount = (
                                    body.get("data", {}).get("balance")
                                    or body.get("balance")
                                    or body.get("amount")
                                    or body.get("credits")
                                    or 0
                                )
                                if amount:
                                    try:
                                        amount = float(amount)  # "10.72" → 10.72
                                    except (TypeError, ValueError):
                                        amount = 0
                                if amount:
                                    _debug(f"fetch_quota: balance={amount}")
                                    return {
                                        "total": amount,
                                        "used": 0,
                                        "balance": amount,
                                    }
                        except Exception as _be:
                            _debug(
                                f"fetch_quota balance url error ({balance_url}): {_be}"
                            )
                            continue
            except Exception as e:
                _debug(f"fetch_quota browser fetch error: {e}")

        # Fallback: verify API key is valid (no real balance data available)
        try:
            async with aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(ssl=_SSL_CTX)
            ) as http:
                async with http.get(
                    f"{MIMO_API_URL}/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status != 200:
                        return {"total": 0, "used": 0, "error": f"HTTP {resp.status}"}
                    return {"total": 0, "used": 0}
        except Exception as e:
            _debug(f"fetch_quota error: {e}")
            return {"total": 0, "used": 0}

    async def cleanup_session(self, session: Any) -> None:
        if session and not session.get("stub"):
            manager = session.get("manager")
            if manager:
                try:
                    await manager.__aexit__(None, None, None)
                except Exception:
                    pass


# ── Standalone runner ──────────────────────────────────────────────────────


async def _main_standalone(email: str, password: str) -> None:
    os.environ.setdefault("BATCHER_ENABLE_CAMOUFOX", "true")
    os.environ.setdefault("BATCHER_CAMOUFOX_HEADLESS", "false")
    os.environ.setdefault("BATCHER_MIMO_DEBUG", "true")

    adapter = MimoAdapter()
    account = NormalizedAccount(provider="mimo", identifier=email, secret=password)

    session = None
    try:
        print(
            json.dumps(
                {
                    "type": "progress",
                    "step": "bootstrap",
                    "message": "Launching browser for MiMo...",
                }
            ),
            flush=True,
        )
        session = await adapter.bootstrap_session(account)

        print(
            json.dumps(
                {
                    "type": "progress",
                    "step": "authenticate",
                    "message": "Completing Google OAuth for MiMo...",
                }
            ),
            flush=True,
        )
        auth_state = await adapter.authenticate(account, session)

        print(
            json.dumps(
                {
                    "type": "progress",
                    "step": "fetch_tokens",
                    "message": "Generating MiMo API key...",
                }
            ),
            flush=True,
        )
        tokens = await adapter.fetch_tokens(account, auth_state, session)

        print(
            json.dumps(
                {
                    "type": "progress",
                    "step": "fetch_quota",
                    "message": "Fetching MiMo quota...",
                }
            ),
            flush=True,
        )
        quota = await adapter.fetch_quota(account, tokens, session) or {}

        from app.providers.base import ProviderResult as AuthResult

        result = AuthResult(ok=True, message="success", tokens=tokens, quota=quota)

        print(
            json.dumps(
                {
                    "type": "result",
                    "mimo": {
                        "success": result.ok,
                        "message": result.message,
                        "tokens": {
                            k: v[:20] + "..." if k == "api_key" and len(v) > 20 else v
                            for k, v in result.tokens.items()
                        },
                        "quota": result.quota,
                    },
                }
            ),
            flush=True,
        )
    except Exception as e:
        print(
            json.dumps({"type": "result", "mimo": {"success": False, "error": str(e)}}),
            flush=True,
        )
    finally:
        await adapter.cleanup_session(session)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args()
    asyncio.run(_main_standalone(args.email, args.password))
