import { describe, expect, test } from "bun:test";
import {
  anthropicToOpenAI,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  openAIToAnthropic,
  openAIStreamToAnthropic,
} from "../../src/proxy/transforms/anthropic";

/** Feed an array of OpenAI SSE `data:` payloads through the stream converter and
 *  collect the parsed Anthropic events it emits. Used by the streaming golden tests. */
async function collectAnthropicStream(
  openAIChunks: unknown[],
  request: Parameters<typeof openAIStreamToAnthropic>[1],
): Promise<Array<{ event: string; data: any }>> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of openAIChunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const out = openAIStreamToAnthropic(source, request);
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }

  const events: Array<{ event: string; data: any }> = [];
  for (const block of buf.split("\n\n")) {
    const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
  }
  return events;
}

describe("anthropic tool conversion", () => {
  test("converts {name, description, input_schema} to OpenAI function shape", () => {
    const out = anthropicToolsToOpenAI([
      {
        name: "get_weather",
        description: "get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ]);
    expect(out).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "get weather",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ]);
  });

  test("passes through already-OpenAI-shaped tools unchanged", () => {
    const openai = [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {} } } }];
    expect(anthropicToolsToOpenAI(openai)).toEqual(openai);
  });

  test("drops tools without a name and defaults missing schema", () => {
    const out = anthropicToolsToOpenAI([{ description: "no name" }, { name: "ok" }]);
    expect(out).toEqual([
      { type: "function", function: { name: "ok", description: "", parameters: { type: "object", properties: {} } } },
    ]);
  });

  test("returns undefined for empty/absent tools", () => {
    expect(anthropicToolsToOpenAI(undefined)).toBeUndefined();
    expect(anthropicToolsToOpenAI([])).toBeUndefined();
  });
});

describe("anthropic tool_choice conversion", () => {
  test("maps object forms to OpenAI equivalents", () => {
    expect(anthropicToolChoiceToOpenAI({ type: "auto" })).toBe("auto");
    expect(anthropicToolChoiceToOpenAI({ type: "any" })).toBe("required");
    expect(anthropicToolChoiceToOpenAI({ type: "none" })).toBe("none");
    expect(anthropicToolChoiceToOpenAI({ type: "tool", name: "f" })).toEqual({
      type: "function",
      function: { name: "f" },
    });
  });

  test("passes string forms through and ignores null", () => {
    expect(anthropicToolChoiceToOpenAI("auto")).toBe("auto");
    expect(anthropicToolChoiceToOpenAI(null)).toBeUndefined();
  });
});

describe("anthropicToOpenAI request mapping", () => {
  test("produces OpenAI-shaped tools in the converted request", () => {
    const req = anthropicToOpenAI({
      model: "qd-Qwen3.7-Max",
      max_tokens: 64,
      messages: [{ role: "user", content: "weather in Tokyo?" }],
      tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any" },
    });
    expect(req.tools?.[0]).toEqual({
      type: "function",
      function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } },
    });
    expect(req.tool_choice).toBe("required");
  });

  test("omits tools/tool_choice keys when not provided", () => {
    const req = anthropicToOpenAI({
      model: "kp-opus-4.6-thinking",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });
    expect("tools" in req).toBe(false);
    expect("tool_choice" in req).toBe(false);
  });

  test("prepends system prompt as a system message", () => {
    const req = anthropicToOpenAI({
      model: "kp-opus-4.6-thinking",
      max_tokens: 64,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(req.messages[0]).toEqual({ role: "system", content: "be terse" });
  });
});

describe("openAIToAnthropic response mapping", () => {
  const req = { model: "auto", max_tokens: 64, messages: [{ role: "user" as const, content: "hi" }] };

  test("maps a plain text completion to an Anthropic message", () => {
    const out = openAIToAnthropic(
      {
        id: "chatcmpl-abc",
        model: "auto",
        choices: [{ message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
      req,
    );
    expect(out.id).toBe("msg_abc");
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.content).toEqual([{ type: "text", text: "hello there" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  test("maps tool_calls to tool_use blocks with parsed input and stop_reason tool_use", () => {
    const out = openAIToAnthropic(
      {
        id: "chatcmpl-xyz",
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 8 },
      },
      req,
    );
    expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Tokyo" } }]);
    expect(out.stop_reason).toBe("tool_use");
  });

  test("maps finish_reason length to max_tokens", () => {
    const out = openAIToAnthropic(
      { choices: [{ message: { role: "assistant", content: "trunc" }, finish_reason: "length" }] },
      req,
    );
    expect(out.stop_reason).toBe("max_tokens");
  });
});

describe("openAIStreamToAnthropic streaming round-trip", () => {
  const req = { model: "auto", max_tokens: 64, messages: [{ role: "user" as const, content: "hi" }] };

  test("emits message_start, a text block, and message_stop for a text stream", async () => {
    const events = await collectAnthropicStream(
      [
        { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      req,
    );
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_delta");
    expect(names[names.length - 1]).toBe("message_stop");

    const text = events
      .filter((e) => e.event === "content_block_delta" && e.data.delta?.type === "text_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(text).toBe("Hello");

    const messageDelta = events.find((e) => e.event === "message_delta");
    expect(messageDelta?.data.delta.stop_reason).toBe("end_turn");
  });

  test("emits tool_use block with streamed input_json_delta and tool_use stop_reason", async () => {
    const events = await collectAnthropicStream(
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"ci' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Tokyo"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ],
      req,
    );
    const start = events.find((e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use");
    expect(start?.data.content_block).toMatchObject({ type: "tool_use", id: "call_1", name: "get_weather" });

    const json = events
      .filter((e) => e.event === "content_block_delta" && e.data.delta?.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(json).toBe('{"city":"Tokyo"}');

    const messageDelta = events.find((e) => e.event === "message_delta");
    expect(messageDelta?.data.delta.stop_reason).toBe("tool_use");
  });

  test("maps reasoning_content to a thinking block before text", async () => {
    const events = await collectAnthropicStream(
      [
        { choices: [{ delta: { reasoning_content: "hmm" }, finish_reason: null }] },
        { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ],
      req,
    );
    const thinking = events.find((e) => e.event === "content_block_start" && e.data.content_block?.type === "thinking");
    expect(thinking).toBeDefined();
    const thinkingDelta = events.find((e) => e.event === "content_block_delta" && e.data.delta?.type === "thinking_delta");
    expect(thinkingDelta?.data.delta.thinking).toBe("hmm");
    const signatureDelta = events.find((e) => e.event === "content_block_delta" && e.data.delta?.type === "signature_delta");
    expect(signatureDelta?.data.delta.signature).toBe("poolprox_unsigned_reasoning_summary");
  });
});
