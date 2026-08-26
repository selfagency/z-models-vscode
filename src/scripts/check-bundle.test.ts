import { describe, expect, it } from 'vitest';
import { findExternalRequires } from '../../scripts/check-bundle.mjs';

describe('findExternalRequires', () => {
  it('returns no offenders for a self-contained bundle', () => {
    const src = `
      const vscode = require('vscode');
      const fs = require('node:fs');
      const path = require('path');
      const stream = require('stream/promises');
    `;
    expect(findExternalRequires(src)).toEqual([]);
  });

  it('flags third-party packages that would not ship', () => {
    const src = `require('@agentsy/core'); require('got');`;
    expect(findExternalRequires(src)).toEqual(['@agentsy/core', 'got']);
  });

  it('ignores require calls inside string literals and comments', () => {
    const src = `
      const a = "require('@agentsy/core')";
      const b = 'require("got")';
      const c = \`require('tiktoken')\`;
      // require('@agentsy/providers')
      /* require('@agentsy/types') */
      const url = "https://example.com/require('x')";
    `;
    expect(findExternalRequires(src)).toEqual([]);
  });

  it('deduplicates and sorts offenders', () => {
    const src = `require('got'); require('@agentsy/core'); require('got');`;
    expect(findExternalRequires(src)).toEqual(['@agentsy/core', 'got']);
  });

  it('does not flag node builtins with or without the node: prefix', () => {
    const src = `require('fs'); require('node:fs'); require('crypto'); require('node:crypto');`;
    expect(findExternalRequires(src)).toEqual([]);
  });
});
