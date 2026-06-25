import type { BaseProvider, ModelInfo } from "./base";
import { KiroProvider } from "./kiro";
import { CodeBuddyProvider } from "./codebuddy";
import { CanvaProvider } from "./canva";
import { CodexProvider } from "./codex";
import { QoderProvider } from "./qoder";
import { ByokProvider } from "./byok";
import { MimoProvider } from "./mimo";
import { AlibabaProvider } from "./alibaba";
import { AntigravityProvider } from "./antigravity";
import { db } from "../../db/index";
import { customModels } from "../../db/schema";

/**
 * Single source of truth for the provider set.
 *
 * To add / remove / change a provider you touch exactly two things:
 *   1. that provider's own file (its models + ownsModel() pattern), and
 *   2. one line in PROVIDER_ORDER below.
 *
 * Routing (getProviderForModel) and model listing (getAllModels) iterate this
 * list — there is no per-provider logic anywhere else. Order matters only for
 * disambiguating overlapping patterns: more specific providers come first, and
 * the single isFallback provider (kiro standard) is consulted last.
 */
// kiro and kiro-pro are two variants of the SAME provider class — same upstream
// (AWS CodeWhisperer), different model catalog + account pool. They keep
// distinct provider names so DB/bot/dashboard treat them separately.
const kiro = new KiroProvider({ variant: "standard" });
const kiroPro = new KiroProvider({ variant: "pro" });
const codebuddy = new CodeBuddyProvider();
const canva = new CanvaProvider();
const codex = new CodexProvider();
const qoder = new QoderProvider();
const byok = new ByokProvider();
const mimo = new MimoProvider();
const alibaba = new AlibabaProvider();
const antigravity = new AntigravityProvider();

// Priority order. antigravity first (unique model names), then alibaba, then rest.
const PROVIDER_ORDER = [antigravity, alibaba, canva, qoder, codex, kiroPro, mimo, byok, codebuddy, kiro] as const;

export const providers = {
  kiro,
  "kiro-pro": kiroPro,
  codebuddy,
  canva,
  codex,
  qoder,
  byok,
  mimo,
  alibaba,
  antigravity,
} as const;

export type ProviderName = keyof typeof providers;

export const PROVIDER_PREFIXES: Record<ProviderName, string> = {
  "antigravity": "ag/",
  "alibaba": "ali/",
  "canva": "cv/",
  "qoder": "qd/",
  "codex": "cx/",
  "kiro-pro": "kp/",
  "mimo": "mm/",
  "codebuddy": "cb/",
  "kiro": "kr/",
  "byok": "byok/",
};

export function getNativeModelId(model: string, providerName: ProviderName): string {
  const prefix = PROVIDER_PREFIXES[providerName];
  if (!prefix || !model.startsWith(prefix)) {
    return model;
  }
  const suffix = model.slice(prefix.length);
  if (providerName === "kiro-pro") {
    return `kp-${suffix}`;
  }
  if (providerName === "qoder") {
    return `qd-${suffix}`;
  }
  if (providerName === "codebuddy") {
    return `cb-${suffix}`;
  }
  if (providerName === "codex") {
    return suffix.startsWith("codex-") ? suffix : `codex-${suffix}`;
  }
  return suffix;
}

// In-memory cache of custom models loaded from SQLite
let _customModelsCache: ModelInfo[] = [];

export async function loadCustomModelsCache(): Promise<void> {
  try {
    const rows = await db.select().from(customModels);
    _customModelsCache = rows.map((row) => ({
      id: row.modelId,
      object: "model",
      created: Math.floor(row.createdAt.getTime() / 1000),
      owned_by: row.ownedBy,
      context_window: row.contextWindow ?? 200000,
      max_output: row.maxOutput ?? 65536,
      thinking: row.thinking ?? false,
      vision: row.vision ?? false,
      creditUnit: "token",
      creditRate: 1 / 1_000_000,
      creditSource: "upstream",
    }));
  } catch (err) {
    console.error("[Registry] Failed to load custom models cache:", err);
    _customModelsCache = [];
  }
}

export function getCustomModelsCached(): ModelInfo[] {
  return _customModelsCache;
}

/** Map a model id to the provider that handles it. */
export function getProviderForModel(model: string): ProviderName | null {
  // Check custom models cache first
  const custom = _customModelsCache.find((m) => m.id === model);
  if (custom) {
    return custom.owned_by as ProviderName;
  }

  // Check prefix matching first
  for (const [providerName, prefix] of Object.entries(PROVIDER_PREFIXES)) {
    if (prefix && model.startsWith(prefix)) {
      return providerName as ProviderName;
    }
  }

  for (const provider of PROVIDER_ORDER) {
    if (provider.ownsModel(model)) return provider.name as ProviderName;
  }
  const fallback = PROVIDER_ORDER.find((p) => p.isFallback);
  return (fallback?.name as ProviderName) ?? null;
}

/** All models across every registered provider + custom models. */
export function getAllModels(): ModelInfo[] {
  const providerModels = PROVIDER_ORDER.flatMap((provider) => {
    const prefix = PROVIDER_PREFIXES[provider.name as ProviderName] || "";
    return provider.getModels().map((model) => {
      // Clean up legacy prefixes
      let cleanId = model.id;
      if (cleanId.startsWith("kp-")) cleanId = cleanId.slice(3);
      else if (cleanId.startsWith("qd-")) cleanId = cleanId.slice(3);
      else if (cleanId.startsWith("cb-")) cleanId = cleanId.slice(3);
      else if (cleanId.startsWith("codex-")) cleanId = cleanId.slice(6);

      const id = cleanId.startsWith(prefix) ? cleanId : `${prefix}${cleanId}`;
      return { ...model, id };
    });
  });
  return [...providerModels, ..._customModelsCache];
}

/** Iterable list of provider instances (priority order). */
export const providerList: readonly BaseProvider[] = PROVIDER_ORDER;

/** Refresh BYOK models from database. */
export async function refreshByokModels(): Promise<void> {
  await byok.refreshModelsCache();
}

/** Get BYOK provider instance. */
export function getByokProvider(): ByokProvider {
  return byok;
}
