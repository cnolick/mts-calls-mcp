import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSessionMaintenance } from '../src/session-maintenance.mjs';

test('idle maintenance starts immediately, avoids overlapping refresh, and stops on shutdown', async () => {
  let calls = 0, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const maintenance = startSessionMaintenance({ refresh: async () => { calls++; await pending; } });
  try {
    assert.equal(calls, 1);
    await maintenance.tick();
    assert.equal(calls, 1);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    await maintenance.tick();
    assert.equal(calls, 2);
    maintenance.close();
    await maintenance.tick();
    assert.equal(calls, 2);
  } finally { finish(); maintenance.close(); }
});

test('upstream refresh failure reports no exception data and allows the next retry', async () => {
  let calls = 0, errors = 0;
  const maintenance = startSessionMaintenance({ refresh: async () => { if (++calls === 1) throw new Error('private credentials'); }, onError: (...args) => { assert.equal(args.length, 0); errors++; } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors, 1);
    await maintenance.tick();
    assert.equal(calls, 2);
    assert.equal(errors, 1);
  } finally { maintenance.close(); }
});
