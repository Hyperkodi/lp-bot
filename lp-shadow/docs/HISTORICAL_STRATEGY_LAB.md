# Permanent initial-liquidity lab

Run the launch-liquidity evaluation with:

```powershell
pnpm strategy:initial
```

`pnpm strategy:historical` remains an alias. The command is read-only: it
fetches market history and runs virtual positions. It does not build, sign, or
send a transaction.

## Product constraint

This lab models the first liquidity supplied when a token's pool is created.
Every candidate therefore:

- opens on the first market observation;
- supplies launched-token inventory, so buyers can trade at launch;
- remains in place for the complete 72-hour replay;
- never compounds, rebalances, exits, or withdraws.

Delayed entry and drawdown exits were tested previously but are not applicable
to the initial-liquidity product. They are not used to select or report launch
options. Later liquidity additions are a separate future policy.

## Candidate grid

The 48 candidates cross:

- inventory: 100/0, 70/30, 50/50, or 30/70 launched token versus SOL;
- Meteora shape: Spot, Curve, or BidAsk;
- fixed width: 15, 31, 51, or 69 bins.

Quote-only positions are excluded because they offer no launched token to the
first buyers. Each candidate uses the historical pool's actual bin step. The
same bin count therefore covers a different percentage range when bin steps
differ.

The virtual injection is $10,000. Initial inventory is assumed to be already
available to the team, so the replay does not invent an acquisition swap before
pool creation.

## Fair benchmarks and objectives

Every LP candidate is compared with holding the exact same initial inventory
mix outside the pool. For example, token-only Curve is compared with token-only
HODL, not a 50/50 basket.

There is deliberately no hidden combined score. Training launches select one
representative for each founder objective:

- capital: median and worst net result versus matching HODL, then drawdown;
- fees: average modeled fee capture, then capital result;
- buyer depth: launch-time quote-to-token depth within 1% modeled price impact;
- durability: percentage of the first 72 hours that price remains in range.

Each representative is locked before the 12 holdout launches are scored.

## Frozen stress cohort

The manifest contains 24 recent SOL-quoted Meteora launches: 12 training and 12
holdout, balanced across crash, middle, and winner strata. They were selected
from creation-ordered scans rather than current TVL or volume leaderboards.
This intentionally includes pools that later lost essentially all liquidity.

The run uses 3,389 observed 30-minute candles. Eighty-eight missing intervals
after the first trade are modeled as unchanged price and zero volume, producing
3,477 replay candles.

The cohort is a stress set, not a population estimate. It covers one recent
market period and one quote asset.

## Results captured 2026-08-14 UTC

| Objective | Shape | Token/SOL | Bins | Holdout median vs HODL | Holdout average | Holdout worst | Average fees | Time in range | Launch depth within 1% | Average max drawdown |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Capital | BidAsk | 100/0 | 69 | +$2 | -$30,679 | -$346,699 | $57 | 35.5% | $150 | 57.5% |
| Fees | Curve | 30/70 | 15 | -$3,417 | -$11,713 | -$104,708 | $329 | 8.6% | $866 | 49.1% |
| Buyer depth | Curve | 100/0 | 15 | +$3 | -$31,331 | -$349,163 | $279 | 8.6% | $2,887 | 50.7% |
| Durability | BidAsk | 100/0 | 69 | +$2 | -$30,679 | -$346,699 | $57 | 35.5% | $150 | 57.5% |

All four options filled the modeled $1,000 buyer order at launch, but fill rate
does not mean low slippage. The depth column is the stricter amount available
before modeled marginal impact exceeds 1%.

### What this means

- Wide token-only BidAsk is the least fragile passive configuration in this
  grid, but even it remains in range only 35.5% of the first 72 hours.
- Narrow token-only Curve concentrates substantially more launched token near
  the opening price, improving initial buyer depth, but price leaves its range
  quickly.
- Narrow quote-heavy Curve captures the most modeled fees, but supplies less
  launched-token depth and trails its matching HODL benchmark on the median
  holdout launch.
- Large negative averages on token-heavy options come from explosive winners:
  the LP sells token inventory through its finite range while token-only HODL
  retains the full upside. This is benchmark regret, not necessarily a loss of
  the original dollar principal.

No candidate simultaneously provides strong launch depth, durable coverage,
high fees, and HODL-like upside. The result is an option set, not approval of a
production default.

## Evidence boundary

Historical observations:

- candle timestamp, OHLC price, and volume;
- pool creation time, actual bin step, and base fee.

Modeled inputs:

- every pool uses $100,000 constant pool TVL divided across 69 virtual bins;
- fees use candle volume multiplied by the pool's base fee;
- missing intervals after the first trade are flat and zero-volume;
- 30-minute closes are replayed without an invented intracandle path;
- buyer depth includes only the team's virtual position, not other LPs,
  routing, market reaction, or historical per-bin state.

Historical TVL, per-bin liquidity, dynamic fees, and executable Jupiter routes
remain unavailable. Fee and depth dollars are directional model outputs, not
audited execution results.

## Turn real launch inputs into a concrete plan

The read-only launch planner replaces the normalized $10,000 injection with
the team's actual launch constraints. It does not connect to a wallet, build a
transaction, sign, or send anything.

From the `lp-shadow` directory, run this example with the placeholder numbers
replaced by the real launch values:

```powershell
pnpm strategy:plan -- --token 1000000 --token-decimals 6 --sol 10 --supply 100000000 --sol-price 200 --buyer-usd 1000 --impact-bps 100 --bin-step 25 --fee-bps 30
```

The inputs mean:

1. launched-token quantity allocated to initial liquidity;
2. the token mint's decimal count, required to map a human price to Meteora's
   atomic-unit bin price;
3. SOL allocated at pool creation;
4. total token supply, used to calculate implied FDV;
5. current SOL/USD display price (entered explicitly; the command does not
   fetch a live price);
6. optional buyer order to inspect near launch;
7. acceptable modeled price impact for that order (`100` bps is 1%);
8. chosen pool bin step and base fee.

With no shape or width specified, the command compares Spot, Curve, and BidAsk
at 15, 31, 51, and 69 funded bins. Every row uses the exact same token and SOL
deposit. To inspect one recipe in detail, add both flags:

```powershell
pnpm strategy:plan -- --token 1000000 --token-decimals 6 --sol 10 --supply 100000000 --sol-price 200 --buyer-usd 1000 --impact-bps 100 --bin-step 25 --fee-bps 30 --shape CURVE --bins 15
```

The detailed plan reports the represented Meteora price and active bin, the
70-bin position-account interval, and the smaller funded interval inside it.
The team-supplied token/SOL ratio defines the intended opening price, which is
rounded to the nearest representable bin and disclosed before confirmation.
Changing either launch amount also changes the implied price and FDV.
`--gas-reserve` defaults to 0.05 SOL and is reported as wallet funding outside
the position. The detailed view also estimates the SDK-published rent for the
pool account, two reserve token accounts, one classic position, and the bin
arrays crossed by that position. It separately reports the minimum wallet SOL
including those known accounts. This is not an all-in quote: creator token
accounts, network and priority fees, optional bitmap-extension rent, and
existing-account credits still require a fresh unsigned network preflight.

The typed execution draft fixes the reviewed orientation as project token X
and wrapped SOL Y, making every displayed price `SOL per project token`. It
converts human amounts to exact atomic integers, derives the deterministic
devnet pool and position addresses, and maps the funded interval into
`OPEN_POSITION`. The draft contains no signer and does not build or send a
transaction. Mint addresses, the real token decimal count, wallet addresses,
and a fresh wallet balance are required before it can be created.

The comparison models buyer depth contributed by this initial position only.
If buyer size is unknown, omit both buyer flags. The planner then reports the
maximum fully filled order supported at 0.5%, 1%, 2%, and 5% modeled average
price impact. This capacity curve is more honest than inventing one buyer; a
specific buyer flag simply adds a point simulation alongside the curve.
It excludes other LPs, routing, dynamic fees, and market reaction, so it is a
planning aid rather than an executable quote or a production winner. Rules for
adding liquidity later remain a separate policy and do not weaken the
permanent initial position. "Permanent" means the bot never autonomously pulls
this liquidity; the founder's explicit withdrawal remains available at all
times.
