-- Performance fees are a fraction of earned trading fees, never principal.
-- Enforce the invariant below application code so a regression cannot persist
-- an overcharge or an unexplained amount.
ALTER TABLE "FeeCharge"
  ADD CONSTRAINT "FeeCharge_nonnegative_earned_check"
    CHECK ("earnedAmount" >= 0),
  ADD CONSTRAINT "FeeCharge_rate_bps_check"
    CHECK ("rateBps" >= 0 AND "rateBps" <= 10000),
  ADD CONSTRAINT "FeeCharge_earned_only_check"
    CHECK (
      "chargedAmount" >= 0
      AND "chargedAmount" = ("earnedAmount" * "rateBps" / 10000)
    );
