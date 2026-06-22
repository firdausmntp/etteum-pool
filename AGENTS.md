# AGENTS.md — etteum-pool

Panduan untuk AI agents (Kiro, Claude, Cursor, dll.) yang bekerja di codebase ini.
Baca file ini sebelum menyentuh kode apapun.

---

## Apa ini?

**etteum-pool** (`poolprox3`) adalah AI API proxy pool — reverse proxy load-balancer yang menyatukan banyak akun dari berbagai AI provider di balik satu endpoint OpenAI-compatible (`/v1/chat/completions`).

Client apapun yang bicara OpenAI/Anthropic format bisa dipointing ke sini. System ini menangani login automation, quota tracking, load balancing, token compression, dan internet exposure via relay tunnel.

---

## Tech Stack

| Layer | Tech | Catatan |
|---|---|---|
| Runtime | **Bun** (bukan Node.js) | Jangan pakai `npm run` atau `node` |
| HTTP Framework | **Hono** | Mirip Express tapi untuk Bun/Edge |
| Database | **SQLite** via **Drizzle ORM** | File: `data/poolprox3.db` |
| Dashboard | **React 19** + **Vite 8** + **Tailwind CSS v4** | Di folder `dashboard/` |
| Auth automation | **Python** subprocess | Camoufox + Playwright, di `scripts/auth/` |
| Wire protocol | **CBOR** over WebSocket | Untuk relay system |

---

## Struktur Monorepo

```
etteum-pool/
├── src/                        ← TypeScript backend (Bun + Hono)
│   ├── index.ts                ← Entry point: app bootstrap, middleware, route mounting
│   ├── config.ts               ← SEMUA env vars + defaults — baca ini dulu
│   ├── db/
│   │   ├── schema.ts           ← Source of truth: 10 tabel + semua TypeScript types
│   │   ├── migrate.ts          ← Bootstrap DDL (idempotent, jalankan di startup)
│   │   └── index.ts            ← SQLite connection + Drizzle instance
│   ├── proxy/
│   │   ├── router.ts           ← Pipeline utama: sanitize → compress → route → execute
│   │   ├── pool.ts             ← AccountPool: load balancing + quota + state machine
│   │   ├── filters.ts          ← PUDIDIL content filter engine
│   │   ├── model-mapping.ts    ← Model alias resolution (DB-backed, cached 10s)
│   │   ├── compression/        ← 6-stage token compression pipeline
│   │   │   └── compression.test.ts  ← Tests co-located dengan source (bukan di test/)
│   │   ├── providers/          ← 9 provider implementations
│   │   └── transforms/         ← Format conversion (Anthropic ↔ OpenAI)
│   ├── auth/
│   │   ├── queue.ts            ← LoginQueue: browser automation job queue (concurrency 2)
│   │   ├── warmup-queue.ts     ← WarmupQueue: token health-check (concurrency 5)
│   │   ├── warmup-scheduler.ts ← Recurring auto-warmup timer
│   │   └── canva-team.ts       ← Canva team join/switch/list (spawns canva_*.py)
│   ├── relay/                  ← WebSocket tunnel system (Cloudflare + custom)
│   │   └── tunnel/             ← Cloudflared binary lifecycle management
│   ├── services/
│   │   └── proxy-pool.ts       ← Egress HTTP/SOCKS5 proxy selection + rotation
│   ├── api/                    ← Management API handlers (/api/*)
│   ├── lib/
│   │   ├── bin-data.ts         ← VCC BIN list (dipakai oleh src/api/vcc.ts)
│   │   └── client-configs/     ← AI client config generators (Cursor, VS Code, dll.)
│   ├── utils/
│   │   └── crypto.ts           ← XOR+base64 encrypt/decrypt untuk account passwords
│   └── ws/
│       └── index.ts            ← WebSocket broadcast hub
├── dashboard/                  ← React SPA (admin panel)
│   └── src/
│       ├── App.tsx             ← Auth gate + lazy route tree
│       ├── lib/api.ts          ← Central fetchApi wrapper (semua HTTP calls lewat sini)
│       ├── hooks/              ← useWebSocket, useWsEvent, useTheme
│       ├── pages/              ← 17 route pages (semua lazy-loaded)
│       └── components/         ← Layout, dashboard widgets, modals
├── scripts/
│   ├── auth/                   ← Python auth bots (Playwright + Camoufox)
│   │   ├── login.py            ← Main login bot (dipanggil via Bun subprocess)
│   │   ├── canva_join_team.py  ← Dipanggil via src/auth/canva-team.ts
│   │   ├── canva_list_teams.py ← Dipanggil via src/auth/canva-team.ts
│   │   ├── canva_switch_brand.py ← Dipanggil via src/auth/canva-team.ts
│   │   └── app/providers/      ← Python provider adapters (kiro, codebuddy, qoder, dll.)
│   ├── cookies/                ← Live session cookies (plaintext JSON — jangan commit!)
│   ├── production.ts           ← Production launcher (spawns 2 processes)
│   └── start.ts                ← Dev launcher (hot reload)
├── relay-edge/                 ← Edge worker deployments (Cloudflare Workers, Deno, Vercel)
├── test/
│   ├── proxy/                  ← Unit tests proxy pipeline (8 files)
│   └── auth/                   ← Unit tests auth layer (logs.test.ts)
├── docs/                       ← Technical documentation
│   └── compression.md          ← Deep-dive compression pipeline architecture
├── data/                       ← Runtime data (gitignored)
│   └── poolprox3.db            ← SQLite database (135MB+, JANGAN dihapus)
└── drizzle/                    ← Optional file-based DB migrations
```

---

## Commands

```bash
# Dev (hot reload)
bun scripts/start.ts

# Production
bun scripts/production.ts

# Run tests
bun test

# Run single test file
bun test test/proxy/routing.test.ts

# DB migrations
bun src/db/migrate.ts

# Build dashboard only
cd dashboard && bun run build
```

**Ports:** Backend `:1930`, Dashboard `:1931`. Dashboard selalu `backend_port + 1`.

---

## Database Schema (10 Tabel)

### Core Tables

**`accounts`** — Entitas utama. Satu baris = satu AI service account.
- `provider`: `kiro | kiro-pro | codebuddy | canva | codex | qoder | byok | mimo`
- `status` state machine: `pending → active → exhausted / error`
- `tokens`: JSON blob (access_token, refresh_token, dll.)
- `password`: XOR+base64 encrypted pakai `ENCRYPTION_KEY`
- Unique index: `(provider, email)`

**`request_logs`** — Audit trail per request (bodies, token counts, quota delta)

**`usage_summary`** — Hourly rollup `(bucket, provider, model)` → data untuk dashboard charts

**`settings`** — Key-value runtime config (LB method, proxy config, relay config, dll.)

**`filter_rules`** — Content filter rules, hot-reloaded tanpa restart

**`model_mappings`** — Model alias rewrite di DB (`haiku` → `qwen-3.7`)

**`proxy_pool`** — Egress HTTP/SOCKS5 proxies untuk outbound requests

**`vcc_cards` + `vcc_transactions`** — Virtual credit card pool untuk auto-upgrade Kiro Pro

**`image_studio_chats` + `image_studio_results`** — Image/video generation via Canva

### Aturan untuk DB changes:
- Schema changes → edit `src/db/schema.ts` + `src/db/migrate.ts` (tambahkan `ADD COLUMN` idempotent)
- Jangan hapus kolom tanpa migrasi eksplisit
- `ensureTablesExist()` dipanggil di startup — harus idempotent

---

## Provider Registry

Priority order (first `ownsModel()` match wins):

```
canva → qoder → codex → kiro-pro → mimo → byok → codebuddy → kiro (fallback)
```

| Provider | Model Prefix | Upstream | Auth Method |
|---|---|---|---|
| `kiro` | fallback | AWS CodeWhisperer | OAuth access_token + profile_arn |
| `kiro-pro` | `kp-` | Same | Same + higher quota tier |
| `codebuddy` | `cb-` | CodeBuddy API | api_key / cookies |
| `canva` | `canva-` | Canva Magic Media | Browser cookies (caz token) via Python |
| `qoder` | `qd-` | qoder.sh | COSY Bearer (reverse-engineered custom protocol) |
| `byok` | user-defined | Any OpenAI-compatible | User's own API key |
| `mimo` | exact model IDs | xiaomimimo.com | Bearer API key |
| `codex` | `gpt-5-codex` | — | — |

> ~~`zenmux`~~ — **DEPRECATED** (keygen API auth tidak bisa diotomasi reliably, dihapus per 2026-06-22)
> ~~`merlin`~~ — **DEPRECATED** (cookie-based auth tidak stabil, dihapus per 2026-06-22)

**Tambah provider baru:** buat file baru di `src/proxy/providers/`, extend `BaseProvider`, register di `src/proxy/providers/registry.ts`.

---

## Request Pipeline

```
Client POST /v1/chat/completions
    │
    ▼ 1. Model Alias Resolution
       DB lookup (cached 10s): "haiku" → "qwen-3.7"
    │
    ▼ 2. PUDIDIL Content Sanitization
       Strip: cc_entrypoint, cc_version, cch= hashes, identity strings
       Layer 1: hardcoded fallback | Layer 2: DB-backed rules (hot-reloaded)
    │
    ▼ 3. Token Compression (6 stages, per-provider configurable)
       TSC → DCP → RTK → Caveman → ImageDedupe → CacheMarkers
    │
    ▼ 4. Provider Routing
       Iterate PROVIDER_ORDER, first ownsModel() match wins
    │
    ▼ 5. Account Selection (AccountPool)
       LB strategies: round_robin | least_connections | random | weighted_quota
       Active accounts cached 3s. In-flight count tracked per account.
    │
    ▼ 6. Provider Execution
       fetchWithTimeout(120s), optional egress proxy from proxy_pool
    │
    ▼ 7. Response Passthrough
       Non-stream: JSON | Stream: SSE pipe
    │
    ▼ 8. Post-Request Accounting (async, non-blocking)
       request_logs insert, usage_summary upsert, WebSocket broadcast
```

---

## Token Compression Pipeline (6 Stages)

Dijalankan sebelum forwarding — mengurangi token consumption per request.

| Stage | Nama | Fungsi |
|---|---|---|
| 1 | **TSC** (Tool Schema Compaction) | Strip whitespace dari JSON schema, trim descriptions, drop `$schema`/`$defs` |
| 2 | **DCP** (Duplicate Content Pruning) | Dedupe konten identik across turns, preserve yang paling baru |
| 3 | **RTK** (Tool Result Truncation) | Truncate tool results di turns lama, keep last N turns full |
| 4 | **Caveman** | Compress git diffs, directory trees, repetitive content |
| 5 | **ImageDedupe** | Dedupe base64 image blocks across turns |
| 6 | **CacheMarkers** | Insert Anthropic `cache_control` di stable prefixes |

---

## Account State Machine

```
pending ──(auth OK)──────▶ active
active  ──(quota=0)──────▶ exhausted
active  ──(auth fail)────▶ error
active  ──(transient err)▶ active (skip ~60s via markTransientFailure)
exhausted ─(warmup OK)───▶ active
error ────(re-auth OK)───▶ active
any ──────(enabled=false)▶ disabled
```

**LoginQueue:** concurrency 2, max 10 queued, retry max 3x exponential backoff. Spawns Python subprocess.

**WarmupQueue:** concurrency 5, max 20 queued. API-only check (tidak perlu browser).

**AutoWarmupScheduler:** `setTimeout`-based recurring, 1-1440 menit (default 15), persisted di `settings` table.

---

## Auth & Security

**API Keys:** Di-hash bcrypt, disimpan di `settings` table. Header: `Authorization: Bearer <key>` atau `x-api-key`.

**Password encryption:** XOR + base64 pakai `ENCRYPTION_KEY` env var.
> ⚠️ Default key di `config.ts` adalah `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6` — WAJIB override di production via `.env`.

**CORS:** Configured via `CORS_ORIGIN` env var.

---

## Relay System

Memungkinkan pool di belakang NAT diakses via public relay server.

- **Modes:** `disabled | client | server | both`
- **Protocol:** CBOR over WebSocket, max 10MB per frame
- **Auth:** Handshake → `auth_ok` + `tunnelId` + `publicUrl`
- **Heartbeat:** 15s interval, timeout 30s
- **Cloudflared:** Binary auto-managed, health check 30s, watchdog 10s, auto-reconnect 5s cooldown

---

## Frontend Dashboard

React 19 SPA di `dashboard/`. Build terpisah dari backend.

**Auth gate:** `App.tsx` cek `localStorage("api_key")` → `POST /api/keys/test`. Semua routes di balik satu boolean check.

**State management:** 3 Context only — `ThemeContext`, `WsContext`, auth prop-drill. Tidak ada Redux/Zustand.

**WebSocket:** `useWsEvent(type, handler)` untuk subscribe ke named events. Events: `request_log`, `account_status`, `account_updated`.

**API client:** `dashboard/src/lib/api.ts` — semua HTTP calls lewat `fetchApi()`. Base URL = `backend_port - 1`.

**Key pages:** Dashboard, Accounts (tabbed per provider), Requests (live log), Usage, Settings, BotLogs, VccPool, ProxyPool, ImageStudio, FilterRules, Relay, Integration.

---

## Environment Variables (Key)

Lihat `src/config.ts` untuk lengkapnya.

```bash
# Wajib di production
ENCRYPTION_KEY=<random-32-char>      # Enkripsi password akun
API_KEY=<your-api-key>               # Auth ke proxy endpoint

# Ports
PORT=1930                            # Backend port
DASHBOARD_PORT=1931                  # Dashboard port

# DB
DATABASE_PATH=data/poolprox3.db      # Path ke SQLite file

# Privacy
POOLPROX_LOG_BODY_REDACT=true        # Redact prompt content dari logs

# Debug

# Relay
RELAY_MODE=disabled                  # disabled|client|server|both
```

---

## Testing

**Test runner:** `bun:test` (Jest-compatible, discovery by convention).

```bash
bun test                              # Semua tests
bun test test/proxy/routing.test.ts  # Single file
```

**10 test files:**

| File | Coverage |
|---|---|
| `test/proxy/routing.test.ts` | 30+ model→provider routing cases |
| `test/proxy/anthropic-transform.test.ts` | Bidirectional format conversion |
| `test/proxy/kiro-request.test.ts` | AWS CodeWhisperer request builders |
| `test/proxy/kiro-history.test.ts` | History format handling |
| `test/proxy/filters.test.ts` | PUDIDIL filter engine |
| `test/proxy/byok-provider.test.ts` | Integration test dengan real SQLite |
| `test/proxy/canva-provider.test.ts` | Canva provider |
| `test/proxy/qoder-provider.test.ts` | Qoder protocol |
| `test/auth/logs.test.ts` | Auth queue logging |
| `src/proxy/compression/compression.test.ts` | Semua 6 compression stages (671 baris) — **co-located dengan source** |

> ⚠️ `compression.test.ts` sengaja co-located di `src/proxy/compression/`, bukan di `test/`. Run dengan: `bun test src/proxy/compression/`

**Test philosophy:** Characterization tests — mengunci behavior saat ini. Kalau ubah behavior, update test dulu.

**Tidak ada CI/CD.** Run `bun test` manual sebelum merge.

---

## Hal yang JANGAN Dilakukan

1. **Jangan hapus atau reset `scripts/cookies/`** — itu live session state akun
2. **Jangan pakai default `ENCRYPTION_KEY`** di production — sudah publicly known
3. **Jangan commit `.env` atau file cookies** ke git
4. **Jangan pakai `npm` atau `node`** — project ini Bun-only
5. **Jangan log prompt content** tanpa `POOLPROX_LOG_BODY_REDACT=true` di production
6. **Jangan ubah schema DB** tanpa menambahkan migrasi idempotent di `migrate.ts`
7. **Jangan rotasi `ENCRYPTION_KEY`** tanpa decrypt-then-re-encrypt semua passwords di DB dulu — instant lockout

---

## File Map Penting

| File | Peran |
|---|---|
| `src/config.ts` | Semua env vars — baca ini dulu sebelum konfigurasi apapun |
| `src/db/schema.ts` | Source of truth semua tabel + TypeScript types |
| `src/db/migrate.ts` | Bootstrap DDL + idempotent column additions |
| `src/index.ts` | App bootstrap, middleware chain, route mounting |
| `src/proxy/router.ts` | Pipeline utama request → response |
| `src/proxy/pool.ts` | `AccountPool` class — core LB logic |
| `src/proxy/filters.ts` | PUDIDIL content filter engine |
| `src/proxy/compression/index.ts` | `compressRequest()` orchestrator — entry point compression pipeline |
| `src/proxy/providers/registry.ts` | Provider priority order + model routing |
| `src/proxy/providers/base.ts` | `BaseProvider` abstract class + shared types |
| `src/proxy/transforms/anthropic.ts` | Bidirectional Anthropic ↔ OpenAI format conversion |
| `src/auth/queue.ts` | `LoginQueue` — browser automation job queue |
| `src/auth/warmup-scheduler.ts` | Recurring auto-warmup timer |
| `src/auth/canva-team.ts` | Canva team management (spawns Python scripts) |
| `src/relay/protocol.ts` | CBOR WebSocket tunnel protocol |
| `src/relay/tunnel/manager.ts` | Cloudflared process lifecycle |
| `src/lib/bin-data.ts` | VCC BIN list (dipakai `src/api/vcc.ts`) |
| `src/lib/client-configs/` | AI client config generators (Cursor, VS Code, OpenCode, dll.) |
| `src/utils/crypto.ts` | XOR+base64 encrypt/decrypt passwords |
| `src/services/proxy-pool.ts` | Egress HTTP/SOCKS5 proxy selection + rotation |
| `dashboard/src/lib/api.ts` | Frontend HTTP client — semua calls lewat sini |
| `dashboard/src/App.tsx` | Auth gate + route tree |
| `scripts/auth/login.py` | Python browser automation bot (entry point) |
| `scripts/auth/app/providers/` | Python provider adapters per-service |
| `docs/compression.md` | Deep-dive arsitektur compression pipeline |
