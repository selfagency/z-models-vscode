import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsup';

const production = process.env.NODE_ENV === 'production'

export default defineConfig({
  entry: ['src/extension.ts', 'src/provider.ts'],
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  external: ['vscode'],
  noExternal: ['tiktoken', '@selfagency/llm-stream-parser'],
  // llm-stream-parser ships ESM-only subpath exports; resolve them to CJS via bundling
  bundle: true,
  sourcemap: !production,
  minify: production,
  clean: true,
  esbuildOptions(options) {
    options.sourcesContent = false
  },
  esbuildPlugins: [
    {
      name: 'copy-tiktoken',
      setup(build) {
        build.onEnd(() => {
          const sourcePath = path.join('node_modules', 'tiktoken', 'tiktoken_bg.wasm')
          const destPath = path.join('dist', 'tiktoken_bg.wasm')
          if (fs.existsSync(sourcePath)) {
            try {
              fs.copyFileSync(sourcePath, destPath)
              console.log('Copied tiktoken_bg.wasm to dist/')
            } catch (err) {
              console.warn('Failed to copy tiktoken_bg.wasm:', err.message)
            }
          }
        })
      },
    },
  ],
})
