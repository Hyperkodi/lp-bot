/** Harness self-check: prove synthetic updates actually reach the handlers. */
import { describe, expect, it } from 'vitest';
import { createFakeService, createHarness } from './helpers/botHarness.js';

describe('bot harness', () => {
  it('routes a command to its handler and captures the reply', async () => {
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/pools');

    expect(service.calls.map((c) => c.method)).toContain('listPools');
    expect(harness.texts().join('\n')).toContain('SOL-USDC');
    expect(harness.lastMessage()?.parse_mode).toBe('HTML');
  });
});
