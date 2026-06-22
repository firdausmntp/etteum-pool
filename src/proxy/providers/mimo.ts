import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
  type ProviderHealthResult,
} from "./base";
import type { Account } from "../../db/schema";
import { decrypt } from "../../utils/crypto";

const MIMO_API_BASE_URL = "https://api.xiaomimimo.com/v1";
const MIMO_PLATFORM_BASE_URL = "https://platform.xiaomimimo.com";
const MIMO_CHAT_URL = `${MIMO_API_BASE_URL}/chat/completions`;
const MIMO_BALANCE_URL = `${MIMO_PLATFORM_BASE_URL}/api/v1/balance`;

interface MimoTokens {
  api_key?: string;
  email?: string;
  created_at?: string;
  ph?: string;
  balance?: string;
  total?: string;
  service_token?: string;
  user_id?: string;
  slh?: string;
}

export class MimoProvider extends BaseProvider {
  name = "mimo";
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    return this.supportedModels.some((m) => m.id === model);
  }

  supportedModels: ModelInfo[] = [
    {
      id: "mimo-v2.5-pro",
      object: "model",
      created: 1750000000,
      owned_by: "mimo",
      context_window: 1000000,
      max_output: 131072,
      thinking: true,
      vision: false,
      creditUnit: "token",
      creditRate: 1 / 1000000,
      creditSource: "upstream",
    },
    {
      id: "mimo-v2.5",
      object: "model",
      created: 1750000000,
      owned_by: "mimo",
      context_window: 1000000,
      max_output: 131072,
      thinking: false,
      vision: false,
      creditUnit: "token",
      creditRate: 0.5 / 1000000,
      creditSource: "upstream",
    },
    {
      id: "mimo-v2-pro",
      object: "model",
      created: 1750000000,
      owned_by: "mimo",
      context_window: 1000000,
      max_output: 131072,
      thinking: true,
      vision: false,
      creditUnit: "token",
      creditRate: 0.8 / 1000000,
      creditSource: "upstream",
    },
    {
      id: "mimo-v2-flash",
      object: "model",
      created: 1750000000,
      owned_by: "mimo",
      context_window: 1000000,
      max_output: 131072,
      thinking: false,
      vision: false,
      creditUnit: "token",
      creditRate: 0.3 / 1000000,
      creditSource: "upstream",
    },
  ];

  private getApiKey(account: Account): string {
    const tokens = this.parseTokens(account);
    if (tokens.api_key) return tokens.api_key;
    if (account.password) {
      try {
        const decrypted = decrypt(account.password);
        if (decrypted && decrypted.length > 10) return decrypted;
      } catch {
        // ignore decrypt errors
      }
    }
    return "";
  }

  private parseTokens(account: Account): MimoTokens {
    if (!account.tokens) return {};
    try {
      if (typeof account.tokens === "string") {
        return JSON.parse(account.tokens) as MimoTokens;
      }
      return account.tokens as MimoTokens;
    } catch {
      return {};
    }
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "Missing API key" };

    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      tools: request.tools,
      tool_choice: request.tool_choice,
      stream: false,
    };

    let response: Response;
    try {
      response = await this.fetchWithTimeout(MIMO_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (response.status === 401 || response.status === 403) return { success: false, error: "Authentication failed" };
    if (response.status === 429) return { success: false, error: "Rate limited", rateLimited: true };
    if (response.status === 402) return { success: false, error: "Quota exhausted", quotaExhausted: true };
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch {
      return { success: false, error: "Failed to parse response JSON" };
    }

    const promptTokens = data.usage?.prompt_tokens ?? this.estimateMessagesTokens(request.messages);
    const completionTokens = data.usage?.completion_tokens ?? 0;
    return { success: true, response: data, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "Missing API key" };

    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      tools: request.tools,
      tool_choice: request.tool_choice,
      stream: true,
    };

    let response: Response;
    try {
      response = await this.fetchWithTimeout(MIMO_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (response.status === 401 || response.status === 403) return { success: false, error: "Authentication failed" };
    if (response.status === 429) return { success: false, error: "Rate limited", rateLimited: true };
    if (response.status === 402) return { success: false, error: "Quota exhausted", quotaExhausted: true };
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }
    if (!response.body) return { success: false, error: "No response body for streaming" };

    const upstream = response.body;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const trimmed = part.trim();
              if (!trimmed) continue;
              controller.enqueue(encoder.encode(trimmed + "\n\n"));
            }
          }
          if (buffer.trim()) controller.enqueue(encoder.encode(buffer.trim() + "\n\n"));
        } catch (err) {
          controller.error(err);
          return;
        } finally {
          reader.releaseLock();
        }
        controller.close();
      },
    });
    return { success: true, stream };
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.parseTokens(account);
    return { success: true, tokens: JSON.stringify(tokens) };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return this.getApiKey(account).length > 0;
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.parseTokens(account);

    // Try live balance from platform API using ph token + full cookie header
    if (tokens.ph) {
      try {
        const phEncoded = encodeURIComponent(tokens.ph);
        const balanceUrl = `${MIMO_BALANCE_URL}?api-platform_ph=${phEncoded}`;
        const cookieHeader = tokens.service_token
          ? `api-platform_serviceToken="${tokens.service_token}"; userId=${tokens.user_id ?? ""}; api-platform_slh="${tokens.slh ?? ""}"; api-platform_ph="${tokens.ph}"`
          : undefined;
        const resp = await this.fetchWithTimeout(balanceUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
          },
        });
        if (resp.ok) {
          const body = (await resp.json()) as { code?: number; data?: { balance?: string; giftBalance?: string; cashBalance?: string } };
          if (body.code === 0 && body.data) {
            const balance = parseFloat(body.data.balance ?? body.data.giftBalance ?? "0") || 0;
            return { success: true, quota: { limit: balance, remaining: balance, used: 0, resetAt: null } };
          }
        }
      } catch {
        // ph expired or invalid — fall through to cached balance
      }
    }

    // Fallback: cached balance from tokens blob (set during login)
    const balance = parseFloat((tokens.balance ?? tokens.total ?? "0") as string) || 0;
    return { success: true, quota: { limit: balance, remaining: balance, used: 0, resetAt: null } };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) {
      return { kind: "missing_tokens", success: false, error: "No API key configured" };
    }

    // Fetch real balance
    const quotaResult = await this.fetchQuota(account);
    if (quotaResult.success && quotaResult.quota) {
      return {
        kind: "healthy",
        success: true,
        quota: { ...quotaResult.quota, source: "mimo.balance" },
      };
    }

    return {
      kind: "healthy",
      success: true,
      error: quotaResult.error || "Could not fetch balance",
    };
  }
}

