import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchRequests, fetchRequestDetail, fetchAccounts } from "@/lib/api";
import { formatDateTimeID } from "@/lib/utils";
import { useWsEvent } from "@/hooks/useWebSocket";

interface ActiveStream {
  id: number;
  provider: string;
  model: string;
  accountEmail: string;
  promptTokens: number;
  startedAt: number;
}

interface RequestLog {
  id: number;
  createdAt: string;
  provider: string;
  model: string | null;
  status: "success" | "error" | "streaming";
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  creditsUsed?: number | null;
  accountId: number | null;
  accountEmail?: string | null;
  accountQuotaBefore?: number | null;
  accountQuotaAfter?: number | null;
  errorMessage: string | null;
  requestBody?: unknown;
  responseBody?: unknown;
  compressionStats?: CompressionStats | null;
}

interface CompressionStats {
  tokensBefore: number;
  tokensAfter: number;
  saved: number;
  savedPct: number;
  byTechnique?: {
    tsc?: number;
    rtk?: number;
    dcp?: number;
    caveman?: number;
    imageDedupe?: number;
    cacheMarkers?: number;
  };
  /** Per-shape-filter savings inside RTK (only present when RTK fired). */
  rtkFilters?: Record<string, number>;
  durationMs: number;
}

function getCreditMeta(req: RequestLog) {
  const body = req.requestBody as { _poolprox?: { creditSource?: string; creditUnit?: string; creditRate?: number } } | null | undefined;
  return body?._poolprox || {};
}

function getStatusColor(status: string): "success" | "warning" | "error" {
  if (status === "success") return "success";
  if (status.includes("429")) return "warning";
  return "error";
}

function labelProvider(provider: string) {
  return provider === "codebuddy" ? "CodeBuddy" : provider.charAt(0).toUpperCase() + provider.slice(1);
}

const PROVIDER_COLORS: Record<string, string> = {
  kiro: "bg-[var(--chart-1)]/15 text-[var(--chart-1)]",
  "kiro-pro": "bg-[var(--chart-2)]/15 text-[var(--chart-2)]",
  codebuddy: "bg-[var(--chart-3)]/15 text-[var(--chart-3)]",
  canva: "bg-[var(--chart-4)]/15 text-[var(--chart-4)]",
  qoder: "bg-[var(--chart-5)]/15 text-[var(--chart-5)]",
  byok: "bg-[var(--chart-6)]/15 text-[var(--chart-6)]",
};

function providerBadgeClass(provider: string): string {
  return PROVIDER_COLORS[provider] ?? "bg-[var(--secondary)] text-[var(--foreground)]";
}

const FLOW_PROVIDERS = ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder", "alibaba", "antigravity", "mimo", "byok"];

const PROVIDER_HEX: Record<string, string> = {
  kiro: "#22c55e",
  "kiro-pro": "#a855f7",
  codebuddy: "#f59e0b",
  canva: "#ec4899",
  codex: "#3b82f6",
  qoder: "#14b8a6",
  alibaba: "#f97316",
  antigravity: "#8b5cf6",
  mimo: "#06b6d4",
  byok: "#6b7280",
};

interface FlowViewProps {
  activeStreams: Map<number, ActiveStream>;
  logs: RequestLog[];
  openDetail: (req: RequestLog) => void;
  accountQuotas: Record<string, { total: number; remaining: number }>;
}

function FlowView({ activeStreams, logs, openDetail, accountQuotas }: FlowViewProps) {
  const W = 480, H = 360;
  const cx = W / 2, cy = H / 2;
  const radius = 120;

  const activeStreamList = Array.from(activeStreams.values());

  // Show providers that have quota (from accounts)
  const quotaProviders = FLOW_PROVIDERS.filter((p) => accountQuotas[p] && accountQuotas[p].total > 0);

  const providerPositions = quotaProviders.map((p, i) => {
    const angle = (i / Math.max(quotaProviders.length, 1)) * 2 * Math.PI - Math.PI / 2;
    return { id: p, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });

  const recentRequests = logs.slice(0, 25);

  const PANEL_WIDTH = 260;

  // Provider logo config
  const LOGO_COLORS: Record<string, string> = {
    kiro: "#8b5cf6",
    "kiro-pro": "#a78bfa",
    codebuddy: "#f59e0b",
    canva: "#e84393",
    codex: "#3b82f6",
    qoder: "#14b8a6",
    mimo: "#f97316",
    alibaba: "#ea580c",
    antigravity: "#6366f1",
    byok: "#64748b",
  };

  const LOGO_LABELS: Record<string, string> = {
    kiro: "K",
    "kiro-pro": "KP",
    codebuddy: "CB",
    canva: "Ca",
    codex: "Cx",
    qoder: "Qd",
    mimo: "Mm",
    alibaba: "Ali",
    antigravity: "Ag",
    byok: "BY",
  };

  const LOGO_IMAGES: Record<string, string> = {
    kiro: "/kiro.png",
    "kiro-pro": "/kiro.png",
    qoder: "/qoder.png",
    mimo: "/mimo.png",
  };

  return (
    <div className="flex flex-col md:flex-row gap-4 rounded-lg border border-[var(--border)] bg-[var(--background)] overflow-hidden p-4" style={{ minHeight: 420 }}>
      {/* Left: Graph */}
      <div className="relative flex-1 rounded-lg border border-[var(--border)] overflow-hidden" style={{ minHeight: 400, background: "var(--background)" }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", maxHeight: 400 }}>
          <defs>
            {/* Grid pattern */}
            <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--border)" strokeWidth="0.3" opacity="0.3" />
            </pattern>
            {/* Glow for active streams */}
            {activeStreamList.map((stream) => {
              const target = providerPositions.find((p) => p.id === stream.provider);
              if (!target) return null;
              const color = PROVIDER_HEX[stream.provider] || "#fff";
              return (
                <radialGradient key={`glow-${stream.startedAt}`} id={`glow-${stream.startedAt}`} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={color} stopOpacity="1" />
                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                </radialGradient>
              );
            })}
          </defs>

          {/* Background grid */}
          <rect width={W} height={H} fill="url(#grid)" />

          {/* Connection lines - curved */}
          {providerPositions.map((p) => {
            const isActive = activeStreamList.some((s) => s.provider === p.id);
            const mx = (cx + p.x) / 2;
            const my = (cy + p.y) / 2;
            const offset = 15;
            const cpx = mx + (p.y - cy) * 0.15;
            const cpy = my - (p.x - cx) * 0.15;
            return (
              <path
                key={p.id}
                d={`M ${cx} ${cy} Q ${cpx} ${cpy} ${p.x} ${p.y}`}
                fill="none"
                stroke={isActive ? (PROVIDER_HEX[p.id] || "#e2e8f0") : "#d4d4d8"}
                strokeWidth={isActive ? "1.5" : "1"}
                opacity={isActive ? 0.7 : 0.35}
              />
            );
          })}

          {/* Active stream particles */}
          {activeStreamList.map((stream) => {
            const target = providerPositions.find((p) => p.id === stream.provider);
            if (!target) return null;
            const mx = (cx + target.x) / 2;
            const my = (cy + target.y) / 2;
            const cpx = mx + (target.y - cy) * 0.15;
            const cpy = my - (target.x - cx) * 0.15;
            const pathD = `M ${cx} ${cy} Q ${cpx} ${cpy} ${target.x} ${target.y}`;
            const color = PROVIDER_HEX[stream.provider] || "#fff";
            return (
              <g key={stream.startedAt}>
                <circle r="6" fill={color} opacity="0.1">
                  <animateMotion dur="1.2s" repeatCount="indefinite" path={pathD} />
                </circle>
                <circle r="2.5" fill={color} opacity="0.9">
                  <animateMotion dur="1.2s" repeatCount="indefinite" path={pathD} />
                </circle>
              </g>
            );
          })}

          {/* Center node */}
          <rect x={cx - 38} y={cy - 20} width={76} height={40} rx={8} fill="var(--card)" stroke="#22c55e" strokeWidth="2" />
          <text x={cx} y={cy + 5} textAnchor="middle" fill="var(--foreground)" fontSize="14" fontWeight="bold" fontFamily="inherit">
            etteum
          </text>

          {/* Provider nodes with logo */}
          {providerPositions.map((p) => {
            const isActive = activeStreamList.some((s) => s.provider === p.id);
            const quota = accountQuotas[p.id] || { total: 0, remaining: 0 };
            const color = LOGO_COLORS[p.id] || "#64748b";
            const pct = quota.total > 0 ? Math.round((quota.remaining / quota.total) * 100) : 0;
            const pw = 110, ph = 36;
            const nodeX = p.x, nodeY = p.y;
            const logoSrc = LOGO_IMAGES[p.id];
            return (
              <g key={p.id}>
                {/* Node background */}
                <rect
                  x={nodeX - pw / 2} y={nodeY - ph / 2}
                  width={pw} height={ph} rx={6}
                  fill="var(--background)"
                  stroke={isActive ? color : "var(--border)"}
                  strokeWidth={isActive ? "1.5" : "1"}
                />
                {/* Logo image or fallback circle */}
                {logoSrc ? (
                  <image
                    href={logoSrc}
                    x={nodeX - pw / 2 + 4}
                    y={nodeY - 12}
                    width={24}
                    height={24}
                    opacity={isActive ? 1 : 0.5}
                  />
                ) : (
                  <>
                    <circle cx={nodeX - pw / 2 + 16} cy={nodeY} r={10} fill={color} opacity={isActive ? 1 : 0.5} />
                    <text x={nodeX - pw / 2 + 16} y={nodeY + 4} textAnchor="middle" fill="#fff" fontSize="8" fontWeight="bold" fontFamily="inherit">
                      {LOGO_LABELS[p.id]}
                    </text>
                  </>
                )}
                {/* Provider name */}
                <text x={nodeX - pw / 2 + 32} y={nodeY + 4} textAnchor="start" fill="var(--foreground)" fontSize="10" fontFamily="inherit" fontWeight="500">
                  {p.id.length > 12 ? p.id.slice(0, 11) + "…" : p.id}
                </text>
                {/* Quota badge */}
                {quota.total > 0 && (
                  <g>
                    <rect x={nodeX + pw / 2 - 24} y={nodeY - 8} width={22} height={14} rx={4} fill={pct > 50 ? "#22c55e" : pct > 20 ? "#f59e0b" : "#ef4444"} opacity="0.9" />
                    <text x={nodeX + pw / 2 - 13} y={nodeY + 2} textAnchor="middle" fill="#fff" fontSize="7" fontWeight="bold" fontFamily="inherit">
                      {pct}%
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {quotaProviders.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--muted-foreground)]">
            No accounts with quota
          </div>
        )}
      </div>

      {/* Right: Recent Requests Table */}
      <div className="md:w-[340px] w-80 rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden flex flex-col shrink-0" style={{ maxHeight: 400 }}>
        <div className="px-4 py-2.5 border-b border-[var(--border)] shrink-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Recent Requests</h3>
        </div>
        {/* Table header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)]/60 bg-[var(--background)]/50 shrink-0">
          <span className="text-[10px] font-medium text-[var(--muted-foreground)] uppercase flex-1">Model</span>
          <span className="text-[10px] font-medium text-[var(--muted-foreground)] uppercase w-28 text-right">In / Out</span>
          <span className="text-[10px] font-medium text-[var(--muted-foreground)] uppercase w-16 text-right">When</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {recentRequests.map((req) => {
            const elapsed = Date.now() - new Date(req.createdAt).getTime();
            const timeAgo = elapsed < 60000 ? "just now"
              : elapsed < 3600000 ? `${Math.floor(elapsed / 60000)}m ago`
              : `${Math.floor(elapsed / 3600000)}h ago`;
            return (
              <div
                key={req.id}
                onClick={() => openDetail(req)}
                className="flex items-center gap-2 px-4 py-1.5 border-b border-[var(--border)]/40 hover:bg-[var(--secondary)]/50 cursor-pointer min-w-0"
              >
                <span className="block h-1.5 w-1.5 rounded-full flex-shrink-0" style={{
                  backgroundColor: req.status === "success" ? "var(--success)"
                    : req.status === "streaming" ? "var(--warning)" : "var(--error)"
                }} />
                <span className="text-[11px] text-[var(--foreground)] flex-1 font-mono min-w-0" style={{ maxWidth: 140 }} title={req.model || ""}>
                  {req.model ? (req.model.length > 16 ? req.model.slice(0, 16) + "…" : req.model) : "-"}
                </span>
                <span className="text-[10px] font-mono flex-shrink-0 text-right w-28" style={{ color: "var(--warning)" }}>
                  {req.promptTokens ? (req.promptTokens >= 1000 ? `${(req.promptTokens / 1000).toFixed(1)}k` : req.promptTokens) : 0}
                </span>
                <span className="text-[9px] text-[var(--muted-foreground)] flex-shrink-0 text-center w-5">↑↓</span>
                <span className="text-[10px] font-mono flex-shrink-0 text-right" style={{ color: "var(--success)" }}>
                  {req.completionTokens ? (req.completionTokens >= 1000 ? `${(req.completionTokens / 1000).toFixed(1)}k` : req.completionTokens) : 0}
                </span>
                <span className="text-[10px] text-[var(--muted-foreground)] flex-shrink-0 w-16 text-right">{timeAgo}</span>
              </div>
            );
          })}
          {recentRequests.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-[var(--muted-foreground)]">No requests yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function Requests() {
  const [searchParams, setSearchParams] = useSearchParams();
  const viewMode = (searchParams.get("view") || "flow") as "table" | "flow";

  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RequestLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const perPage = 25;
  const [activeStreams, setActiveStreams] = useState<Map<number, ActiveStream>>(new Map());
  const [now, setNow] = useState<number>(Date.now());
  const [accountQuotas, setAccountQuotas] = useState<Record<string, { total: number; remaining: number }>>({});

  async function loadQuotas() {
    try {
      const res = await fetchAccounts() as { data: { id: number; provider: string; quotaLimit?: number; quotaRemaining?: number }[] };
      const accounts = res?.data || [];
      const quotas: Record<string, { total: number; remaining: number }> = {};
      for (const a of accounts) {
        const p = a.provider;
        quotas[p] = quotas[p] || { total: 0, remaining: 0 };
        quotas[p].total += a.quotaLimit || 0;
        quotas[p].remaining += a.quotaRemaining || 0;
      }
      setAccountQuotas(quotas);
    } catch {}
  }

  useEffect(() => { loadQuotas(); }, []);

  /**
   * Open the detail drawer for a row. The list endpoint omits the heavy
   * requestBody / responseBody columns to keep the page snappy, so we lazily
   * fetch the full record here. We immediately show what we already have so
   * the drawer feels instant, then fill in the bodies once they arrive.
   */
  async function openDetail(req: RequestLog) {
    setSelected(req);
    if (req.requestBody !== undefined && req.responseBody !== undefined) return;
    setDetailLoading(true);
    try {
      const res = (await fetchRequestDetail(req.id)) as { data: RequestLog };
      if (res?.data) {
        setSelected((current) => (current?.id === req.id ? { ...current, ...res.data } : current));
      }
    } catch {
      // best-effort; leave bodies undefined and let the UI render empty blocks
    } finally {
      setDetailLoading(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const res = await fetchRequests(1, 100, provider) as { data: RequestLog[] };
      setLogs(res.data || []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    setPage(1);
  }, [provider]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  useWsEvent("request_started", (msg) => {
    const d = msg.data as { id: number; provider: string; model: string; accountEmail?: string; email?: string; promptTokens?: number };
    setNow(Date.now());
    setActiveStreams((prev) => {
      const next = new Map(prev);
      next.set(d.id, {
        id: d.id,
        provider: d.provider,
        model: d.model,
        accountEmail: d.accountEmail || d.email || "",
        promptTokens: d.promptTokens || 0,
        startedAt: Date.now(),
      });
      return next;
    });
  });

  useWsEvent(["request_log"], (msg) => {
    if (msg.type === "request_log") {
      const incoming = msg.data as RequestLog;

      // BUG 3: skip entries that don't match the active provider filter
      if (provider && provider !== "all" && incoming.provider !== provider) {
        return;
      }

      setLogs((current) => {
        const existing = current.findIndex((l) => l.id === incoming.id);
        if (existing >= 0) {
          // Update existing entry (e.g. streaming → success/error)
          const updated = [...current];
          updated[existing] = incoming;
          return updated;
        }
        // New entry — prepend
        return [incoming, ...current].slice(0, 100);
      });

      // Only remove from active streams once the final status arrives
      if (incoming.status !== "streaming") {
        setActiveStreams((prev) => {
          if (!prev.has(incoming.id)) return prev;
          const next = new Map(prev);
          next.delete(incoming.id);
          return next;
        });
      }
    }
  });

  useEffect(() => {
    if (activeStreams.size === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeStreams.size]);

  const filtered = logs.filter((req) => {
    const q = search.toLowerCase();
    return (
      req.model?.toLowerCase().includes(q) ||
      req.provider.toLowerCase().includes(q) ||
      req.errorMessage?.toLowerCase().includes(q) ||
      String(req.accountId || "").includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Requests</h1>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">
            Recent API request logs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-[var(--border)] overflow-hidden text-sm">
            <button
              onClick={() => setSearchParams({ view: "table" })}
              className={`px-3 py-1.5 text-sm transition-colors ${
                viewMode === "table"
                  ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                  : "bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              Table
            </button>
            <button
              onClick={() => setSearchParams({ view: "flow" })}
              className={`px-3 py-1.5 text-sm transition-colors border-l border-[var(--border)] ${
                viewMode === "flow"
                  ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                  : "bg-[var(--background)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              Flow
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search requests..." className="pl-9" />
        </div>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]">
          <option value="all">All Providers</option>
          <option value="kiro">Kiro</option>
          <option value="codebuddy">CodeBuddy</option>
          <option value="canva">Canva</option>
        </select>
      </div>

      {activeStreams.size > 0 && (
        <div className="mb-4 space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <span className="block h-2 w-2 rounded-full bg-[var(--success)] animate-pulse" />
            Live Streams
          </p>
          {Array.from(activeStreams.values()).map((stream) => {
            const elapsed = now - stream.startedAt;
            return (
              <div
                key={stream.id}
                className="flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--background)] px-3"
                style={{ height: 44 }}
              >
                <span className="block h-2 w-2 shrink-0 rounded-full bg-[var(--success)] animate-pulse" />
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${providerBadgeClass(stream.provider)}`}>
                  {labelProvider(stream.provider)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--foreground)]">
                  {stream.model}
                </span>
                <span className="hidden shrink-0 text-xs text-[var(--muted-foreground)] sm:inline">
                  {stream.accountEmail}
                </span>
                {stream.promptTokens > 0 && (
                  <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
                    ~{stream.promptTokens}tk
                  </span>
                )}
                <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--foreground)]">
                  {formatElapsed(elapsed)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {viewMode === "flow" && (
        <FlowView activeStreams={activeStreams} logs={logs} openDetail={openDetail} accountQuotas={accountQuotas} />
      )}

      {viewMode === "table" && (
      <Card className="border-[var(--border)]">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Time</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Provider</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden md:table-cell">Model</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4">Status</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden md:table-cell">Duration</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden lg:table-cell">Tokens</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden lg:table-cell">Credits</th>
                  <th className="text-left text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wide p-4 hidden lg:table-cell">Account</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice((page - 1) * perPage, page * perPage).map((req) => (
                  <tr key={req.id} onClick={() => openDetail(req)} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--secondary)]/50 cursor-pointer">
                    <td className="p-4 text-xs text-[var(--muted-foreground)] font-mono">{formatDateTimeID(req.createdAt)}</td>
                    <td className="p-4 text-sm text-[var(--foreground)]">{labelProvider(req.provider)}</td>
                    <td className="p-4 text-sm text-[var(--foreground)] hidden md:table-cell">{req.model || "-"}</td>
                    <td className="p-4"><Badge variant={getStatusColor(req.status)}>{req.status}</Badge></td>
                    <td className="p-4 text-sm text-[var(--muted-foreground)] hidden md:table-cell">{((req.durationMs ?? 0) / 1000).toFixed(1)}s</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden lg:table-cell">{req.totalTokens || 0}</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden lg:table-cell">{Number(req.creditsUsed || 0).toFixed(2)}</td>
                    <td className="p-4 text-xs text-[var(--muted-foreground)] hidden lg:table-cell">{req.accountEmail || (req.accountId ? `#${req.accountId}` : "-")}</td>
                  </tr>
                ))}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={8} className="p-8 text-center text-sm text-[var(--muted-foreground)]">No request logs yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > perPage && (
            <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
              <p className="text-xs text-[var(--muted-foreground)]">
                {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</Button>
                <span className="text-xs text-[var(--muted-foreground)]">{page}/{Math.ceil(filtered.length / perPage)}</span>
                <Button variant="outline" size="sm" disabled={page >= Math.ceil(filtered.length / perPage)} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={() => setSelected(null)}>
          <aside className="h-full w-full max-w-[520px] overflow-y-auto border-l border-[var(--border)] bg-[var(--card)] p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-4">
              <div>
                <h2 className="font-bold text-[var(--foreground)]">{selected.model || "Request"}</h2>
                <p className="text-xs text-[var(--muted-foreground)]">{formatDateTimeID(selected.createdAt)}</p>
              </div>
              <button className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => setSelected(null)}>✕</button>
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs">
              <Badge variant={getStatusColor(selected.status)}>{selected.status}</Badge>
              <span className="text-[var(--muted-foreground)]">HTTP {selected.status === "success" ? 200 : 503}</span>
              <span className="text-[var(--muted-foreground)]">{((selected.durationMs || 0) / 1000).toFixed(1)}s</span>
              <span className="text-[var(--muted-foreground)]">{labelProvider(selected.provider)}</span>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-2">
              <Metric label="Total" value={selected.totalTokens || 0} color="blue" />
              <Metric label="Prompt" value={selected.promptTokens || 0} color="green" />
              <Metric label="Completion" value={selected.completionTokens || 0} color="indigo" />
              <Metric label="Credit" value={(selected.creditsUsed || 0).toFixed(2)} color="yellow" />
            </div>

            <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-3 text-xs text-[var(--muted-foreground)]">
              Credit source: <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditSource || "unknown"}</span>
              {getCreditMeta(selected).creditUnit && <> · Unit: <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditUnit}</span></>}
              {typeof getCreditMeta(selected).creditRate === "number" && <> · Rate: <span className="text-[var(--foreground)]">{getCreditMeta(selected).creditRate}</span></>}
            </div>

            {selected.compressionStats && (
              <CompressionPanel
                stats={selected.compressionStats}
                promptTokens={selected.promptTokens}
              />
            )}

            <div className="mt-5 space-y-1">
              <p className="text-xs uppercase text-[var(--muted-foreground)]">Account</p>
              <p className="text-sm font-medium text-[var(--foreground)]">{selected.accountEmail || `#${selected.accountId}`}</p>
              <p className="text-xs text-[var(--muted-foreground)]">Credit: {selected.accountQuotaBefore ?? 0} → {selected.accountQuotaAfter ?? 0}</p>
            </div>

            {selected.errorMessage && (
              <div className="mt-5 rounded-md bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">{selected.errorMessage}</div>
            )}

            {detailLoading && selected.requestBody === undefined ? (
              <div className="mt-5 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                <RefreshCw className="w-3 h-3 animate-spin" /> Loading request & response body…
              </div>
            ) : (
              <>
                <JsonBlock title="Request Body" value={selected.requestBody} />
                <JsonBlock title="Response Body" value={selected.responseBody} />
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string | number; color: string }) {
  const colors: Record<string, string> = {
    blue: "bg-[var(--info)]/10 text-[var(--info)]",
    green: "bg-[var(--success)]/10 text-[var(--success)]",
    indigo: "bg-[var(--primary)]/10 text-[var(--primary)]",
    yellow: "bg-[var(--warning)]/10 text-[var(--warning)]",
  };
  return <div className={`rounded-md p-3 ${colors[color]}`}><p className="text-[10px] uppercase opacity-80">{label}</p><p className="font-bold">{value}</p></div>;
}

const TECHNIQUE_LABELS: Record<keyof NonNullable<CompressionStats["byTechnique"]>, string> = {
  tsc: "TSC (tool schema)",
  rtk: "RTK (tool truncation)",
  dcp: "DCP (dedup)",
  caveman: "Caveman (system prompt)",
  imageDedupe: "Image dedup",
  cacheMarkers: "Cache markers",
};

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

const RTK_FILTER_LABELS: Record<string, string> = {
  "git-diff": "git diff (hunks)",
  "git-status": "git status",
  tree: "tree (depth ≤ 1)",
  "read-numbered": "Read (line-numbered)",
  grep: "grep (per-file)",
  "dedup-log": "dedup-log",
  generic: "generic head + tail",
};

function CompressionPanel({
  stats,
  promptTokens,
}: {
  stats: CompressionStats;
  promptTokens: number | null;
}) {
  const { tokensBefore, tokensAfter, saved, byTechnique = {}, rtkFilters, durationMs } = stats;
  const techEntries = Object.entries(byTechnique).filter(([, v]) => typeof v === "number" && v > 0) as Array<
    [keyof typeof TECHNIQUE_LABELS, number]
  >;
  const filterEntries: Array<[string, number]> = rtkFilters
    ? Object.entries(rtkFilters).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    : [];

  // Best practice: anchor the displayed before/after to provider-reported
  // prompt_tokens (ground truth) instead of our char/4 heuristic. Our internal
  // estimate is only used to allocate per-technique attribution; for the
  // headline numbers we trust the upstream usage.prompt_tokens.
  //
  // Formula:
  //   actualBefore = promptTokens + saved   (what would have been billed without compression)
  //   actualAfter  = promptTokens           (what was actually billed)
  //   actualPct    = saved / actualBefore   (real savings ratio)
  //
  // If promptTokens is missing/0 (e.g. error response), fall back to our estimate.
  const hasProviderTruth = typeof promptTokens === "number" && promptTokens > 0;
  const displayAfter = hasProviderTruth ? promptTokens : tokensAfter;
  const displayBefore = hasProviderTruth ? promptTokens + saved : tokensBefore;
  const displayPct = displayBefore > 0 ? (saved / displayBefore) * 100 : 0;

  // No real savings on this request — show a muted "ran but no-op" line.
  if (saved <= 0) {
    return (
      <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--secondary)]/40 p-3 text-xs text-[var(--muted-foreground)]">
        <span className="uppercase tracking-wide">Compression</span>
        <span className="ml-2">Pipeline ran in {durationMs}ms — no compressible content this turn.</span>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-[var(--success)]/30 bg-[var(--success)]/5 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wide text-[var(--success)]">Compression</p>
        <p className="text-[10px] text-[var(--muted-foreground)]">Pipeline {durationMs}ms</p>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-xl font-bold text-[var(--success)]">−{formatNum(saved)}</span>
        <span className="text-xs text-[var(--muted-foreground)]">tokens saved</span>
        <span className="ml-auto text-sm font-semibold text-[var(--success)]">{displayPct.toFixed(2)}%</span>
      </div>

      <div
        className="mt-1 text-[11px] text-[var(--muted-foreground)]"
        title={
          hasProviderTruth
            ? `Anchored to provider-reported prompt_tokens (${formatNum(promptTokens!)}). Internal estimate was ${formatNum(tokensBefore)} → ${formatNum(tokensAfter)}.`
            : "Internal char/4 estimate (provider usage not available)"
        }
      >
        {formatNum(displayBefore)} <span className="opacity-50">→</span> {formatNum(displayAfter)} tokens
        {hasProviderTruth && <span className="ml-1 opacity-50">· actual</span>}
      </div>

      {techEntries.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-[var(--border)] pt-2">
          <p className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">By technique</p>
          {techEntries.map(([key, value]) => {
            const pct = saved > 0 ? (value / saved) * 100 : 0;
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="flex-1 text-[var(--foreground)]">{TECHNIQUE_LABELS[key]}</span>
                <div className="h-1 w-16 overflow-hidden rounded-full bg-[var(--border)]">
                  <div className="h-full bg-[var(--success)]" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <span className="w-16 text-right text-[var(--muted-foreground)]">−{formatNum(value)}</span>
              </div>
            );
          })}
        </div>
      )}

      {filterEntries.length > 0 && (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
            RTK filters ({filterEntries.length}) <span className="opacity-50 group-open:hidden">▸</span><span className="opacity-50 hidden group-open:inline">▾</span>
          </summary>
          <div className="mt-1 space-y-1">
            {filterEntries.map(([name, value]) => {
              const rtkTotal = byTechnique.rtk ?? 0;
              const pct = rtkTotal > 0 ? (value / rtkTotal) * 100 : 0;
              return (
                <div key={name} className="flex items-center gap-2 text-[11px]">
                  <span className="flex-1 pl-2 text-[var(--muted-foreground)]">{RTK_FILTER_LABELS[name] ?? name}</span>
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-[var(--border)]">
                    <div className="h-full bg-[var(--success)]/60" style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                  <span className="w-16 text-right text-[var(--muted-foreground)]">−{formatNum(value)}</span>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const text = JSON.stringify(value || {}, null, 2);
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs uppercase text-[var(--muted-foreground)]">{title}</p>
        <button className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]" onClick={() => navigator.clipboard.writeText(text)}>Copy</button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-md border border-[var(--border)] bg-black/30 p-3 text-xs text-[var(--muted-foreground)]">{text}</pre>
    </div>
  );
}
