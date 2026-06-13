import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, RefreshCw, Zap, Flame, Globe, Wand2 } from "lucide-react";
import {
  fetchSettings,
  updateSettings,
  fetchProviderList,
  fetchAutoWarmupStatus,
  type AutoWarmupStatus,
} from "@/lib/api";
import { useApi } from "@/hooks/useApi";
import { useTimedMessage } from "@/hooks/useTimedMessage";

const PROVIDER_LABELS: Record<string, string> = {
  kiro: "Kiro",
  "kiro-pro": "Kiro Pro",
  codebuddy: "CodeBuddy",
  canva: "Canva",
};

function labelFor(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider]!;
  return provider
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export default function Settings() {
  const [form, setForm] = useState<Record<string, string>>({
    load_balancing_method: "round_robin",
    auto_warmup_interval_minutes: "15",
    proxy_pool_usage: "all",
    proxy_pool_rotation: "round_robin",
    // Compression defaults — keep in sync with DEFAULT_COMPRESSION_CONFIG.
    compression_rtk_enabled: "true",
    compression_rtk_max_tool_chars: "4000",
    compression_rtk_keep_last_n_turns_full: "2",
    compression_rtk_smart_truncate: "true",
    compression_dcp_enabled: "false",
    compression_caveman_enabled: "false",
    compression_caveman_level: "lite",
    compression_cache_markers_enabled: "true",
    compression_image_dedupe_enabled: "true",
  });
  const [warmupStatus, setWarmupStatus] = useState<AutoWarmupStatus | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const providerListApi = useApi<{ data: string[] }>(fetchProviderList, []);

  const providers = useMemo(
    () => providerListApi.data?.data || [],
    [providerListApi.data]
  );

  async function load() {
    const res = (await fetchSettings()) as { data: Record<string, string> };
    setForm((current) => ({ ...current, ...(res.data || {}) }));
    setDirty(false);
    fetchAutoWarmupStatus().then(setWarmupStatus).catch(() => {});
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  function setValue(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  function lbMethodFor(provider: string): string {
    return (
      form[`provider_${provider}_lb_method`] ||
      form.load_balancing_method ||
      "round_robin"
    );
  }

  function isOverride(provider: string): boolean {
    return Boolean(form[`provider_${provider}_lb_method`]);
  }

  async function save() {
    setSaving(true);
    try {
      await updateSettings(form);
      setSavedAt(new Date());
      setDirty(false);
      setMessage("Settings saved.");
    } finally {
      setSaving(false);
    }
  }

  const globalMethod = form.load_balancing_method || "round_robin";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Proxy Settings</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Configure load balancing and auto warmup
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <span className="text-xs text-[var(--warning)] px-2 py-1 rounded bg-[var(--warning)]/10">
              Unsaved
            </span>
          )}
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="w-4 h-4 mr-2" /> Reload
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            <Save className="w-4 h-4 mr-2" /> {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {message && (
        <div className="rounded-md bg-[var(--success)]/10 p-3 text-sm text-[var(--success)]">
          {message}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Load Balancing */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-4 h-4 text-[var(--primary)]" />
              Load Balancing
            </CardTitle>
            <CardDescription>
              Control how requests are distributed across accounts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Global Method
              </label>
              <select
                value={form.load_balancing_method || "round_robin"}
                onChange={(e) => setValue("load_balancing_method", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {globalMethod === "sequential"
                  ? "Uses accounts in order, moves to next only when current is exhausted."
                  : "Distributes requests evenly across all active accounts."}
              </p>
            </div>

            {providers.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-[var(--foreground)]">
                  Per-Provider Override
                </div>
                <div className="space-y-2">
                  {providers.map((provider) => {
                    const key = `provider_${provider}_lb_method`;
                    const effective = lbMethodFor(provider);
                    const overriden = isOverride(provider);
                    return (
                      <div
                        key={provider}
                        className="flex items-center justify-between gap-3 p-3 rounded-lg bg-[var(--secondary)] border border-transparent hover:border-[var(--border)] transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--foreground)] flex items-center gap-2">
                            {labelFor(provider)}
                            {overriden && (
                              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--primary)]/20 text-[var(--primary)]">
                                override
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-[var(--muted-foreground)]">
                            {effective === "sequential" ? "Sequential" : "Round Robin"}
                            {!overriden && (
                              <span className="ml-1 text-[var(--muted-foreground)]/70">
                                (inherits global)
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={form[key] || ""}
                            onChange={(e) => setValue(key, e.target.value)}
                            className="h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
                          >
                            <option value="">Inherit</option>
                            <option value="round_robin">Round Robin</option>
                            <option value="sequential">Sequential</option>
                          </select>
                          {overriden && (
                            <button
                              type="button"
                              onClick={() => setValue(key, "")}
                              className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] px-2 py-1 rounded hover:bg-[var(--secondary)]"
                              title="Clear override"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Auto WarmUp */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Flame className="w-4 h-4 text-[var(--primary)]" />
              Auto WarmUp
            </CardTitle>
            <CardDescription>
              Automatically warm up enabled providers on a schedule
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm text-[var(--foreground)]">Interval (minutes)</label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={form.auto_warmup_interval_minutes || ""}
                onChange={(e) => setValue("auto_warmup_interval_minutes", e.target.value)}
                placeholder="15"
                className="mt-1"
              />
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                Global interval for all providers with Auto WarmUp enabled
              </p>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-3 space-y-2">
              <p className="text-xs text-[var(--muted-foreground)]">Status</p>
              <p className="text-sm font-medium text-[var(--foreground)]">
                {warmupStatus && warmupStatus.enabledProviders.length > 0
                  ? `${warmupStatus.enabledProviders.length} provider${warmupStatus.enabledProviders.length === 1 ? "" : "s"} enabled`
                  : "No provider enabled"}
              </p>
              {warmupStatus?.enabledProviders && warmupStatus.enabledProviders.length > 0 && (
                <p className="text-xs text-[var(--muted-foreground)] truncate">
                  {warmupStatus.enabledProviders.map(labelFor).join(", ")}
                </p>
              )}
              {warmupStatus?.nextRunAt && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  Next run: {new Date(warmupStatus.nextRunAt).toLocaleTimeString()}
                </p>
              )}
              {savedAt && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  Last saved: {savedAt.toLocaleTimeString()}
                </p>
              )}
            </div>

            <p className="text-xs text-[var(--muted-foreground)]">
              Auto WarmUp checks accounts with status active, exhausted, or error (skips pending). Enable/disable per provider on the Accounts page.
            </p>
          </CardContent>
        </Card>

        {/* Proxy Pool */}
        <Card className="border-[var(--border)]">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="w-4 h-4 text-[var(--primary)]" />
              Proxy Pool
            </CardTitle>
            <CardDescription>
              Configure how the proxy pool is used for outgoing requests
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Usage Scope
              </label>
              <select
                value={form.proxy_pool_usage || "all"}
                onChange={(e) => setValue("proxy_pool_usage", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="all">All — Model + Auth</option>
                <option value="model">Model Only — API requests only</option>
                <option value="auth">Auth Only — Login automation only</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {form.proxy_pool_usage === "model"
                  ? "Proxies are only used for upstream model API calls. Auth/login runs without proxy."
                  : form.proxy_pool_usage === "auth"
                    ? "Proxies are only used for login automation. Model API calls go direct."
                    : "Proxies are used for both model API calls and login automation."}
              </p>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4 space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">
                Rotation Strategy
              </label>
              <select
                value={form.proxy_pool_rotation || "round_robin"}
                onChange={(e) => setValue("proxy_pool_rotation", e.target.value)}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"
              >
                <option value="round_robin">Round Robin</option>
                <option value="sequential">Sequential</option>
              </select>
              <p className="text-xs text-[var(--muted-foreground)]">
                {form.proxy_pool_rotation === "sequential"
                  ? "Uses one proxy until it fails, then moves to the next in the list."
                  : "Distributes requests evenly across all active proxies in rotation."}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Compression — token saver pipeline */}
        <Card className="border-[var(--border)] lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-[var(--primary)]" />
              Compression
            </CardTitle>
            <CardDescription>
              Reduce token usage by compressing tool outputs, deduplicating context, and shortening prompts. Pipeline runs in order: DCP → RTK → Caveman → Image Dedupe → Cache Markers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* RTK */}
            <CompressionRow
              title="RTK"
              subtitle="Tool Result Compression"
              description="Truncates large tool outputs (git diff, grep, file reads) in OLDER turns. The last N turns are passed through untouched so the model still sees fresh context."
              enabled={form.compression_rtk_enabled === "true"}
              onToggle={(v) => setValue("compression_rtk_enabled", v ? "true" : "false")}
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">Max chars per tool result</label>
                  <Input
                    type="number"
                    min={500}
                    max={50000}
                    step={500}
                    value={form.compression_rtk_max_tool_chars || "4000"}
                    onChange={(e) => setValue("compression_rtk_max_tool_chars", e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted-foreground)]">Keep last N turns full</label>
                  <Input
                    type="number"
                    min={0}
                    max={20}
                    value={form.compression_rtk_keep_last_n_turns_full || "2"}
                    onChange={(e) => setValue("compression_rtk_keep_last_n_turns_full", e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-xs text-[var(--foreground)]">
                    <input
                      type="checkbox"
                      checked={form.compression_rtk_smart_truncate === "true"}
                      onChange={(e) => setValue("compression_rtk_smart_truncate", e.target.checked ? "true" : "false")}
                    />
                    Smart truncate (git diff / tree)
                  </label>
                </div>
              </div>
            </CompressionRow>

            {/* DCP */}
            <CompressionRow
              title="DCP"
              subtitle="Context Deduplication"
              description="When the same read-only tool (Read, Glob, Grep, LS, WebFetch) is called twice with identical input, the older result is replaced with a short reference stub. Lossless from the model's perspective."
              enabled={form.compression_dcp_enabled === "true"}
              onToggle={(v) => setValue("compression_dcp_enabled", v ? "true" : "false")}
            />

            {/* Caveman */}
            <CompressionRow
              title="Caveman"
              subtitle="Terse System Prompt"
              description="Strips filler words and compacts the system prompt. ⚠️ Off by default — aggressive levels can change model behaviour. Test with your own prompts before enabling Full or Ultra."
              enabled={form.compression_caveman_enabled === "true"}
              onToggle={(v) => setValue("compression_caveman_enabled", v ? "true" : "false")}
              alwaysShowChildren
            >
              <div className="mt-3 space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  Compression level
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { lvl: "lite", title: "Lite", subtitle: "Drop filler", hint: "~5–15% saving · safest" },
                      { lvl: "full", title: "Full", subtitle: "Bullet form", hint: "~30–50% saving · moderate risk" },
                      { lvl: "ultra", title: "Ultra", subtitle: "Telegraphic", hint: "~50–70% saving · may degrade output" },
                    ] as const
                  ).map(({ lvl, title, subtitle, hint }) => {
                    const selected = form.compression_caveman_level === lvl;
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setValue("compression_caveman_level", lvl)}
                        title={hint}
                        className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors text-left ${
                          selected
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                            : "border-[var(--border)] bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <div>{title}</div>
                        <div className="text-[10px] mt-0.5 opacity-70">{subtitle}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
                  {form.compression_caveman_level === "lite" &&
                    "Lite: removes politeness fillers (\"please\", \"make sure to\") and verbose connectors. Sentence structure preserved. Saves ~5–15%."}
                  {form.compression_caveman_level === "full" &&
                    "Full: lite + collapses narrative connectors (\"furthermore\", \"that being said\"), drops \"the following\" lead-ins, simplifies if/when clauses. Saves ~30–50%. Test before deploying."}
                  {form.compression_caveman_level === "ultra" &&
                    "Ultra: full + drops articles (a/an/the), drops modal helpers (you can/may/might), forces imperative voice. Saves ~50–70% but may degrade model behaviour. Use only after benchmarking."}
                </p>
              </div>
            </CompressionRow>

            {/* Cache Markers */}
            <CompressionRow
              title="Cache Markers"
              subtitle="Anthropic Prompt Caching"
              description="Tags the stable system-prompt prefix with cache_control:ephemeral so upstream providers can cache it. Auto-skips when prefix contains timestamps or UUIDs (would never cache anyway). Pays off as ~75% discount on repeat input tokens."
              enabled={form.compression_cache_markers_enabled === "true"}
              onToggle={(v) => setValue("compression_cache_markers_enabled", v ? "true" : "false")}
            />

            {/* Image Dedupe */}
            <CompressionRow
              title="Image Dedupe"
              subtitle="Duplicate Image Detection"
              description="When the same image is attached more than once in a request, later occurrences are replaced with a reference stub. Lossless — the image is still in earlier context."
              enabled={form.compression_image_dedupe_enabled === "true"}
              onToggle={(v) => setValue("compression_image_dedupe_enabled", v ? "true" : "false")}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CompressionRow({
  title,
  subtitle,
  description,
  enabled,
  onToggle,
  children,
  alwaysShowChildren = false,
}: {
  title: string;
  subtitle: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
  /** When true, children render even when toggle is off (visually dimmed). */
  alwaysShowChildren?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-[var(--foreground)]">{title}</span>
            <span className="text-xs text-[var(--muted-foreground)]">({subtitle})</span>
          </div>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{description}</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <div className="w-10 h-5 bg-[var(--border)] peer-checked:bg-[var(--primary)] rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-5"></div>
        </label>
      </div>
      {children && (alwaysShowChildren || enabled) && (
        <div className={alwaysShowChildren && !enabled ? "opacity-50 pointer-events-none" : ""}>
          {children}
        </div>
      )}
    </div>
  );
}
