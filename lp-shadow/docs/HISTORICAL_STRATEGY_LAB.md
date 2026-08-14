# Historical strategy lab

Run the read-only evaluation with:

```powershell
pnpm strategy:historical
```

The command fetches each fixed pool's first 72 hours of 30-minute OHLCV from
Meteora, evaluates the three unchanged built-in profiles, selects one Treasury
Defensive quote-exposure candidate using training launches only, and then
scores that locked candidate once on holdout. It does not build transactions,
sign, send, or change a production profile.

## Frozen stress cohort

The 24 addresses are frozen in `src/strategy/historicalManifest.ts`. They came
from repeated creation-ordered scans of non-blacklisted SOL-quoted pools, not a
current-volume or current-TVL leaderboard. At capture, eligible pools had at
least 116 of 145 possible first-72-hour candles. Selection deliberately spans
three observed outcome strata:

| Stratum | Training | Holdout | Captured 72h return range |
| --- | ---: | ---: | ---: |
| Crash | 4 | 4 | -96.8% to -77.8% |
| Middle | 4 | 4 | -70.1% to +11.8% |
| Winner | 4 | 4 | +51.2% to +3,495.0% |

This construction prevents a top-pools-only survivor sample and ensures that
both catastrophic failures and explosive winners are tested. It is deliberately
stress-stratified, so its averages are not estimates of the broader launch-pool
population. All launches are still recent SOL-quoted pools, another important
scope limit.

The capture used 3,389 observed candles. When Meteora later returned no candle
for an interval after the first trade, the replay inserted 88 explicitly modeled
flat, zero-volume inactivity candles, producing 3,477 replay candles. It never
interpolates a price move or invents volume.

## Evidence boundary

Historical observations:

- candle timestamp, open, high, low, close, and volume;
- pool creation time, bin step, and base fee.

Explicit models where public historical observations are unavailable:

- every pool uses the same $100,000 modeled TVL, divided over 69 virtual bins;
- fee revenue is candle volume multiplied by the pool base fee;
- omitted intervals after the first observation use the previous close and zero
  volume;
- rebalance swaps use a 50 bps impact input;
- only 30-minute closes are replayed, not intracandle paths.

Historical TVL, per-bin liquidity, dynamic fees, and Jupiter routes are not
available. Absolute fee dollars, execution costs, and net returns therefore
remain model-assisted results rather than audited performance.

## Built-in profile results

Captured 2026-08-14 UTC:

| Cohort | Profile | Average net vs HODL | Average max drawdown | Average rebalances |
| --- | --- | ---: | ---: | ---: |
| Training | Fee Maximizer | -$1,681 | 38.5% | 0.0 |
| Training | Market Depth | -$1,622 | 38.9% | 0.0 |
| Training | Treasury Defensive (15%) | -$1,220 | 34.3% | 0.4 |
| Holdout | Fee Maximizer | -$20,012 | 37.5% | 0.0 |
| Holdout | Market Depth | -$19,998 | 38.2% | 0.0 |
| Holdout | Treasury Defensive (15%) | -$19,018 | 34.0% | 0.4 |

The holdout means are dominated by STONK's roughly 35x first-72-hour move. That
is why parameter selection uses median and worst-launch outcomes before mean.
Drawdown is a strategy-NAV statistic, not benchmark regret: a strategy can rise
monotonically and still lag HODL badly in an explosive winner.

## Training-only parameter lock

The sweep changes only Treasury Defensive's deployed quote share. Deployed base
remains 50%; undeployed quote remains in reserve.

| Deployed quote | Training median net vs HODL | Training average | Training worst | Average max drawdown |
| ---: | ---: | ---: | ---: | ---: |
| 0% | -$273 | -$1,059 | -$5,781 | 31.8% |
| 5% | -$275 | -$1,073 | -$5,780 | 32.6% |
| 10% | -$313 | -$1,146 | -$5,779 | 33.4% |
| 15% | -$344 | -$1,220 | -$5,773 | 34.3% |
| 20% | -$375 | -$1,291 | -$5,772 | 35.3% |
| 30% | -$451 | -$1,423 | -$5,719 | 37.3% |
| 50% | -$628 | -$1,684 | -$5,730 | 40.8% |

Ranking is deterministic: highest training median net versus HODL, then best
worst launch, lowest average drawdown, highest mean, fewest rebalances, and
lower quote exposure. Under that predeclared ordering, the training set locked
the 0% candidate before holdout was evaluated.

| Locked candidate | Holdout median net vs HODL | Holdout average | Holdout worst | Average max drawdown |
| --- | ---: | ---: | ---: | ---: |
| 0% deployed quote | -$155 | -$18,597 | -$223,934 | 30.1% |

This is rejection evidence, not a production recommendation. Zero deployed
quote is effectively a capital-preservation control, and it still trails HODL
on the median holdout launch. The built-in 15% Treasury Defensive profile is
unchanged.

## Next evidence step

1. Repeat the frozen-cohort method across older launch periods and non-SOL quote
   assets so one market window cannot dominate the conclusion.
2. Capture live full-bin state and exact-pool Jupiter quotes repeatedly to
   replace modeled TVL, liquidity, and impact with observed execution evidence.
3. Test structurally different policies, including delayed entry, one-sided
   inventory, and explicit exit rules; quote-exposure tuning alone did not find
   a viable LP candidate.
4. Shadow any surviving candidate version before considering a production
   change.
