/**
 * The quote client's failure behaviour.
 *
 * A quote that comes back malformed must FAIL, not return NaN. The distinction
 * matters because the caller already handles a failed quote gracefully — it
 * falls back to pricing the swap pessimistically — whereas a NaN propagates
 * into the cost estimate, makes every comparison against it false, and
 * silently disables rebalancing for the life of the run while the logs stay
 * clean.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../src/poller/http.js', () => ({ fetchJson: (...args: unknown[]) => fetchJson(...args) }));

const { fetchQuote } = await import('../src/poller/jupiter.js');

const args = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: 1_000_000_000,
  slippageBps: 50,
};

afterEach(() => {
  fetchJson.mockReset();
});

describe('fetchQuote', () => {
  it('parses a healthy quote', async () => {
    fetchJson.mockResolvedValueOnce({
      inAmount: '1000000000',
      outAmount: '33300000',
      priceImpactPct: '0.0006',
      routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }],
    });

    const quote = await fetchQuote(args);

    expect(quote.inAmount).toBe(1_000_000_000);
    expect(quote.outAmount).toBe(33_300_000);
    expect(quote.priceImpactPct).toBeCloseTo(0.0006);
    expect(quote.routeLabels).toEqual(['Meteora DLMM']);
  });

  it('still succeeds when only the price impact is unusable', async () => {
    // priceImpactPct has a documented null fallback in the cost estimator, so
    // a missing one is not a reason to discard an otherwise valid quote.
    fetchJson.mockResolvedValueOnce({
      inAmount: '1000000000',
      outAmount: '33300000',
      priceImpactPct: 'not-a-number',
    });

    const quote = await fetchQuote(args);

    expect(quote.priceImpactPct).toBeNull();
    expect(quote.outAmount).toBe(33_300_000);
  });

  it.each([
    ['missing outAmount', { inAmount: '1000000000' }],
    ['non-numeric outAmount', { inAmount: '1000000000', outAmount: 'lots' }],
    ['zero outAmount', { inAmount: '1000000000', outAmount: '0' }],
    ['negative outAmount', { inAmount: '1000000000', outAmount: '-5' }],
    ['missing inAmount', { outAmount: '33300000' }],
    ['non-numeric inAmount', { inAmount: 'some', outAmount: '33300000' }],
    ['zero inAmount', { inAmount: '0', outAmount: '33300000' }],
  ])('throws rather than returning NaN when the response has %s', async (_label, body) => {
    fetchJson.mockResolvedValueOnce(body);
    await expect(fetchQuote(args)).rejects.toThrow(/unusable (in|out)Amount/);
  });

  it('never resolves with a non-finite amount for any malformed body', async () => {
    // The property that actually matters downstream, stated directly.
    for (const body of [
      { inAmount: 'x', outAmount: 'y' },
      { inAmount: null, outAmount: null },
      {},
      { inAmount: '1000000000', outAmount: 'NaN' },
    ]) {
      fetchJson.mockResolvedValueOnce(body);
      const result = await fetchQuote(args).catch(() => null);
      if (result !== null) {
        expect(Number.isFinite(result.inAmount)).toBe(true);
        expect(Number.isFinite(result.outAmount)).toBe(true);
      }
    }
  });
});
