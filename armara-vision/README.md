# Armara Vision

Institutional analytics and monitoring for **tokenized equities** (on-chain /
RWA equities). Tracks issuers (Ondo GM, xStocks, bStocks, Dinari, Robinhood EU,
Securitize) across Solana, Ethereum, BNB, Arbitrum and Base, with the
premium/discount vs the underlying share price as the headline metric.

## Status

Steps 1–4 of 6 in place: scaffold, schema, seed data, adapters, snapshot
cron, market overview, asset screener, asset detail (DexScreener-style
OHLCV chart + wallet trading via embedded Jupiter Terminal on Solana), and
the news panel with an "Upcoming tokenizations" section. Remaining: risk
monitor board, user-defined alert evaluation, market-hours chart shading,
EVM swap widget.

## Quick start

```bash
npm install
cp .env.example .env        # keys optional — see comments in the file
npx prisma db push          # create SQLite schema
npx prisma db seed          # issuers, ~35 assets, structure cards, events
npm run dev                 # status page at http://localhost:3000
npm run snapshot            # take one live snapshot manually
```

## Architecture

```
prisma/                     schema + seed data (issuers, assets, structure cards)
src/lib/adapters/           one module per external source, all swappable:
  http.ts                     shared fetch: TTL cache (memory + DB), per-provider
                              rate limiting, exponential backoff, stale-if-error
  coingecko.ts                token prices/mcap/volume (free tier; Pro via env key)
  geckoterminal.ts            DEX pools, liquidity, on-chain volume
  defillama.ts                issuer protocol TVL
  stocks.ts                   underlying equity quotes (Finnhub; swappable)
  rwa-xyz.ts, dune.ts         stubs with TODOs (request-only / saved-query APIs)
src/lib/metrics/            derived calculations:
  premium.ts                  premium/discount bps (±50bps flag threshold)
  tracking-error.ts           rolling stddev of token-vs-underlying returns
  slippage.ts                 $100k / $1M order slippage estimate from AMM liquidity
  market-hours.ts             NYSE session check (off-hours price discovery flag)
src/lib/snapshot.ts         hourly job → AssetSnapshot / PoolSnapshot /
                            IssuerSnapshot / SupplyEvent (our own time series)
src/app/api/cron/snapshot   scheduler endpoint (Vercel cron wired in vercel.json;
                            CRON_SECRET-protected)
src/app/                    UI (Next.js App Router, Tailwind, dark terminal theme)
```

### Degradation policy

Every adapter response carries `{asOf, stale}` provenance. If a provider is
down or rate-limited, the HTTP layer serves the last cached payload (marked
stale), and the UI falls back to the latest stored snapshot with an explicit
"as of" timestamp — never a blank screen.

### Database

SQLite via Prisma by default; switch `provider` in `prisma/schema.prisma` to
`postgresql` and update `DATABASE_URL` for production.
