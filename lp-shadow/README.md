# lp-shadow — Phase 1

A read-only "shadow mode" agent for one Meteora DLMM pool on Solana. It runs the
full decision loop of a concentrated-liquidity LP strategy — polling pool state,
computing signals, deciding `HOLD / COMPOUND / REBALANCE / EXIT` — and **never
signs or sends a transaction**. Every decision is logged with its reasoning and a
live cost estimate, and a virtual position is simulated so the strategy's P&L can
be scored against benchmarks.

The output of Phase 1 is **evidence**, not yield: does this strategy beat just
holding the tokens, net of realistic costs?

```
net = fees_earned − (HODL_value − LP_value) − rebalance_costs
```

Fee APR alone is not the objective. Time-in-range alone is not the objective.

## No keys, by construction

There is no wallet, keypair, mnemonic, or signing code anywhere in this repo —
not even behind a flag. Three things keep it that way:

- `.env.example` has no key variable, and `src/config.ts` would reject one.
- ESLint fails the build on any import of `keypair`, `bip39`, `ed25519-hd-key`,
  or `@solana/wallet-*` (`eslint.config.js`).
- The only Jupiter endpoint called is `/quote`. `/swap`, which builds a
  transaction, is never called.

## Architecture

```
src/
  index.ts              main loop: poll → signals → decide → apply-virtually → persist
  config.ts             TOML + env, validated with zod, flattened into one Params object
  types.ts              PoolSnapshot, VirtualPosition, Signals, Decision, CostEstimate…
  binMath.ts            geometric bin pricing + the range-width rule        [PURE]
  clock.ts              the only module that reads wall-clock time zones
  poller/               ALL network I/O: DLMM SDK, Meteora API, Jupiter, priority fees
  signals/              EWMA realized vol, settle flag, regime detection    [PURE]
  decision/             the engine and the cost estimator                   [PURE]
  virtual/              the simulated position and the benchmarks           [PURE]
  ledger/               every database write; registry.ts owns tenants/pools/strategy
  report/               daily Telegram report and the go-live gate
  replay/               re-run the engine over stored snapshots
```

**Multi-tenant.** A `Tenant` (identity imported from a parent bot, never
established here) owns `ManagedPool` rows. Every observation and decision is
scoped to a pool, so two pools cannot contaminate each other's evidence. One
canonical `StrategyVersion` runs across all of them — stamped on every decision,
so pools can be migrated to a new version without destroying the track record —
while position size stays per pool, because size changes the answer. See
`docs/PHASE_1_5_MULTI_TENANT.md`.

**The architectural rule:** `decision/`, `virtual/`, `signals/` and `binMath.ts`
are pure and synchronous — same inputs, same outputs, no clock reads, no network.
That is what makes the replay harness trustworthy, and it is enforced by an
ESLint boundary rule rather than left to discipline. Try importing `poller/` from
`decision/` and `pnpm lint` fails.

## Setup

```sh
pnpm install
cp .env.example .env          # fill in DATABASE_URL and RPC_URL
pnpm prisma:generate
pnpm prisma:migrate           # `prisma migrate deploy` — runs clean on a fresh Postgres
```

Pools are rows, not config. `config/default.toml` seeds the canonical strategy on
first boot; the pools to shadow are registered through `src/ledger/registry.ts`
(and, later, the bot layer):

```ts
const tenant = await upsertTenant(prisma, {
  externalUserId: '...',        // from the parent bot
  telegramChatId: '...',
  label: 'Some Project',
});
const strategy = await publishStrategyVersion(prisma, params, 'initial');
await addManagedPool(prisma, {
  tenantId: tenant.id,
  strategyVersionId: strategy.id,
  poolAddress: '...',
  label: 'SOL-USDC',
  virtualNavUsd: 10_000,        // the size this project would actually deploy
});
```

To find a pool:

```sh
curl -s 'https://dlmm.datapi.meteora.ag/pools?search=SOL-USDC&sort_key=tvl&order_by=desc&limit=5' \
  | jq '.data[] | {address, name, tvl, bin_step: .pool_config.bin_step}'
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | run the shadow loop against the configured pool |
| `pnpm test` | vitest; the loop integration tests skip themselves without `DATABASE_URL` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint, including the purity boundary rule |
| `pnpm replay --from 2026-08-01 --params ./config/sweep.toml [--pool <id>]` | re-run the engine over one pool's stored snapshots with alternate params |
| `pnpm report --print-only [--pool <id>]` | build the daily report on demand |
| `pnpm exec tsx scripts/seed-synthetic.ts --hours 48 --wipe` | fill a scratch database with synthetic snapshots to smoke-test the pipeline |

## How the strategy decides

Gates are evaluated in order; first match wins. Every gate's pass/fail lands in
`Decision.reasons`, so any non-HOLD decision is explainable from that array
alone.

1. **EXIT** — 24h volume/TVL under `exit.vol_tvl_floor` continuously for
   `exit.vol_tvl_dwell_hours`. Missing pool stats never start the clock.
2. **REBALANCE** — all five must hold: price out of range; out of range for
   `oor_dwell_min`; past the nearest edge by `edge_overshoot_pct`; price
   `settled` (do not rebalance into a trend); and projected 7-day fee recapture
   at least `cost_coverage_multiple` × the live cost estimate.
3. **COMPOUND** — in range, and pending fees clear
   `max(min_fees_usd, min_fees_pct_nav × NAV)`.
4. **HOLD** — with a note on which gates came closest.

**Range width** comes from *slow* vol: `half-width = width_k × σ_slow/√365`,
converted to bins and clamped to `[min_total_bins, max_total_bins]`. Fast vol is
only used for the `settled` flag and regime detection. Widening in chop and
narrowing in quiet falls out of this without a separate rule.

## What the simulation does and does not model

Honest about its approximations, because the point of Phase 1 is evidence:

- **Per-bin inventory is tracked.** When the active bin crosses bin *i*, bin
  *i*'s inventory converts at *bin i's own price*, not at the market price. That
  is the actual DLMM mechanic, and it is where impermanent loss comes from.
- **Fees are approximated.** DLMM pays only the active bin, so the simulation
  takes `ourLiq / (poolActiveBinLiq + ourLiq)` of the interval's pool fees. The
  interval fee figure is a delta of the pool's lifetime `trade_fee` counter (or,
  when that is unavailable, a pro-rata slice of `fees.24h`) — not a per-bin
  fee-growth read on chain. Fine for scoring a strategy; not a substitute for
  reconciling a real position.
- **Costs come from live quotes.** The swap cost is the gap between the notional
  in and the router's output valued at the reference price — that single figure
  contains price impact and route fees. The configured slippage tolerance is
  *not* added on top; it is a tolerance, not an expected cost. Position rent is
  refundable and nets to zero; bin-array rent for arrays that must be created is
  sunk and is charged.
- **NAV is quote-denominated and reported as USD.** True for a
  stablecoin-quoted pool, which is what Phase 1 targets.
- **The full-range benchmark is crude and labeled as such.** `V(p) = V₀√(p/p₀)`
  plus a `V/TVL` share of pool fees. It exists to answer "is concentration adding
  anything", not to be accurate.
- **No LVR.** Net-vs-HODL is the headline metric, as specified.

## Reporting and the go-live gate

A daily Telegram message at 07:00 America/Edmonton: NAV vs HODL vs full-range,
fees accrued, virtual costs paid, time in range, the last 24h of non-HOLD
decisions with their full reason trails, pool vol/TVL, and fast/slow vol. EXIT
and price-divergence (>1% pool vs Jupiter) alert immediately.

Once a week the report appends the advisory go-live gate. All three must hold:

- ≥ 4–6 weeks of shadow data, **and**
- the window contains ≥ 1 vol-regime change (7d realized vol doubling or
  halving), **and**
- strategy NAV > HODL NAV net of estimated costs.

Until then it prints `VERDICT: KEEP SHADOWING`.

## Ops

Long-running worker (systemd, pm2, Railway — anything that restarts it). On boot
it reloads the virtual position from the last `VirtualPositionEvent` and re-warms
the vol EWMAs from stored snapshots, so a restart does not reset the strategy's
memory. If a poll fails the tick is skipped — a snapshot is never fabricated —
and after `loop.max_consecutive_failures` consecutive failures it alerts once.

## Verifying upstream

`VERIFICATION.md` records exactly which SDK version, API base URLs, endpoints and
response fields were checked, when, and what could not be confirmed from the
build environment. Read it before the first live run.

## Phase 2 (not built)

The signing pipeline — program-ID allowlist, per-tx and daily notional caps,
mandatory `simulateTransaction`, no transfers to arbitrary addresses, DB-flag
kill switch, dedicated hot wallet, CAD-denominated event logging. The Phase 1
`Decision` objects become its input unchanged. None of it exists in this repo.
