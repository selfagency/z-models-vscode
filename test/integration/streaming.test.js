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
const http = require('http');
const vscode = require('vscode');

/** How long after the last chunk we wait before declaring text was buffered. */
const ARRIVAL_TOLERANCE_MS = 150;

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * @param {object} opts
 * @param {number} opts.chunkDelayMs delay between chunks; makes buffering observable
 * @param {boolean} opts.holdOpen extra delay before the response ends, so a
 *   renderer that emits at end() is distinguishable from one that streams
 */
function startZaiStub({ chunkDelayMs = 25, holdOpen = 250 } = {}) {
  const state = { requestBodies: [], lastChunkSentAt: 0, serverClosedAt: 0, requests: 0 };

  const server = http.createServer(async (req, res) => {
    state.requests += 1;

    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'glm-5.3', object: 'model', created: 0, owned_by: 'z-ai' },
            { id: 'glm-5.3-flash', object: 'model', created: 0, owned_by: 'z-ai' },
          ],
        }),
      );
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    state.requestBodies.push(JSON.parse(body || '{}'));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Reasoning arrives on its own channel first, the way Z.ai streams thinking.
    res.write(sse({ choices: [{ delta: { reasoning_content: 'thinking hard' } }] }));

    for (const piece of ['Hello', ' streamed', ' world.']) {
      await new Promise(r => setTimeout(r, chunkDelayMs));
      res.write(sse({ choices: [{ delta: { content: piece } }] }));
      state.lastChunkSentAt = Date.now();
    }

    await new Promise(r => setTimeout(r, holdOpen));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    state.lastChunkSentAt = Date.now();
    res.write('data: [DONE]\n\n');
    res.end();
    state.serverClosedAt = Date.now();
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        baseUrl: `http://127.0.0.1:${port}/api/coding/paas/v4`,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

/** Matches the provider's signature: (model, messages, options, progress, token). */
const MODEL = { id: 'glm-5.3', name: 'GLM 5.3', maxInputTokens: 1000000, maxOutputTokens: 131072 };

function makeMessages() {
  return [
    {
      role: 1, // ChatRequestRole.User
      content: [new vscode.LanguageModelTextPart('hi')],
    },
  ];
}

async function runResponse(provider, progress) {
  await provider.provideLanguageModelChatResponse(
    MODEL,
    makeMessages(),
    {},
    progress,
    new vscode.CancellationTokenSource().token,
  );
}

// The shipped bundle is minified, so constructor names are unusable
// (LanguageModelTextPart -> 'ln'). Identify parts by instanceof instead.
function isText(part) {
  return part instanceof vscode.LanguageModelTextPart;
}
function isThinking(part) {
  return 'value' in part && part.constructor?.name !== 'LanguageModelTextPart' && part.value !== undefined;
}

function textOf(recorder) {
  return recorder
    .filter(e => isText(e.part))
    .map(e => e.part.value)
    .join('');
}

async function providerHandle() {
  const provider = await vscode.commands.executeCommand('z-models-vscode.__testProvider');
  assert.ok(provider, 'test provider handle not available');
  return provider;
}

suite('Streaming end-to-end', () => {
  let stub;
  let config;

  suiteSetup(async function () {
    this.timeout(30000);
    stub = await startZaiStub();
    config = vscode.workspace.getConfiguration('zModels');
    await config.update('api.baseUrlOverride', stub.baseUrl, vscode.ConfigurationTarget.Global);
    await config.update('api.endpointMode', 'zaiCoding', vscode.ConfigurationTarget.Global);

    // Activate first: the __test* commands do not exist until activate() has
    // run, and suite order is not guaranteed across files.
    const ext = vscode.extensions.getExtension('selfagency.z-models-vscode');
    assert.ok(ext, 'extension not found');
    if (!ext.isActive) await ext.activate();

    // The provider refuses to run without a key and reads it through
    // ApiKeyManager -> ExtensionContext.secrets. Seed a stub key, then drive the
    // public model-info path, which is what builds the HTTP client.
    await vscode.commands.executeCommand('z-models-vscode.__testSeedApiKey', 'test-stub-key');
    const provider = await providerHandle();
    await provider.provideLanguageModelChatInformation(
      { silent: true },
      new vscode.CancellationTokenSource().token,
    );
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('z-models-vscode.__testClearApiKey');
    await config?.update('api.baseUrlOverride', undefined, vscode.ConfigurationTarget.Global);
    await stub?.close();
  });

  test('text reaches the progress surface before the response completes', async function () {
    this.timeout(30000);

    const provider = await providerHandle();

    const recorder = [];
    stub.state.lastChunkSentAt = 0;
    stub.state.serverClosedAt = 0;

    await runResponse(provider, { report: part => recorder.push({ at: Date.now(), part }) });

    const text = textOf(recorder);
    assert.strictEqual(text, 'Hello streamed world.', `unexpected text: ${JSON.stringify(text)}`);

    // Streaming means the last text part lands BEFORE the response finishes.
    // lastChunkSentAt is when the server emitted its final chunk, so a positive
    // lead here is proof of streaming; a negative or zero lead is the buffered
    // behaviour this test exists to catch.
    const lastTextAt = Math.max(...recorder.filter(e => isText(e.part)).map(e => e.at));
    const leadMs = stub.state.lastChunkSentAt - lastTextAt;
    assert.ok(
      leadMs >= ARRIVAL_TOLERANCE_MS,
      `text was buffered: last text part arrived ${-leadMs}ms AFTER the final chunk ` +
        `(need >=${ARRIVAL_TOLERANCE_MS}ms before it). ` +
        `parts=${JSON.stringify(recorder.map(e => ({ dt: e.at - stub.state.lastChunkSentAt, v: e.part?.value })))}`,
    );
  });

  test('emits more than one text part for a multi-chunk response', async function () {
    this.timeout(30000);
    const provider = await providerHandle();

    const recorder = [];
    await runResponse(provider, { report: part => recorder.push({ at: Date.now(), part }) });

    const textParts = recorder.filter(e => isText(e.part));
    // A renderer that dumps everything at once produces exactly 1 part.
    assert.ok(
      textParts.length > 1,
      `expected the response to arrive as multiple parts, got ${textParts.length}: ${JSON.stringify(textParts)}`,
    );
    assert.strictEqual(textParts.length, 3, `expected 3 content chunks, got ${textParts.length}`);

    // Each part must be a distinct chunk, not three copies of the whole body.
    assert.deepStrictEqual(
      textParts.map(e => e.part.value),
      ['Hello', ' streamed', ' world.'],
      'content was not delivered chunk by chunk',
    );
  });

  test('reasoning arrives on the thinking channel, not as content', async function () {
    this.timeout(30000);
    const provider = await providerHandle();

    const recorder = [];
    await runResponse(provider, { report: part => recorder.push({ at: Date.now(), part }) });

    assert.strictEqual(
      textOf(recorder),
      'Hello streamed world.',
      `reasoning leaked into the text channel: ${JSON.stringify(recorder.map(e => e.part?.value))}`,
    );
    const thinking = recorder.filter(e => !isText(e.part));
    assert.ok(
      thinking.length > 0,
      `expected a thinking part for reasoning_content, got ${JSON.stringify(recorder.map(e => e.part?.value))}`,
    );
  });

  test('reports models advertised by the endpoint', async function () {
    this.timeout(30000);
    const provider = await providerHandle();

    const models = await provider.fetchModels();
    const ids = models.map(m => m.id);
    assert.ok(ids.includes('glm-5.3'), `glm-5.3 missing from ${JSON.stringify(ids)}`);
    // The generated limits table must apply to a live id, or context window
    // silently collapses to the 32K default (issues #12 / #21).
    const flash = models.find(m => m.id === 'glm-5.3-flash');
    assert.ok(flash, 'glm-5.3-flash missing');
    assert.strictEqual(
      flash.maxInputTokens,
      1_000_000,
      `glm-5.3-flash reported ${flash.maxInputTokens} input tokens, expected 1000000`,
    );
  });
});
