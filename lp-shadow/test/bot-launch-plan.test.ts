import { describe, expect, it } from 'vitest';
import { planInitialLiquidityForLaunch } from '../src/service/launchPlanning.js';
import { createFakeService, createHarness } from './helpers/botHarness.js';

describe('/launchplan read-only onboarding', () => {
  it('collects founder inputs and renders the permanent initial-liquidity plan', async () => {
    const service = createFakeService({
      planInitialLiquidity: async (input) => planInitialLiquidityForLaunch(input),
    });
    const harness = createHarness(service);

    await harness.send('/launchplan');
    expect(harness.texts().at(-1)).toContain('Nothing will launch, sign, or move funds');

    await harness.send('10000000 132 1000000000 6 75.89');
    const result = harness.texts().at(-1) ?? '';
    expect(result).toContain('Initial liquidity plan — read only');
    expect(result).toContain('SPOT / 69 funded bins');
    expect(result).toContain('DLMM_STANDARD_DUAL_SIDED');
    expect(result).toContain('0.0000131782698211 SOL/token');
    expect(result).toContain('Known SDK account rent');
    expect(result).toContain('Buyer capacity from this position only');
    expect(result).toContain('Founder withdrawal remains available');
  });

  it('keeps the prompt active after malformed input and supports cancel', async () => {
    const service = createFakeService({
      planInitialLiquidity: async (input) => planInitialLiquidityForLaunch(input),
    });
    const harness = createHarness(service);

    await harness.send('/launchplan');
    await harness.send('10000000 132 missing');
    expect(harness.texts().at(-1)).toContain('exactly five positive values');
    expect(service.calls.map((call) => call.method)).not.toContain('planInitialLiquidity');

    await harness.send('/cancel');
    expect(harness.texts().at(-1)).toBe('Cancelled.');
    await harness.send('10000000 132 1000000000 6 75.89');
    expect(service.calls.map((call) => call.method)).not.toContain('planInitialLiquidity');
  });
});
