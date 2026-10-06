'use strict';
// The model-picker path, exercised through the same API the Copilot Chat UI uses.
//
// test/integration/streaming.test.js drives the provider directly, proving the
// transport and the renderer. This file goes one layer out and asks VS Code for
// the models the way the picker does, then sends a request the way the chat view
// does:
//
//   vscode.lm.selectChatModels({ vendor: 'z' })   -> what the picker lists
//   model.sendRequest(messages, options, token)   -> what the chat view sends
//
// This covers the listing half of the picker: what VS Code resolves from our
// registration, with the metadata the picker renders. That is enough to catch a
// broken registration or a wrong LanguageModelChatInformation shape before a
// user does.
//
// Boundary, established by measurement rather than assumption:
//
//   vscode.lm.selectChatModels({vendor:'z'})  -> our models, no auth needed.
//   model.sendRequest(...)                     -> does NOT reach our provider.
//   Copilot Chat UI                            -> needs a signed-in session.
//
// sendRequest routes through Copilot Chat's own authenticated harness rather
// than dispatching to the contributed provider directly. With no GitHub session
// in CI it resolves without reaching the stub, so a test asserting on it would
// be asserting on the workbench, not on this extension. Asserting the rendered
// webview needs Playwright against the Electron DOM with a signed-in profile.

const assert = require('assert');
const vscode = require('vscode');
const {
  RESPONSE,
  state,
  pickModels,
  getProvider,
} = require('./harness');

suite('Model picker path', () => {
  test('the picker resolves Z.ai models for vendor "z"', async function () {
    this.timeout(30000);
    const models = await pickModels();
    const ids = models.map(m => m.id);
    assert.ok(ids.includes('glm-5.3'), `glm-5.3 missing from ${JSON.stringify(ids)}`);
    assert.ok(
      ids.includes('glm-5.3-flash'),
      `glm-5.3-flash missing from ${JSON.stringify(ids)}`,
    );
  });

  test('models carry the metadata the picker displays', async function () {
    this.timeout(30000);
    const models = await pickModels(m => m.some(x => x.id === 'glm-5.3-flash'));
    const flash = models.find(m => m.id === 'glm-5.3-flash');
    assert.ok(flash, 'glm-5.3-flash missing from the picker');

    // The picker renders name/family and the chat view reserves maxInputTokens.
    // A wrong value here is the #12/#21 class of bug: silently 32K.
    assert.ok(flash.name, 'model has no display name');
    assert.ok(flash.family, 'model has no family, so the picker cannot group it');
    assert.strictEqual(
      flash.maxInputTokens,
      1_000_000,
      `picker reports ${flash.maxInputTokens} input tokens for glm-5.3-flash, expected 1000000`,
    );
    assert.strictEqual(flash.vendor, 'z', `model reports vendor ${flash.vendor}, expected z`);
    // maxOutputTokens is deliberately not asserted: VS Code's picker proxy does
    // not surface it (verified against 1.140). Only maxInputTokens, family,
    // vendor and the capability flags cross that boundary.
  });

  // The in-memory half of this - ApiKeyManager caching a key that a raw secret
  // delete leaves behind - is proven in src/tests/provider/clear-api-key.test.ts,
  // because it is invisible from here: every observable path reports "no key"
  // either way.
  test('clearing the key stops the provider advertising models', async function () {
    this.timeout(30000);
    const provider = await getProvider();
    await pickModels();

    await vscode.commands.executeCommand('z-models-vscode.__testClearApiKey');

    // Asserted against the provider, not vscode.lm. VS Code caches a vendor's
    // catalog and its own refresh timing is not something a test can pin, so a
    // picker-level emptiness check would be testing the workbench rather than
    // this extension. What matters is that the provider stops advertising models
    // and stops sending.
    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true },
      new vscode.CancellationTokenSource().token,
    );
    assert.deepStrictEqual(
      infos.map(m => m.id),
      [],
      `provider still advertises ${JSON.stringify(infos.map(m => m.id))} after the key was cleared`,
    );

    // And the provider must refuse rather than quietly send with the deleted key.
    await assert.rejects(
      provider.provideLanguageModelChatResponse(
        { id: 'glm-5.3', name: 'GLM 5.3', maxInputTokens: 1000, maxOutputTokens: 1000 },
        [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart('hi')])],
        {},
        { report() {} },
        new vscode.CancellationTokenSource().token,
      ),
      /API key/i,
      'provider still accepted a request with no API key',
    );
  });
});