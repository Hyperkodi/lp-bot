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

## Information needed for a real launch recommendation

The next pass should replace the normalized $10,000 injection with the team's
actual launch constraints:

1. launched-token quantity allocated to initial liquidity;
2. SOL allocated at pool creation;
3. intended opening price or FDV;
4. largest buyer order that should clear near launch;
5. acceptable price impact for that order;
6. desired opening price range and chosen pool bin step/base fee.

Those inputs will let the lab turn the four tradeoff families into concrete
token amounts, SOL amounts, and bin ranges. Rules for adding liquidity later
should then be evaluated independently without weakening the permanent initial
position.
