// Underlying-equity price adapter. Finnhub chosen for the free tier
// (60 calls/min, real-time-ish US quotes) — vs Alpha Vantage's 25 req/day.
// Swappable: implement EquityPriceAdapter with another provider (Polygon,
// Alpha Vantage) and change the export at the bottom.
import { fetchJsonCached } from "./http";
import type { EquityPriceAdapter, EquityQuote, Sourced } from "./types";

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const BASE = "https://finnhub.io/api/v1";
const TTL_MS = 60_000; // prices: 60s per NFR
const MIN_INTERVAL_MS = 1100; // ~55/min, under the 60/min free cap

interface FinnhubQuote {
  c: number; // current price
  pc: number; // previous close
  dp: number | null; // percent change
  t: number; // unix seconds of quote
}

export const finnhub: EquityPriceAdapter = {
  async getQuote(ticker: string): Promise<Sourced<EquityQuote>> {
    if (!FINNHUB_KEY) {
      // No key configured: degrade gracefully — caller falls back to the
      // latest snapshot's underlying price.
      return {
        data: { ticker, priceUsd: null, previousClose: null, changePct: null, quotedAt: null },
        asOf: new Date(),
        stale: true,
        provider: "finnhub",
      };
    }
    const url = `${BASE}/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`;
    const hit = await fetchJsonCached<FinnhubQuote>(url, {
      provider: "finnhub",
      ttlMs: TTL_MS,
      minIntervalMs: MIN_INTERVAL_MS,
    });
    const q = hit.data;
    return {
      data: {
        ticker,
        priceUsd: q.c > 0 ? q.c : null, // Finnhub returns 0 for unknown symbols
        previousClose: q.pc > 0 ? q.pc : null,
        changePct: q.dp,
        quotedAt: q.t ? new Date(q.t * 1000) : null,
      },
      asOf: hit.asOf,
      stale: hit.stale,
      provider: "finnhub",
    };
  },
};

export const equityPrices: EquityPriceAdapter = finnhub;
