'use strict';
// Shared harness for the integration suites.
//
// One stub server, one settings change, one activation, for the whole Mocha
// process. Two suites each standing up their own server and rewriting
// zModels.api.baseUrlOverride raced: one suite's response text bled into the
// other's assertions, and whichever finished last left the other's client
// pointed at a dead port. Global VS Code settings are process-wide, so the
// fixtures have to be too.

const assert = require('assert');
const http = require('http');
const vscode = require('vscode');

/** The exact response the stub streams. Shared so every suite asserts the same bytes. */
const RESPONSE = {
  reasoning: 'thinking hard',
  textChunks: ['Hello', ' streamed', ' world.'],
  get text() {
    return this.textChunks.join('');
  },
  models: ['glm-5.3', 'glm-5.3-flash'],
};

// lastChunkSentAt: last content chunk written. serverClosedAt: when res.end()
// happened. Streaming means text lands well before the second, not the first.
const state = { chatRequests: 0, modelRequests: 0, requestBodies: [], lastChunkSentAt: 0, serverClosedAt: 0 };

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

let server;
let baseUrl;

/**
 * VS Code's language-model registry caches a vendor's catalog for the whole
 * session once queried, so activation and key seeding have to happen before any
 * suite runs. A root hook (setup/teardown in the TDD interface) is the only
 * thing that beats file ordering.
 */
async function setupZaiStub() {
  // Mocha binds the context as `this`, it does not pass it as an argument.
  this.timeout(60000);

  server = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) {
      state.modelRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: RESPONSE.models.map(id => ({ id, object: 'model', created: 0, owned_by: 'z-ai' })),
        }),
      );
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    state.chatRequests += 1;
    state.requestBodies.push(JSON.parse(body || '{}'));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.write(sse({ choices: [{ delta: { reasoning_content: RESPONSE.reasoning } }] }));

    for (const piece of RESPONSE.textChunks) {
      await new Promise(r => setTimeout(r, 25));
      res.write(sse({ choices: [{ delta: { content: piece } }] }));
      state.lastChunkSentAt = Date.now();
    }

    // Hold the response open after the last content chunk. A renderer that
    // emits at end() and one that streams are only distinguishable if the
    // stream stays alive a while after the content is done.
    await new Promise(r => setTimeout(r, 250));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.write('data: [DONE]\n\n');
    res.end();
    state.serverClosedAt = Date.now();
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/coding/paas/v4`;

  const config = vscode.workspace.getConfiguration('zModels');
  await config.update('api.baseUrlOverride', baseUrl, vscode.ConfigurationTarget.Global);
  await config.update('api.endpointMode', 'zaiCoding', vscode.ConfigurationTarget.Global);

  const ext = vscode.extensions.getExtension('selfagency.z-models-vscode');
  assert.ok(ext, 'extension not found');
  if (!ext.isActive) await ext.activate();

  await vscode.commands.executeCommand('z-models-vscode.__testSeedApiKey', 'test-stub-key');
  await pickModels();
}

async function teardownZaiStub() {
  this.timeout(30000);
  await vscode.commands.executeCommand('z-models-vscode.__testClearApiKey').catch(() => {});
  const config = vscode.workspace.getConfiguration('zModels');
  await config.update('api.baseUrlOverride', undefined, vscode.ConfigurationTarget.Global);
  if (server) await new Promise(r => server.close(r));
  server = undefined;
}

/**
 * Resolve the models the way the model picker does, polling because discovery
 * is asynchronous and cached. Fails with the real state so a genuine
 * registration regression is distinguishable from a slow start.
 */
async function pickModels(predicate = () => true, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await vscode.lm.selectChatModels({ vendor: 'z' });
    if (last.length > 0 && predicate(last)) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(
    `vscode.lm.selectChatModels({vendor:'z'}) resolved nothing within ${timeoutMs}ms. ` +
      `Last result: ${JSON.stringify(last.map(m => ({ id: m.id, vendor: m.vendor })))}`,
  );
}

async function getProvider() {
  const provider = await vscode.commands.executeCommand('z-models-vscode.__testProvider');
  assert.ok(provider, 'test provider handle not available');
  return provider;
}

/** Drive a response and record every part with its arrival time. */
async function runResponse(provider) {
  const recorder = [];
  const MODEL = { id: 'glm-5.3', name: 'GLM 5.3', maxInputTokens: 1000000, maxOutputTokens: 131072 };
  await provider.provideLanguageModelChatResponse(
    MODEL,
    [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart('hi')])],
    {},
    { report: part => recorder.push({ at: Date.now(), part }) },
    new vscode.CancellationTokenSource().token,
  );
  return recorder;
}

// The shipped bundle is minified, so constructor names are unusable
// (LanguageModelTextPart -> 'ln'). Identify parts by instanceof instead.
const isText = part => part instanceof vscode.LanguageModelTextPart;
const textOf = recorder =>
  recorder
    .filter(e => isText(e.part))
    .map(e => e.part.value)
    .join('');

module.exports = {
  RESPONSE,
  state,
  setupZaiStub,
  teardownZaiStub,
  pickModels,
  getProvider,
  runResponse,
  isText,
  textOf,
};

// Root before-all / after-all, registered here so the fixtures run exactly once
// no matter how many suites import the harness. Mocha runs the TDD interface in
// this project (suite/test, not describe/it): there `setup`/`teardown` are
// beforeEach/afterEach, and the root-scope before-all is `suiteSetup`.
suiteSetup(setupZaiStub);
suiteTeardown(teardownZaiStub);