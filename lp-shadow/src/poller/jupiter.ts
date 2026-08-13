/**
 * Jupiter: a price cross-check and a live quote for the hypothetical rebalance
 * swap leg.
 *
 * Verified 2026-08:
 *   Price v3  GET {base}/price/v3?ids=<mint>[,<mint>]
 *             -> { "<mint>": { usdPrice, blockId, decimals, priceChange24h } }
 *   Quote     GET {base}/swap/v1/quote?inputMint&outputMint&amount&slippageBps
 *             -> { inAmount, outAmount, priceImpactPct, slippageBps, routePlan, ... }
 *
 * Free host is https://lite-api.jup.ag; the keyed host is https://api.jup.ag and
 * is used automatically when JUPITER_API_KEY is set. Only the /quote endpoint is
 * called — never /swap, which is what builds a transaction.
 */
import { fetchJson } from './http.js';

const FREE_BASE = 'https://lite-api.jup.ag';
const KEYED_BASE = 'https://api.jup.ag';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

function base(): string {
  const explicit = process.env.JUPITER_API_BASE;
  if (explicit) return explicit;
  return process.env.JUPITER_API_KEY ? KEYED_BASE : FREE_BASE;
}

function headers(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY;
  return key ? { 'x-api-key': key } : {};
}

type PriceV3Entry = { usdPrice?: number; decimals?: number; blockId?: number };

export async function fetchUsdPrices(mints: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(mints)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const url = `${base()}/price/v3?ids=${unique.join(',')}`;
  const body = await fetchJson<Record<string, PriceV3Entry | null>>(url, {
    headers: headers(),
    timeoutMs: 8_000,
  });
  const out = new Map<string, number>();
  for (const [mint, entry] of Object.entries(body)) {
    if (entry?.usdPrice !== undefined && Number.isFinite(entry.usdPrice)) {
      out.set(mint, entry.usdPrice);
    }
  }
  return out;
}

export type QuoteResult = {
  inAmount: number;
  outAmount: number;
  /** Fraction, e.g. 0.0042 for 0.42%. */
  priceImpactPct: number | null;
  routeLabels: string[];
};

type QuoteResponse = {
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string;
  routePlan?: { swapInfo?: { label?: string } }[];
};

/**
 * Quote for the hypothetical swap leg of a rebalance. Nothing is executed; the
 * numbers exist only to price the decision.
 */
export async function fetchQuote(args: {
  inputMint: string;
  outputMint: string;
  /** Raw units of the input mint (already scaled by its decimals). */
  amount: number;
  slippageBps: number;
}): Promise<QuoteResult> {
  const amount = Math.max(1, Math.round(args.amount));
  const params = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: String(amount),
    slippageBps: String(args.slippageBps),
    swapMode: 'ExactIn',
    restrictIntermediateTokens: 'true',
  });
  const body = await fetchJson<QuoteResponse>(`${base()}/swap/v1/quote?${params}`, {
    headers: headers(),
    timeoutMs: 10_000,
  });

  const impact = body.priceImpactPct === undefined ? NaN : Number(body.priceImpactPct);
  return {
    inAmount: Number(body.inAmount),
    outAmount: Number(body.outAmount),
    priceImpactPct: Number.isFinite(impact) ? impact : null,
    routeLabels: (body.routePlan ?? []).map((step) => step.swapInfo?.label ?? '?'),
  };
}
