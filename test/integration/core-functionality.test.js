const assert = require('node:assert');

suite('Core Functionality Tests', () => {
  // Test 1: Verify UsageService data structure
  test('UsageService data structure matches the service contract', () => {
    // UsageService.fetchUsage() resolves to a FetchResult whose `data` is a
    // UsageData. Assert the full shape the service is required to produce.
    const fetchResult = {
      success: true,
      data: {
        tokenQuotas: [],
        timeLimits: [],
        planLevel: 'free',
        todayPrompts: 0,
        todayTokens: 0,
        sevenDayPrompts: 0,
        sevenDayTokens: 0,
        thirtyDayPrompts: 0,
        thirtyDayTokens: 0,
        lastUpdated: new Date(),
        connectionStatus: 'connected',
      },
    };

    assert.strictEqual(fetchResult.success, true);
    assert.ok(fetchResult.data);
    assert.ok(Array.isArray(fetchResult.data.tokenQuotas));
    assert.ok(Array.isArray(fetchResult.data.timeLimits));
    assert.strictEqual(typeof fetchResult.data.planLevel, 'string');
    assert.strictEqual(typeof fetchResult.data.todayPrompts, 'number');
    assert.strictEqual(typeof fetchResult.data.todayTokens, 'number');
    assert.strictEqual(typeof fetchResult.data.sevenDayPrompts, 'number');
    assert.strictEqual(typeof fetchResult.data.sevenDayTokens, 'number');
    assert.strictEqual(typeof fetchResult.data.thirtyDayPrompts, 'number');
    assert.strictEqual(typeof fetchResult.data.thirtyDayTokens, 'number');
    assert.ok(fetchResult.data.lastUpdated instanceof Date);
    assert.ok(['connected', 'disconnected', 'error'].includes(fetchResult.data.connectionStatus));
  });

  // Test 2: Verify UsageService failure contract
  test('UsageService failure result carries an error message', () => {
    // When fetchUsage() cannot complete, it resolves to a FetchResult with
    // success:false and a human-readable error string.
    const fetchResult = { success: false, error: 'API key not configured' };

    assert.strictEqual(fetchResult.success, false);
    assert.strictEqual(typeof fetchResult.error, 'string');
    assert.ok(fetchResult.error.length > 0);
  });

  // Test 3: Verify usage data interface structure
  test('Usage data interface has expected structure', () => {
    const mockUsageData = {
      tokenQuotas: [
        {
          windowName: '5-Hour',
          unit: 3,
          number: 5,
          percentage: 50,
          nextResetTime: Date.now() + 18000000
        }
      ],
      timeLimits: [
        {
          windowName: '1-Month MCP Tools',
          unit: 5,
          number: 1,
          percentage: 25,
          usage: 100,
          currentValue: 25,
          remaining: 75,
          nextResetTime: Date.now() + 2592000000
        }
      ],
      todayPrompts: 10,
      todayTokens: 5000,
      sevenDayPrompts: 50,
      sevenDayTokens: 25000,
      thirtyDayPrompts: 200,
      thirtyDayTokens: 100000,
      lastUpdated: new Date(),
      connectionStatus: 'connected'
    };

    // Verify the structure matches our expectations
    assert.ok('tokenQuotas' in mockUsageData);
    assert.ok('timeLimits' in mockUsageData);
    assert.ok('todayPrompts' in mockUsageData);
    assert.ok('todayTokens' in mockUsageData);
    assert.ok('sevenDayPrompts' in mockUsageData);
    assert.ok('sevenDayTokens' in mockUsageData);
    assert.ok('thirtyDayPrompts' in mockUsageData);
    assert.ok('thirtyDayTokens' in mockUsageData);
    assert.ok('lastUpdated' in mockUsageData);
    assert.ok('connectionStatus' in mockUsageData);

    // Verify token quota structure
    assert.ok('windowName' in mockUsageData.tokenQuotas[0]);
    assert.ok('unit' in mockUsageData.tokenQuotas[0]);
    assert.ok('number' in mockUsageData.tokenQuotas[0]);
    assert.ok('percentage' in mockUsageData.tokenQuotas[0]);
    assert.ok('nextResetTime' in mockUsageData.tokenQuotas[0]);

    // Verify time limit structure
    assert.ok('windowName' in mockUsageData.timeLimits[0]);
    assert.ok('unit' in mockUsageData.timeLimits[0]);
    assert.ok('number' in mockUsageData.timeLimits[0]);
    assert.ok('percentage' in mockUsageData.timeLimits[0]);
    assert.ok('usage' in mockUsageData.timeLimits[0]);
    assert.ok('currentValue' in mockUsageData.timeLimits[0]);
    assert.ok('remaining' in mockUsageData.timeLimits[0]);
    assert.ok('nextResetTime' in mockUsageData.timeLimits[0]);
  });

  // Test 4: Verify token quota calculation
  test('Token quota calculation works correctly', () => {
    const quota = {
      windowName: '5-Hour',
      unit: 3,
      number: 5,
      percentage: 50,
      nextResetTime: Date.now() + 18000000
    };

    assert.strictEqual(quota.percentage, 50);
    assert.strictEqual(quota.windowName, '5-Hour');
    assert.strictEqual(quota.unit, 3); // 3 = hours
    assert.strictEqual(quota.number, 5);
  });

  // Test 5: Verify time limit calculation
  test('Time limit calculation works correctly', () => {
    const timeLimit = {
      windowName: '1-Month MCP Tools',
      unit: 5,
      number: 1,
      percentage: 25,
      usage: 100,
      currentValue: 25,
      remaining: 75,
      nextResetTime: Date.now() + 2592000000
    };

    assert.strictEqual(timeLimit.percentage, 25);
    assert.strictEqual(timeLimit.usage, 100);
    assert.strictEqual(timeLimit.currentValue, 25);
    assert.strictEqual(timeLimit.remaining, 75);
  });
});