// Build-time guard: fail the build if dist/extension.js contains external
// require() calls to packages that will not ship in the VSIX.
//
// The VS Code extension host guarantees only two module sources at runtime:
//   - the 'vscode' API, and
//   - Node.js builtins.
// Everything else must be bundled into dist/extension.js (via tsup's
// 'noExternal') or shipped as a dependency. Because '.vscodeignore' excludes
// 'node_modules/**' and releases run 'vsce package --no-dependencies', any
// external require() to a third-party package silently breaks the installed
// extension with 'Cannot find module '<pkg>'' (see issues #15/#16).
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

// Node builtins, with and without the 'node:' prefix.
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// The only non-builtin module guaranteed present in the extension host.
const allowed = new Set(['vscode']);

const REQUIRE = 'require';

/**
 * Return the sorted list of external module specifiers in 'source' that are
 * neither Node builtins nor 'vscode' — i.e. packages that would not ship.
 * @param {string} source
 * @returns {string[]}
 */
export function findExternalRequires(source) {
  const found = new Set();
  let i = 0;

  while (i < source.length) {
    i = advance(source, i, found);
  }

  return [...found].sort(compareModules);
}

/**
 * Process the character at 'i' and return the index of the next character to
 * inspect. Skips whitespace, comments, and string literals; records external
 * require() module specifiers into 'found'.
 * @param {string} source
 * @param {number} i
 * @param {Set<string>} found
 * @returns {number}
 */
function advance(source, i, found) {
  const c = source[i];

  if (/\s/.test(c)) return i + 1;
  if (c === '/' && source[i + 1] === '/') return skipLineComment(source, i);
  if (c === '/' && source[i + 1] === '*') return skipBlockComment(source, i);
  if (isQuote(c)) return skipString(source, i);
  if (c === 'r' && source.startsWith(REQUIRE, i)) {
    return handleRequire(source, i, found);
  }
  return i + 1;
}

function isQuote(c) {
  return c === '"' || c === "'" || c === '`';
}

function handleRequire(source, i, found) {
  const mod = readRequireModule(source, i);
  if (mod !== null && !builtins.has(mod) && !allowed.has(mod)) {
    found.add(mod);
  }
  return mod !== null ? i + REQUIRE.length + mod.length + 4 : i + 1;
}

/** Compare two module specifiers for a deterministic, locale-independent sort. */
function compareModules(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read the module specifier of a 'require('...')' / 'require("...")' call
 * starting at 'i', or null when the call is malformed.
 * @param {string} source
 * @param {number} i
 * @returns {string | null}
 */
function readRequireModule(source, i) {
  const after = skipWhitespace(source, i + REQUIRE.length);
  if (source[after] !== '(') return null;
  const open = after + 1;
  const q = source[open];
  if (q !== '"' && q !== "'") return null;
  const close = source.indexOf(q, open + 1);
  if (close === -1) return null;
  return source.slice(open + 1, close);
}

/** Skip a line comment starting at 'i'; returns the index after the newline. */
function skipLineComment(source, i) {
  i += 2;
  while (i < source.length && source[i] !== '\n') i++;
  return i;
}

/** Skip a block comment starting at 'i'; returns the index after the close marker. */
function skipBlockComment(source, i) {
  i += 2;
  while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
  return i + 2;
}

/** Skip a string literal starting at 'i' (which points at the quote). */
function skipString(source, i) {
  const quote = source[i];
  i++;
  while (i < source.length) {
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

// Run directly: 'node scripts/check-bundle.mjs'
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(checkBundle() ? 0 : 1);
}
