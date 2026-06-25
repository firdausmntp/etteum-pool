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
import { Cpu, Copy, Check, Search, Plus, Pencil, Trash2, GripVertical, ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { fetchModels, fetchIntegration, saveIntegration, type ModelMappingDTO, fetchCombos, createCombo, updateCombo, deleteCombo, type ModelComboDTO, fetchCustomModels, createCustomModel, updateCustomModel, deleteCustomModel, type CustomModelDTO } from "@/lib/api";
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
  mimo: "bg-[var(--chart-5)]/15 text-[var(--chart-5)] border-[var(--chart-5)]/30",
  alibaba: "bg-[var(--info)]/15 text-[var(--info)] border-[var(--info)]/30",
  antigravity: "bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30",
  byok: "bg-[var(--secondary)]/30 text-[var(--foreground)] border-[var(--border)]",
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

  // Combos state
  const [combos, setCombos] = useState<ModelComboDTO[]>([]);
  const [loadingCombos, setLoadingCombos] = useState(false);
  const [comboDialogOpen, setComboDialogOpen] = useState(false);
  const [editingCombo, setEditingCombo] = useState<ModelComboDTO | null>(null);
  const [comboName, setComboName] = useState("");
  const [comboLabel, setComboLabel] = useState("");
  const [comboModels, setComboModels] = useState<string[]>([]);
  const [comboModelInput, setComboModelInput] = useState("");
  const [savingCombo, setSavingCombo] = useState(false);
  const { message: comboMessage, setMessage: setComboMessage } = useTimedMessage<string>(null, 2000);
  const [showComboPicker, setShowComboPicker] = useState(false);
  const comboPickerRef = useRef<HTMLDivElement>(null);

  // Pagination state — must be here (before derived values) to satisfy React Hook Rules
  const [page, setPage] = useState(1);

  // Custom Models state
  const [customModelsList, setCustomModelsList] = useState<CustomModelDTO[]>([]);
  const [loadingCustomModels, setLoadingCustomModels] = useState(false);
  const [customModelDialogOpen, setCustomModelDialogOpen] = useState(false);
  const [editingCustomModel, setEditingCustomModel] = useState<CustomModelDTO | null>(null);

  // Custom Model form state
  const [customModelForm, setCustomModelForm] = useState({
    modelId: "",
    ownedBy: "antigravity",
    contextWindow: 200000,
    maxOutput: 65536,
    thinking: false,
    vision: false,
  });
  const [savingCustomModel, setSavingCustomModel] = useState(false);
  const { message: customModelMessage, setMessage: setCustomModelMessage } = useTimedMessage<string>(null, 2000);

  const loadCustomModels = async () => {
    setLoadingCustomModels(true);
    try {
      const res = await fetchCustomModels();
      setCustomModelsList(res.data ?? []);
    } catch (err) {
      console.warn("Failed to load custom models:", err);
      setCustomModelsList([]);
    } finally {
      setLoadingCustomModels(false);
    }
  };

  const refreshAllModels = async () => {
    try {
      const res = await fetchModels();
      setModels(res.data || []);
    } catch {}
    await loadCustomModels();
  };

  const openCreateCustomModel = () => {
    setEditingCustomModel(null);
    setCustomModelForm({
      modelId: "",
      ownedBy: "antigravity",
      contextWindow: 200000,
      maxOutput: 65536,
      thinking: false,
      vision: false,
    });
    setCustomModelDialogOpen(true);
  };

  const openEditCustomModel = (m: CustomModelDTO) => {
    setEditingCustomModel(m);
    setCustomModelForm({
      modelId: m.modelId,
      ownedBy: m.ownedBy,
      contextWindow: m.contextWindow ?? 200000,
      maxOutput: m.maxOutput ?? 65536,
      thinking: m.thinking,
      vision: m.vision,
    });
    setCustomModelDialogOpen(true);
  };

  const handleDeleteCustomModel = async (id: number, modelId: string) => {
    if (!confirm(`Delete custom model "${modelId}"?`)) return;
    try {
      await deleteCustomModel(id);
      setCustomModelMessage("Custom model deleted successfully");
      await refreshAllModels();
    } catch (err: any) {
      setCustomModelMessage(err?.message || "Failed to delete custom model");
    }
  };

  const handleSaveCustomModel = async () => {
    if (!customModelForm.modelId.trim() || !customModelForm.ownedBy.trim()) return;
    setSavingCustomModel(true);
    try {
      if (editingCustomModel) {
        await updateCustomModel(editingCustomModel.id, {
          modelId: customModelForm.modelId.trim(),
          ownedBy: customModelForm.ownedBy.trim(),
          contextWindow: Number(customModelForm.contextWindow),
          maxOutput: Number(customModelForm.maxOutput),
          thinking: customModelForm.thinking,
          vision: customModelForm.vision,
        });
        setCustomModelMessage("Custom model updated successfully");
      } else {
        await createCustomModel({
          modelId: customModelForm.modelId.trim(),
          ownedBy: customModelForm.ownedBy.trim(),
          contextWindow: Number(customModelForm.contextWindow),
          maxOutput: Number(customModelForm.maxOutput),
          thinking: customModelForm.thinking,
          vision: customModelForm.vision,
        });
        setCustomModelMessage("Custom model created successfully");
      }
      setCustomModelDialogOpen(false);
      await refreshAllModels();
    } catch (err: any) {
      setCustomModelMessage(err?.message || "Failed to save custom model");
    } finally {
      setSavingCustomModel(false);
    }
  };

  const loadCombos = async () => {
    setLoadingCombos(true);
    try {
      const data = await fetchCombos();
      setCombos(data.combos ?? []);
    } catch (err) {
      // Endpoint might not exist yet if backend hasn't been restarted
      console.warn("[Combos] Failed to load combos, endpoint may not exist:", err);
      setCombos([]);
    } finally {
      setLoadingCombos(false);
    }
  };

  const openCreateCombo = () => {
    setEditingCombo(null);
    setComboName("");
    setComboLabel("");
    setComboModels([]);
    setComboModelInput("");
    setComboDialogOpen(true);
  };

  const openEditCombo = (combo: ModelComboDTO) => {
    setEditingCombo(combo);
    setComboName(combo.name);
    setComboLabel(combo.label || "");
    setComboModels([...combo.modelsJson]);
    setComboModelInput("");
    setComboDialogOpen(true);
  };

  const handleDeleteCombo = async (name: string) => {
    if (!confirm(`Delete combo "${name}"?`)) return;
    await deleteCombo(name);
    await loadCombos();
  };

  const handleSaveCombo = async () => {
    if (!comboName.trim() || comboModels.length === 0) return;
    setSavingCombo(true);
    try {
      if (editingCombo) {
        await updateCombo(editingCombo.name, {
          name: comboName.trim(),
          label: comboLabel.trim() || undefined,
          models: comboModels,
        });
      } else {
        await createCombo({ name: comboName.trim(), label: comboLabel.trim() || undefined, models: comboModels });
      }
      setComboDialogOpen(false);
      await loadCombos();
      setComboMessage(editingCombo ? "Combo updated" : "Combo created");
    } catch (err: any) {
      setComboMessage(err?.message || "Failed to save combo");
    } finally {
      setSavingCombo(false);
    }
  };

  const handleAddComboModel = () => {
    const model = comboModelInput.trim();
    if (model && !comboModels.includes(model)) {
      setComboModels([...comboModels, model]);
      setComboModelInput("");
    }
  };

  const handleRemoveComboModel = (idx: number) => {
    setComboModels(comboModels.filter((_, i) => i !== idx));
  };

  const handleMoveComboModel = (fromIdx: number, toIdx: number) => {
    const updated = [...comboModels];
    const [item] = updated.splice(fromIdx, 1);
    updated.splice(toIdx, 0, item);
    setComboModels(updated);
  };

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
    loadCombos();
    loadCustomModels();
  }, []);

  // Close combo picker on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (comboPickerRef.current && !comboPickerRef.current.contains(e.target as Node)) {
        setShowComboPicker(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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

  // Pagination (page state is declared above with hooks)
  const PAGE_SIZE = 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedModels = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const startIdx = filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endIdx = Math.min(page * PAGE_SIZE, filtered.length);

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
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
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
            onClick={() => { setFilter(p); setPage(1); }}
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
                {pagedModels.map((model) => (
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

      {/* Pagination controls */}
      {filtered.length > 0 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-[var(--muted-foreground)]">
            Showing {startIdx}–{endIdx} of {filtered.length} models
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-xs text-[var(--muted-foreground)] px-2">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Model Combos — drag-drop reorderable model chains */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Model Combos</h2>
            <p className="text-sm text-[var(--muted-foreground)]">Create named chains — proxy tries models in order, falls back on failure</p>
          </div>
          <Button onClick={openCreateCombo} size="sm">
            <Plus className="w-4 h-4 mr-2" /> Add Combo
          </Button>
        </div>

        {comboMessage && (
          <div className="mb-4 px-3 py-2 rounded-md text-sm bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/30">
            {comboMessage}
          </div>
        )}

        {loadingCombos ? (
          <div className="text-sm text-[var(--muted-foreground)]">Loading combos...</div>
        ) : combos.length === 0 ? (
          <div className="text-sm text-[var(--muted-foreground)] border rounded-lg p-6 text-center">
            No combos configured. Create one to enable model fallback chains.
          </div>
        ) : (
          <div className="space-y-3">
            {combos.map((combo) => (
              <Card key={combo.name}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold text-sm">{combo.name}</h3>
                        {combo.label && (
                          <span className="text-xs text-[var(--muted-foreground)]">— {combo.label}</span>
                        )}
                        <Badge variant={combo.enabled ? "default" : "secondary"} className="text-xs ml-auto">
                          {combo.enabled ? "Active" : "Disabled"}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        {combo.modelsJson.map((model, idx) => (
                          <div key={idx} className="flex items-center gap-0.5">
                            {idx > 0 && <ArrowRight className="w-3 h-3 text-[var(--muted-foreground)]" />}
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-mono bg-[var(--muted)]/40 text-[var(--foreground)] border border-[var(--border)]">
                              {model}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="w-7 h-7" onClick={() => openEditCombo(combo)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="w-7 h-7 text-[var(--error)] hover:text-[var(--error)]" onClick={() => handleDeleteCombo(combo.name)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Custom Models CRUD Section */}
      <div className="mt-8 border-t border-[var(--border)] pt-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Custom Models</h2>
            <p className="text-sm text-[var(--muted-foreground)]">Dynamically register custom model IDs and map them to pool providers</p>
          </div>
          <Button onClick={openCreateCustomModel} size="sm">
            <Plus className="w-4 h-4 mr-2" /> Add Custom Model
          </Button>
        </div>

        {customModelMessage && (
          <div className="mb-4 px-3 py-2 rounded-md text-sm bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/30">
            {customModelMessage}
          </div>
        )}

        {loadingCustomModels ? (
          <div className="text-sm text-[var(--muted-foreground)]">Loading custom models...</div>
        ) : customModelsList.length === 0 ? (
          <div className="text-sm text-[var(--muted-foreground)] border rounded-lg p-6 text-center">
            No custom models configured. Click "Add Custom Model" to register one.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden bg-[var(--card)] text-[var(--card-foreground)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--muted)]/50">
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left px-4 py-3 font-medium">Model ID</th>
                  <th className="text-left px-4 py-3 font-medium">Owned By / Provider</th>
                  <th className="text-left px-4 py-3 font-medium">Context Window</th>
                  <th className="text-left px-4 py-3 font-medium">Max Output</th>
                  <th className="text-left px-4 py-3 font-medium">Features</th>
                  <th className="text-right px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {customModelsList.map((m) => (
                  <tr key={m.id} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--muted)]/20 transition-colors">
                    <td className="px-4 py-3 font-mono text-sm">{m.modelId}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${providerColors[m.ownedBy] || "bg-[var(--muted)]/20 text-[var(--muted-foreground)]"}`}>
                        {m.ownedBy}
                      </span>
                    </td>
                    <td className="px-4 py-3">{formatNumber(m.contextWindow)}</td>
                    <td className="px-4 py-3">{formatNumber(m.maxOutput)}</td>
                    <td className="px-4 py-3 space-x-1">
                      {m.thinking && <Badge variant="default" className="text-xs">Thinking</Badge>}
                      {m.vision && <Badge variant="secondary" className="text-xs">Vision</Badge>}
                    </td>
                    <td className="px-4 py-3 text-right space-x-1">
                      <Button variant="ghost" size="icon" onClick={() => openEditCustomModel(m)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="text-[var(--error)] hover:text-[var(--error)]" onClick={() => handleDeleteCustomModel(m.id, m.modelId)}>
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

      {/* Custom Model Create/Edit Dialog */}
      <Dialog open={customModelDialogOpen} onOpenChange={setCustomModelDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCustomModel ? "Edit Custom Model" : "Add Custom Model"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Model ID</label>
              <Input
                value={customModelForm.modelId}
                onChange={(e) => setCustomModelForm((f) => ({ ...f, modelId: e.target.value }))}
                placeholder="ag/gemini-3.5-pro"
                disabled={!!editingCustomModel}
              />
              <p className="text-xs text-[var(--muted-foreground)]">Ensure it matches what your clients will target (e.g. starting with provider prefixes like ag/)</p>
            </div>
            
            <div className="space-y-1">
              <label className="text-sm font-medium">Owner Provider</label>
              <select
                value={customModelForm.ownedBy}
                onChange={(e) => setCustomModelForm((f) => ({ ...f, ownedBy: e.target.value }))}
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="antigravity">antigravity</option>
                <option value="byok">byok</option>
                <option value="kiro">kiro</option>
                <option value="kiro-pro">kiro-pro</option>
                <option value="codebuddy">codebuddy</option>
                <option value="canva">canva</option>
                <option value="codex">codex</option>
                <option value="qoder">qoder</option>
                <option value="mimo">mimo</option>
                <option value="alibaba">alibaba</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Context Window</label>
              <Input
                type="number"
                value={String(customModelForm.contextWindow)}
                onChange={(e) => setCustomModelForm((f) => ({ ...f, contextWindow: Number(e.target.value) }))}
                placeholder="200000"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">Max Output Tokens</label>
              <Input
                type="number"
                value={String(customModelForm.maxOutput)}
                onChange={(e) => setCustomModelForm((f) => ({ ...f, maxOutput: Number(e.target.value) }))}
                placeholder="65536"
              />
            </div>

            <div className="flex items-center gap-4 pt-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCustomModelForm((f) => ({ ...f, thinking: !f.thinking }))}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                    customModelForm.thinking ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]/30"
                  }`}
                  aria-label="Toggle thinking support"
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      customModelForm.thinking ? "translate-x-[18px]" : "translate-x-[3px]"
                    }`}
                  />
                </button>
                <label className="text-sm font-medium">Supports Thinking</label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCustomModelForm((f) => ({ ...f, vision: !f.vision }))}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                    customModelForm.vision ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]/30"
                  }`}
                  aria-label="Toggle vision support"
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      customModelForm.vision ? "translate-x-[18px]" : "translate-x-[3px]"
                    }`}
                  />
                </button>
                <label className="text-sm font-medium">Supports Vision (Images)</label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomModelDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSaveCustomModel}
              disabled={savingCustomModel || !customModelForm.modelId.trim() || !customModelForm.ownedBy.trim()}
            >
              {savingCustomModel ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Combo Dialog */}
      <Dialog open={comboDialogOpen} onOpenChange={(open) => !open && setComboDialogOpen(false)}>
        <DialogContent className="w-full max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingCombo ? "Edit Combo" : "Create Model Combo"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Combo Name</label>
              <Input
                value={comboName}
                onChange={(e) => setComboName(e.target.value)}
                placeholder="abubu"
                disabled={!!editingCombo}
              />
              <p className="text-xs text-[var(--muted-foreground)]">Used as model id in requests</p>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Label (optional)</label>
              <Input
                value={comboLabel}
                onChange={(e) => setComboLabel(e.target.value)}
                placeholder="My fallback chain"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Model Chain (drag to reorder)</label>
              <div ref={comboPickerRef} className="relative flex gap-2">
                <div className="relative flex-1">
                  <Input
                    value={comboModelInput}
                    onChange={(e) => { setComboModelInput(e.target.value); setShowComboPicker(true); }}
                    onFocus={() => setShowComboPicker(true)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddComboModel(); setShowComboPicker(false); } if (e.key === "Escape") setShowComboPicker(false); }}
                    placeholder="Search or type model id..."
                    className="w-full"
                  />
                  {showComboPicker && (() => {
                    const q = comboModelInput.trim().toLowerCase();
                    const suggestions = models
                      .filter((m) => !comboModels.includes(m.id))
                      .filter((m) => q === "" || m.id.toLowerCase().includes(q) || m.owned_by.toLowerCase().includes(q))
                      .slice(0, 8);
                    return suggestions.length > 0 ? (
                      <div
                        className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-[var(--border)] bg-[var(--background)] shadow-lg max-h-48 overflow-y-auto"
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        {suggestions.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              if (!comboModels.includes(m.id)) {
                                setComboModels([...comboModels, m.id]);
                              }
                              setComboModelInput("");
                              setShowComboPicker(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--secondary)] transition-colors"
                          >
                            <span className="flex-1 font-mono text-[var(--foreground)] truncate">{m.id}</span>
                            <span className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${providerColors[m.owned_by] || "bg-[var(--muted)]/20 text-[var(--muted-foreground)] border-[var(--border)]"}`}>
                              {m.owned_by}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null;
                  })()}
                </div>
                <Button onClick={() => { handleAddComboModel(); setShowComboPicker(false); }} size="sm">Add</Button>
              </div>

              {comboModels.length > 0 && (
                <div className="space-y-1.5 mt-2">
                  {comboModels.map((model, idx) => (
                    <div
                      key={`${model}-${idx}`}
                      className="flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--background)] cursor-grab active:cursor-grabbing group"
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(idx))}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const fromIdx = Number(e.dataTransfer.getData("text/plain"));
                        if (fromIdx !== idx) handleMoveComboModel(fromIdx, idx);
                      }}
                    >
                      <GripVertical className="w-4 h-4 text-[var(--muted-foreground)] shrink-0" />
                      <span className="flex-1 text-sm font-mono">{model}</span>
                      <span className="text-xs text-[var(--muted-foreground)] shrink-0">#{idx + 1}</span>
                      <button
                        onClick={() => handleRemoveComboModel(idx)}
                        className="p-0.5 rounded hover:bg-[var(--error)]/10 text-[var(--muted-foreground)] hover:text-[var(--error)] opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <p className="text-xs text-[var(--muted-foreground)] mt-1">
                    Proxy tries models top→bottom, falls back on failure
                  </p>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setComboDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSaveCombo}
              disabled={savingCombo || !comboName.trim() || comboModels.length === 0}
            >
              {savingCombo ? "Saving..." : (editingCombo ? "Update" : "Create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
