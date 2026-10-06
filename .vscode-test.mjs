import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test/integration/**/*.test.js',
  // --disable-extensions is deliberately NOT set. vscode.lm.selectChatModels()
  // is how the model picker discovers contributed models, and with extensions
  // disabled it resolves our vendor to nothing, so the tests that cover the
  // picker path cannot see any Z.ai model. Copilot Chat itself activates but
  // stays unauthenticated in CI, which is fine: these tests supply the model
  // from our own provider, so no GitHub session is required.
  launchArgs: ['--disable-workspace-trust', '--skip-release-notes', '--skip-welcome'],
});
