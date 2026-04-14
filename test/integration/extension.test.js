'use strict';
const assert = require('assert');
const vscode = require('vscode');

suite('Extension Integration', () => {
  let ext;

  suiteSetup(async () => {
    // The activation event ('onLanguageModelChatProvider:z') doesn't fire
    // automatically in the test harness, so force-activate the extension.
    ext = vscode.extensions.getExtension('selfagency.z-models-vscode');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
  });

  test('extension is available and active', async () => {
    assert.ok(ext, 'extension not found');
    assert.ok(ext.isActive, 'extension not active');
  });

  test('manageApiKey command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('z-chat.manageApiKey'),
      'z-chat.manageApiKey command not registered'
    );
  });

  test('manageSettings command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('z-chat.manageSettings'),
      'z-chat.manageSettings command not registered'
    );
  });
});
