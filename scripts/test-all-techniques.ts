/**
 * Manual integration test: kirim 6 request synthetic langsung ke compressRequest()
 * untuk memastikan SEMUA 6 teknik trigger.
 */
import { compressRequest } from "../src/proxy/compression/index";
import { DEFAULT_COMPRESSION_CONFIG } from "../src/proxy/compression/types";

const all: any = {
  ...DEFAULT_COMPRESSION_CONFIG,
  dcp: { enabled: true, whitelist: ["Read", "Glob", "Grep", "LS", "WebFetch"] },
  caveman: { enabled: true, level: "full" },
};

console.log("=== Config (all techniques ON) ===");
console.log(JSON.stringify({
  rtk: all.rtk.enabled,
  dcp: all.dcp.enabled,
  caveman: all.caveman.enabled,
  cacheMarkers: all.cacheMarkers.enabled,
  imageDedupe: all.imageDedupe.enabled,
  tsc: all.tsc.enabled,
}, null, 2));
console.log();

// 1. TSC: tools array dengan $schema metadata
const tsc_req: any = {
  model: "test",
  messages: [{ role: "user", content: "hi" }],
  tools: Array.from({ length: 10 }, (_, i) => ({
    name: `tool_${i}`,
    description: "Does    something    cool.\n\n\n\nMore  text.",
    input_schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: `tool_${i}`,
      type: "object",
      additionalProperties: false,
      properties: { x: { type: "string" } },
    },
  })),
};
console.log("=== 1. TSC ===");
const r1 = compressRequest(tsc_req, all);
console.log("byTechnique:", r1.stats.byTechnique, "saved:", r1.stats.saved);
console.log();

// 2. RTK: large tool_result in older turn
const big = "x".repeat(10000);
const rtk_req: any = {
  model: "test",
  messages: [
    { role: "user", content: "do work" },
    { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: big }] },
    { role: "assistant", content: "done" },
    { role: "user", content: "more" },
    { role: "assistant", content: [{ type: "tool_use", id: "u2", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u2", content: "small" }] },
    { role: "assistant", content: "ok" },
  ],
};
console.log("=== 2. RTK ===");
const r2 = compressRequest(rtk_req, all);
console.log("byTechnique:", r2.stats.byTechnique, "saved:", r2.stats.saved);
console.log();

// 3. DCP: 2x identical Read
const dcp_req: any = {
  model: "test",
  messages: [
    { role: "user", content: "read" },
    { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "x".repeat(2000) }] },
    { role: "assistant", content: "got it" },
    { role: "user", content: "again" },
    { role: "assistant", content: [{ type: "tool_use", id: "r2", name: "Read", input: { file_path: "/a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "r2", content: "x".repeat(2000) }] },
    { role: "assistant", content: "done" },
  ],
};
console.log("=== 3. DCP ===");
const r3 = compressRequest(dcp_req, all);
console.log("byTechnique:", r3.stats.byTechnique, "saved:", r3.stats.saved);
console.log();

// 4. Caveman: system prompt with filler words
const cave_req: any = {
  model: "test",
  system: "You are a    helpful AI assistant.\n\n\n\nPlease   carefully and thoroughly think through user requests. " + "Be very very helpful and precise. ".repeat(50),
  messages: [{ role: "user", content: "hi" }],
};
console.log("=== 4. Caveman ===");
const r4 = compressRequest(cave_req, all);
console.log("byTechnique:", r4.stats.byTechnique, "saved:", r4.stats.saved);
console.log();

// 5. Image dedupe: same base64 image twice
const fake_b64 = "A".repeat(2000);
const img_req: any = {
  model: "test",
  messages: [
    { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: fake_b64 } },
      { type: "text", text: "look at this" }
    ]},
    { role: "assistant", content: "ok" },
    { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: fake_b64 } },
      { type: "text", text: "again same image" }
    ]},
  ],
};
console.log("=== 5. Image Dedupe ===");
const r5 = compressRequest(img_req, all);
console.log("byTechnique:", r5.stats.byTechnique, "saved:", r5.stats.saved);
console.log();

// 6. Cache Markers: large stable system
const cm_req: any = {
  model: "test",
  system: "You are a senior software engineer working on a large codebase. ".repeat(50),
  messages: [{ role: "user", content: "hi" }],
};
console.log("=== 6. Cache Markers ===");
const r6 = compressRequest(cm_req, all);
console.log("byTechnique:", r6.stats.byTechnique, "saved:", r6.stats.saved);
const sys = (r6.request as any).system;
const tagged = Array.isArray(sys) && sys.some((b: any) => b.cache_control);
console.log("cache_control attached to system:", tagged);
console.log();

console.log("=== SUMMARY ===");
const triggered = {
  tsc: (r1.stats.byTechnique.tsc ?? 0) > 0,
  rtk: (r2.stats.byTechnique.rtk ?? 0) > 0,
  dcp: (r3.stats.byTechnique.dcp ?? 0) > 0,
  caveman: (r4.stats.byTechnique.caveman ?? 0) > 0,
  imageDedupe: (r5.stats.byTechnique.imageDedupe ?? 0) > 0,
  cacheMarkers: tagged,
};
for (const [k, v] of Object.entries(triggered)) {
  console.log(`  ${v ? "✅" : "❌"}  ${k}`);
}
