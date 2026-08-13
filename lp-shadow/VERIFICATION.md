# Upstream verification log

Spec §15.1 says not to code against remembered URLs. This is what was checked,
when, and how. Re-verify before trusting any of it — these endpoints have
migrated before.

**Verified: 2026-08-13.**

## `@meteora-ag/dlmm`

- Latest published version: **1.9.14** (npm registry, `dist-tags.latest`). Pinned
  exactly in `package.json` because the constants below come out of it.
- Package name confirmed as `@meteora-ag/dlmm`. `@meteora-ag/dlmm-sdk` and
  `@meteora-ag/dlmm-sdk-public` are older lines and were **not** used.
- The ESM build (`dist/index.mjs`) contains a bare directory import into
  `@coral-xyz/anchor/dist/cjs/utils/bytes` that Node refuses to resolve. The CJS
  build works, so `src/poller/dlmmSdk.ts` loads it through `createRequire`.
  `module.exports` there is the `DLMM` class with every named export attached as
  a property.

### Constants read out of the SDK (§15.2), not hardcoded

Read at runtime by `src/poller/sdkConstants.ts`:

| Export | Value in 1.9.14 | Used for |
| --- | --- | --- |
| `DEFAULT_BIN_PER_POSITION` | 70 | bins in a **classic** position — the ceiling `position.max_total_bins` is validated against |
| `MAX_BINS_PER_POSITION` | 1400 | bins in an **extended** position; not used by Phase 1 |
| `MAX_BIN_ARRAY_SIZE` | 70 | bins per bin-array account |
| `BIN_ARRAY_FEE` | 0.07143744 SOL | rent for one bin array — **sunk**, charged on rebalance |
| `POSITION_FEE` | 0.05740608 SOL | rent for a position account — refundable, so it nets to 0 |
| `TOKEN_ACCOUNT_FEE` | 0.00203928 SOL | — |
| `BIN_ARRAY_BITMAP_FEE` | 0.01180416 SOL | — |

Note the spec assumed ~70 was the hard maximum. In 1.9.14 that is the classic
single-position limit; extended positions reach 1400. Phase 1 models one classic
position, so `config/default.toml` keeps `max_total_bins = 69` and `toParams`
rejects anything above 70.

Other SDK behaviour confirmed by reading `dist/index.d.ts` and `dist/index.mjs`:

- `DLMM.create(connection, poolAddress, opt?)` — takes no wallet.
- `getActiveBin()` returns `BinLiquidity` with `pricePerToken` (real price) and
  `price` (per-lamport).
- `getDynamicFee()` returns the **total** fee (base + variable) as a percentage,
  not just the variable part — so `feeBps = getDynamicFee() * 100`.
- `calculateSpotDistribution(activeBin, binIds)` gives uniform
  `xAmountBpsOfTotal` above the active bin and uniform `yAmountBpsOfTotal` below,
  with the active bin taking a half share of each. `test/engine.test.ts`
  cross-checks `distributeSpot` against it.

## Meteora DLMM public API

- Base: `https://dlmm.datapi.meteora.ag` (rate limit 30 rps). The older
  `dlmm-api.meteora.ag` host is the previous generation. Overridable via
  `METEORA_API_BASE`.
- `GET /pools/{address}` returns, among other fields:
  `tvl`, `current_price`, `apr`, `volume.{30m,1h,2h,4h,12h,24h}`,
  `fees.{...}`, `protocol_fees.{...}`, `fee_tvl_ratio.{...}`,
  `cumulative_metrics.{volume,trade_fee,protocol_fee}`,
  `pool_config.{bin_step,base_fee_pct,max_fee_pct,protocol_fee_pct}`,
  `token_x`/`token_y` objects.
- `cumulative_metrics.trade_fee` is the lifetime counter the per-interval fee
  cursor deltas against.

## Jupiter

- Free host `https://lite-api.jup.ag`; keyed host `https://api.jup.ag` (used
  automatically when `JUPITER_API_KEY` is set). Overridable via
  `JUPITER_API_BASE`.
- Price: `GET /price/v3?ids=<mint>[,<mint>]` →
  `{ "<mint>": { usdPrice, blockId, decimals, priceChange24h } }`.
- Quote: `GET /swap/v1/quote?inputMint&outputMint&amount&slippageBps&swapMode`
  → `{ inAmount, outAmount, otherAmountThreshold, priceImpactPct, slippageBps,
  routePlan, ... }` (confirmed against `jup-ag/jupiter-quote-api-node`'s
  `swagger.yaml`).
- Only `/quote` is called. `/swap`, the endpoint that builds a transaction, is
  never called from anywhere in this repo.

## Helius priority fees

- JSON-RPC method `getPriorityFeeEstimate`, served on the same RPC URL, with
  params `[{ accountKeys: [...], options: { priorityLevel, recommended } }]` and
  a `priorityFeeEstimate` result in micro-lamports per compute unit.
  `priorityLevel` accepts `Min | Low | Medium | High | VeryHigh`; Phase 1 uses
  `Medium`.
- Fallback for non-Helius RPCs: standard `getRecentPrioritizationFees`, median
  of the returned samples. If both fail, a deliberately non-zero constant is
  used so a broken endpoint never makes rebalancing look free.

## What could not be verified from this environment

Network egress here is restricted: `docs.meteora.ag`, `dlmm.datapi.meteora.ag`,
`lite-api.jup.ag` and `api.jup.ag` all return 403 at the egress proxy, so the
live endpoints were **not** called end-to-end. Field names and paths above come
from documentation and from published client libraries, not from a live
response. The npm registry and `raw.githubusercontent.com` were reachable, so
the SDK facts are first-hand.

Before the first real run, do one manual check per endpoint:

```sh
curl -s "https://dlmm.datapi.meteora.ag/pools/<POOL>" | jq '{tvl, current_price, volume, fees, cumulative_metrics, pool_config}'
curl -s "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112"
curl -s "https://lite-api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=1000000000&slippageBps=50" | jq '{inAmount, outAmount, priceImpactPct}'
curl -s -X POST "$RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getPriorityFeeEstimate","params":[{"accountKeys":["<POOL>"],"options":{"priorityLevel":"Medium","recommended":true}}]}'
```

If a shape has moved, the poller modules are the only files that need editing —
the pure layer never sees an API response.
