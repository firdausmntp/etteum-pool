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

// ============================================================================
// Antigravity Constants
// ============================================================================

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 min buffer

// Endpoint fallback order
const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

// ============================================================================
// Model definitions
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
  // ── Gemini CLI quota (separate, used as fallback or when cli_first=true) ───
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
  // ── Legacy aliases (auto-routed to correct upstream) ──────────────────────
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
}

interface GeminiPart {
  text?: string;
  thought?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiContent {
  role: "user" | "model";
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
  };
  error?: { code: number; message: string; status: string };
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
  } catch {
    // ignore
  }

  console.log(`[antigravity] refreshAccessToken: Refreshing token with proxy=${proxy ? proxy.url : "none"}`);
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

    console.log(`[antigravity] refreshAccessToken: Response status is ${response.status}`);
    if (response.status !== 200) {
      const error = (await response.json().catch(() => null)) as any;
      console.log(`[antigravity] refreshAccessToken: Error response:`, JSON.stringify(error));
      if (error?.error === "invalid_grant") {
        throw new Error(`Refresh token revoked: ${error.error_description || "invalid_grant"}`);
      }
      return null;
    }

    const data = await response.json();
    console.log(`[antigravity] refreshAccessToken: Refresh successful`);
    return data as any;
  } catch (err: any) {
    console.log(`[antigravity] refreshAccessToken: Exception:`, err?.message || err);
    if (err instanceof Error && err.message.includes("revoked")) throw err;
    return null;
  }
}

export async function fetchProjectId(accessToken: string): Promise<string | null> {
  // Use v1internal:loadCodeAssist to get the cloudaicompanionProject.
  // This does NOT require Cloud Resource Manager API to be enabled.
  const endpoints = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  ];

  let proxy: any = null;
  try {
    const { getNextProxy } = await import("../../services/proxy-pool");
    proxy = await getNextProxy("model");
  } catch {
    // ignore
  }

  console.log(`[antigravity] fetchProjectId: Starting project lookup via loadCodeAssist, proxy=${proxy ? proxy.url : "none"}`);

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const url = `${endpoint}/v1internal:loadCodeAssist`;
    try {
      console.log(`[antigravity] fetchProjectId: POST ${url}`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "antigravity/1.11.5 windows/amd64",
          "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
          "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
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

      console.log(`[antigravity] fetchProjectId: Response status from ${endpoint} is ${res.status}`);
      if (res.ok) {
        const data = await res.json() as any;
        console.log(`[antigravity] fetchProjectId: loadCodeAssist response:`, JSON.stringify(data).slice(0, 500));
        // Case 1: project is auto-assigned by Google (managed tier)
        const projectId = data?.cloudaicompanionProject || data?.project || data?.projectId;
        if (projectId && typeof projectId === "string") {
          console.log(`[antigravity] fetchProjectId: Found managed project_id=${projectId}`);
          return projectId;
        }
        // Case 2: userDefinedCloudaicompanionProject=true → user must supply their own GCP project.
        // We return a special sentinel so callers know to send requests without a project field.
        const allowedTiers: any[] = data?.allowedTiers || [];
        const hasUserDefined = allowedTiers.some((t: any) => t.userDefinedCloudaicompanionProject === true);
        if (hasUserDefined) {
          console.log(`[antigravity] fetchProjectId: userDefinedCloudaicompanionProject=true, will send requests without project field`);
          return "__user_defined__";
        }
      } else {
        const errText = await res.text().catch(() => "");
        console.log(`[antigravity] fetchProjectId: Error response: ${res.status} - ${errText.slice(0, 200)}`);
      }
    } catch (e: any) {
      console.log(`[antigravity] fetchProjectId: Exception for ${endpoint}:`, e?.message || e);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(`[antigravity] fetchProjectId: Failed to resolve project ID from any endpoint`);
  return null;
}

// ============================================================================
// Account credential extraction
// ============================================================================

function getCredentials(account: Account): AntigravityTokens | null {
  try {
    // tokens field stores: { refresh_token, project_id, managed_project_id, email, ... }
    const tokens: AntigravityTokens = typeof account.tokens === "string"
      ? JSON.parse(account.tokens)
      : (account.tokens as AntigravityTokens) || {};

    // refresh_token may be stored as "refresh_token|project_id|managed_project_id" format
    let refreshToken = tokens.refresh_token || "";
    let projectId = tokens.project_id || "";
    let managedProjectId = tokens.managed_project_id || "";

    // If refresh_token contains pipes, parse it
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

  // 1. Check if we need to refresh the access token
  const isTokenExpired = !accessToken || !newExpiry || newExpiry <= now + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
  if (isTokenExpired) {
    try {
      const tokens = await refreshAccessToken(creds.refresh_token!);
      if (!tokens) return null;

      accessToken = tokens.access_token;
      newExpiry = now + (tokens.expires_in * 1000);
      hasNewTokens = true;
    } catch {
      return null;
    }
  }

  // 2. Check if project_id is missing and resolve it dynamically
  let projectId = creds.project_id;
  if (!projectId && accessToken) {
    const fetched = await fetchProjectId(accessToken);
    if (fetched) {
      projectId = fetched;
      hasNewTokens = true;
    }
  }

  if (hasNewTokens) {
    const stored_refresh = projectId
      ? `${creds.refresh_token}|${projectId}`
      : creds.refresh_token;

    const newTokensBlob = {
      refresh_token: stored_refresh,
      access_token: accessToken!,
      access_expires_at: newExpiry!,
      email: creds.email,
      project_id: projectId,
      managed_project_id: creds.managed_project_id,
    };

    return {
      accessToken,
      newTokens: newTokensBlob,
    };
  }

  return { accessToken };
}

// ============================================================================
// OpenAI → Gemini format conversion
// ============================================================================

function openAiToGeminiMessages(messages: ChatMessage[]): GeminiContent[] {
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

    // Include tool results if present
    if (msg.tool_call_id && msg.content) {
      contents.push({
        role: "user",
        parts: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }],
      });
    }
  }

  return contents;
}

function resolveModelName(model: string): string {
  const cleanModel = model.startsWith("ag/") ? model.slice(3) : model;

  const modelMapping: Record<string, string> = {
    // Antigravity quota models
    "gemini-3-pro": "gemini-3-pro",
    "gemini-3.1-pro": "gemini-3.1-pro",
    "gemini-3-flash": "gemini-3-flash",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
    "antigravity-gemini-3-pro": "gemini-3-pro",
    "antigravity-gemini-3.1-pro": "gemini-3.1-pro",
    "antigravity-gemini-3-flash": "gemini-3-flash",
    "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6",
    "antigravity-claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
    // Gemini CLI quota models (preview)
    "gemini-3-flash-preview": "gemini-3-flash-preview",
    "gemini-3-pro-preview": "gemini-3-pro-preview",
    "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools": "gemini-3.1-pro-preview-customtools",
    // Legacy aliases
    "gemini-3-pro-image": "gemini-3-pro",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-opus-4-5": "claude-opus-4-5",
  };

  return modelMapping[cleanModel] || cleanModel;
}

function buildGeminiUrl(endpoint: string, _projectId: string, model: string, stream: boolean): string {
  // Use v1internal endpoints — these work without Cloud Resource Manager API
  // and accept the envelope format { project, model, request: {...} }
  const method = stream ? "streamGenerateContent" : "generateContent";
  return `${endpoint}/v1internal:${method}`;
}

function getHeaders(accessToken: string, model: string): Record<string, string> {
  const cleanModel = model.startsWith("ag/") ? model.slice(3) : model;
  const isAntigravityModel = cleanModel.includes("antigravity") || cleanModel.startsWith("gemini-3") || cleanModel.startsWith("claude-sonnet-4-6") || cleanModel.startsWith("claude-opus-4-6");
  const isClaudeModel = cleanModel.startsWith("claude") || cleanModel.includes("claude");

  if (isClaudeModel) {
    return {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "google-api-nodejs-client/9.15.1",
      "X-Goog-Api-Client": "gl-node/22.17.0",
      "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
    };
  }

  return {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "antigravity/1.11.5 windows/amd64",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
  };
}

function buildInnerGeminiRequest(
  request: ChatCompletionRequest,
  stream: boolean,
): Record<string, unknown> {
  const contents = openAiToGeminiMessages(request.messages);
  const systemMessage = request.messages.find((m) => m.role === "system");
  const systemInstruction = systemMessage
    ? (typeof systemMessage.content === "string" ? systemMessage.content : JSON.stringify(systemMessage.content))
    : null;

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.max_tokens ?? 8192,
    temperature: request.temperature ?? 1.0,
    topP: request.top_p ?? 0.95,
  };

  if (stream) {
    generationConfig.candidateCount = 1;
  }

  const inner: Record<string, unknown> = {
    contents,
    generationConfig,
  };

  if (systemInstruction) {
    inner.systemInstruction = {
      role: "system",
      parts: [{ text: systemInstruction }],
    };
  }

  return inner;
}

function buildGeminiBody(
  request: ChatCompletionRequest,
  stream: boolean,
  projectId: string,
): Record<string, unknown> {
  // v1internal envelope format: { project?, model, request: { contents, ... } }
  // When project is '__user_defined__' or empty, omit the project field entirely.
  const geminiModel = resolveModelName(request.model);
  const needsProject = projectId && projectId !== "__user_defined__" && projectId !== "default" && projectId !== "";
  const body: Record<string, unknown> = {
    model: geminiModel,
    request: buildInnerGeminiRequest(request, stream),
  };
  if (needsProject) {
    body.project = projectId;
  }
  return body;
}

function extractTextFromGeminiResponse(response: GeminiResponse): string {
  if (!response.candidates || response.candidates.length === 0) {
    if (response.error) {
      return `Error: ${response.error.message}`;
    }
    return "";
  }

  const candidate = response.candidates[0];
  const parts = candidate?.content?.parts || [];
  const texts: string[] = [];

  for (const part of parts) {
    // Skip thought blocks, only extract text
    if (part.text && !part.thought) {
      texts.push(part.text);
    }
  }

  return texts.join("");
}

function extractUsageFromGeminiResponse(response: GeminiResponse): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const usage = response.usageMetadata;
  return {
    prompt_tokens: usage?.promptTokenCount || 0,
    completion_tokens: usage?.candidatesTokenCount || 0,
    total_tokens: usage?.totalTokenCount || 0,
  };
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
    return model.startsWith("ag/") || ANTIGRAVITY_MODELS.some((m) => m.id === model);
  }

  override async chatCompletion(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const auth = await getValidAccessToken(account);
    if (!auth) {
      return { success: false, error: "Failed to obtain access token" };
    }
    const { accessToken, newTokens } = auth;

    const creds = newTokens ? newTokens : getCredentials(account);
    const projectId = creds?.project_id || "";

    const body = JSON.stringify(buildGeminiBody(request, false, projectId));
    console.log(`[antigravity] chatCompletion: projectId=${projectId || "(none)"} model=${request.model}`);
    const headers = getHeaders(accessToken, request.model);

    // Try each endpoint in fallback order
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const url = buildGeminiUrl(endpoint, projectId, request.model, false);
        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers,
          body,
        });

        const text = await response.text();

        if (response.ok) {
          // v1internal returns the Gemini response directly or wrapped in a 'response' field
          let parsedRes: any;
          try {
            const parsed = JSON.parse(text);
            parsedRes = parsed?.response || parsed;
          } catch {
            parsedRes = {};
          }
          return {
            success: true,
            response: {
              id: this.generateId(),
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: extractTextFromGeminiResponse(parsedRes) },
                  finish_reason: "stop",
                },
              ],
              usage: extractUsageFromGeminiResponse(parsedRes),
            },
            tokens: newTokens || undefined,
          };
        }

        // Check if it's a retriable error
        if (response.status >= 500 || response.status === 429) {
          continue; // Try next endpoint
        }

        console.log(`[antigravity] chatCompletion: endpoint=${endpoint} status=${response.status} body=${text.slice(0, 300)}`);
        return { success: false, error: `Antigravity API error: ${response.status} ${text}` };
      } catch (err: any) {
        console.log(`[antigravity] chatCompletion: exception at ${endpoint}:`, err?.message);
        continue; // Try next endpoint
      }
    }

    return { success: false, error: "All Antigravity endpoints failed" };
  }

  override async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const auth = await getValidAccessToken(account);
    if (!auth) {
      return { success: false, error: "Failed to obtain access token" };
    }
    const { accessToken, newTokens } = auth;

    const creds = newTokens ? newTokens : getCredentials(account);
    const projectId = creds?.project_id || "";

    const body = JSON.stringify(buildGeminiBody(request, true, projectId));
    // Streaming uses ?alt=sse query param for SSE format
    const headers = getHeaders(accessToken, request.model);

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        // For streaming, append ?alt=sse to get SSE format from v1internal
        const url = buildGeminiUrl(endpoint, projectId, request.model, true) + "?alt=sse";
        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers,
          body,
        });

        if (response.ok) {
          return {
            success: true,
            stream: response.body as unknown as ReadableStream<Uint8Array>,
            tokens: newTokens || undefined,
          };
        }

        if (response.status >= 500 || response.status === 429) {
          continue;
        }

        const text = await response.text();
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

      // Resolve project_id if missing
      let projectId = creds.project_id;
      if (!projectId && tokens.access_token) {
        const fetched = await fetchProjectId(tokens.access_token);
        if (fetched) {
          projectId = fetched;
        }
      }

      const stored_refresh = projectId
        ? `${tokens.refresh_token || creds.refresh_token}|${projectId}`
        : tokens.refresh_token || creds.refresh_token;

      const newTokensBlob = {
        refresh_token: stored_refresh,
        access_token: tokens.access_token,
        access_expires_at: newExpiry,
        email: creds.email,
        project_id: projectId,
        managed_project_id: creds.managed_project_id,
      };

      return {
        success: true,
        tokens: JSON.stringify(newTokensBlob),
      };
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
    // Antigravity uses Google's internal quota — we track via DB
    const remaining = account.quotaRemaining ?? 1_000_000;
    const limit = account.quotaLimit ?? 1_000_000;

    return {
      success: true,
      quota: { limit, remaining, used: limit - remaining, resetAt: null },
    };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const auth = await getValidAccessToken(account);
    if (!auth) {
      return { kind: "auth_error", success: false, error: "Failed to refresh access token" };
    }
    const { accessToken, newTokens } = auth;

    const creds = newTokens ? newTokens : getCredentials(account);
    const projectId = creds?.project_id || "default";

    // Send a minimal test request
    try {
      const endpoint = ANTIGRAVITY_ENDPOINTS[0] || "https://daily-cloudcode-pa.sandbox.googleapis.com";
      const url = buildGeminiUrl(endpoint, projectId, "gemini-3-flash", false);
      const headers = getHeaders(accessToken, "gemini-3-flash");
      const body = JSON.stringify({
        project: projectId,
        model: "gemini-3-flash",
        request: {
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          generationConfig: { maxOutputTokens: 1, temperature: 0 },
        },
      });

      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body,
      });

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
