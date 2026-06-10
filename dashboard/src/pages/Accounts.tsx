import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle as DTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, Upload, RefreshCw, Play, RotateCcw, Flame } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useWsEvent } from "@/hooks/useWebSocket";
import {
  completeCodexOAuthCallbackUrl,
  createAccount,
  fetchAccounts,
  fetchApi,
  fetchAuthQueue,
  fetchAutoWarmupStatus,
  fetchSettings,
  fetchWarmupQueue,
  getCodexAuthorize,
  importAccounts,
  loginAccounts,
  loginAllAccounts,
  pollCodexOAuthStatus,
  startCodexOAuthProxy,
  stopCodexOAuth,
  updateSettings,
  warmupAllAccounts,
  type AutoWarmupStatus,
} from "@/lib/api";

type Provider = "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder";

interface Account {
  id: number;
  email: string;
  provider: Provider;
  status: string;
  quotaLimit?: number;
  quotaRemaining?: number;
}

const providers: Provider[] = ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder"];

function labelProvider(provider: string) {
  if (provider === "kiro-pro") return "Kiro Pro";
  if (provider === "codebuddy") return "CodeBuddy";
  if (provider === "codex") return "Codex";
  if (provider === "qoder") return "Qoder";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export default function Accounts() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<any>(null);
  const [warmupQueue, setWarmupQueue] = useState<any>(null);
  const [warmupProgress, setWarmupProgress] = useState<Record<string, { total: number; completed: number; active: number }>>({});
  const [autoWarmup, setAutoWarmup] = useState<AutoWarmupStatus | null>(null);
  const [settingsMap, setSettingsMap] = useState<Record<string, string>>({});
  const [now, setNow] = useState<number>(Date.now());

  const [addForm, setAddForm] = useState({ email: "", password: "", provider: "kiro" as Provider, browserEngine: "camoufox", headless: false });
  const [addDialogProvider, setAddDialogProvider] = useState<Provider | null>(null);
  const [instantTokens, setInstantTokens] = useState("");
  const [cookieValue, setCookieValue] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [addMode, setAddMode] = useState<"single" | "bulk" | "instant" | "pat">("bulk");
  const [bulkBrowserEngine, setBulkBrowserEngine] = useState("camoufox");
  const [bulkHeadless, setBulkHeadless] = useState(true);
  const [bulkConcurrency, setBulkConcurrency] = useState(3);
  const [codexOauthBusy, setCodexOauthBusy] = useState(false);
  const [codexOauthAuthUrl, setCodexOauthAuthUrl] = useState("");
  const [codexOauthCallbackUrl, setCodexOauthCallbackUrl] = useState("");
  const [loginPendingDialog, setLoginPendingDialog] = useState(false);
  const [loginPendingConcurrency, setLoginPendingConcurrency] = useState(2);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codexOauthPopupRef = useRef<Window | null>(null);
  const codexOauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codexOauthStateRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [accountsRes, queueRes, warmupQueueRes, autoWarmupRes, settingsRes] = await Promise.all([
        fetchAccounts() as Promise<{ data: Account[] }>,
        fetchAuthQueue().catch(() => null),
        fetchWarmupQueue().catch(() => null),
        fetchAutoWarmupStatus().catch(() => null),
        fetchSettings().catch(() => null) as Promise<{ data: Record<string, string> } | null>,
      ]);
      setAccounts(accountsRes.data || []);
      setQueue(queueRes);
      setWarmupQueue(warmupQueueRes);
      setAutoWarmup(autoWarmupRes);
      setSettingsMap(settingsRes?.data || {});
      updateWarmupQueue(warmupQueueRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!autoWarmup?.nextRunAt) return;
    const targetMs = new Date(autoWarmup.nextRunAt).getTime();
    let refetched = false;
    const tick = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!refetched && current >= targetMs) {
        refetched = true;
        setTimeout(() => {
          fetchAutoWarmupStatus().then(setAutoWarmup).catch(() => {});
          load();
        }, 1500);
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [autoWarmup?.nextRunAt]);

  const reloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmupReloadRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReload = () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    reloadRef.current = setTimeout(() => { load(); }, 800);
  };

  function updateWarmupQueue(res: any) {
    if (!res?.data || typeof res.data !== "object") {
      setWarmupProgress({});
      return;
    }
    const next: Record<string, { total: number; completed: number; active: number }> = {};
    for (const [provider, val] of Object.entries(res.data)) {
      const info = val as any;
      const total = Number(info.total || 0);
      const completed = Number(info.completed || 0);
      const active = Number(info.active || 0);
      if (total > 0) {
        next[provider] = { total, completed, active };
      }
    }
    setWarmupProgress(next);
  }

  const scheduleWarmupReload = () => {
    if (warmupReloadRef.current) clearTimeout(warmupReloadRef.current);
    warmupReloadRef.current = setTimeout(async () => {
      try {
        const res = await fetchWarmupQueue();
        updateWarmupQueue(res);
      } catch {}
    }, 500);
  };

  useEffect(() => () => {
    if (reloadRef.current) clearTimeout(reloadRef.current);
    if (warmupReloadRef.current) clearTimeout(warmupReloadRef.current);
    if (codexOauthPollRef.current) clearInterval(codexOauthPollRef.current);
    if (codexOauthStateRef.current) {
      stopCodexOAuth(codexOauthStateRef.current).catch(() => {});
    }
    codexOauthPopupRef.current?.close();
  }, []);

  useEffect(() => {
    const pollId = codexOauthPollRef.current;
    return () => {
      if (pollId) clearInterval(pollId);
    };
  }, []);

  useWsEvent(["auto_warmup_status"], (msg) => {
    setAutoWarmup(msg.data);
  });

  useWsEvent([
    "warmup_queue_added", "warmup_processing",
    "warmup_complete", "warmup_success", "warmup_exhausted",
    "warmup_auth_error", "warmup_transient_error",
    "warmup_queue_cleared"
  ], scheduleWarmupReload);

  useWsEvent(["account_status"], scheduleReload);

  async function handleToggleAutoWarmup(provider: Provider) {
    const key = `auto_warmup_provider_${provider}`;
    const next = settingsMap[key] === "true" ? "false" : "true";
    setSettingsMap((current) => ({ ...current, [key]: next }));
    try {
      await updateSettings({ [key]: next });
      const status = await fetchAutoWarmupStatus();
      setAutoWarmup(status);
      showSuccess(`Auto WarmUp ${next === "true" ? "enabled" : "disabled"} for ${labelProvider(provider)}`);
    } catch (err) {
      setSettingsMap((current) => ({ ...current, [key]: next === "true" ? "false" : "true" }));
      showError(err);
    }
  }

  function autoWarmupEnabledFor(provider: Provider): boolean {
    return settingsMap[`auto_warmup_provider_${provider}`] === "true";
  }

  function countdownLabel(): string {
    if (!autoWarmup?.nextRunAt) return "—";
    const remaining = Math.max(0, new Date(autoWarmup.nextRunAt).getTime() - now);
    const totalSeconds = Math.floor(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function showSuccess(text: string) {
    setMessage(text);
    setError(null);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(() => setMessage(null), 4000);
  }
  function showError(err: unknown) { setError(err instanceof Error ? err.message : String(err)); setMessage(null); }

  async function handleAdd() {
    if (!addDialogProvider) return;
    try {
      const payload: any = { email: addForm.email, password: addForm.password, provider: addDialogProvider, headless: addForm.headless, browserEngine: addForm.browserEngine };
      await createAccount(payload);
      showSuccess("Account added and bot login started.");
      setAddForm({ email: "", password: "", provider: "kiro", browserEngine: "camoufox", headless: false });
      setAddDialogProvider(null);
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleInstantLogin() {
    if (!instantTokens.trim()) { showError(new Error("Paste refresh tokens (one per line)")); return; }
    const tokens = instantTokens.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (tokens.length === 0) { showError(new Error("No valid tokens found")); return; }

    try {
      const res = await fetchApi<{ success: number; failed: number; errors?: string[] }>("/api/accounts/instant-login", {
        method: "POST",
        body: JSON.stringify({ tokens, provider: addDialogProvider }),
      });
      showSuccess(`Instant login: ${res.success} success, ${res.failed} failed`);
      setInstantTokens("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleCookieLogin() {
    if (!cookieValue.trim()) { showError(new Error("Paste Personal Access Token (PAT)")); return; }
    try {
      const res = await fetchApi<any>("/api/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: "qoder",
          personalToken: cookieValue.trim(),
        }),
      });
      showSuccess("Qoder account added successfully");
      setCookieValue("");
      setAddDialogProvider(null);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleBulkImport() {
    if (!addDialogProvider || !bulkText.trim()) { showError(new Error("Paste email|password lines")); return; }
    try {
      const opts: any = { headless: bulkHeadless, browserEngine: bulkBrowserEngine, concurrency: bulkConcurrency };
      const res = await importAccounts(bulkText, [addDialogProvider], opts) as any;
      showSuccess(res.message || "Bulk import queued.");
      setBulkText("");
      setAddDialogProvider(null);
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  function clearCodexOAuthPolling() {
    if (codexOauthPollRef.current) {
      clearInterval(codexOauthPollRef.current);
      codexOauthPollRef.current = null;
    }
  }

  function resetCodexOAuthFlow() {
    clearCodexOAuthPolling();
    codexOauthPopupRef.current?.close();
    codexOauthPopupRef.current = null;
    codexOauthStateRef.current = null;
    setCodexOauthBusy(false);
    setCodexOauthAuthUrl("");
    setCodexOauthCallbackUrl("");
  }

  async function safeCopyText(text: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess(successMessage);
    } catch (err) {
      showError(err);
    }
  }

  function isCodexCallbackUrlValid(value: string) {
    try {
      const url = new URL(value.trim());
      return !!url.searchParams.get("code") && !!url.searchParams.get("state");
    } catch {
      return false;
    }
  }

  const hasPreparedCodexOAuth = !!codexOauthStateRef.current && !!codexOauthAuthUrl;
  const codexCallbackReady = isCodexCallbackUrlValid(codexOauthCallbackUrl);
  const codexCallbackExample = "http://localhost:1455/auth/callback?code=...&state=...";
  const codexLoopbackUrl = "http://localhost:1455/auth/callback";

  async function startCodexOAuthSession() {
    const redirectUri = codexLoopbackUrl;
    const appPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
    const auth = await getCodexAuthorize(redirectUri);
    await startCodexOAuthProxy({
      appPort,
      state: auth.state,
      codeVerifier: auth.codeVerifier,
      redirectUri: auth.redirectUri,
    });
    codexOauthStateRef.current = auth.state;
    setCodexOauthAuthUrl(auth.authUrl);
    setCodexOauthCallbackUrl("");
    return auth;
  }

  function finishCodexOAuthSuccess(status: Awaited<ReturnType<typeof pollCodexOAuthStatus>>) {
    resetCodexOAuthFlow();
    showSuccess(`Codex connected: ${status.connection?.displayName || status.connection?.email || "account added"}`);
    setAddDialogProvider(null);
    load();
  }

  function beginCodexOAuthPolling() {
    clearCodexOAuthPolling();
    codexOauthPollRef.current = setInterval(async () => {
      const state = codexOauthStateRef.current;
      if (!state) return;

      try {
        const status = await pollCodexOAuthStatus(state);
        if (status.status === "done") {
          finishCodexOAuthSuccess(status);
          return;
        }

        if (status.status === "error" || status.status === "cancelled" || status.status === "not_found" || status.status === "unknown") {
          resetCodexOAuthFlow();
          showError(new Error(status.error || "Codex OAuth failed"));
        }
      } catch (pollError) {
        resetCodexOAuthFlow();
        showError(pollError);
      }
    }, 1500);
  }

  async function handleCodexOAuthLogin() {
    if (codexOauthBusy) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      const auth = await startCodexOAuthSession();
      codexOauthPopupRef.current = window.open(auth.authUrl, "codex_oauth_popup", "width=640,height=800");
      if (!codexOauthPopupRef.current) {
        window.open(auth.authUrl, "_blank", "noopener,noreferrer");
      }
      beginCodexOAuthPolling();
    } catch (err) {
      resetCodexOAuthFlow();
      showError(err);
    }
  }

  async function handleCodexOAuthPrepareManual() {
    if (codexOauthBusy || hasPreparedCodexOAuth) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      await startCodexOAuthSession();
      beginCodexOAuthPolling();
      setCodexOauthBusy(false);
      showSuccess("Auth URL ready. Open it, login, lalu paste callback URL di bawah.");
    } catch (err) {
      resetCodexOAuthFlow();
      showError(err);
    }
  }

  async function handleCodexOAuthSubmitManual() {
    if (codexOauthBusy || !codexCallbackReady) return;
    setCodexOauthBusy(true);
    setError(null);

    try {
      await completeCodexOAuthCallbackUrl(codexOauthCallbackUrl);
      const state = codexOauthStateRef.current;
      if (!state) {
        resetCodexOAuthFlow();
        showSuccess("Codex connected");
        setAddDialogProvider(null);
        await load();
        return;
      }
      const status = await pollCodexOAuthStatus(state);
      finishCodexOAuthSuccess(status);
    } catch (err) {
      setCodexOauthBusy(false);
      showError(err);
    }
  }

  async function handleCodexOAuthCopyAuthUrl() {
    if (!codexOauthAuthUrl) return;
    await safeCopyText(codexOauthAuthUrl, "Auth URL copied");
  }

  function handleCodexOAuthOpenManual() {
    if (!codexOauthAuthUrl) return;
    window.open(codexOauthAuthUrl, "_blank", "noopener,noreferrer");
  }

  async function handleCodexOAuthPasteCallback() {
    try {
      const text = await navigator.clipboard.readText();
      setCodexOauthCallbackUrl(text);
    } catch (err) {
      showError(err);
    }
  }

  function handleOpenAddDialog(provider: Provider) {
    resetCodexOAuthFlow();
    if (provider === "codex") {
      setAddMode("pat");
    }
    setAddDialogProvider(provider);
  }

  function handleCloseAddDialog() {
    const state = codexOauthStateRef.current;
    resetCodexOAuthFlow();
    if (state) {
      stopCodexOAuth(state).catch(() => {});
    }
    setAddDialogProvider(null);
  }

  function handleSetCodexMode(mode: typeof addMode) {
    if (mode === addMode) return;
    const state = codexOauthStateRef.current;
    resetCodexOAuthFlow();
    if (state) {
      stopCodexOAuth(state).catch(() => {});
    }
    setAddMode(mode);
  }

  async function handleLoginAll() {
    setLoginPendingDialog(true);
  }

  async function confirmLoginAll() {
    setLoginPendingDialog(false);
    try {
      const res = await loginAllAccounts({ concurrency: loginPendingConcurrency }) as any;
      showSuccess(res.message || "Login all queued.");
      await load();
      navigate("/bot-logs");
    } catch (err) { showError(err); }
  }

  async function handleWarmupProvider(provider: Provider) {
    try {
      const res = await warmupAllAccounts({ providers: [provider], statuses: ["active", "exhausted", "error"] }) as any;
      showSuccess(res.message || `${labelProvider(provider)} WarmUp queued.`);
      await load();
    } catch (err) { showError(err); }
  }

  async function handleRetryErrors(provider: Provider) {
    const ids = accounts.filter((a) => a.provider === provider && a.status === "error").map((a) => a.id);
    if (ids.length === 0) return;
    await loginAccounts(ids);
    showSuccess(`Queued ${ids.length} ${labelProvider(provider)} error accounts for retry.`);
    await load();
  }

  const providerStats = useMemo(() => {
    return providers.map((provider) => {
      const rows = accounts.filter((a) => a.provider === provider);
      const quotaLimit = rows.reduce((sum, a) => sum + (a.quotaLimit || 0), 0);
      const quotaRemaining = rows.reduce((sum, a) => sum + (a.quotaRemaining || 0), 0);
      return {
        provider,
        total: rows.length,
        active: rows.filter((a) => a.status === "active").length,
        exhausted: rows.filter((a) => a.status === "exhausted").length,
        pending: rows.filter((a) => a.status === "pending").length,
        error: rows.filter((a) => a.status === "error").length,
        credits: { used: Math.max(0, quotaLimit - quotaRemaining), total: quotaLimit, remaining: quotaRemaining },
      };
    });
  }, [accounts]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Accounts</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">Manage provider accounts</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleLoginAll}>
            <Play className="w-4 h-4 mr-2" /> Login Pending
          </Button>
        </div>
      </div>

      {/* Messages */}
      {(message || error) && (
        <div className={`rounded-md p-3 text-sm ${message ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--error)]/10 text-[var(--error)]"}`}>
          {message || error}
        </div>
      )}

      {/* Queue status - Login only */}
      {(Number(queue?.active || 0) > 0 || Number(queue?.queued || 0) > 0) && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-xs text-[var(--muted-foreground)]">
          Login: {Number(queue?.active || 0)} running, {Number(queue?.queued || 0)} queued
        </div>
      )}

      {/* Provider cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {providerStats.map((stat) => (
          <Card
            key={stat.provider}
            className="border-[var(--border)] cursor-pointer hover:border-[var(--primary)]/50 transition-colors"
            onClick={() => navigate(`/accounts/${stat.provider}`)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{labelProvider(stat.provider)}</CardTitle>
                <span className="text-xs text-[var(--muted-foreground)]">{stat.total} accounts</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Status grid */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-[var(--success)]">{stat.active}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Active</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-[var(--warning)]">{stat.exhausted}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Exhausted</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-[var(--warning)]">{stat.pending}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Pending</p>
                </div>
                <div className="rounded-md bg-[var(--secondary)] p-2">
                  <p className="text-lg font-bold text-[var(--error)]">{stat.error}</p>
                  <p className="text-[10px] text-[var(--muted-foreground)]">Error</p>
                </div>
              </div>

              {/* Credits remaining */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--muted-foreground)]">Credits</span>
                  <span className="text-[var(--foreground)]">
                    {stat.credits.remaining.toFixed(1)} / {stat.credits.total.toFixed(1)} remaining
                  </span>
                </div>
                <Progress
                  value={stat.credits.total > 0 ? Math.round((stat.credits.remaining / stat.credits.total) * 100) : 0}
                  className="h-2"
                />
              </div>

              {/* WarmUp progress - hide when completed */}
              {warmupProgress[stat.provider] && warmupProgress[stat.provider].completed < warmupProgress[stat.provider].total && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--muted-foreground)]">WarmUp</span>
                    <span className="text-[var(--foreground)]">
                      {warmupProgress[stat.provider].completed} / {warmupProgress[stat.provider].total} completed
                    </span>
                  </div>
                  <Progress
                    value={warmupProgress[stat.provider].total > 0 ? Math.round((warmupProgress[stat.provider].completed / warmupProgress[stat.provider].total) * 100) : 0}
                    className="h-2"
                  />
                </div>
              )}

              {/* Auto WarmUp toggle + countdown */}
              <div
                className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-2"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Flame className={`h-4 w-4 shrink-0 ${autoWarmupEnabledFor(stat.provider) ? "text-[var(--warning)]" : "text-[var(--muted-foreground)]"}`} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[var(--foreground)] leading-tight">Auto WarmUp</p>
                    <p className="text-[10px] text-[var(--muted-foreground)] leading-tight">
                      {autoWarmupEnabledFor(stat.provider)
                        ? autoWarmup?.nextRunAt
                          ? `Next in ${countdownLabel()} · every ${autoWarmup.intervalMinutes}m`
                          : `Every ${autoWarmup?.intervalMinutes ?? 15}m`
                        : "Disabled"}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleAutoWarmup(stat.provider)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    autoWarmupEnabledFor(stat.provider) ? "bg-[var(--primary)]" : "bg-[var(--border)]"
                  }`}
                  aria-label={`Toggle auto warmup for ${labelProvider(stat.provider)}`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      autoWarmupEnabledFor(stat.provider) ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              {/* Buttons */}
              <div className="grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                <Button className="w-full" variant="default" size="sm" onClick={() => handleOpenAddDialog(stat.provider)}>
                  <Plus className="mr-1 h-4 w-4" /> Add
                </Button>
                <Button className="w-full" variant="outline" size="sm" onClick={() => handleWarmupProvider(stat.provider)} disabled={Boolean(warmupProgress[stat.provider])}>
                  <RefreshCw className="mr-1 h-4 w-4" /> Warmup
                </Button>
                <Button className="w-full" variant="outline" size="sm" onClick={() => handleRetryErrors(stat.provider)} disabled={stat.error === 0}>
                  <RotateCcw className="mr-1 h-4 w-4" /> Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Login Pending Dialog */}
      <Dialog open={loginPendingDialog} onOpenChange={setLoginPendingDialog}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DTitle>Login Pending Accounts</DTitle>
            <DialogDescription>Choose how many accounts to login concurrently.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-3">
              <label className="text-sm text-[var(--muted-foreground)]">Concurrent:</label>
              <select value={loginPendingConcurrency} onChange={(e) => setLoginPendingConcurrency(Number(e.target.value))} className="h-8 w-20 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)]">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setLoginPendingDialog(false)}>Cancel</Button>
              <Button size="sm" onClick={confirmLoginAll}>
                <Play className="w-4 h-4 mr-2" /> Start Login
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Account Dialog (per-provider) */}
      <Dialog open={addDialogProvider !== null} onOpenChange={(open) => {
        if (open) return;
        handleCloseAddDialog();
      }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DTitle>Add {addDialogProvider ? labelProvider(addDialogProvider) : ""} Account</DTitle>
            <DialogDescription>
              {addDialogProvider === "kiro-pro" || addDialogProvider === "codex"
                ? "Add via browser login or instant login with API key/token."
                : addDialogProvider === "qoder"
                ? "Add via PAT, bulk Google accounts, or single account."
                : `Add account for ${addDialogProvider ? labelProvider(addDialogProvider) : "this provider"}.`}
            </DialogDescription>
          </DialogHeader>

          {/* Mode tabs */}
          {addDialogProvider === "kiro-pro" || addDialogProvider === "codex" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("instant")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "instant" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Instant Login (Token)</button>
              {addDialogProvider === "codex" && <button onClick={() => handleSetCodexMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >OAuth Login</button>}
              <button onClick={() => addDialogProvider === "codex" ? handleSetCodexMode("bulk") : setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => addDialogProvider === "codex" ? handleSetCodexMode("single") : setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          ) : addDialogProvider === "qoder" ? (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("pat")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "pat" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >PAT (Token)</button>
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          ) : (
            <div className="flex gap-1 rounded-md bg-[var(--secondary)] p-1">
              <button onClick={() => setAddMode("bulk")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "bulk" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Bulk (Email|Pass)</button>
              <button onClick={() => setAddMode("single")}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${addMode === "single" ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted-foreground)]"}`}
              >Single</button>
            </div>
          )}

          {/* Token / OAuth mode */}
          {addMode === "pat" && addDialogProvider === "qoder" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Personal Access Token (PAT)</label>
                <textarea
                  value={cookieValue}
                  onChange={(e) => setCookieValue(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder="qd-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste Qoder Personal Access Token. Server akan menukar dengan jobToken otomatis dan menyimpan kredensial untuk inference.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleCookieLogin}>Add Account</Button>
              </div>
            </div>
          )}

          {addMode === "pat" && addDialogProvider === "codex" && (
            <div className="space-y-3">
              <div className="rounded-md border border-[var(--border)] bg-[var(--secondary)]/30 p-3 text-sm text-[var(--muted-foreground)]">
                Login Codex bisa via popup OpenAI atau mode manual: generate auth URL, buka, lalu paste callback URL.
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" size="sm" onClick={handleCodexOAuthPrepareManual} disabled={codexOauthBusy || hasPreparedCodexOAuth}>
                  {hasPreparedCodexOAuth ? "Manual Ready" : codexOauthBusy ? "Preparing..." : "Prepare Manual"}
                </Button>
                <Button size="sm" onClick={handleCodexOAuthLogin} disabled={codexOauthBusy || hasPreparedCodexOAuth}>
                  {codexOauthBusy ? "Waiting for OAuth..." : "Start OAuth Login"}
                </Button>
              </div>

              {hasPreparedCodexOAuth && (
                <div className="space-y-3 rounded-md border border-[var(--border)] p-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-sm text-[var(--foreground)]">Auth URL</label>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={handleCodexOAuthCopyAuthUrl}>Copy</Button>
                        <Button size="sm" variant="outline" onClick={handleCodexOAuthOpenManual}>Open</Button>
                      </div>
                    </div>
                    <textarea
                      value={codexOauthAuthUrl}
                      readOnly
                      className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-mono text-[var(--foreground)] focus:outline-none resize-none"
                    />
                  </div>

                  <div className="rounded-md bg-[var(--secondary)]/30 p-3 text-xs text-[var(--muted-foreground)] space-y-1.5">
                    <p><span className="text-[var(--foreground)]">Callback:</span> <code className="break-all">{codexLoopbackUrl}</code></p>
                    <p><span className="text-[var(--foreground)]">Contoh:</span> <code className="break-all">{codexCallbackExample}</code></p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-sm text-[var(--foreground)]">Callback URL</label>
                      <Button size="sm" variant="outline" onClick={handleCodexOAuthPasteCallback} disabled={codexOauthBusy}>Paste</Button>
                    </div>
                    <textarea
                      value={codexOauthCallbackUrl}
                      onChange={(e) => setCodexOauthCallbackUrl(e.target.value)}
                      className="w-full h-20 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                      placeholder={codexCallbackExample}
                    />
                    <div className="flex justify-end">
                      <Button size="sm" onClick={handleCodexOAuthSubmitManual} disabled={codexOauthBusy || !codexCallbackReady}>
                        {codexOauthBusy ? "Completing OAuth..." : "Submit Callback URL"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={handleCloseAddDialog} disabled={codexOauthBusy && !hasPreparedCodexOAuth}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Instant Login mode (Kiro Pro only) */}
          {addMode === "instant" && (addDialogProvider === "kiro-pro" || addDialogProvider === "codex") && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Refresh Tokens (satu per baris)</label>
                <textarea
                  value={instantTokens}
                  onChange={(e) => setInstantTokens(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={"eyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs...\neyJhbGciOiJSUzI1NiIs..."}
                />
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">Paste refresh token per baris. Email otomatis di-extract dari token.</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleInstantLogin}>Login Instant</Button>
              </div>
            </div>
          )}

          {/* Bulk mode (all providers) */}
          {addMode === "bulk" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Accounts (email|password per baris)</label>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="mt-1 w-full h-40 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] resize-none"
                  placeholder={"email@example.com|password123\nanother@example.com|pass456"}
                />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Browser Engine</label>
                <select value={bulkBrowserEngine} onChange={(e) => setBulkBrowserEngine(e.target.value)} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                  <option value="camoufox">Camoufox (Anti-detect, default)</option>
                  <option value="chromium">Chromium (Playwright)</option>
                </select>
              </div>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                  <input type="checkbox" checked={bulkHeadless} onChange={(e) => setBulkHeadless(e.target.checked)} className="h-4 w-4 rounded border-[var(--border)]" />
                  Run browser headless
                </label>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-[var(--foreground)]">Concurrent:</label>
                  <select value={bulkConcurrency} onChange={(e) => setBulkConcurrency(Number(e.target.value))} className="h-8 w-16 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)]">
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleBulkImport}>Import & Login</Button>
              </div>
            </div>
          )}

          {/* Single mode (all providers) */}
          {addMode === "single" && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[var(--foreground)]">Email</label>
                <Input value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="email@example.com" className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Password</label>
                <Input value={addForm.password} onChange={(e) => setAddForm({ ...addForm, password: e.target.value })} type="password" placeholder="********" className="mt-1" />
              </div>
              <div>
                <label className="text-sm text-[var(--foreground)]">Browser Engine</label>
                <select value={addForm.browserEngine} onChange={(e) => setAddForm({ ...addForm, browserEngine: e.target.value })} className="mt-1 w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
                  <option value="camoufox">Camoufox (Anti-detect, default)</option>
                  <option value="chromium">Chromium (Playwright)</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                <input type="checkbox" checked={addForm.headless} onChange={(e) => setAddForm({ ...addForm, headless: e.target.checked })} className="h-4 w-4 rounded border-[var(--border)]" />
                Run browser headless
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setAddDialogProvider(null)}>Cancel</Button>
                <Button onClick={handleAdd}>Add Account</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
