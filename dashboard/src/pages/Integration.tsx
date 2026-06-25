import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Plug,
  ArrowRight,
  Search,
  ChevronsUpDown,
  Check,
  Terminal,
  Zap,
  RefreshCw,
  Code,
  Box,
  Hammer,
  PawPrint,
} from "lucide-react";
import {
  fetchIntegration,
  saveIntegration,
  fetchApiKey,
  applyIntegrationConfig,
  fetchIntegrationClients,
  applyClientConfig,
  applyAllClients,
  restoreClientConfig,
  API_BASE,
  type ModelMappingDTO,
  type ClientMetaDTO,
  type IntegrationModelDTO,
} from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";
import { useWsEvent } from "@/hooks/useWebSocket";
import { ClientCard } from "@/components/integration/ClientCard";

// the assistant only ever calls these three model classes.
const CLAUDE_CODE_SLOTS = [
  { source: "haiku", title: "Haiku", desc: "small / fast / background tasks" },
  { source: "sonnet", title: "Sonnet", desc: "main coding model" },
  { source: "opus", title: "Opus", desc: "heavy reasoning" },
] as const;

/** Searchable model dropdown. */
function ModelCombobox({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { id: string; owned_by: string }[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Simple implementation using useEffect for click-outside
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (
        containerRef &&
        !containerRef.contains(e.target as Node)
      )
        setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, containerRef]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) =>
          o.id.toLowerCase().includes(q) ||
          o.owned_by.toLowerCase().includes(q)
      )
    : options;

  const select = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const triggerCls =
    "w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] text-sm flex items-center justify-between gap-2 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]";

  return (
    <div ref={setContainerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={triggerCls}
      >
        <span
          className={
            value
              ? "truncate text-[var(--foreground)]"
              : "truncate text-[var(--muted-foreground)]"
          }
        >
          {value || "— pass through (no mapping) —"}
        </span>
        <ChevronsUpDown className="w-4 h-4 opacity-60 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] shadow-lg">
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--border)]">
            <Search className="w-3.5 h-3.5 text-[var(--muted-foreground)] shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              className="w-full bg-transparent text-sm focus:outline-none text-[var(--foreground)]"
            />
          </div>
          <ul className="max-h-[18rem] overflow-y-auto py-1">
            <li>
              <button
                type="button"
                onClick={() => select("")}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)] flex items-center justify-between ${
                  !value ? "bg-[var(--secondary)]" : ""
                }`}
              >
                <span className="text-[var(--muted-foreground)]">
                  — pass through (no mapping) —
                </span>
                {!value && (
                  <Check className="w-3.5 h-3.5 text-[var(--primary)]" />
                )}
              </button>
            </li>
            {filtered.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => select(o.id)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--secondary)] flex items-center justify-between gap-2 ${
                    value === o.id ? "bg-[var(--secondary)]" : ""
                  }`}
                >
                  <span className="truncate text-[var(--foreground)]">
                    {o.id}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {o.owned_by}
                    </span>
                    {value === o.id && (
                      <Check className="w-3.5 h-3.5 text-[var(--primary)]" />
                    )}
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
                No models match "{query}".
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function Integration() {
  const [enabled, setEnabled] = useState(true);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [models, setModels] = useState<
    { id: string; owned_by: string }[]
  >([]);
  // Fix #7: loading state for API key
  const [apiKey, setApiKey] = useState("");
  const [loadingApiKey, setLoadingApiKey] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingClients, setLoadingClients] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  // Fix #1: applyAll state
  const [applyingAll, setApplyingAll] = useState(false);
  const { message: applyAllResult, setMessage: setApplyAllResult } = useTimedMessage<string>(null, 4000);
  const [clients, setClients] = useState<ClientMetaDTO[]>([]);
  const [integrationModels, setIntegrationModels] = useState<
    IntegrationModelDTO[]
  >([]);
  const [activeTab, setActiveTab] = useState("claude");
  const { message, setMessage } = useTimedMessage<string>(null, 3000);

  const baseUrl = API_BASE;
  const defaultModel = "kp/sonnet-4.6";

  // Per-client model selection
  const [clientModels, setClientModels] = useState<Record<string, string>>({
    opencode: "kp/sonnet-4.6",
    codex: "cx/auto",
    hermes: "kp/sonnet-4.6",
    openclaw: "kp/sonnet-4.6",
    kilo: "kp/sonnet-4.6",
  });

  const load = useCallback(async () => {
    try {
      setLoadingApiKey(true);
      const [data, keyRes] = await Promise.all([
        fetchIntegration(),
        fetchApiKey().catch(() => null),
      ]);
      setEnabled(data.enabled);
      setModels(data.models || []);

      const next: Record<string, string> = {};
      for (const slot of CLAUDE_CODE_SLOTS) {
        const found = (data.mappings || []).find(
          (m) => m.sourcePattern.toLowerCase() === slot.source
        );
        next[slot.source] = found?.targetModel || "";
      }
      setTargets(next);
      if (keyRes?.key) setApiKey(keyRes.key);
    } catch (e: unknown) {
      setMessage((e instanceof Error ? e.message : null) || "Failed to load integration settings");
    } finally {
      setLoading(false);
      setLoadingApiKey(false);
    }
  }, [setMessage]);

  const loadClients = useCallback(async () => {
    setLoadingClients(true);
    try {
      const data = await fetchIntegrationClients();
      setClients(data.clients || []);
      setIntegrationModels(data.models || []);
    } catch (e: unknown) {
      console.error("Failed to load clients:", e);
    } finally {
      setLoadingClients(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadClients();
  }, [load, loadClients]);
  useWsEvent(["model_mappings_updated"], load);

  const handleSave = async () => {
    setSaving(true);
    try {
      const mappings: ModelMappingDTO[] = CLAUDE_CODE_SLOTS.map((slot, i) => ({
        sourcePattern: slot.source,
        matchType: "contains",
        targetModel: targets[slot.source] || "",
        enabled: Boolean(targets[slot.source]),
        priority: i,
        label: `the assistant · ${slot.title}`,
      }));
      await saveIntegration({ enabled, mappings });
      setMessage("Saved");
    } catch (e: unknown) {
      setMessage((e instanceof Error ? e.message : null) || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleApplyConfig = async () => {
    setApplying(true);
    try {
      await applyIntegrationConfig(baseUrl);
      setMessage("Applied configuration to ~/.claude/settings.json");
    } catch (e: unknown) {
      setMessage((e instanceof Error ? e.message : null) || "Failed to apply configuration");
    } finally {
      setApplying(false);
    }
  };

  // Fix #1: apply all clients handler
  const handleApplyAll = async () => {
    setApplyingAll(true);
    try {
      await applyAllClients(baseUrl);
      setApplyAllResult("Applied all detected clients successfully");
      await loadClients();
    } catch (e: unknown) {
      setApplyAllResult((e instanceof Error ? e.message : null) || "Failed to apply all clients");
    } finally {
      setApplyingAll(false);
    }
  };

  const handleApplyClient = async (clientId: string, model: string) => {
    await applyClientConfig(clientId, baseUrl, model);
    await loadClients();
  };

  const handleRestoreClient = async (clientId: string) => {
    await restoreClientConfig(clientId);
    await loadClients();
  };

  // Fix #2: helper for tab content with loading/empty state
  function ClientTabContent({ clientId, model, onModelChange, showPreview }: {
    clientId: string;
    model: string;
    onModelChange: (m: string) => void;
    showPreview?: boolean;
  }) {
    if (loadingClients) {
      return (
        <div className="flex items-center gap-2 py-8 text-sm text-[var(--muted-foreground)]">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading...
        </div>
      );
    }
    const matched = clients.filter((c) => c.id === clientId);
    if (matched.length === 0) {
      return (
        <p className="text-sm text-[var(--muted-foreground)]">
          Client not detected on this machine.
        </p>
      );
    }
    return (
      <>
        {matched.map((c) => (
          <ClientCard
            key={c.id}
            client={c}
            baseUrl={baseUrl}
            apiKey={loadingApiKey ? "" : apiKey}
            model={model}
            models={integrationModels}
            showPreview={showPreview}
            onModelChange={onModelChange}
            onApply={handleApplyClient}
            onRestore={handleRestoreClient}
          />
        ))}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)] flex items-center gap-2">
            <Plug className="w-6 h-6" /> Integration
          </h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Connect AI coding tools to your proxy pool
          </p>
        </div>
        {/* Fix #1: Apply All Detected button */}
        <div className="flex items-center gap-2">
          <Button
            onClick={handleApplyAll}
            disabled={applyingAll}
            variant="outline"
            className="gap-2"
          >
            {applyingAll ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Zap className="w-4 h-4" />
            )}
            Apply All Detected
          </Button>
        </div>
      </div>

      {/* Fix #1: toast for applyAll result */}
      {applyAllResult && (
        <div className="px-4 py-2 rounded-md bg-[var(--secondary)] text-sm text-[var(--foreground)]">
          {applyAllResult}
        </div>
      )}

      {message && (
        <div className="px-4 py-2 rounded-md bg-[var(--secondary)] text-sm text-[var(--foreground)]">
          {message}
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="claude" className="gap-1.5">
            <Terminal className="w-3.5 h-3.5" /> Claude
          </TabsTrigger>
          <TabsTrigger value="opencode" className="gap-1.5">
            <Code className="w-3.5 h-3.5" /> OpenCode
          </TabsTrigger>
          <TabsTrigger value="codex" className="gap-1.5">
            <Box className="w-3.5 h-3.5" /> Codex
          </TabsTrigger>
          <TabsTrigger value="hermes" className="gap-1.5">
            <Hammer className="w-3.5 h-3.5" /> Hermes
          </TabsTrigger>
          <TabsTrigger value="openclaw" className="gap-1.5">
            <PawPrint className="w-3.5 h-3.5" /> OpenClaw
          </TabsTrigger>
          <TabsTrigger value="kilo" className="gap-1.5">
            <Zap className="w-3.5 h-3.5" /> Kilo
          </TabsTrigger>
        </TabsList>

        {/* ── Claude Tab ──────────────────────────────────────── */}
        <TabsContent value="claude" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Terminal className="w-4 h-4" /> the assistant Setup
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-[var(--muted-foreground)]">
                Point the assistant at this proxy. Sets{" "}
                <code className="text-xs bg-[var(--secondary)] px-1 py-0.5 rounded">
                  ANTHROPIC_BASE_URL
                </code>{" "}
                and{" "}
                <code className="text-xs bg-[var(--secondary)] px-1 py-0.5 rounded">
                  ANTHROPIC_AUTH_TOKEN
                </code>{" "}
                in{" "}
                <code className="text-xs bg-[var(--secondary)] px-1 py-0.5 rounded">
                  ~/.claude/settings.json
                </code>
                .
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <CodeRow label="ANTHROPIC_BASE_URL" value={baseUrl} />
                {/* Fix #7: grey placeholder while loading */}
                {loadingApiKey ? (
                  <div>
                    <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">
                      ANTHROPIC_AUTH_TOKEN
                    </label>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)]">
                      <span className="flex-1 h-4 rounded bg-[var(--secondary)] animate-pulse" />
                    </div>
                  </div>
                ) : (
                  <CodeRow label="ANTHROPIC_AUTH_TOKEN" value={apiKey || "<YOUR_API_KEY>"} />
                )}
              </div>
              <Button onClick={handleApplyConfig} disabled={applying} className="gap-2">
                {applying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Apply Config
              </Button>
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enable mapping
            </label>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ArrowRight className="w-4 h-4" /> Model Mapping
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-[var(--muted-foreground)]">Loading...</p>
              ) : (
                <div className="space-y-3">
                  {CLAUDE_CODE_SLOTS.map((slot) => (
                    <div key={slot.source} className="flex flex-col gap-2 sm:flex-row sm:items-center px-4 py-3 rounded-md bg-[var(--secondary)]">
                      <div className="sm:w-48 shrink-0">
                        <div className="text-sm font-medium text-[var(--foreground)]">{slot.title}</div>
                        <div className="text-xs text-[var(--muted-foreground)]">{slot.desc}</div>
                      </div>
                      <ArrowRight className="hidden sm:block w-4 h-4 text-[var(--muted-foreground)] shrink-0" />
                      <ModelCombobox
                        value={targets[slot.source] || ""}
                        options={models}
                        onChange={(id) => setTargets((t) => ({ ...t, [slot.source]: id }))}
                      />
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs text-[var(--muted-foreground)]">
                Leave "pass through" to keep original behavior. Changes apply after Save.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── OpenCode Tab ────────────────────────────────────── */}
        <TabsContent value="opencode" className="space-y-6">
          <ClientTabContent
            clientId="opencode"
            model={clientModels.opencode || defaultModel}
            onModelChange={(m) => setClientModels((p) => ({ ...p, opencode: m }))}
            showPreview
          />
        </TabsContent>

        {/* ── Codex Tab ───────────────────────────────────────── */}
        <TabsContent value="codex" className="space-y-6">
          {/* Fix #8: showPreview={true} for Codex */}
          <ClientTabContent
            clientId="codex"
            model={clientModels.codex || "cx/auto"}
            onModelChange={(m) => setClientModels((p) => ({ ...p, codex: m }))}
            showPreview
          />
        </TabsContent>

        {/* ── Hermes Tab ──────────────────────────────────────── */}
        <TabsContent value="hermes" className="space-y-6">
          {/* Fix #8: showPreview={true} for Hermes */}
          <ClientTabContent
            clientId="hermes"
            model={clientModels.hermes || defaultModel}
            onModelChange={(m) => setClientModels((p) => ({ ...p, hermes: m }))}
            showPreview
          />
        </TabsContent>

        {/* ── OpenClaw Tab ────────────────────────────────────── */}
        <TabsContent value="openclaw" className="space-y-6">
          <ClientTabContent
            clientId="openclaw"
            model={clientModels.openclaw || defaultModel}
            onModelChange={(m) => setClientModels((p) => ({ ...p, openclaw: m }))}
            showPreview
          />
        </TabsContent>

        {/* ── Kilo Tab ────────────────────────────────────────── */}
        <TabsContent value="kilo" className="space-y-6">
          <ClientTabContent
            clientId="kilo"
            model={clientModels.kilo || defaultModel}
            onModelChange={(m) => setClientModels((p) => ({ ...p, kilo: m }))}
            showPreview
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Inline copyable code row */
function CodeRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <label className="text-xs font-medium text-[var(--muted-foreground)] mb-1 block">
        {label}
      </label>
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)]">
        <code className="text-sm font-mono text-[var(--foreground)] truncate flex-1">
          {value}
        </code>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard unavailable */
            }
          }}
          className="p-1.5 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)] transition-colors shrink-0"
          title="Copy"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-[var(--success)]" />
          ) : (
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
