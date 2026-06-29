import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type StreamChunk,
  type ModelInfo,
  type ProviderResult,
  type ProviderHealthResult,
} from "./base";
import type { Account } from "../../db/schema";
import { decrypt } from "../../utils/crypto";
import { config } from "../../config";
import { KiroProvider } from "./kiro";

// Lazy Kiro singleton — only instantiated when Antigravity fallback is needed
let _kiroFallback: KiroProvider | null = null;
function getKiroFallback(): KiroProvider {
  if (!_kiroFallback) _kiroFallback = new KiroProvider({ variant: "standard" });
  return _kiroFallback;
}

// ============================================================================
// Antigravity Constants (synced with 9router registry)
// ============================================================================

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 min buffer

const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

// 9router IDE fingerprint
const AG_IDE_VERSION = "antigravity/1.107.0";

// ============================================================================
// Model definitions (9router registry models)
// ============================================================================

const ANTIGRAVITY_MODELS: ModelInfo[] = [
  // ── Antigravity quota (Gemini models with thinking) ────────────────────────
  {
    id: "ag/gemini-3-pro",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3.1-pro",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3-flash",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/claude-sonnet-4-6",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/claude-opus-4-6-thinking",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  // ── 9router models: reasoning_effort tiered ────────────────────────────────
  {
    id: "ag/gemini-3-flash-agent",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3.5-flash-high",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3.5-flash-low",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3.5-flash-extra-low",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-pro-agent",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3.1-pro-low",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gpt-oss-120b-medium",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  // ── Gemini CLI quota (no thinking) ─────────────────────────────────────────
  {
    id: "ag/gemini-2.5-flash",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: false,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-2.5-pro",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: false,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3-flash-preview",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: false,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3-pro-preview",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3.1-pro-preview",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/gemini-3.1-pro-preview-customtools",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  // ── Image generation models ────────────────────────────────────────────────
  {
    id: "ag/gemini-3.1-flash-image",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: false,
    vision: true,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  // ── Legacy aliases ─────────────────────────────────────────────────────────
  {
    id: "ag/gemini-3-pro-image",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: false,
    vision: true,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/claude-sonnet-4-5",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
  {
    id: "ag/claude-opus-4-5",
    object: "model",
    created: 1677610602,
    owned_by: "antigravity",
    context_window: 200000,
    max_output: 65536,
    thinking: true,
    vision: false,
    creditUnit: "token",
    creditRate: 1 / 1_000_000,
    creditSource: "upstream",
  },
];

// ============================================================================
// Token and account types
// ============================================================================

interface AntigravityTokens {
  refresh_token?: string;
  project_id?: string;
  managed_project_id?: string;
  access_token?: string;
  access_expires_at?: number;
  email?: string;
  quota_remaining?: number;
  onboarded?: boolean;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content: {
    role: string;
    parts: GeminiPart[];
  };
  finishReason?: string;
  safetyRatings?: unknown[];
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { code: number; message: string; status: string };
}

// ============================================================================
// Schema sanitization (9router cleanJSONSchemaForAntigravity)
// ============================================================================

// Constraints Gemini API truly does NOT support (9router cleanJSONSchemaForAntigravity verified)
// ponytail: only strip what's actually broken — minLength, maxLength, enum, pattern, minimum, maximum, etc. are all supported
const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  "$schema", "$defs", "definitions", "const", "$ref", "$comment",
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  "anyOf", "oneOf", "allOf", "not",
  "dependencies", "dependentSchemas", "dependentRequired",
  "if", "then", "else",
  "contentMediaType", "contentEncoding",
  // UI-only constraints that Gemini doesn't understand
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor",
];

function cleanJSONSchemaForAntigravity(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;

  // Phase 1: Strip unsupported constraints
  let cleaned = JSON.parse(JSON.stringify(schema));
  for (const field of UNSUPPORTED_SCHEMA_CONSTRAINTS) {
    if (cleaned && typeof cleaned === "object" && field in cleaned) {
      delete (cleaned as Record<string, unknown>)[field];
    }
  }

  // Phase 2: Flatten anyOf/oneOf → first alternative
  function flattenAnyOfOneOf(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach(flattenAnyOfOneOf); return; }
    const rec = obj as Record<string, unknown>;
    if (rec.anyOf && Array.isArray(rec.anyOf) && rec.anyOf.length > 0) {
      const first = rec.anyOf[0];
      if (first && typeof first === "object") {
        delete rec.anyOf;
        Object.assign(rec, first);
      } else { delete rec.anyOf; }
    }
    if (rec.oneOf && Array.isArray(rec.oneOf) && rec.oneOf.length > 0) {
      const first = rec.oneOf[0];
      if (first && typeof first === "object") {
        delete rec.oneOf;
        Object.assign(rec, first);
      } else { delete rec.oneOf; }
    }
    for (const v of Object.values(rec)) flattenAnyOfOneOf(v);
  }
  flattenAnyOfOneOf(cleaned);

  // Phase 3: Merge allOf
  function mergeAllOf(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) { obj.forEach(mergeAllOf); return; }
    const rec = obj as Record<string, unknown>;
    if (rec.allOf && Array.isArray(rec.allOf)) {
      const merged: Record<string, unknown> = {};
      for (const part of rec.allOf) {
        if (part && typeof part === "object" && !Array.isArray(part)) {
          Object.assign(merged, part);
        }
      }
      delete rec.allOf;
      // Preserve non-allOf keys
      const { allOf, ...rest } = rec;
      Object.assign(rec, merged, rest);
    }
    for (const v of Object.values(rec)) mergeAllOf(v);
  }
  mergeAllOf(cleaned);

  // Phase 4: Strip invalid required properties
  function cleanupRequired(obj: unknown): void {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    const rec = obj as Record<string, unknown>;
    if (rec.type === "object" && Array.isArray(rec.required) && rec.properties && typeof rec.properties === "object") {
      const validRequired = (rec.required as string[]).filter(
        (field: string) => (rec.properties as Record<string, unknown>).hasOwnProperty(field)
      );
      rec.required = validRequired.length > 0 ? validRequired : undefined;
    }
    for (const v of Object.values(rec)) cleanupRequired(v);
  }
  cleanupRequired(cleaned);

  // Phase 5: Placeholder for empty object schemas (Gemini API requirement)
  function addPlaceholders(obj: unknown): void {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    const rec = obj as Record<string, unknown>;
    if (rec.type === "object" && (!rec.properties || Object.keys(rec.properties as object).length === 0)) {
      rec.properties = {
        reason: { type: "string", description: "Brief explanation of why you are calling this tool" },
      };
      rec.required = ["reason"];
    }
    for (const v of Object.values(rec)) addPlaceholders(v);
  }
  addPlaceholders(cleaned);

  return cleaned;
}

// ============================================================================
// Tool cloaking (9router _ide suffix + sanitizeFunctionName)
// ============================================================================

function sanitizeGeminiFunctionName(name: string): string {
  if (!name) return "_unknown";
  let sanitized = name.replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = "_" + sanitized;
  return sanitized.substring(0, 64);
}

// ============================================================================
// Client-Metadata headers (9router fingerprint)
// ============================================================================

function getPlatformEnum(): number {
  const ua = globalThis.navigator?.userAgent || process.env.USER_AGENT || "";
  const lower = ua.toLowerCase();
  if (lower.includes("win")) return 3; // WINDOWS
  if (lower.includes("linux")) return 2; // LINUX
  return 1; // MAC
}

function buildClientMetadata(ideType = 9, pluginType = 2): string {
  return JSON.stringify({
    ideType,
    platform: getPlatformEnum(),
    pluginType,
  });
}

function buildHeaders(accessToken: string, model: string): Record<string, string> {
  const isClaude = model.toLowerCase().includes("claude");

  if (isClaude) {
    return {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "google-api-nodejs-client/9.15.1",
      "X-Goog-Api-Client": "gl-node/22.17.0",
      "X-Goog-Request-Source": "local",
      "Client-Metadata": buildClientMetadata(0, 2),
    };
  }

  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": `${AG_IDE_VERSION} darwin/arm64`,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "X-Goog-Request-Source": "local",
    "Client-Metadata": buildClientMetadata(9, 2),
  };
}

// ============================================================================
// Thinking budget mapping (reasoning_effort → thinkingConfig.thinkingBudget)
// ============================================================================

function effortToThinkingBudget(effort?: string): number | undefined {
  switch (effort) {
    case "low": return 256;
    case "medium": return 1024;
    case "high": return 2048;
    default: return undefined;
  }
}

function budgetToEffort(budget: number): string | undefined {
  if (budget >= 2048) return "high";
  if (budget >= 1024) return "medium";
  if (budget > 0) return "low";
  return undefined;
}

// ============================================================================
// Model resolution (9router model names + legacy aliases)
// ============================================================================

function resolveModelName(model: string): string {
  const clean = model.startsWith("ag/") ? model.slice(3) : model;

  const mapping: Record<string, string> = {
    // 9router agent models
    "gemini-3-flash-agent": "gemini-3-flash-agent",
    "gemini-pro-agent": "gemini-pro-agent",
    // 9router tiered thinking models
    "gemini-3.5-flash-high": "gemini-3-flash-agent",
    "gemini-3.5-flash-low": "gemini-3-flash-agent",
    "gemini-3.5-flash-extra-low": "gemini-3-flash-agent",
    "gemini-3.1-pro-low": "gemini-3.1-pro-low",
    // GPT-OSS
    "gpt-oss-120b-medium": "gpt-oss-120b-medium",
    // Core Antigravity models
    "gemini-3-pro": "gemini-3-pro",
    "gemini-3.1-pro": "gemini-3.1-pro",
    "gemini-3-flash": "gemini-3-flash",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
    // Gemini CLI quota models
    "gemini-3-flash-preview": "gemini-3-flash-preview",
    "gemini-3-pro-preview": "gemini-3-pro-preview",
    "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools": "gemini-3.1-pro-preview-customtools",
    // Image models
    "gemini-3.1-flash-image": "gemini-3.1-flash-image",
    // Legacy aliases
    "gemini-3-pro-image": "gemini-3-pro",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-opus-4-5": "claude-opus-4-5",
    "antigravity-gemini-3-pro": "gemini-3-pro",
    "antigravity-gemini-3.1-pro": "gemini-3.1-pro",
    "antigravity-gemini-3-flash": "gemini-3-flash",
    "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6",
    "antigravity-claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
  };

  return mapping[clean] || clean;
}

function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

function getTierFromModel(model: string): string | undefined {
  if (model.includes("high")) return "high";
  if (model.includes("extra-low")) return "extra-low";
  if (model.includes("low")) return "low";
  return undefined;
}

// ============================================================================
// Token refresh
// ============================================================================

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number; refresh_token?: string } | null> {
  let proxy: any = null;
  try {
    const { getNextProxy } = await import("../../services/proxy-pool");
    proxy = await getNextProxy("model");
  } catch { /* ignore */ }

  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.antigravityClientId,
        client_secret: config.antigravityClientSecret,
      }),
      ...(proxy ? { proxy: proxy.url } : {}),
    } as any);

    if (response.status !== 200) {
      const error = (await response.json().catch(() => null)) as any;
      if (error?.error === "invalid_grant") {
        throw new Error(`Refresh token revoked: ${error.error_description || "invalid_grant"}`);
      }
      return null;
    }

    return await response.json() as any;
  } catch (err: any) {
    if (err instanceof Error && err.message.includes("revoked")) throw err;
    return null;
  }
}

// ============================================================================
// Project ID resolution (loadCodeAssist — 9router pattern)
// ============================================================================

export async function fetchProjectId(accessToken: string): Promise<string | null> {
  const endpoints = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  ];

  let proxy: any = null;
  try {
    const { getNextProxy } = await import("../../services/proxy-pool");
    proxy = await getNextProxy("model");
  } catch { /* ignore */ }

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const url = `${endpoint}/v1internal:loadCodeAssist`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "google-api-nodejs-client/9.15.1",
          "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
      "Client-Metadata": buildClientMetadata(0, 2),
        },
        body: JSON.stringify({
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
        signal: controller.signal,
        ...(proxy ? { proxy: proxy.url } : {}),
      } as any);

      if (res.ok) {
        const data = await res.json() as any;
        const projectId = data?.cloudaicompanionProject || data?.project || data?.projectId;
        if (projectId && typeof projectId === "string") return projectId;

        const allowedTiers: any[] = data?.allowedTiers || [];
        const hasUserDefined = allowedTiers.some((t: any) => t.userDefinedCloudaicompanionProject === true);
        if (hasUserDefined) return "__user_defined__";
      }
    } catch { /* continue */ } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ============================================================================
// AvailableModels quota check (9router fetchAvailableModels)
// ============================================================================

async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number }; error?: string }> {
  const endpoint = "https://cloudcode-pa.googleapis.com";
  const url = `${endpoint}/v1internal:fetchAvailableModels`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout — non-blocking

  let proxy: any = null;
  try {
    const { getNextProxy } = await import("../../services/proxy-pool");
    proxy = await getNextProxy("model");
  } catch { /* ignore */ }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Goog-Request-Source": "local",
      },
      body: JSON.stringify({ project: projectId }),
      signal: controller.signal,
      ...(proxy ? { proxy: proxy.url } : {}),
    } as any);

    if (!res.ok) {
      return { success: false, error: `fetchAvailableModels failed: ${res.status}` };
    }

    const data = await res.json() as any;
    const model = data?.models?.[0];
    if (!model) return { success: false, error: "No models in response" };

    const limit = model?.quota?.maxUsageLimit || 1_000_000;
    const remaining = model?.quota?.remainingUsage || limit;
    const used = limit - remaining;

    return { success: true, quota: { limit, remaining, used } };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Account credential extraction
// ============================================================================

function getCredentials(account: Account): AntigravityTokens | null {
  try {
    const tokens: AntigravityTokens = typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : (account.tokens as AntigravityTokens) || {};

    let refreshToken = tokens.refresh_token || "";
    let projectId = tokens.project_id || "";
    let managedProjectId = tokens.managed_project_id || "";

    if (refreshToken.includes("|")) {
      const parts = refreshToken.split("|");
      refreshToken = parts[0] || "";
      projectId = projectId || (parts[1] || "");
      managedProjectId = managedProjectId || (parts[2] || "");
    }

    if (!refreshToken) return null;

    return {
      refresh_token: refreshToken,
      project_id: projectId,
      managed_project_id: managedProjectId,
      access_token: tokens.access_token || "",
      access_expires_at: tokens.access_expires_at || 0,
      email: tokens.email || account.email,
      quota_remaining: tokens.quota_remaining,
      onboarded: tokens.onboarded,
    };
  } catch {
    return null;
  }
}

async function getValidAccessToken(account: Account): Promise<{ accessToken: string; newTokens?: any } | null> {
  const creds = getCredentials(account);
  if (!creds) return null;

  const now = Date.now();
  let accessToken = creds.access_token;
  let newExpiry = creds.access_expires_at;
  let hasNewTokens = false;

  const isTokenExpired = !accessToken || !newExpiry || newExpiry <= now + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
  if (isTokenExpired) {
    try {
      const tokens = await refreshAccessToken(creds.refresh_token!);
      if (!tokens) {
        return null;
      }
      accessToken = tokens.access_token;
      newExpiry = now + (tokens.expires_in * 1000);
      hasNewTokens = true;
    } catch (err: any) {
      return null;
    }
  }

  let projectId = creds.project_id;
  if (!projectId && accessToken) {
    const fetched = await fetchProjectId(accessToken);
    if (fetched) { projectId = fetched; hasNewTokens = true; }
  }

  // Fire-and-forget quota refresh — NEVER blocks token return
  // ponytail: best-effort only, upgrade to blocking if quota accuracy becomes critical
  if (accessToken && projectId && projectId !== "__user_defined__") {
    try {
      const quota = await fetchAvailableModels(accessToken, projectId);
      if (quota.success && quota.quota) {
        hasNewTokens = true;
        const newTokensBlob = {
          refresh_token: projectId ? `${creds.refresh_token}|${projectId}` : creds.refresh_token,
          access_token: accessToken!,
          access_expires_at: newExpiry!,
          email: creds.email,
          project_id: projectId,
          managed_project_id: creds.managed_project_id,
          quota_remaining: quota.quota.remaining,
        };
        return { accessToken, newTokens: newTokensBlob };
      }
    } catch {
      // Quota check failed — continue with existing tokens
    }
  }

  if (hasNewTokens) {
    const stored_refresh = projectId ? `${creds.refresh_token}|${projectId}` : creds.refresh_token;
    const newTokensBlob = {
      refresh_token: stored_refresh,
      access_token: accessToken!,
      access_expires_at: newExpiry!,
      email: creds.email,
      project_id: projectId,
      managed_project_id: creds.managed_project_id,
    };
    return { accessToken: accessToken!, newTokens: newTokensBlob };
  }

  return { accessToken: accessToken! };
}

// ============================================================================
// OpenAI → Gemini format conversion (9router openaiToGeminiCLIRequest pattern)
// ============================================================================

function openAiToGeminiMessages(messages: ChatMessage[]): { contents: GeminiContent[]; systemInstruction: string | null } {
  const contents: GeminiContent[] = [];
  let systemInstruction: string | null = null;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      continue;
    }

    const parts: GeminiPart[] = [];

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push({ text: part.text });
        } else if (part.type === "image_url" && part.image_url) {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
          if (url.startsWith("data:")) {
            const match = url.match(/^data:(.+?);base64,(.+)$/);
            if (match) {
              parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
            }
          }
        }
      }
    }

    if (parts.length > 0) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }

    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const fnName = sanitizeGeminiFunctionName(tc.function?.name || "_unknown");
        try {
          const args = typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : (tc.function?.arguments || {});
          parts.push({ functionCall: { name: fnName, args } });
        } catch { /* skip malformed tool call */ }
      }
    }

    if (msg.tool_call_id && msg.content) {
      contents.push({
        role: "function",
        parts: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }],
      });
    }
  }

  return { contents, systemInstruction };
}

// ============================================================================
// Gemini request building (9router wrapInCloudCodeEnvelope pattern)
// ============================================================================

function buildInnerGeminiRequest(
  request: ChatCompletionRequest,
  stream: boolean,
): Record<string, unknown> {
  const { contents, systemInstruction } = openAiToGeminiMessages(request.messages);

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.max_tokens ?? 8192,
    temperature: request.temperature ?? 1.0,
    topP: request.top_p ?? 0.95,
  };

  // Thinking budget mapping from reasoning_effort
  const reqAny = request as any;
  if (request.reasoning_effort || reqAny.reasoning) {
    const effort = request.reasoning_effort || reqAny.reasoning;
    const budget = effortToThinkingBudget(effort);
    if (budget !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget: budget };
    }
  }

  // Also check model-based tier
  const tier = getTierFromModel(request.model);
  if (tier && !generationConfig.thinkingConfig) {
    const budget = effortToThinkingBudget(tier);
    if (budget !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget: budget };
    }
  }

  if (stream) generationConfig.candidateCount = 1;

  const inner: Record<string, unknown> = { contents, generationConfig };

  if (systemInstruction) {
    inner.systemInstruction = {
      role: "system",
      parts: [{ text: systemInstruction }],
    };
  }

  // Tools with schema sanitization and cloaking
  const hasTools = request.messages.some((m) => m.role === "assistant" && m.tool_calls);
  if (hasTools || request.tools) {
    const functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> = [];

    // Extract from OpenAI tools if present
    if (request.tools) {
      for (const tool of request.tools) {
        if (tool.type === "function" && tool.function) {
          const fn = tool.function;
          const sanitizedName = sanitizeGeminiFunctionName(fn.name);
          functionDeclarations.push({
            name: sanitizedName,
            description: fn.description || "",
            parameters: fn.parameters ? cleanJSONSchemaForAntigravity(fn.parameters) : { type: "object", properties: {} },
          });
        }
      }
    }

    if (functionDeclarations.length > 0) {
      inner.tools = [{ functionDeclarations }];
    }
  }

  return inner;
}

function needsProject(projectId: string): boolean {
  // ponytail: no project → fallback to Kiro
  const p = (projectId || "").trim();
  return !!(p && p !== "__user_defined__" && p !== "default");
}

function buildGeminiBody(
  request: ChatCompletionRequest,
  stream: boolean,
  projectId: string,
): Record<string, unknown> {
  const geminiModel = resolveModelName(request.model);
  const body: Record<string, unknown> = {
    model: geminiModel,
    request: buildInnerGeminiRequest(request, stream),
  };
  const cleanProject = (projectId || "").trim();
  if (needsProject(cleanProject)) body.project = cleanProject;
  return body;
}



// ============================================================================
// Response parsing
// ============================================================================

function extractTextFromGeminiResponse(response: GeminiResponse): string {
  if (!response.candidates || response.candidates.length === 0) {
    if (response.error) return `Error: ${response.error.message}`;
    return "";
  }

  const candidate = response.candidates[0];
  const parts = candidate?.content?.parts || [];
  const texts: string[] = [];

  for (const part of parts) {
    // Extract text but skip thought blocks for content (9router pattern)
    if (part.text && !part.thought) {
      texts.push(part.text);
    }
  }

  return texts.join("");
}

function extractReasoningFromGeminiResponse(response: GeminiResponse): string {
  if (!response.candidates) return "";
  const parts = response.candidates[0]?.content?.parts || [];
  const thoughts: string[] = [];
  for (const part of parts) {
    if (part.thought && part.text) thoughts.push(part.text);
  }
  return thoughts.join("");
}

function extractUsageFromGeminiResponse(response: GeminiResponse): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
} {
  const usage = response.usageMetadata;
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // 9router pattern: fold thoughts into completion tokens
  const thoughts = usage.thoughtsTokenCount || 0;
  const candidates = usage.candidatesTokenCount || 0;

  return {
    prompt_tokens: usage.promptTokenCount || 0,
    completion_tokens: candidates + thoughts, // Fold thinking into completion
    total_tokens: usage.totalTokenCount || 0,
    reasoning_tokens: thoughts > 0 ? thoughts : undefined,
    cached_tokens: usage.cachedContentTokenCount || undefined,
  };
}

// ============================================================================
// Transient error patterns (9router Antigravity-specific)
// ============================================================================

function isAntigravityRetriable(status: number, body: string): boolean {
  if (status >= 500) return true;
  if (status === 429) return true;
  // Specific patterns from 9router
  if (status === 400 && (
    body.includes("RESOURCE_EXHAUSTED") ||
    body.includes("RATE_LIMIT_EXCEEDED") ||
    body.includes("DEADLINE_EXCEEDED")
  )) return true;
  if (status === 408) return true;
  if (status === 503) return true;
  return false;
}

// ============================================================================
// Provider class
// ============================================================================

export class AntigravityProvider extends BaseProvider {
  name = "antigravity";
  override nativeFormat: "openai" | "anthropic" = "openai";
  override isFallback = false;

  override get supportedModels(): ModelInfo[] {
    return ANTIGRAVITY_MODELS;
  }

  override ownsModel(model: string): boolean {
    // ag/ prefix routing
    if (model.startsWith("ag/")) return true;
    // Bare model names (legacy compatibility: gemini-2.5-pro, etc.)
    const clean = model.startsWith("ag/") ? model.slice(3) : model;
    const legacyBare = [
      "gemini-2.5-pro", "gemini-2.5-flash",
      "gemini-3-pro", "gemini-3.1-pro", "gemini-3-flash",
      "gemini-3-flash-preview", "gemini-3-pro-preview",
      "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
      "gemini-3-pro-image", "gemini-3.1-flash-image",
      "claude-sonnet-4-6", "claude-opus-4-6-thinking",
      "claude-sonnet-4-5", "claude-opus-4-5",
      "gemini-3-flash-agent", "gemini-pro-agent",
      "gemini-3.5-flash-high", "gemini-3.5-flash-low", "gemini-3.5-flash-extra-low",
      "gemini-3.1-pro-low", "gpt-oss-120b-medium",
    ];
    return legacyBare.includes(clean);
  }

  override async chatCompletion(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const auth = await getValidAccessToken(account);
    if (!auth) return { success: false, error: "Failed to obtain access token" };
    const { accessToken, newTokens } = auth;

    const creds = newTokens ? newTokens : getCredentials(account);
    const projectId = creds?.project_id || "";

    // Fallback to Kiro when account has no Cloud Code project
    if (!needsProject(projectId)) {
      const kiroResult = await getKiroFallback().chatCompletion(account, request);
      if (kiroResult.success) {
        // Rewrite model field to match Antigravity response format
        if (kiroResult.response) {
          kiroResult.response.model = request.model;
        }
      }
      return kiroResult;
    }

    // ponytail: all models go through Gemini format — CloudCode handles Claude internally
    const bodyStr = JSON.stringify(buildGeminiBody(request, false, projectId));
    const headers = buildHeaders(accessToken, request.model);

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      const url = `${endpoint}/v1internal:generateContent`;
      try {
        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers,
          body: bodyStr,
        });

        const text = await response.text();

        if (response.ok) {
          let parsedRes: any;
          try {
            const parsed = JSON.parse(text);
            parsedRes = parsed?.response || parsed;
          } catch { parsedRes = {}; }

          const usage = extractUsageFromGeminiResponse(parsedRes);
          const choice: any = {
            index: 0,
            message: { role: "assistant", content: extractTextFromGeminiResponse(parsedRes) },
            finish_reason: "stop",
          };

          // Include reasoning in response if present
          const reasoning = extractReasoningFromGeminiResponse(parsedRes);
          if (reasoning) choice.message.reasoning = reasoning;

          // Build usage object with details
          const usageObj: any = {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
          };
          if (usage.reasoning_tokens) usageObj.completion_tokens_details = { reasoning_tokens: usage.reasoning_tokens };
          if (usage.cached_tokens) usageObj.prompt_tokens_details = { cached_tokens: usage.cached_tokens };

          return {
            success: true,
            response: {
              id: this.generateId(),
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [choice],
              usage: usageObj,
            },
            tokens: newTokens || undefined,
          };
        }

        if (isAntigravityRetriable(response.status, text)) {
          continue;
        }

        return { success: false, error: `Antigravity API error: ${response.status} ${text}` };
      } catch (err: any) {
        continue;
      }
    }

    return { success: false, error: "All Antigravity endpoints failed" };
  }

  override async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const auth = await getValidAccessToken(account);
    if (!auth) return { success: false, error: "Failed to obtain access token" };
    const { accessToken, newTokens } = auth;

    const creds = newTokens ? newTokens : getCredentials(account);
    const projectId = creds?.project_id || "";

    // Fallback to Kiro when account has no Cloud Code project
    if (!needsProject(projectId)) {
      const kiroResult = await getKiroFallback().chatCompletionStream(account, request);
      return kiroResult;
    }

    const isClaude = isClaudeModel(request.model);
    let bodyStr: string;
    let headers: Record<string, string>;

    // ponytail: all models go through Gemini format — CloudCode handles Claude internally
    bodyStr = JSON.stringify(buildGeminiBody(request, true, projectId));
    headers = buildHeaders(accessToken, request.model);

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
      try {
        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers,
          body: bodyStr,
        });

        if (response.ok) {
          return {
            success: true,
            stream: response.body as unknown as ReadableStream<Uint8Array>,
            tokens: newTokens || undefined,
          };
        }

        const text = await response.text();

        if (isAntigravityRetriable(response.status, "")) {
          continue;
        }

        return { success: false, error: `Antigravity API error: ${response.status} ${text}` };
      } catch (err: any) {
        continue;
      }
    }

    return { success: false, error: "All Antigravity endpoints failed" };
  }

  override async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const creds = getCredentials(account);
    if (!creds?.refresh_token) return { success: false, error: "Missing refresh token" };

    try {
      const tokens = await refreshAccessToken(creds.refresh_token);
      if (!tokens) return { success: false, error: "Failed to refresh token" };

      const now = Date.now();
      const newExpiry = now + (tokens.expires_in * 1000);

      let projectId = creds.project_id;
      if (!projectId && tokens.access_token) {
        const fetched = await fetchProjectId(tokens.access_token);
        if (fetched) projectId = fetched;
      }

      // Fetch quota if available
      let quotaRemaining: number | undefined;
      if (projectId && projectId !== "__user_defined__" && tokens.access_token) {
        const quota = await fetchAvailableModels(tokens.access_token, projectId);
        if (quota.success && quota.quota) quotaRemaining = quota.quota.remaining;
      }

      const stored_refresh = projectId ? `${tokens.refresh_token || creds.refresh_token}|${projectId}` : tokens.refresh_token || creds.refresh_token;
      const newTokensBlob = {
        refresh_token: stored_refresh,
        access_token: tokens.access_token,
        access_expires_at: newExpiry,
        email: creds.email,
        project_id: projectId,
        managed_project_id: creds.managed_project_id,
        quota_remaining: quotaRemaining,
      };

      return { success: true, tokens: JSON.stringify(newTokensBlob) };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  override async validateAccount(account: Account): Promise<boolean> {
    const creds = getCredentials(account);
    return !!(creds?.refresh_token);
  }

  override async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt: Date | null };
    error?: string;
  }> {
    const auth = await getValidAccessToken(account);
    if (!auth) {
      const remaining = account.quotaRemaining ?? 1_000_000;
      const limit = account.quotaLimit ?? 1_000_000;
      return { success: true, quota: { limit, remaining, used: limit - remaining, resetAt: null } };
    }

    const { accessToken } = auth;
    const creds = getCredentials(account);
    const projectId = creds?.project_id || "";

    if (projectId && projectId !== "__user_defined__") {
      const quota = await fetchAvailableModels(accessToken, projectId);
      if (quota.success && quota.quota) {
        return {
          success: true,
          quota: {
            limit: quota.quota.limit,
            remaining: quota.quota.remaining,
            used: quota.quota.used,
            resetAt: null,
          },
        };
      }
    }

    const remaining = account.quotaRemaining ?? 1_000_000;
    const limit = account.quotaLimit ?? 1_000_000;
    return { success: true, quota: { limit, remaining, used: limit - remaining, resetAt: null } };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const auth = await getValidAccessToken(account);
    if (!auth) return { kind: "auth_error", success: false, error: "Failed to refresh access token" };
    const { accessToken, newTokens } = auth;

    const creds = newTokens ? newTokens : getCredentials(account);
    const projectId = creds?.project_id || "default";

    try {
      const endpoint = ANTIGRAVITY_ENDPOINTS[0] || "https://daily-cloudcode-pa.sandbox.googleapis.com";
      const url = `${endpoint}/v1internal:generateContent`;
      const headers = buildHeaders(accessToken, "gemini-3-flash");
      const body = JSON.stringify({
        project: projectId,
        model: "gemini-3-flash",
        request: {
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          generationConfig: { maxOutputTokens: 1, temperature: 0 },
        },
      });

      const response = await this.fetchWithTimeout(url, { method: "POST", headers, body });

      if (response.ok) {
        return {
          kind: "healthy",
          success: true,
          tokens: newTokens || undefined,
          quota: {
            limit: 1_000_000,
            remaining: account.quotaRemaining ?? 1_000_000,
            used: 1_000_000 - (account.quotaRemaining ?? 1_000_000),
            resetAt: null,
            source: "antigravity.health_check",
          },
        };
      }

      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_error", success: false, error: `Auth failed: ${response.status}` };
      }
      if (response.status === 429) {
        return { kind: "exhausted", success: false, error: "Rate limited" };
      }

      return {
        kind: "transient_error",
        success: false,
        retryable: response.status >= 500,
        error: `Health check ${response.status}: ${text.slice(0, 200)}`,
      };
    } catch (err) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
