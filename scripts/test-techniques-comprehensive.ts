/**
 * Comprehensive smoke test for ALL 6 compression techniques.
 *
 * For each technique, build a request that should trigger it, run through
 * compressRequest(), and assert the technique fires + savings > 0 (or
 * structural change for cache markers).
 *
 * Run with: bun scripts/test-techniques-comprehensive.ts
 */
import { compressRequest } from "../src/proxy/compression/index";
import { DEFAULT_COMPRESSION_CONFIG } from "../src/proxy/compression/types";

interface CaseResult {
  name: string;
  expected: string;
  passed: boolean;
  detail: string;
}

const results: CaseResult[] = [];

const allOn: any = {
  ...DEFAULT_COMPRESSION_CONFIG,
  dcp: { enabled: true, whitelist: ["Read", "Glob", "Grep", "LS", "WebFetch"] },
  caveman: { enabled: true, level: "full" },
};

function check(name: string, expected: string, passed: boolean, detail: string) {
  results.push({ name, expected, passed, detail });
}

// === TSC ===
{
  const req: any = {
    model: "test", messages: [{ role: "user", content: "hi" }],
    tools: Array.from({ length: 20 }, (_, i) => ({
      name: `t_${i}`,
      description: "Does    something    cool.\n\n\n\nMore  text.",
      input_schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: `t_${i}`, type: "object", additionalProperties: false,
        properties: { x: { type: "string", description: "An  arg." } },
      },
    })),
  };
  const r = compressRequest(req, allOn);
  check("TSC", "tsc > 0", (r.stats.byTechnique.tsc ?? 0) > 0, `tsc=${r.stats.byTechnique.tsc} saved=${r.stats.saved}`);
}

// === TSC w/ OpenAI flavor ===
{
  const req: any = {
    model: "test", messages: [{ role: "user", content: "hi" }],
    tools: Array.from({ length: 10 }, (_, i) => ({
      type: "function",
      function: {
        name: `t_${i}`,
        description: "Does   stuff   here.",
        parameters: { $schema: "x", type: "object", additionalProperties: false, properties: { x: { type: "string" } } },
      },
    })),
  };
  const r = compressRequest(req, allOn);
  check("TSC (OpenAI)", "tsc > 0", (r.stats.byTechnique.tsc ?? 0) > 0, `tsc=${r.stats.byTechnique.tsc}`);
}

// === RTK ===
{
  const big = "x".repeat(10000);
  const req: any = {
    model: "test",
    messages: [
      { role: "user", content: "do" },
      { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: big }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "more" },
      { role: "assistant", content: [{ type: "tool_use", id: "u2", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "ok" }] },
      { role: "assistant", content: "done" },
    ],
  };
  const r = compressRequest(req, allOn);
  check("RTK (Anthropic)", "rtk > 0", (r.stats.byTechnique.rtk ?? 0) > 0, `rtk=${r.stats.byTechnique.rtk}`);
}

// === RTK w/ OpenAI tool message ===
{
  const big = "x".repeat(10000);
  const req: any = {
    model: "test",
    messages: [
      { role: "user", content: "do" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: big },
      { role: "assistant", content: "done" },
      { role: "user", content: "again" },
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: "ok" },
      { role: "assistant", content: "done" },
    ],
  };
  const r = compressRequest(req, allOn);
  check("RTK (OpenAI role:tool)", "rtk > 0", (r.stats.byTechnique.rtk ?? 0) > 0, `rtk=${r.stats.byTechnique.rtk}`);
}

// === DCP ===
{
  const big = "x".repeat(2000);
  const req: any = {
    model: "test",
    messages: [
      { role: "user", content: "read" },
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: big }] },
      { role: "assistant", content: "got it" },
      { role: "user", content: "again" },
      { role: "assistant", content: [{ type: "tool_use", id: "r2", name: "Read", input: { file_path: "/a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r2", content: big }] },
      { role: "assistant", content: "done" },
    ],
  };
  const r = compressRequest(req, allOn);
  check("DCP", "dcp > 0", (r.stats.byTechnique.dcp ?? 0) > 0, `dcp=${r.stats.byTechnique.dcp}`);
}

// === Caveman ===
{
  const sys = "You are a    helpful AI assistant.\n\n\n\nPlease very carefully and thoroughly think step by step. " + "It is very important that you are precise. ".repeat(80);
  const req: any = { model: "test", system: sys, messages: [{ role: "user", content: "hi" }] };
  const r = compressRequest(req, allOn);
  check("Caveman (full)", "caveman > 0", (r.stats.byTechnique.caveman ?? 0) > 0, `caveman=${r.stats.byTechnique.caveman}`);
}

// === Image Dedupe ===
{
  const fake = "B".repeat(2000);
  const req: any = {
    model: "test",
    messages: [
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: fake } },
        { type: "text", text: "look" }
      ]},
      { role: "assistant", content: "ok" },
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: fake } },
        { type: "text", text: "again" }
      ]},
    ],
  };
  const r = compressRequest(req, allOn);
  check("Image Dedupe", "imageDedupe > 0", (r.stats.byTechnique.imageDedupe ?? 0) > 0, `img=${r.stats.byTechnique.imageDedupe}`);
}

// === Cache Markers (system) ===
{
  const sys = "You are a senior software engineer. ".repeat(40); // > 1024 chars, stable
  const req: any = { model: "test", system: sys, messages: [{ role: "user", content: "hi" }] };
  const r = compressRequest(req, allOn);
  const newSys = (r.request as any).system;
  const tagged = Array.isArray(newSys) && newSys.some((b: any) => b.cache_control);
  check("Cache Markers (system)", "system tagged", tagged, `tagged=${tagged}`);
}

// === Cache Markers (tools) ===
{
  const req: any = {
    model: "test", messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "stable_tool", description: "desc", input_schema: { type: "object" } }],
  };
  const r = compressRequest(req, allOn);
  const tools = (r.request as any).tools;
  const tagged = Array.isArray(tools) && tools.some((t: any) => t.cache_control);
  check("Cache Markers (tools)", "tools tagged", tagged, `tagged=${tagged}`);
}

// === Cache Markers SKIP unstable ===
{
  const sys = "Run started at 2025-06-13T15:00:00Z. " + "Helper text. ".repeat(80);
  const req: any = { model: "test", system: sys, messages: [{ role: "user", content: "hi" }] };
  const r = compressRequest(req, allOn);
  const newSys = (r.request as any).system;
  const taggedSys = Array.isArray(newSys) && newSys.some((b: any) => b.cache_control);
  // Unstable system not tagged. (tools is empty, so no tools fallback)
  check("Cache Markers skips unstable", "system NOT tagged", !taggedSys, `taggedSys=${taggedSys}`);
}

// === Codex provider override ===
{
  const sys = "Stable system. ".repeat(80);
  const req: any = { model: "test", system: sys, messages: [{ role: "user", content: "hi" }] };
  const r = compressRequest(req, allOn, "codex");
  const newSys = (r.request as any).system;
  // Either system is unchanged string OR not tagged
  const tagged = Array.isArray(newSys) && newSys.some((b: any) => b.cache_control);
  check("Cache Markers codex override", "skipped for codex", !tagged, `tagged=${tagged}`);
}

// === Pipeline disabled (all OFF) ===
{
  const off: any = {
    rtk: { enabled: false, maxToolChars: 4000, keepLastNTurnsFull: 2, smartTruncate: true },
    dcp: { enabled: false, whitelist: [] },
    caveman: { enabled: false, level: "lite" },
    cacheMarkers: { enabled: false, providerOverrides: {} },
    imageDedupe: { enabled: false },
    tsc: { enabled: false, stripSchemaWhitespace: false, trimDescriptions: false, dropSchemaMeta: false },
  };
  const req: any = { model: "test", messages: [{ role: "user", content: "hi" }], tools: [{ name: "x", description: "  s  ", input_schema: { $schema: "y", type: "object" } }] };
  const r = compressRequest(req, off);
  check("All OFF -> no change", "saved == 0", r.stats.saved === 0, `saved=${r.stats.saved}`);
}

// === Print ===
console.log("");
console.log("┌──────────────────────────────────────────┬───────────────────────┬─────────┐");
console.log("│ Technique                                │ Detail                │ Status  │");
console.log("├──────────────────────────────────────────┼───────────────────────┼─────────┤");
let pass = 0, fail = 0;
for (const r of results) {
  const status = r.passed ? "✅ PASS" : "❌ FAIL";
  if (r.passed) pass++; else fail++;
  console.log(`│ ${r.name.padEnd(40)} │ ${r.detail.padEnd(21)} │ ${status} │`);
}
console.log("└──────────────────────────────────────────┴───────────────────────┴─────────┘");
console.log(`\n${pass}/${results.length} passed (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
