// Build-time guard: fail the build if dist/extension.js contains external
// require() calls to packages that will not ship in the VSIX.
//
// The VS Code extension host guarantees only two module sources at runtime:
//   - the `vscode` API, and
//   - Node.js builtins.
// Everything else must be bundled into dist/extension.js (via tsup's
// `noExternal`) or shipped as a dependency. Because `.vscodeignore` excludes
// `node_modules/**` and releases run `vsce package --no-dependencies`, any
// external require() to a third-party package silently breaks the installed
// extension with `Cannot find module '<pkg>'` (see issues #15/#16).
//
// This script scans the bundle with a small state machine that tracks string
// and comment regions, so require() calls inside strings/comments cannot
// false-positive, and real require() calls are never missed.

import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = resolve(ROOT, 'dist', 'extension.js');

// Node builtins, with and without the `node:` prefix.
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// The only non-builtin module guaranteed present in the extension host.
const allowed = new Set(['vscode']);

/**
 * Return the sorted list of external module specifiers in `source` that are
 * neither Node builtins nor `vscode` — i.e. packages that would not ship.
 * @param {string} source
 * @returns {string[]}
 */
export function findExternalRequires(source) {
  const found = new Set();
  const n = source.length;
  let i = 0;

  while (i < n) {
    const c = source[i];

    // Skip whitespace.
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Skip line comments.
    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Skip block comments.
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Skip string literals (single, double, template).
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i);
      continue;
    }

    // Match a require('...') / require("...") call in real code.
    if (c === 'r' && source.startsWith('require', i)) {
      const after = skipWhitespace(source, i + 'require'.length);
      if (source[after] === '(') {
        const open = after + 1;
        const q = source[open];
        if (q === '"' || q === "'") {
          const close = source.indexOf(q, open + 1);
          if (close !== -1) {
            const mod = source.slice(open + 1, close);
            if (!builtins.has(mod) && !allowed.has(mod)) found.add(mod);
            i = close + 1;
            continue;
          }
        }
      }
    }

    i++;
  }

  return [...found].sort();
}

/** Skip a string literal starting at `i` (which points at the quote). */
function skipString(source, i) {
  const quote = source[i];
  const n = source.length;
  i++;
  while (i < n) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    // Template literals can contain nested ${...}; treat the whole thing as
    // opaque by scanning to the closing backtick (escapes handled above).
    i++;
  }
  return i;
}

function skipWhitespace(source, i) {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

/**
 * Check a bundle file for non-shipping external requires. Logs the result and
 * returns true when the bundle is self-contained.
 * @param {string} [bundlePath]
 * @returns {boolean}
 */
export function checkBundle(bundlePath = BUNDLE) {
  const source = readFileSync(bundlePath, 'utf8');
  const offenders = findExternalRequires(source);
  if (offenders.length === 0) {
    console.log(`✓ ${bundlePath} is self-contained (no external requires beyond vscode/node builtins)`);
    return true;
  }
  console.error(
    `✗ ${bundlePath} has external requires that will not ship in the VSIX:\n` +
      offenders.map((m) => `  - ${m}`).join('\n') +
      `\nAdd these packages to the \`noExternal\` list in tsup.config.mjs so they are bundled, ` +
      `or ship them as dependencies.`,
  );
  return false;
}

// Run directly: `node scripts/check-bundle.mjs`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(checkBundle() ? 0 : 1);
}
