import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Cpu, Copy, Check, Search, Plus, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchModels, fetchIntegration, saveIntegration, type ModelMappingDTO } from "@/lib/api";
import { useTimedMessage } from "@/hooks/useTimedMessage";

interface ModelData {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  context_window?: number;
  max_output?: number;
  thinking?: boolean;
}

const providerColors: Record<string, string> = {
  kiro: "bg-[var(--chart-2)]/15 text-[var(--chart-2)] border-[var(--chart-2)]/30",
  "kiro-pro": "bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/30",
  codebuddy: "bg-[var(--chart-3)]/15 text-[var(--chart-3)] border-[var(--chart-3)]/30",
  canva: "bg-[var(--chart-6)]/15 text-[var(--chart-6)] border-[var(--chart-6)]/30",
  codex: "bg-[var(--chart-1)]/15 text-[var(--chart-1)] border-[var(--chart-1)]/30",
  qoder: "bg-[var(--chart-4)]/15 text-[var(--chart-4)] border-[var(--chart-4)]/30",
};

function formatNumber(n: number | undefined): string {
  if (!n) return "-";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

const MATCH_TYPES = ["exact", "prefix", "contains", "regex"] as const;

type MappingForm = {
  sourcePattern: string;
  matchType: string;
  targetModel: string;
  enabled: boolean;
  priority: number;
  label: string;
};

export default function Models() {
  const [models, setModels] = useState<ModelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const { message: copiedModel, setMessage: setCopiedModel } = useTimedMessage<string>(null, 1500);

  // Mappings state
  const [mappings, setMappings] = useState<ModelMappingDTO[]>([]);
  const [loadingMappings, setLoadingMappings] = useState(false);
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [mappingForm, setMappingForm] = useState<MappingForm>({
    sourcePattern: "",
    matchType: "exact",
    targetModel: "",
    enabled: true,
    priority: 0,
    label: "",
  });
  const [savingMappings, setSavingMappings] = useState(false);

  const loadMappings = async () => {
    setLoadingMappings(true);
    try {
      const data = await fetchIntegration();
      setMappings(data.mappings ?? []);
    } finally {
      setLoadingMappings(false);
    }
  };

  useEffect(() => {
    fetchModels()
      .then((res: { data: ModelData[] }) => {
        setModels(res.data || []);
      })
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
    loadMappings();
  }, []);

  const handleAddMapping = () => {
    setEditingIndex(null);
    setMappingForm({ sourcePattern: "", matchType: "exact", targetModel: "", enabled: true, priority: 0, label: "" });
    setMappingDialogOpen(true);
  };

  const handleEditMapping = (m: ModelMappingDTO, index: number) => {
    setEditingIndex(index);
    setMappingForm({
      sourcePattern: m.sourcePattern,
      matchType: m.matchType,
      targetModel: m.targetModel,
      enabled: m.enabled,
      priority: m.priority,
      label: m.label ?? "",
    });
    setMappingDialogOpen(true);
  };

  const handleDeleteMapping = async (index: number) => {
    const next = mappings.filter((_, i) => i !== index);
    setMappings(next);
    await saveIntegration({ mappings: next });
  };

  const handleToggleMapping = async (index: number) => {
    const next = mappings.map((m, i) =>
      i === index ? { ...m, enabled: !m.enabled } : m
    );
    setMappings(next);
    await saveIntegration({ mappings: next });
  };

  const handleSaveMapping = async () => {
    setSavingMappings(true);
    try {
      const entry: ModelMappingDTO = {
        sourcePattern: mappingForm.sourcePattern,
        matchType: mappingForm.matchType,
        targetModel: mappingForm.targetModel,
        enabled: mappingForm.enabled,
        priority: mappingForm.priority,
        label: mappingForm.label || null,
      };
      let next: ModelMappingDTO[];
      if (editingIndex !== null) {
        next = mappings.map((m, i) => (i === editingIndex ? entry : m));
      } else {
        next = [...mappings, entry];
      }
      await saveIntegration({ mappings: next });
      setMappings(next);
      setMappingDialogOpen(false);
    } finally {
      setSavingMappings(false);
    }
  };

  const providers = ["all", ...Array.from(new Set(models.map((m) => m.owned_by)))];

  const filtered = models
    .filter((m) => filter === "all" || m.owned_by === filter)
    .filter((m) =>
      search === "" ||
      m.id.toLowerCase().includes(search.toLowerCase()) ||
      m.owned_by.toLowerCase().includes(search.toLowerCase())
    );

  async function copyModelId(modelId: string) {
    await navigator.clipboard.writeText(modelId);
    setCopiedModel(modelId);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--primary)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Models</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          {models.length} models available across {new Set(models.map((m) => m.owned_by)).size} providers
        </p>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <input
              type="text"
              placeholder="Search models, owners..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            />
          </div>
        </CardContent>
      </Card>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {providers.map((p) => (
          <button
            key={p}
            onClick={() => setFilter(p)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === p
                ? "bg-[var(--info)]/20 text-[var(--info)] border border-[var(--info)]/30"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            }`}
          >
            {p === "all" ? "All" : p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--secondary)]/50">
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Model
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Owner
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Context
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Output
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-medium text-[var(--muted-foreground)] uppercase tracking-wider">
                    Features
                  </th>
                  <th className="w-12"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((model) => (
                  <tr
                    key={model.id}
                    className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--secondary)]/30 transition-colors"
                  >
                    {/* Model ID */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--foreground)]">
                          {model.id}
                        </span>
                      </div>
                    </td>

                    {/* Owner */}
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${providerColors[model.owned_by] || "bg-[var(--muted)]/20 text-[var(--muted-foreground)]"}`}>
                        {model.owned_by}
                      </span>
                    </td>

                    {/* Context */}
                    <td className="py-3 px-4 text-sm text-[var(--foreground)]">
                      {formatNumber(model.context_window)}
                    </td>

                    {/* Output */}
                    <td className="py-3 px-4 text-sm text-[var(--foreground)]">
                      {formatNumber(model.max_output)}
                    </td>

                    {/* Features */}
                    <td className="py-3 px-4">
                      {model.thinking && (
                        <Badge variant="default" className="text-xs">
                          Thinking
                        </Badge>
                      )}
                    </td>

                    {/* Copy Button */}
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => copyModelId(model.id)}
                        title={`Copy model ID: ${model.id}`}
                        className="p-1.5 rounded-md hover:bg-[var(--secondary)] transition-colors group"
                      >
                        {copiedModel === model.id ? (
                          <Check className="w-4 h-4 text-[var(--success)]" />
                        ) : (
                          <Copy className="w-4 h-4 text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12">
              <Cpu className="w-12 h-12 text-[var(--muted-foreground)] mb-4" />
              <p className="text-[var(--muted-foreground)]">No models found</p>
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Try adjusting your search or filter
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Model Mappings CRUD */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Model Mappings</h2>
            <p className="text-sm text-[var(--muted-foreground)]">Remap incoming model names to different targets</p>
          </div>
          <Button onClick={handleAddMapping} size="sm">
            <Plus className="w-4 h-4 mr-2" /> Add Mapping
          </Button>
        </div>

        {loadingMappings ? (
          <div className="text-sm text-[var(--muted-foreground)]">Loading...</div>
        ) : mappings.length === 0 ? (
          <div className="text-sm text-[var(--muted-foreground)] border rounded-lg p-6 text-center">
            No model mappings configured.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--muted)]/50">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Source Pattern</th>
                  <th className="text-left px-4 py-2 font-medium">Match Type</th>
                  <th className="text-left px-4 py-2 font-medium">Target Model</th>
                  <th className="text-left px-4 py-2 font-medium">Priority</th>
                  <th className="text-left px-4 py-2 font-medium">Label</th>
                  <th className="text-left px-4 py-2 font-medium">Enabled</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m, i) => (
                  <tr key={i} className="border-t hover:bg-[var(--muted)]/20 transition-colors">
                    <td className="px-4 py-2 font-mono text-xs">{m.sourcePattern}</td>
                    <td className="px-4 py-2">
                      <Badge variant="outline" className="text-xs">{m.matchType}</Badge>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{m.targetModel}</td>
                    <td className="px-4 py-2 text-[var(--muted-foreground)]">{m.priority}</td>
                    <td className="px-4 py-2 text-[var(--muted-foreground)]">{m.label || "—"}</td>
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => handleToggleMapping(i)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                          m.enabled ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]/30"
                        }`}
                        aria-label={m.enabled ? "Disable" : "Enable"}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                            m.enabled ? "translate-x-[18px]" : "translate-x-[3px]"
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right space-x-1">
                      <Button variant="ghost" size="icon" onClick={() => handleEditMapping(m, i)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDeleteMapping(i)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add/Edit Mapping Dialog */}
      <Dialog open={mappingDialogOpen} onOpenChange={setMappingDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingIndex !== null ? "Edit Mapping" : "Add Mapping"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Source Pattern</label>
              <Input
                value={mappingForm.sourcePattern}
                onChange={(e) => setMappingForm((f) => ({ ...f, sourcePattern: e.target.value }))}
                placeholder="gpt-4o"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Match Type</label>
              <select
                value={mappingForm.matchType}
                onChange={(e) => setMappingForm((f) => ({ ...f, matchType: e.target.value }))}
                className="w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {MATCH_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Target Model</label>
              <Input
                value={mappingForm.targetModel}
                onChange={(e) => setMappingForm((f) => ({ ...f, targetModel: e.target.value }))}
                placeholder="glm-5.2-free"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Priority</label>
              <Input
                type="number"
                value={String(mappingForm.priority)}
                onChange={(e) => setMappingForm((f) => ({ ...f, priority: Number(e.target.value) }))}
                placeholder="0"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Label (optional)</label>
              <Input
                value={mappingForm.label}
                onChange={(e) => setMappingForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="my-mapping"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMappingForm((f) => ({ ...f, enabled: !f.enabled }))}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                  mappingForm.enabled ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]/30"
                }`}
                aria-label="Toggle enabled"
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                    mappingForm.enabled ? "translate-x-[18px]" : "translate-x-[3px]"
                  }`}
                />
              </button>
              <label className="text-sm font-medium">Enabled</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMappingDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSaveMapping}
              disabled={savingMappings || !mappingForm.sourcePattern || !mappingForm.targetModel}
            >
              {savingMappings ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
