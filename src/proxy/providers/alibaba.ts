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

/**
 * Alibaba Cloud Model Studio (Bailian / DASHSCOPE) provider.
 *
 * OpenAI-compatible API with per-account workspace routing:
 *   URL: https://{workspace-id}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions
 *   Auth: Bearer {sk-key}
 *   Quota: 1,000,000 tokens per account (free tier)
 *
 * Account tokens JSON shape:
 *   { sk_key: "...", workspace_id: "ws-xxxx", email: "..." }
 */
const ALIBABA_REGION = "ap-southeast-1";
const ALIBABA_QUOTA = 1_000_000;

// All Alibaba / Qwen chat-capable models sourced from models_full.json (145 entries, 85 included)
// Excluded: TTS, ASR, image-gen, embeddings, MT, realtime S2S, captioner, livetranslate
const ALIBABA_MODELS: ModelInfo[] = [
  { id: "qwen3.7-max-2026-06-08", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.7-plus-2026-05-26", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.7-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "glm-5.1", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 202745, max_output: 131072, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.7-max-2026-05-17", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.7-max-preview", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.7-max-2026-05-20", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.7-max", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "deepseek-v4-flash", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 393216, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "deepseek-v4-pro", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 393216, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.6-27b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-plus-2026-04-20", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.6-max-preview", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.6-35b-a3b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.6-flash", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.6-flash-2026-04-16", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-omni-plus-2026-03-15", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-omni-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-omni-flash-2026-03-15", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-omni-flash", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.6-plus-2026-04-02", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.6-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "deepseek-v3.2", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 393216, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-flash-2026-02-23", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-flash", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-122b-a10b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-35b-a3b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-27b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-coder-next", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-397b-a17b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-plus-2026-02-15", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3.5-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-vl-flash-2026-01-22", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-max-2026-01-23", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-plus-character", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 32768, max_output: 4096, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-flash-character", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 8192, max_output: 4096, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-flash", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-vl-plus-2025-12-19", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-omni-flash-2025-12-01", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-plus-2025-12-01", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-vl-ocr-2025-11-20", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 38192, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "ccai-pro", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-vl-flash", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-vl-flash-2025-10-15", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-omni-flash", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-omni-flash-2025-09-15", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-plus-latest", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-plus-2025-01-25", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwq-plus-2025-03-05", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: true, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-coder-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwq-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: true, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qvq-max", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: true, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-omni-turbo", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 32768, max_output: 2048, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-8b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-30b-a3b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-235b-a22b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-plus-2025-04-28", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-coder-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-coder-480b-a35b-instruct", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-235b-a22b-instruct-2507", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-plus-2025-07-14", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-coder-plus-2025-07-22", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-235b-a22b-thinking-2507", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: true, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-coder-flash", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-vl-max", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-max", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-max-2025-09-23", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-vl-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-vl-235b-a22b-instruct", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-vl-235b-a22b-thinking", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: true, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-30b-a3b-thinking-2507", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: true, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-30b-a3b-instruct-2507", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-14b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-32b", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-vl-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-coder-plus-2025-09-23", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-vl-plus-2025-09-23", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-plus-2025-09-11", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-next-80b-a3b-thinking", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: true, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-next-80b-a3b-instruct", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen3-max-preview", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 262144, max_output: 65536, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen2-7b-instruct", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-max", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 32768, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-plus", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 1000000, max_output: 32768, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
  { id: "qwen-turbo", object: "model", created: 1750000000, owned_by: "alibaba", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 1 / 1_000_000, creditSource: "upstream" },
];

interface AlibabaTokens {
  sk_key?: string;
  workspace_id?: string;
  email?: string;
}

export class AlibabaProvider extends BaseProvider {
  name = "alibaba";
  override nativeFormat: "openai" | "anthropic" = "openai";
  override isFallback = false;

  override get supportedModels(): ModelInfo[] {
    return ALIBABA_MODELS;
  }

  override ownsModel(model: string): boolean {
    return ALIBABA_MODELS.some((m) => m.id === model);
  }

  private getCredentials(account: Account): { skKey: string; workspaceId: string } | null {
    try {
      const raw = decrypt(account.password);
      const tokens: AlibabaTokens = typeof raw === "string" ? JSON.parse(raw) : raw;
      const skKey = tokens.sk_key || "";
      const workspaceId = tokens.workspace_id || "";
      if (!skKey || !workspaceId) return null;
      return { skKey, workspaceId };
    } catch {
      // Legacy: tokens stored directly as JSON in tokens field
      try {
        const tokens: AlibabaTokens = typeof account.tokens === "string"
          ? JSON.parse(account.tokens)
          : (account.tokens as AlibabaTokens) || {};
        const skKey = tokens.sk_key || "";
        const workspaceId = tokens.workspace_id || "";
        if (!skKey || !workspaceId) return null;
        return { skKey, workspaceId };
      } catch {
        return null;
      }
    }
  }

  private buildUrl(workspaceId: string, model: string): string {
    return `https://${workspaceId}.${ALIBABA_REGION}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
  }

  override async chatCompletion(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const creds = this.getCredentials(account);
    if (!creds) {
      return {
        success: false,
        error: "Missing sk_key or workspace_id in account tokens",
      };
    }

    const url = this.buildUrl(creds.workspaceId, request.model);
    const body = JSON.stringify({
      ...request,
      stream: false,
    });

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.skKey}`,
      },
      body,
    });

    const text = await response.text();

    if (!response.ok) {
      return {
        success: false,
        error: `Alibaba API error: ${response.status} ${text}`,
      };
    }

    try {
      const data = JSON.parse(text) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices in response" };

      const promptTokens = data.usage?.prompt_tokens || 0;
      const completionTokens = data.usage?.completion_tokens || 0;

      data.model = request.model;

      return {
        success: true,
        response: data,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (e) {
      return { success: false, error: `Invalid JSON response: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  override async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const creds = this.getCredentials(account);
    if (!creds) {
      return {
        success: false,
        error: "Missing sk_key or workspace_id in account tokens",
      };
    }

    const url = this.buildUrl(creds.workspaceId, request.model);
    const body = JSON.stringify({
      ...request,
      stream: true,
    });

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.skKey}`,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `Alibaba API error: ${response.status} ${text}`,
      };
    }

    return {
      success: true,
      stream: response.body as unknown as ReadableStream<Uint8Array>,
    };
  }

  override async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    // No refresh needed — SK keys are long-lived
    return { success: true };
  }

  override async validateAccount(account: Account): Promise<boolean> {
    const creds = this.getCredentials(account);
    return !!(creds?.skKey && creds?.workspaceId);
  }

  override async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt: Date | null };
    error?: string;
  }> {
    // No public balance endpoint — use fixed quota of 1M tokens
    // The DB tracks quotaRemaining based on token usage
    const remaining = account.quotaRemaining ?? ALIBABA_QUOTA;
    const limit = account.quotaLimit ?? ALIBABA_QUOTA;

    return {
      success: true,
      quota: {
        limit,
        remaining,
        used: limit - remaining,
        resetAt: null,
      },
    };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const creds = this.getCredentials(account);
    if (!creds) {
      return { kind: "missing_tokens", success: false, error: "No SK key or workspace ID configured" };
    }

    // Send a minimal test request to verify the account works
    try {
      const url = this.buildUrl(creds.workspaceId, "qwen-flash");
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creds.skKey}`,
        },
        body: JSON.stringify({
          model: "qwen-flash",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }),
      });

      if (response.ok) {
        return {
          kind: "healthy",
          success: true,
          quota: {
            limit: ALIBABA_QUOTA,
            remaining: account.quotaRemaining ?? ALIBABA_QUOTA,
            used: ALIBABA_QUOTA - (account.quotaRemaining ?? ALIBABA_QUOTA),
            resetAt: null,
            source: "alibaba.health_check",
          },
        };
      }

      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_error", success: false, error: `Auth failed: ${response.status}` };
      }
      if (response.status === 429) {
        return { kind: "exhausted", success: false, error: "Quota exceeded" };
      }

      return {
        kind: "healthy",
        success: true,
        error: `Health check returned ${response.status}: ${text.slice(0, 200)}`,
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
