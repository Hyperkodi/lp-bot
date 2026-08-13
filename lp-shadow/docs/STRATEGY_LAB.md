# Strategy lab

The strategy lab compares the complete built-in profile definitions: engine
parameters, DLMM distribution shape, default bin step, and launch guard. Run:

```powershell
pnpm strategy:lab
pnpm strategy:lab -- --json
```

The default suite is deterministic and synthetic. It is a stress test for the
model and plumbing, not evidence that any profile is ready for customer funds.
No profile is ranked or selected from this suite.

## What is now modeled

- Spot distributes value evenly across the range.
- Curve uses Meteora's middle-heavy Gaussian shape.
- BidAsk uses Meteora's edge-heavy inverse-Gaussian shape.
- Each hypothetical pool uses its profile's 10, 25, or 50 bps bin step while
  retaining the same underlying price path.
- The 24-hour launch guard records every would-be rebalance it suppresses.
- Results include NAV versus HODL, fees, costs, maximum drawdown, time in range,
  rebalances, suppressed rebalances, average range width, and final base-token
  share.
- The live Meteora recipe maps `SPOT`, `CURVE`, and `BID_ASK` to SDK strategy
  types 0, 1, and 2 instead of always sending Spot.

## Initial synthetic findings

The four paths cover a quiet market, a two-times uptrend, a launch drawdown to
roughly 30% of its post-launch price, and volatile chop.

- Fee Maximizer captured the most fees in the quiet path ($41.75), but it was
  extremely active in stress: 35 rebalances during the drawdown and 50 during
  chop. It trailed HODL by $7,819.80 in the chop path. This is a warning, not a
  tuned result.
- Market Depth generally sat between the other profiles. Time in range is not
  enough to prove market depth; the lab still needs a buyer-slippage model.
- Treasury Defensive had the smallest HODL gap and drawdown in synthetic chop,
  but failed its central promise in the drawdown: it performed no rebalance and
  finished 100% in the falling base token with a 70.2% maximum drawdown.
- The launch guard suppressed hundreds of aggressive actions in trending
  scenarios, confirming that it materially changes early-launch behavior.
- Maximum drawdown and net-versus-HODL answer different questions. A rising
  strategy can show little absolute drawdown while badly trailing HODL, so both
  must remain visible.

## Evidence gaps before tuning

1. Supply historical launch snapshots or collect shadow data from Armara-owned
   launches. Synthetic paths must not be used to choose production parameters.
2. Add a depth/slippage model using the virtual position's per-bin liquidity;
   time in range is only a proxy.
3. Redesign Treasury Defensive with an explicit asymmetric inventory budget or
   one-sided range. Balanced BidAsk is edge-heavy, not downside protection.
4. Validate fee attribution against real position fee growth. Current replay
   apportions interval pool fees by active-bin share.
5. Treat alternate-bin-step results as controlled comparisons only: re-binning
   assumes the same external volume, fees, and liquidity would exist.
6. Use training and holdout launch sets, then shadow the chosen versions before
   publishing an immutable Strategy Profile v1.

Until those gaps close, the three numeric profile definitions remain initial
configuration under `TODO(profile-replay)`.
