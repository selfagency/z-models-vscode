import { describe, expect, it } from 'vitest';
import { createZAiInlineToolCallParser } from '@agentsy/core/processor';
import { ToolCallAccumulator } from '@agentsy/core/tool-calls';

/**
 * Z.ai streams tool calls as control tokens inside the text channel:
 *   <|tool_call_begin|>name<|tool_call_argument_begin|>{"k":"v"}<|tool_call_end|>
 *
 * The provider composes `createZAiInlineToolCallParser()` with
 * `ToolCallAccumulator` (see provideLanguageModelChatResponse). These tests pin
 * that composition, which replaced 132 lines of bespoke parsing and previously
 * had no coverage at all.
 */
function run(chunks: string[]): { text: string; calls: Array<{ name: string; args: unknown }> } {
  const parser = createZAiInlineToolCallParser();
  const accumulator = new ToolCallAccumulator();
  const calls: Array<{ name: string; args: unknown }> = [];
  let text = '';

  const drain = () => {
    for (const { index, call } of accumulator.getCompletedCallsWithIndices()) {
      calls.push({ name: call.name, args: call.arguments });
      accumulator.removeCall(index);
    }
  };

  for (const chunk of chunks) {
    const parsed = parser.parse(chunk, { done: false });
    text += parsed.content;
    for (const delta of parsed.nativeToolCallDeltas ?? []) {
      accumulator.addDelta(delta);
    }
    drain();
  }

  for (const { call } of accumulator.flushWithIndices()) {
    calls.push({ name: call.name, args: call.arguments });
  }
  return { text, calls };
}

describe('Z.ai inline tool-call token parsing', () => {
  it('passes plain text through unchanged', () => {
    const { text, calls } = run(['Hello ', 'world.']);
    expect(text).toBe('Hello world.');
    expect(calls).toEqual([]);
  });

  it('extracts a tool call and keeps surrounding text', () => {
    const { text, calls } = run([
      'Checking. ',
      '<|tool_call_begin|>get_weather<|tool_call_argument_begin|>{"city":"Berlin"}<|tool_call_end|>',
      ' Done.',
    ]);
    expect(text).toBe('Checking.  Done.');
    expect(calls).toEqual([{ name: 'get_weather', args: { city: 'Berlin' } }]);
  });

  it('reassembles a tool call split across chunk boundaries', () => {
    // The arguments arrive in pieces; nothing is emitted until they parse.
    const { calls } = run([
      '<|tool_call_begin|>get_weather<|tool_call_argument_begin|>{"ci',
      'ty":"Ber',
      'lin"}<|tool_call_end|>',
    ]);
    expect(calls).toEqual([{ name: 'get_weather', args: { city: 'Berlin' } }]);
  });

  it('handles a tool call split mid-token-name', () => {
    const { calls } = run([
      '<|tool_call_beg',
      'in|>search<|tool_call_argument_begin|>{"q":"glm"}<|tool_call_end|>',
    ]);
    expect(calls).toEqual([{ name: 'search', args: { q: 'glm' } }]);
  });

  it('emits multiple tool calls from one response', () => {
    const { calls } = run([
      '<|tool_call_begin|>a_one<|tool_call_argument_begin|>{"x":1}<|tool_call_end|>',
      '<|tool_call_begin|>b_two<|tool_call_argument_begin|>{"y":2}<|tool_call_end|>',
    ]);
    expect(calls.map(c => c.name)).toEqual(['a_one', 'b_two']);
    expect(calls[0]?.args).toEqual({ x: 1 });
    expect(calls[1]?.args).toEqual({ y: 2 });
  });

  it('emits visible text incrementally rather than only at flush', () => {
    // Regression guard: LLMStreamProcessor buffers text in a residual and only
    // releases it on flush(), which would stall the chat UI. The provider uses
    // the parser directly for exactly this reason.
    const parser = createZAiInlineToolCallParser();
    const first = parser.parse('streaming now', { done: false });
    expect(first.content).toBe('streaming now');
  });

  it('emits a call as soon as its arguments become valid JSON', () => {
    const parser = createZAiInlineToolCallParser();
    const accumulator = new ToolCallAccumulator();

    const partial = parser.parse('<|tool_call_begin|>f<|tool_call_argument_begin|>{"a":', { done: false });
    for (const d of partial.nativeToolCallDeltas ?? []) accumulator.addDelta(d);
    expect(accumulator.getCompletedCallsWithIndices()).toHaveLength(0);

    const rest = parser.parse('1}<|tool_call_end|>', { done: false });
    for (const d of rest.nativeToolCallDeltas ?? []) accumulator.addDelta(d);
    const completed = accumulator.getCompletedCallsWithIndices();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.call.name).toBe('f');
  });

  it('survives malformed JSON without throwing', () => {
    const { text, calls } = run([
      'oops <|tool_call_begin|>broken<|tool_call_argument_begin|>{not json}<|tool_call_end|> after',
    ]);
    expect(text).toContain('after');
    expect(text).not.toContain('tool_call');
    // Either it is dropped or surfaced as raw text, but the loop must not throw.
    expect(Array.isArray(calls)).toBe(true);
  });

  it('leaves a partial trailing token buffered rather than leaking it as text', () => {
    const { text, calls } = run(['complete text', '<|tool_call_beg']);
    expect(text).toBe('complete text');
    expect(calls).toEqual([]);
  });
});
