import { db } from "../db/index";
import { accounts, type Account } from "../db/schema";
import { eq } from "drizzle-orm";
import { providers } from "../proxy/router";
import { pool, type ProviderName } from "../proxy/pool";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import type { ProviderHealthKind, ProviderHealthResult, ProviderQuotaSnapshot } from "../proxy/providers/base";

type AccountStatus = "active" | "exhausted" | "error" | "pending" | string;

export interface WarmupResult {
  success: boolean;
  accountId: number;
  provider: string;
  email: string;
  previousStatus: AccountStatus;
  status: AccountStatus;
  kind: ProviderHealthKind;
  quota?: ProviderQuotaSnapshot;
  refreshedTokens?: boolean;
  retryable?: boolean;
  error?: string;
  message?: string;
}

interface AccountWarmupUpdate {
  status: AccountStatus;
  errorMessage: string | null;
  quotaLimit?: number;
  quotaRemaining?: number;
  quotaResetAt?: Date | null;
  tokens?: unknown;
  metadata: unknown;
}

function shortError(value?: string) {
  if (!value) return null;
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function mergeWarmupMetadata(account: Account, health: ProviderHealthResult) {
  const existing = account.metadata && typeof account.metadata === "object" && !Array.isArray(account.metadata)
    ? account.metadata as Record<string, unknown>
    : {};

  return {
    ...existing,
    ...(health.metadata || {}),
    warmup: {
      lastCheckedAt: new Date().toISOString(),
      kind: health.kind,
      success: health.success,
      retryable: Boolean(health.retryable),
      quotaSource: health.quota?.source,
      authRefreshed: Boolean(health.tokens),
      lastError: shortError(health.error || health.message),
    },
    overage: health.quota?.overage || existing.overage || null,
  };
}

export function mapHealthToAccountUpdate(account: Account, health: ProviderHealthResult): AccountWarmupUpdate {
  let status: AccountStatus = account.status;
  let errorMessage: string | null = account.errorMessage || null;

  // Qoder: skip status updates to preserve custom daily credit system (200 req/day)
  // Only allow warmup to update status if account is in error state (session expired, etc)
  const skipStatusUpdate = account.provider === "qoder" &&
    (account.status === "exhausted" || account.status === "active");

  switch (health.kind) {
    case "healthy":
      if (!skipStatusUpdate) {
        status = "active";
        errorMessage = null;
      }
      break;
    case "exhausted":
      if (!skipStatusUpdate) {
        status = "exhausted";
        errorMessage = "Quota exhausted";
      }
      break;
    case "banned":
      status = "error";
      errorMessage = health.error || "Account banned or disabled";
      break;
    case "session_expired":
      status = "error";
      errorMessage = health.error || "Session expired; re-login required";
      break;
    case "auth_error":
      status = "error";
      errorMessage = health.error || "Authentication error";
      break;
    case "missing_tokens":
      status = account.status === "pending" ? "pending" : "error";
      errorMessage = health.error || "No tokens available; login required";
      break;
    case "transient_error":
      status = account.status;
      errorMessage = health.error || health.message || account.errorMessage || "Transient warmup error";
      break;
    case "unsupported":
      status = account.status;
      errorMessage = health.message || health.error || account.errorMessage || null;
      break;
  }

  const update: AccountWarmupUpdate = {
    status,
    errorMessage,
    metadata: mergeWarmupMetadata(account, health),
  };

  // Qoder: skip quota updates to preserve custom daily credit system (200 req/day)
  if (account.provider !== "qoder") {
    if (health.quota) {
      update.quotaLimit = Number(health.quota.limit || 0);
      update.quotaRemaining = Math.max(0, Number(health.quota.remaining || 0));
      if (health.kind === "exhausted") update.quotaRemaining = 0;
      if (health.quota.resetAt) {
        const resetAt = new Date(health.quota.resetAt);
        if (!Number.isNaN(resetAt.getTime())) update.quotaResetAt = resetAt;
      }
    } else if (health.kind === "exhausted") {
      update.quotaRemaining = 0;
    }
  }

  if (health.tokens) update.tokens = health.tokens;
  return update;
}

function eventTypeFor(kind: ProviderHealthKind) {
  if (kind === "healthy") return "warmup_success";
  if (kind === "exhausted") return "warmup_exhausted";
  if (kind === "transient_error") return "warmup_transient_error";
  if (kind === "unsupported") return "warmup_unsupported";
  return "warmup_auth_error";
}

function messageFor(result: WarmupResult) {
  if (result.kind === "healthy") return `WarmUp healthy: ${result.quota?.remaining ?? "unknown"} credits remaining`;
  if (result.kind === "exhausted") return "WarmUp detected exhausted quota";
  if (result.kind === "transient_error") return `WarmUp transient error: ${result.error || result.message || "unknown"}`;
  if (result.kind === "unsupported") return result.message || "WarmUp unsupported for provider";
  return result.error || result.message || `WarmUp ${result.kind}`;
}

export async function warmupAccount(account: Account): Promise<WarmupResult> {
  const provider = providers[account.provider as keyof typeof providers];
  if (!provider) {
    return {
      success: false,
      accountId: account.id,
      provider: account.provider,
      email: account.email,
      previousStatus: account.status,
      status: "error",
      kind: "unsupported",
      error: `Provider not configured: ${account.provider}`,
    };
  }

  const startLog = addAuthLog({
    type: "warmup_processing",
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    step: "checking",
    message: `WarmUp checking ${account.provider}/${account.email}`,
  });

  broadcast({
    type: "warmup_processing",
    data: {
      logId: startLog.id,
      id: account.id,
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      step: "checking",
      message: startLog.message,
      timestamp: startLog.timestamp,
    },
  });

  const health: ProviderHealthResult = await provider.healthCheck(account);

  // For kiro/kiro-pro accounts marked exhausted but with overage enabled,
  // probe inference to verify if the account can still serve requests.
  if (health.kind === "exhausted" && account.provider.startsWith("kiro") && health.quota?.overage?.enabled) {
    try {
      const probeResult = await provider.chatCompletion(account, {
        model: account.provider === "kiro-pro" ? "claude-sonnet-4.6" : "auto",
        messages: [{ role: "user", content: "Say OK" }],
        max_tokens: 4,
      });
      if (probeResult.success) {
        // Inference works — override health to healthy (PAYG active)
        health.kind = "healthy";
        health.success = true;
        health.metadata = { ...health.metadata, inferenceProbe: "passed", overageBudget: true };
      } else if (probeResult.quotaExhausted) {
        // Truly exhausted (overage cap hit)
        health.metadata = { ...health.metadata, inferenceProbe: "quota_exhausted" };
      } else {
        health.metadata = { ...health.metadata, inferenceProbe: "failed", probeError: probeResult.error?.slice(0, 100) };
      }
    } catch (e) {
      health.metadata = { ...health.metadata, inferenceProbe: "error", probeError: (e instanceof Error ? e.message : String(e)).slice(0, 100) };
    }
  }

  // For qoder accounts: server-reported quota=0 doesn't always mean truly exhausted.
  // Probe inference with the cheapest model (qd-Lite, price_factor=0) to confirm.
  if (health.kind === "exhausted" && account.provider === "qoder") {
    try {
      const probeResult = await provider.chatCompletion(account, {
        model: "qd-Lite",
        messages: [{ role: "user", content: "Say OK" }],
        max_tokens: 4,
      });
      if (probeResult.success) {
        health.kind = "healthy";
        health.success = true;
        health.metadata = { ...health.metadata, inferenceProbe: "passed", quotaOverride: true };
      } else if (probeResult.quotaExhausted) {
        health.metadata = { ...health.metadata, inferenceProbe: "quota_exhausted" };
      } else {
        health.metadata = { ...health.metadata, inferenceProbe: "failed", probeError: probeResult.error?.slice(0, 100) };
      }
    } catch (e) {
      health.metadata = { ...health.metadata, inferenceProbe: "error", probeError: (e instanceof Error ? e.message : String(e)).slice(0, 100) };
    }
  }

  const update = mapHealthToAccountUpdate(account, health);

  const dbUpdate: Record<string, unknown> = {
    status: update.status,
    errorMessage: update.errorMessage,
    metadata: update.metadata,
    updatedAt: new Date(),
  };
  if (update.quotaLimit !== undefined) dbUpdate.quotaLimit = update.quotaLimit;
  if (update.quotaRemaining !== undefined) dbUpdate.quotaRemaining = update.quotaRemaining;
  if (update.quotaResetAt !== undefined) dbUpdate.quotaResetAt = update.quotaResetAt;
  if (update.tokens !== undefined) dbUpdate.tokens = update.tokens;

  await db.update(accounts).set(dbUpdate).where(eq(accounts.id, account.id));
  pool.invalidate(account.provider as ProviderName);

  const result: WarmupResult = {
    success: health.kind === "healthy" || health.kind === "exhausted",
    accountId: account.id,
    provider: account.provider,
    email: account.email,
    previousStatus: account.status,
    status: update.status,
    kind: health.kind,
    quota: health.quota,
    refreshedTokens: Boolean(health.tokens),
    retryable: Boolean(health.retryable),
    error: health.error,
    message: health.message,
  };

  const type = eventTypeFor(health.kind);
  const log = addAuthLog({
    type,
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    step: health.kind,
    message: messageFor(result),
    error: health.kind === "healthy" || health.kind === "exhausted" ? undefined : health.error,
    data: {
      kind: health.kind,
      status: update.status,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
      retryable: health.retryable,
      refreshedTokens: Boolean(health.tokens),
    },
  });

  broadcast({
    type,
    data: {
      logId: log.id,
      id: account.id,
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      status: update.status,
      kind: health.kind,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
      retryable: health.retryable,
      refreshedTokens: Boolean(health.tokens),
      message: log.message,
      error: log.error,
      timestamp: log.timestamp,
    },
  });

  broadcast({
    type: "account_status",
    data: {
      id: account.id,
      status: update.status,
      provider: account.provider,
      error: update.errorMessage,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
    },
  });

  return result;
}
