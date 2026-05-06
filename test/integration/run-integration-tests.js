#!/usr/bin/env node

// Simple integration test runner
const { execSync } = require('child_process');
const path = require('path');

console.log('Running integration tests...\n');

try {
  // Run integration tests with a custom config that includes them
  const result = execSync(
    'npx vitest run test/integration/core-functionality.test.js --config vitest.integration.config.js',
    {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'inherit'
    }
  );

  console.log('\n✅ All integration tests passed!');
  process.exit(0);
} catch (error) {
  console.error('\n❌ Integration tests failed:', error.message);
  process.exit(1);
}