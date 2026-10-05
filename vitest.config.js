import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'src/test/vscode.mock.ts'),
    },
  },
  test: {
    environment: 'node',
    restoreMocks: true,
    exclude: [
      'node_modules/**',
      '.opencode/**',
      '.cortexkit/**',
      // Downloaded VS Code binary; gitignored, but its internal scripts are
      // still on disk and vitest tries to collect them.
      '.vscode-test/**',
      'dist/**',
      'out/**',
      'scripts/**',
      'test/integration/**',
    ],
  },
})
