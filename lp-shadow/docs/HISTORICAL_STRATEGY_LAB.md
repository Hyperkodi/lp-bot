# Historical strategy lab

Run the read-only historical and live-quote validation with:

```powershell
pnpm strategy:historical
```

The command fetches the first 72 hours of 5-minute OHLCV directly from
Meteora for six recent SOL-quoted launch pools, replays the three profiles, and
then requests current quote-to-base Jupiter quotes for $100, $500, and $1,000.
It never calls Jupiter's transaction-building endpoint and never signs or sends
anything.

## Dataset and split

The fixed manifest prevents a discovery query from silently changing the sample.

| Cohort | Pool | Address | Candles / expected |
| --- | --- | --- | ---: |
| Training | TOAD-SOL | `7iyWwX51LwktZoYbwjndBGwX98VYm3pqNRGoZLw1tB3s` | 865 / 865 |
| Training | STONK-SOL | `48M3tRdbVYmEbf5rCTFVAgqCCaZdChVmeg3VPBrmgT8m` | 865 / 865 |
| Training | CATE-SOL | `AUaPMKd13d633cXRRrPRfTeL5XRN64ngDWLEfH5zfBML` | 865 / 865 |
| Holdout | BUTTHOLE-SOL | `EAf6shtt8QGJ7UiSRrDc6pzwXKEmb5s7tCCpSDe5zpzZ` | 864 / 865 |
| Holdout | XST-SOL | `FXc1BVyNDmqwSKbYD8JwMGq5uqsUov4BCjqnATAeyARk` | 840 / 865 |
| Holdout | MANLET-SOL | `68C62WPYiiNZxprbuaMj2ULXpiTDKcs5xsX7kBGnyajR` | 861 / 865 |

This is 5,160 observed candles. Training versus holdout is enforced in the
report, but no parameters were changed from these results.

## Evidence boundary

Historical facts:

- candle timestamp, open, high, low, close, and volume;
- pool creation time, token pair, bin step, and base fee.

Explicit proxies where the public historical endpoint has no observation:

- replay uses candle closes; it does not invent the path between close points;
- current TVL is held constant and divided across 69 bins because historical
  TVL and per-bin liquidity are unavailable;
- fee revenue is candle volume multiplied by the pool's base fee; historical
  dynamic fees are unavailable;
- rebalance swaps use a conservative 50 bps impact input because historical
  Jupiter routes cannot be reconstructed.

For those reasons, fee dollars, rebalance counts, and absolute net returns are
model-assisted historical results, not audited performance.

## Results captured 2026-08-14 00:30 UTC

| Cohort | Profile | Average net vs HODL | Average max drawdown | Average rebalances |
| --- | --- | ---: | ---: | ---: |
| Training | Fee Maximizer | -$7,946 | 78.9% | 24.7 |
| Training | Market Depth | -$5,428 | 60.5% | 2.7 |
| Training | Treasury Defensive | +$299 | 30.0% | 0.0 |
| Holdout | Fee Maximizer | -$3,166 | 49.3% | 12.7 |
| Holdout | Market Depth | -$2,147 | 44.3% | 2.3 |
| Holdout | Treasury Defensive | -$217 | 34.5% | 0.3 |

The conclusions are narrow but useful:

- Fee Maximizer is still much too active for launch conditions and is not a
  production candidate in its current form.
- Market Depth remains materially behind HODL in both cohorts. A wide range is
  not enough to establish good execution quality.
- Treasury Defensive generalizes directionally to the holdout set and sharply
  reduces the HODL gap, but it still loses $217 on average there. This does not
  validate the provisional 15% quote-exposure setting.
- Six launches are far too few for production selection, particularly because
  all are recent SOL-quoted meme-token launches.

## Current Jupiter cross-check

At capture time, Jupiter used the exact studied pool for all tested TOAD,
STONK, and XST order sizes; for BUTTHOLE it used the exact pool at all sizes,
including a split Meteora route at $1,000. CATE routed through Pump.fun rather
than the studied pool. MANLET used other liquidity at $100 and $500 and the
studied pool at $1,000.

Jupiter's reported price impact for exact-pool quotes ranged from 0.000% to
0.466% in that single live sample. These quotes are current and ephemeral—not
historical—and an exact-pool `no` says nothing about the studied pool's depth.
The script checks Jupiter's AMM address, not just the human-readable route label.

## Next evidence step

1. Expand to dozens of launches covering different liquidity, volatility, and
   outcome regimes.
2. Capture live full-bin pool state alongside repeated exact-pool Jupiter
   quotes so buyer-depth predictions can be calibrated instead of compared to a
   single quote snapshot.
3. Sweep parameters only on training launches, lock candidates, and score them
   once on holdout launches.
4. Shadow the surviving candidate versions before any production decision.
