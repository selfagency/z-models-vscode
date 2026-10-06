'use strict';
// Streaming end-to-end test.
//
// Motivation: a buffered renderer shipped unnoticed. `LLMStreamProcessor`'s
// default `scrubContextTags: true` holds all text in a residual and releases it
// only on flush(), so every response reached the chat UI only once the model had
// finished. The unit tests caught the mechanism; this catches the product.
//
// The whole chain runs here for real: a local HTTP server speaks Z.ai's SSE
// dialect, the provider posts to it, and text must arrive on the VS Code
// progress surface BEFORE the server closes the response. Unit tests cannot
// prove that, because they construct their own stream.

const assert = require('assert');
const {
  RESPONSE,
  state,
  getProvider,
  runResponse,
  isText,
  textOf,
} = require('./harness');

/** How much lead time over the final chunk counts as streaming rather than buffering. */
const ARRIVAL_TOLERANCE_MS = 150;

suite('Streaming end-to-end', () => {
  test('text reaches the progress surface before the response completes', async function () {
    this.timeout(30000);
    const provider = await getProvider();
    state.lastChunkSentAt = 0;
    state.serverClosedAt = 0;

    const recorder = await runResponse(provider);

    assert.strictEqual(textOf(recorder), RESPONSE.text, `unexpected text: ${JSON.stringify(textOf(recorder))}`);

    // Streaming means the last text part lands BEFORE the response finishes.
    // state.lastChunkSentAt is when the server emitted its final chunk, so a
    // positive lead proves streaming; zero or negative is the buffered behaviour
    // this test exists to catch.
    const lastTextAt = Math.max(...recorder.filter(e => isText(e.part)).map(e => e.at));
    const leadMs = state.serverClosedAt - lastTextAt;
    assert.ok(
      leadMs >= ARRIVAL_TOLERANCE_MS,
      `text was buffered: last text part arrived ${-leadMs}ms AFTER the response closed ` +
        `(need >=${ARRIVAL_TOLERANCE_MS}ms before it). ` +
        `parts=${JSON.stringify(recorder.map(e => ({ dt: e.at - state.serverClosedAt, v: e.part?.value })))}`,
    );
  });

  test('content arrives chunk by chunk, not as one dump', async function () {
    this.timeout(30000);
    const provider = await getProvider();
    const recorder = await runResponse(provider);

    const textParts = recorder.filter(e => isText(e.part));
    // A renderer that dumps everything at once produces exactly 1 part.
    assert.ok(
      textParts.length > 1,
      `expected the response to arrive as multiple parts, got ${textParts.length}`,
    );
    // Each part must be a distinct chunk, not several copies of the whole body.
    assert.deepStrictEqual(
      textParts.map(e => e.part.value),
      RESPONSE.textChunks,
      'content was not delivered chunk by chunk',
    );
  });

  test('reasoning arrives on the thinking channel, not as content', async function () {
    this.timeout(30000);
    const provider = await getProvider();
    const recorder = await runResponse(provider);

    assert.strictEqual(
      textOf(recorder),
      RESPONSE.text,
      `reasoning leaked into the text channel: ${JSON.stringify(recorder.map(e => e.part?.value))}`,
    );
    const thinking = recorder.filter(e => !isText(e.part));
    assert.ok(
      thinking.length > 0,
      `expected a thinking part for reasoning_content, got ${JSON.stringify(recorder.map(e => e.part?.value))}`,
    );
    assert.strictEqual(thinking[0].part.value, RESPONSE.reasoning);
  });

  test('the upstream request carries the configured model and streaming flag', async function () {
    this.timeout(30000);
    const provider = await getProvider();
    const before = state.requestBodies.length;
    await runResponse(provider);

    const body = state.requestBodies[before];
    assert.ok(body, 'no upstream request body captured');
    assert.strictEqual(body.model, 'glm-5.3', `unexpected model in request: ${body.model}`);
    assert.strictEqual(body.stream, true, 'request did not ask for a stream');
  });
});