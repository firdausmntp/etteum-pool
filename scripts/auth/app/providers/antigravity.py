from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import ssl
import sys
import time
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlparse

import aiohttp

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter

# ── Antigravity OAuth Constants ─────────────────────────────────────────────

ANTIGRAVITY_CLIENT_ID = os.getenv(
    "ANTIGRAVITY_CLIENT_ID",
    "ANTIGRAVITY_CLIENT_ID_PLACEHOLDER",
)
ANTIGRAVITY_CLIENT_SECRET = os.getenv("ANTIGRAVITY_CLIENT_SECRET", "ANTIGRAVITY_CLIENT_SECRET_PLACEHOLDER")
ANTIGRAVITY_SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
]
ANTIGRAVITY_REDIRECT_URI = "http://localhost:1930/oauth-callback"
ANTIGRAVITY_REDIRECT_PORT = 1930

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo"

# ── PKCE helpers ─────────────────────────────────────────────────────────────


def generate_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(32)
    challenge_bytes = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(challenge_bytes).decode("ascii").rstrip("=")
    return verifier, challenge


def encode_state(verifier: str, project_id: str = "") -> str:
    payload = {"verifier": verifier, "projectId": project_id}
    json_bytes = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(json_bytes).decode("ascii").rstrip("=")


def decode_state(state: str) -> tuple[str, str]:
    normalized = state.replace("-", "+").replace("_", "/")
    padding_needed = (4 - len(normalized) % 4) % 4
    padded = normalized + "=" * padding_needed
    json_bytes = base64.b64decode(padded)
    payload = json.loads(json_bytes.decode("utf-8"))
    return payload.get("verifier", ""), payload.get("projectId", "")


# ── Google OAuth helpers (reuse mimo patterns) ───────────────────────────────


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
                const hasPassword = Array.from(
                    document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                ).some(e => e.offsetParent !== null);
                // Success: left Google entirely
                if (!host.includes('accounts.google.com')) return true;
                // Success: password field gone (navigation happened on Google)
                if (!hasPassword) return true;
                return false;
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
        await asyncio.sleep(1.5)
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
            val = await loc.input_value()
            if len(str(val).strip()) < 3:
                _debug("password input empty after typing, skipping")
                continue
            if not await _click_google_next(page):
                await loc.press("Enter")
            await _wait_for_google_password_transition(page)
            return True
        except Exception:
            continue
    return False


async def _handle_consent(page: Any) -> bool:
    try:
        url = page.url
    except Exception:
        return False
    if "accounts.google.com" not in url:
        return False
    if (
        "/signin/oauth" not in url
        and "/consent" not in url
        and "/firstparty" not in url
    ):
        return False
    try:
        clicked = await page.evaluate("""() => {
            const ALLOW_TEXTS = [
                'continue', 'allow', 'lanjut', 'lanjutkan', 'izinkan',
                'login', 'sign in', 'masuk', 'authorize', 'grant',
            ];
            const DENY_TEXTS = ['batal', 'cancel', 'deny', 'back', 'kembali'];
            for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                const txt = (btn.textContent || btn.value || '').trim().toLowerCase();
                if (!txt || btn.offsetParent === null) continue;
                if (DENY_TEXTS.some(d => txt === d || txt.includes(d))) continue;
                if (ALLOW_TEXTS.some(a => txt === a || txt.includes(a))) {
                    btn.click(); return txt;
                }
            }
            return null;
        }""")
        if clicked:
            await asyncio.sleep(2)
        return bool(clicked)
    except Exception:
        return False


# ── 9router Client-Metadata helpers ─────────────────────────────────────────

def _get_platform_code() -> str:
    """9router platform code: N=Windows, M=Mac, L=Linux."""
    import platform
    system = platform.system().lower()
    if system == "windows":
        return "N"
    elif system == "linux":
        return "L"
    return "M"  # darwin default


def _get_platform_enum() -> int:
    """Numeric platform enum for Google Cloud Code API (PR #1236 fix).
    0=PLATFORM_UNSPECIFIED, 1=MAC, 2=LINUX, 3=WINDOWS, 4=WEB, 5=CHROME_OS
    """
    import platform
    system = platform.system().lower()
    if system == "windows":
        return 3
    elif system == "linux":
        return 2
    return 1  # darwin = MAC


def _get_platform_name() -> str:
    """Real platform name for API calls (not UNSPECIFIED)."""
    import platform
    system = platform.system().lower()
    if system == "windows":
        return "WINDOWS"
    elif system == "linux":
        return "LINUX"
    return "MAC"


def _build_client_metadata(ide_type: str = "9", plugin_type: str = "GEMINI") -> str:
    """Build Client-Metadata JSON header (9router fingerprint)."""
    return json.dumps({
        "ideType": ide_type,
        "platform": _get_platform_code(),
        "pluginType": plugin_type,
    })


# ── 9router onboardUser activation ──────────────────────────────────────────

async def _onboard_user(access_token: str) -> dict[str, Any] | None:
    """Activate user via onboardUser endpoint (9router pattern).
    
    POST https://cloudcode-pa.googleapis.com/v1internal:onboardUser
    Required to activate Antigravity account before first use.
    """
    url = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata": json.dumps({
            "ideType": _get_platform_enum(),
            "platform": _get_platform_enum(),
            "pluginType": 2,  # GEMINI
        }),
    }
    body = json.dumps({
        "metadata": {
            "ideType": _get_platform_enum(),
            "platform": _get_platform_enum(),
            "pluginType": 2,
        },
    })

    async with aiohttp.ClientSession() as http:
        try:
            async with http.post(url, data=body, headers=headers, ssl=_SSL_CTX,
                                 timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    _debug(f"onboardUser OK: {json.dumps(data)[:200]}")
                    return data
                else:
                    text = await resp.text()
                    _debug(f"onboardUser {resp.status}: {text[:200]}")
                    return None
        except Exception as e:
            _debug(f"onboardUser error: {e}")
            return None


# ── 9router loadCodeAssist (replaces _fetch_project_id) ─────────────────────

async def _load_code_assist(access_token: str) -> tuple[str | None, bool]:
    """Fetch project ID via loadCodeAssist (9router pattern).
    
    POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
    Returns (project_id, user_defined_flag).
    """
    endpoints = [
        "https://cloudcode-pa.googleapis.com",
        "https://daily-cloudcode-pa.sandbox.googleapis.com",
        "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    ]

    async with aiohttp.ClientSession() as http:
        for endpoint in endpoints:
            url = f"{endpoint}/v1internal:loadCodeAssist"
            headers = {
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "User-Agent": "google-api-nodejs-client/9.15.1",
                "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
                "Client-Metadata": _build_client_metadata("IDE_UNSPECIFIED", "GEMINI"),
            }
            body = json.dumps({
                "metadata": {
                    "ideType": _get_platform_enum(),
                    "platform": _get_platform_enum(),
                    "pluginType": 2,
                },
            })

            try:
                async with http.post(url, data=body, headers=headers, ssl=_SSL_CTX,
                                     timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    if resp.status == 200:
                        data = await resp.json()

                        # Primary: cloudaicompanionProject
                        project_id = (
                            data.get("cloudaicompanionProject")
                            or data.get("project")
                            or data.get("projectId")
                        )
                        if project_id and isinstance(project_id, str):
                            return project_id, False

                        # Check allowedTiers for userDefinedCloudaicompanionProject
                        allowed_tiers = data.get("allowedTiers", [])
                        has_user_defined = any(
                            t.get("userDefinedCloudaicompanionProject") is True
                            for t in allowed_tiers
                        )
                        if has_user_defined:
                            return None, True
            except Exception as e:
                _debug(f"loadCodeAssist {endpoint}: {e}")
                continue

    return None, False


# ── 9router fetchAvailableModels (real quota check) ─────────────────────────

async def _fetch_available_models(access_token: str, project_id: str) -> dict[str, Any] | None:
    """Fetch available models and real quota via fetchAvailableModels (9router pattern).
    
    POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
    Returns quota info for the user's project.
    """
    url = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "X-Goog-Request-Source": "local",
    }
    body = json.dumps({"project": project_id})

    async with aiohttp.ClientSession() as http:
        try:
            async with http.post(url, data=body, headers=headers, ssl=_SSL_CTX,
                                 timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    models = data.get("models", [])
                    if models:
                        model = models[0]
                        quota = model.get("quota", {})
                        max_limit = quota.get("maxUsageLimit", 1_000_000)
                        remaining = quota.get("remainingUsage", max_limit)
                        return {
                            "limit": max_limit,
                            "remaining": remaining,
                            "used": max_limit - remaining,
                            "unit": "token",
                        }
                    _debug(f"fetchAvailableModels: no models in response")
                    return None
                else:
                    text = await resp.text()
                    _debug(f"fetchAvailableModels {resp.status}: {text[:200]}")
                    return None
        except Exception as e:
            _debug(f"fetchAvailableModels error: {e}")
            return None


# ── Virtual project ID for accounts without Cloud Code ────────────────────────
# ponytail: 9router pattern — reuse a known-working project ID for new accounts
# This project was auto-discovered from accounts that already had Cloud Code setup
# Source: 9router Issue #1358, account fingerprint "zinc-computer-ccx0h"
ANTIGRAVITY_VIRTUAL_PROJECT_ID = "zinc-computer-ccx0h"


class AntigravityProviderAdapter(ProviderAdapter):
    name = "antigravity"

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

            _AG_FF_PREFS = {
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
                "firefox_user_prefs": _AG_FF_PREFS,
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
        _pw_filled = False
        _blank_ticks = 0
        _last_url = ""
        _stuck_ticks = 0

        # Build OAuth authorization URL
        verifier, challenge = generate_pkce()
        scope_str = " ".join(ANTIGRAVITY_SCOPES)
        state = encode_state(verifier)
        auth_url = (
            f"{GOOGLE_AUTH_URL}?"
            f"response_type=code&"
            f"client_id={ANTIGRAVITY_CLIENT_ID}&"
            f"redirect_uri={quote(ANTIGRAVITY_REDIRECT_URI, safe='')}&"
            f"scope={quote(scope_str, safe='')}&"
            f"state={state}&"
            f"code_challenge={challenge}&"
            f"code_challenge_method=S256&"
            f"access_type=offline&"
            f"prompt=consent"
        )

        # Callback will be captured by polling the Hono backend (port 1930).
        captured_callback: dict[str, str | None] = {"url": None}

        _debug(f"Navigating to OAuth URL: {auth_url[:100]}...")
        print(f"[AG] goto auth_url={auth_url[:100]}", file=sys.stderr, flush=True)
        await page.goto(auth_url, wait_until="domcontentloaded", timeout=20000)
        await asyncio.sleep(2)

        _tick_count = 0
        try:
            for _ in range(90):
                _tick_count += 1
                if _tick_count % 10 == 0:
                    try:
                        _tick_url = page.url
                    except Exception:
                        _tick_url = "?"
                    print(f"[AG] tick {_tick_count} url={_tick_url[:80]}", file=sys.stderr, flush=True)
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

                if url == "about:blank" or url == "":
                    _blank_ticks += 1
                    _stuck_ticks = 0
                    if _blank_ticks >= 4:
                        try:
                            await page.reload(
                                wait_until="domcontentloaded", timeout=10000
                            )
                        except Exception:
                            pass
                        _blank_ticks = 0
                    await asyncio.sleep(1.5)
                    continue
                else:
                    _blank_ticks = 0

                if url == _last_url:
                    _stuck_ticks += 1
                else:
                    _stuck_ticks = 0
                _last_url = url

                host = urlparse(url).netloc
                path = urlparse(url).path

                # Success: polled callback from Hono backend OR browser navigated to it
                callback_url = captured_callback.get("url") or (
                    url
                    if (
                        ("localhost:1930" in url or "oauth-callback" in url)
                        and "accounts.google.com" not in host
                    )
                    else None
                )
                if callback_url:
                    _debug(f"Got callback URL: {callback_url[:150]}")
                    qs = parse_qs(urlparse(callback_url).query)
                    auth_code = qs.get("code", [None])[0]
                    returned_state = qs.get("state", [None])[0]
                    if auth_code:
                        print("[AG] callback_url set, returning success", file=sys.stderr, flush=True)
                        return {
                            "authenticated": True,
                            "code": auth_code,
                            "state": returned_state,
                        }
                    raise RetryableBatcherError(
                        ErrorCode.auth_temporary_failure,
                        "OAuth callback missing authorization code",
                    )

                # Handle consent page
                print(f"[AG] consent handler called, url={url[:80]}", file=sys.stderr, flush=True)
                if await _handle_consent(page):
                    print("[AG] consent clicked", file=sys.stderr, flush=True)
                    _debug("accepted OAuth consent")
                    await asyncio.sleep(0.8)
                    continue

                # Handle Google account chooser
                if "accounts.google.com" in host and "accountchooser" in url:
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
                        pass
                    await asyncio.sleep(1.0)
                    continue

                if "accounts.google.com" in host:
                    now = time.monotonic()
                    at_pw = await _is_password_step(page)
                    at_email = await _is_email_step(page)

                    if at_email and not at_pw:
                        print("[AG] email step detected", file=sys.stderr, flush=True)
                        if now < email_deadline:
                            await asyncio.sleep(0.4)
                            continue
                        _email_result = await _fill_google_email(page, account.identifier)
                        if _email_result:
                            print("[AG] email filled OK", file=sys.stderr, flush=True)
                            _debug("entered email")
                            email_deadline = time.monotonic() + 12.0
                            await asyncio.sleep(1.0)
                            continue
                        else:
                            print("[AG] email fill FAILED", file=sys.stderr, flush=True)

                    if at_pw:
                        print("[AG] password step detected", file=sys.stderr, flush=True)
                        if _pw_filled:
                            await asyncio.sleep(0.5)
                            continue
                        if now < pw_deadline:
                            await asyncio.sleep(0.4)
                            continue
                        _pw_result = await _fill_google_password(page, account.secret)
                        if _pw_result:
                            print("[AG] password filled OK", file=sys.stderr, flush=True)
                            _debug("entered password")
                            _pw_filled = True
                            pw_deadline = time.monotonic() + 8.0
                            _left_google = False
                            for _pw_tick in range(5):
                                await asyncio.sleep(1.0)
                                try:
                                    _cur = page.url
                                except Exception:
                                    break
                                if "accounts.google.com" not in (_cur or ""):
                                    _debug(f"left google after {_pw_tick + 1}s")
                                    _left_google = True
                                    break
                            if not _left_google:
                                _debug("still on google after 5s")
                                # Check if Google showed an error (wrong password, challenge, blocked)
                                try:
                                    _has_error = await page.evaluate("""() => {
                                        // Google wrong password error selectors
                                        const errSels = [
                                            '[data-error-code]', '.o6cuMc', '.dEOOab',
                                            '[aria-live="assertive"]', '#view_container [data-error]'
                                        ];
                                        for (const sel of errSels) {
                                            const el = document.querySelector(sel);
                                            if (el && el.offsetParent !== null && (el.textContent || '').trim()) return true;
                                        }
                                        // If password field is still visible, Google didn't accept it
                                        const pwField = document.querySelector('input[name="Passwd"], input[type="password"]');
                                        return !!(pwField && pwField.offsetParent !== null);
                                    }""")
                                    if _has_error:
                                        raise RetryableBatcherError(
                                            ErrorCode.auth_temporary_failure,
                                            "Google rejected password or showed error/challenge",
                                        )
                                except (
                                    RetryableBatcherError,
                                    NonRetryableBatcherError,
                                ):
                                    raise
                                except Exception:
                                    pass
                            continue
                        else:
                            print("[AG] password fill FAILED", file=sys.stderr, flush=True)

                    # Poll Hono backend for OAuth callback
                    # Poll setelah email terisi (tidak perlu tunggu _pw_filled)
                    # karena consent page bisa redirect sebelum _pw_filled = True
                    if not captured_callback.get("url"):
                        print("[AG] polling backend...", file=sys.stderr, flush=True)
                        try:
                            import urllib.request as _urllib
                            import json as _json

                            poll_url = f"http://localhost:1930/api/oauth-callback/poll?state={state}"
                            with _urllib.urlopen(poll_url, timeout=3) as _resp:
                                _data = _json.loads(_resp.read())
                                if _data.get("code"):
                                    captured_callback["url"] = (
                                        f"http://localhost:1930/oauth-callback?code={_data['code']}&state={_data['state']}"
                                    )
                                    print("[AG] poll got code!", file=sys.stderr, flush=True)
                                    _debug(
                                        f"Polled callback successfully: code received"
                                    )
                        except Exception:
                            pass  # Will retry next iteration

                    if at_email or at_pw:
                        await asyncio.sleep(0.6)
                        continue

                    # CAPTCHA / challenge detection
                    if (
                        "/challenge/" in path.lower()
                        and "/challenge/pwd" not in path.lower()
                    ):
                        if any(
                            x in path.lower()
                            for x in ("recaptcha", "ipp", "totp", "dk", "sk")
                        ):
                            _debug(f"Google CAPTCHA/challenge detected: {path}")
                            raise RetryableBatcherError(
                                ErrorCode.auth_temporary_failure,
                                f"Google CAPTCHA/challenge at {path}",
                            )
                        await asyncio.sleep(2.0)
                        continue

                    # Speedbump pages
                    if "/speedbump/" in path:
                        _debug(f"Google speedbump page: {path}")
                        try:
                            await page.evaluate("""() => {
                                const specific = document.getElementById('gaplustosNext');
                                if (specific) {
                                    const btn = specific.querySelector('button');
                                    if (btn && !btn.disabled) { btn.click(); return; }
                                    window.scrollTo(0, document.body.scrollHeight);
                                }
                                const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                                const btn = btns.find(b =>
                                    b.offsetParent !== null && !b.disabled &&
                                    /accept|agree|confirm|continue|next|ok|yes|understand/i.test((b.textContent || b.value || '').trim())
                                );
                                if (btn) { btn.click(); return; }
                                window.scrollTo(0, document.body.scrollHeight);
                            }""")
                        except Exception:
                            pass
                        await asyncio.sleep(2.0)
                        continue

                    _debug(f"Google intermediate page: path={path}")
                    await asyncio.sleep(1.5)
                    continue

                _debug(f"unhandled state: url={url}")
                await asyncio.sleep(1.0)

            raise RetryableBatcherError(
                ErrorCode.auth_temporary_failure, "Antigravity OAuth flow timed out"
            )
        except Exception:
            raise
        finally:
            await asyncio.sleep(1)

    async def fetch_tokens(
        self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any
    ) -> dict[str, str]:
        auth_code = auth_state.get("code")
        state = auth_state.get("state")

        if not auth_code:
            raise NonRetryableBatcherError(
                ErrorCode.auth_temporary_failure,
                "no authorization code from OAuth flow",
            )

        # Decode state to get PKCE verifier
        verifier, _ = decode_state(state) if state else ("", "")
        if not verifier:
            raise NonRetryableBatcherError(
                ErrorCode.auth_temporary_failure, "missing PKCE verifier in state"
            )

        # Exchange code for tokens
        async with aiohttp.ClientSession() as http:
            token_data = urlencode(
                {
                    "code": auth_code,
                    "client_id": ANTIGRAVITY_CLIENT_ID,
                    "client_secret": ANTIGRAVITY_CLIENT_SECRET,
                    "redirect_uri": ANTIGRAVITY_REDIRECT_URI,
                    "grant_type": "authorization_code",
                    "code_verifier": verifier,
                }
            )

            try:
                async with http.post(
                    GOOGLE_TOKEN_URL,
                    data=token_data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    ssl=_SSL_CTX,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    body = await resp.json()
                    if resp.status != 200:
                        raise RetryableBatcherError(
                            ErrorCode.auth_temporary_failure,
                            f"Token exchange failed: {body.get('error_description', body.get('error', 'unknown'))}",
                        )
            except (RetryableBatcherError, NonRetryableBatcherError):
                raise
            except Exception as e:
                raise RetryableBatcherError(
                    ErrorCode.auth_temporary_failure,
                    f"Token exchange request failed: {e}",
                )

        access_token = body.get("access_token")
        refresh_token = body.get("refresh_token")
        expires_in = body.get("expires_in", 3600)

        if not access_token or not refresh_token:
            raise NonRetryableBatcherError(
                ErrorCode.auth_temporary_failure, "Missing tokens in OAuth response"
            )

        # Fetch user email
        email = account.identifier
        try:
            async with aiohttp.ClientSession() as http:
                async with http.get(
                    GOOGLE_USERINFO_URL,
                    headers={"Authorization": f"Bearer {access_token}"},
                    ssl=_SSL_CTX,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status == 200:
                        user_info = await resp.json()
                        email = user_info.get("email", email)
        except Exception:
            pass

        # Run all 3 API calls in parallel — total time = max(any one), not sum
        # ponytail: gather for speed, each call has its own timeout + error handling
        onboard_task = asyncio.create_task(_onboard_user(access_token))
        loadcode_task = asyncio.create_task(_load_code_assist(access_token))
        
        onboard_result = await onboard_task
        
        project_id, user_defined = await loadcode_task
        
        quota_info = None
        if project_id:
            quota_info = await _fetch_available_models(access_token, project_id)
        
        _debug(f"onboardUser result: {onboard_result}")
        _debug(f"loadCodeAssist result: project_id={project_id}, user_defined={user_defined}")
        _debug(f"fetchAvailableModels result: {quota_info}")

        # Use virtual project if loadCodeAssist returned no real project
        # ponytail: 9router pattern — reuse known-working project for new accounts
        if not project_id and user_defined:
            _debug(f"No Cloud Code project found, using virtual project: {ANTIGRAVITY_VIRTUAL_PROJECT_ID}")
            project_id = ANTIGRAVITY_VIRTUAL_PROJECT_ID

        # Use virtual project if loadCodeAssist returned no real project
        if not project_id and user_defined:
            _debug(f"No Cloud Code project found, using virtual project: {ANTIGRAVITY_VIRTUAL_PROJECT_ID}")
            project_id = ANTIGRAVITY_VIRTUAL_PROJECT_ID

        # Format: refresh_token|project_id|managed_project_id
        # Format: refresh_token|project_id|managed_project_id
        managed_project_id = ""
        stored_refresh = f"{refresh_token}|{project_id or ''}|{managed_project_id}"

        return {
            "refresh_token": stored_refresh,
            "access_token": access_token,
            "email": email,
            "project_id": project_id,
            "managed_project_id": managed_project_id,
            "onboarded": onboard_result is not None,
            "quota_limit": quota_info["limit"] if quota_info else 1_000_000,
            "quota_remaining": quota_info["remaining"] if quota_info else 1_000_000,
        }

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        """Fetch real quota via fetchAvailableModels (9router pattern)."""
        # Parse project_id from stored refresh_token
        stored_refresh = tokens.get("refresh_token", "")
        parts = stored_refresh.split("|")
        project_id = parts[1] if len(parts) > 1 else ""

        if not project_id:
            _debug("fetch_quota: no project_id, falling back to default")
            return {
                "limit": 1_000_000,
                "remaining": 1_000_000,
                "used": 0,
                "unit": "token",
            }

        # Extract access_token from tokens for API call
        access_token = tokens.get("access_token", "")
        if not access_token:
            _debug("fetch_quota: no access_token, falling back to default")
            return {
                "limit": 1_000_000,
                "remaining": 1_000_000,
                "used": 0,
                "unit": "token",
            }

        quota_info = await _fetch_available_models(access_token, project_id)
        if quota_info:
            _debug(f"fetch_quota: real quota = {quota_info}")
            return quota_info

        _debug("fetch_quota: API failed, falling back to default")
        return {
            "limit": 1_000_000,
            "remaining": 1_000_000,
            "used": 0,
            "unit": "token",
        }

    async def _fetch_project_id(self, access_token: str) -> str | None:
        """Fetch project ID from Google Cloud Code API."""
        endpoints = [
            "https://cloudcode-pa.googleapis.com",
            "https://daily-cloudcode-pa.sandbox.googleapis.com",
            "https://autopush-cloudcode-pa.sandbox.googleapis.com",
        ]
        async with aiohttp.ClientSession() as http:
            for endpoint in endpoints:
                try:
                    async with http.get(
                        f"{endpoint}/v1/projects",
                        headers={"Authorization": f"Bearer {access_token}"},
                        ssl=_SSL_CTX,
                        timeout=aiohttp.ClientTimeout(total=10),
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            projects = data.get("projects", [])
                            if projects:
                                return projects[0].get("projectId")
                except Exception:
                    continue
        return None


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_ANTIGRAVITY_DEBUG", "false").lower() == "true":
        print(f"[antigravity-auth] {msg}", flush=True)
