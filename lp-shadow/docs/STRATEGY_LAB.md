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
- Treasury Defensive starts from the same 50/50 base/quote basket as the
  benchmarks, deploys 50% of NAV as base and only 15% as quote, and holds the
  remaining 35% as quote reserve outside the bins. The reserve cannot be
  converted by swaps. The 15% value is provisional.
- A quote-to-base buyer is walked through the strategy-owned bins. Results
  report quote depth before 1% marginal price impact plus average fill and
  slippage on snapshots with a fill for an order equal to 10% of initial
  strategy NAV.
- Results include NAV versus HODL, fees, costs, maximum drawdown, time in range,
  rebalances, suppressed rebalances, average range width, final base-token and
  reserve shares, initial quote at risk, and cumulative quote converted to
  base.
- The live Meteora recipe maps `SPOT`, `CURVE`, and `BID_ASK` to SDK strategy
  types 0, 1, and 2 instead of always sending Spot.

## Initial synthetic findings

The four paths cover a quiet market, a two-times uptrend, a launch drawdown to
roughly 30% of its post-launch price, and volatile chop.

- Fee Maximizer captured the most fees in the quiet path ($41.75), but it was
  extremely active in stress: 35 rebalances during the drawdown and 50 during
  chop. It trailed HODL by $7,819.80 in the chop path. This is a warning, not a
  tuned result.
- Market Depth did not prove its low-slippage promise. In the quiet path, its
  simulated $1,000 buyer averaged 25.1 bps slippage versus 8.3 bps for Fee
  Maximizer. With equal capital, a wider range provides coverage farther from
  spot but leaves less liquidity near the current price. This finding is about
  strategy-owned bins only, not whole-pool execution.
- The defensive reserve materially improved the drawdown path: Treasury
  Defensive's maximum drawdown fell from the earlier balanced model's 70.2% to
  46.0%, its HODL gap improved from -$3,459.54 to -$1,000.35, and 64.9% of final
  NAV remained in reserve. It also exposed only $1,500 of the initial $10,000
  NAV as quote inside bins.
- The reserve does not cap cumulative conversion. Price can first sell base
  into quote and later convert that newly created quote back into base; the
  drawdown path recorded $6,600 of cumulative quote-to-base flow. The protected
  reserve, not cumulative flow, is the hard boundary.
- Defensive liquidity comes with a severe buyer-experience trade-off after a
  crash: its $1,000 test order averaged 91.5% fill across the drawdown path and
  7,376.1 bps slippage on snapshots with a fill because much of its remaining
  base sat far above spot.
- The launch guard suppressed hundreds of aggressive actions in trending
  scenarios, confirming that it materially changes early-launch behavior.
- Maximum drawdown and net-versus-HODL answer different questions. A rising
  strategy can show little absolute drawdown while badly trailing HODL, so both
  must remain visible.

## Evidence gaps before tuning

1. Supply historical launch snapshots or collect shadow data from Armara-owned
   launches. Synthetic paths must not be used to choose production parameters.
2. Validate buyer experience against complete pool bin state and real Jupiter
   quotes. The current model isolates this strategy's contribution and excludes
   other LPs, swap fees, routing, and market reaction.
3. Sweep and validate Treasury Defensive's provisional 15% quote exposure on
   training and holdout launches. Also compare it with a one-sided ask range;
   synthetic results must not select the production setting.
4. Validate fee attribution against real position fee growth. Current replay
   apportions interval pool fees by active-bin share.
5. Treat alternate-bin-step results as controlled comparisons only: re-binning
   assumes the same external volume, fees, and liquidity would exist.
6. Use training and holdout launch sets, then shadow the chosen versions before
   publishing an immutable Strategy Profile v1.

Until those gaps close, the three numeric profile definitions remain initial
configuration under `TODO(profile-replay)`.

The first historical training/holdout run is now implemented and documented in
[`HISTORICAL_STRATEGY_LAB.md`](./HISTORICAL_STRATEGY_LAB.md). It narrows the
uncertainty but does not close the gaps: the sample has only six launches and
historical TVL, per-bin liquidity, dynamic fees, and Jupiter routes remain
unavailable.
