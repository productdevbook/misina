import { describe, expect, it } from "vitest"
import {
  accumulateAnthropicMessage,
  accumulateOpenAIToolCalls,
  collect,
  sseStream,
} from "../src/stream/index.ts"

function sseFrom(events: Array<{ event?: string; data: string }>): Response {
  const body = events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${e.data}\n\n`)
    .join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

describe("collect — generic stream reducer", () => {
  it("folds chunks into an accumulator", async () => {
    async function* nums(): AsyncGenerator<number> {
      yield 1
      yield 2
      yield 3
    }
    const sum = await collect(nums(), (acc, n) => acc + n, 0)
    expect(sum).toBe(6)
  })

  it("empty source returns initial unchanged", async () => {
    async function* empty(): AsyncGenerator<number> {}
    expect(await collect(empty(), (a, n) => a + n, 42)).toBe(42)
  })
})

describe("accumulateOpenAIToolCalls", () => {
  it("merges deltas indexed by tool_call.index", async () => {
    const events = sseFrom([
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "lookup" } },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"foo"}' } }] } }],
        }),
      },
      { data: "[DONE]" },
    ])
    const calls = await accumulateOpenAIToolCalls(sseStream(events))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.id).toBe("call_1")
    expect(calls[0]?.type).toBe("function")
    expect(calls[0]?.function.name).toBe("lookup")
    expect(calls[0]?.function.arguments).toBe('{"q":"foo"}')
  })

  it("handles multiple tool calls (index 0 + index 1)", async () => {
    const events = sseFrom([
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "a", function: { name: "f1", arguments: "{}" } },
                  { index: 1, id: "b", function: { name: "f2", arguments: '{"x":1}' } },
                ],
              },
            },
          ],
        }),
      },
      { data: "[DONE]" },
    ])
    const calls = await accumulateOpenAIToolCalls(sseStream(events))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.function.name).toBe("f1")
    expect(calls[1]?.function.name).toBe("f2")
  })

  it("ignores non-tool-call deltas (text content) silently", async () => {
    const events = sseFrom([
      { data: JSON.stringify({ choices: [{ delta: { content: "hello" } }] }) },
      { data: "[DONE]" },
    ])
    const calls = await accumulateOpenAIToolCalls(sseStream(events))
    expect(calls).toEqual([])
  })

  it("malformed JSON in a chunk is skipped, stream continues", async () => {
    const events = sseFrom([
      { data: "not json" },
      {
        data: JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { name: "x", arguments: "{}" } }] } },
          ],
        }),
      },
      { data: "[DONE]" },
    ])
    const calls = await accumulateOpenAIToolCalls(sseStream(events))
    expect(calls[0]?.function.name).toBe("x")
  })
})

describe("accumulateAnthropicMessage", () => {
  it("builds a text message from message_start + content_block_delta + message_stop", async () => {
    const events = sseFrom([
      {
        event: "message_start",
        data: JSON.stringify({ message: { id: "msg_01", model: "claude-x", role: "assistant" } }),
      },
      {
        event: "content_block_start",
        data: JSON.stringify({ index: 0, content_block: { type: "text", text: "" } }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Hello " } }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "world" } }),
      },
      { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
      {
        event: "message_delta",
        data: JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      },
      { event: "message_stop", data: "{}" },
    ])
    const msg = await accumulateAnthropicMessage(sseStream(events))
    expect(msg.id).toBe("msg_01")
    expect(msg.model).toBe("claude-x")
    expect(msg.content[0]?.type).toBe("text")
    expect(msg.content[0]?.text).toBe("Hello world")
    expect(msg.stop_reason).toBe("end_turn")
    expect(msg.usage?.output_tokens).toBe(5)
  })

  it("accumulates tool_use partial_json and parses on content_block_stop", async () => {
    const events = sseFrom([
      { event: "message_start", data: JSON.stringify({ message: { id: "msg" } }) },
      {
        event: "content_block_start",
        data: JSON.stringify({
          index: 0,
          content_block: { type: "tool_use", id: "tu_1", name: "search", input: {} },
        }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"q":' },
        }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"misina"}' },
        }),
      },
      { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
      { event: "message_stop", data: "{}" },
    ])
    const msg = await accumulateAnthropicMessage(sseStream(events))
    const block = msg.content[0]
    expect(block?.type).toBe("tool_use")
    expect(block?.name).toBe("search")
    // The input was {} on start; partial_json finalizes it.
    expect(block?.partial_json).toBe('{"q":"misina"}')
  })

  it("malformed partial_json leaves block.input undefined and partial_json intact", async () => {
    const events = sseFrom([
      { event: "message_start", data: JSON.stringify({ message: {} }) },
      {
        event: "content_block_start",
        data: JSON.stringify({
          index: 0,
          content_block: { type: "tool_use", id: "x", name: "f" },
        }),
      },
      {
        event: "content_block_delta",
        data: JSON.stringify({
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{not-json" },
        }),
      },
      { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
      { event: "message_stop", data: "{}" },
    ])
    const msg = await accumulateAnthropicMessage(sseStream(events))
    expect(msg.content[0]?.partial_json).toBe("{not-json")
    expect(msg.content[0]?.input).toBeUndefined()
  })
})
