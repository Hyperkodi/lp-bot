# Initial liquidity readiness

Status as of 2026-08-14: **planning and guarded devnet scaffolding only**. No
launch transaction has been signed or sent.

## Founder inputs and provisional assumptions

| Item | Value |
| --- | ---: |
| Project tokens | 10,000,000 |
| SOL deposited | 132 |
| Total supply | 1,000,000,000 |
| SOL/USD display price | $75.89 |
| Token decimals | 6, provisional until verified from the real mint |
| Shape / funded bins | Spot / 69 |
| Bin step / base fee | 50 bps / 30 bps, provisional until a Standard preset exists |

The token/SOL ratio implies 0.0000132 SOL per token. Meteora bin rounding maps
that to active bin -868 and 0.0000131782698211 SOL per token, an implied FDV of
about $1,000,098.90 at the supplied SOL/USD display price.

## Current strategy decision

Use a dual-sided DLMM **Standard pool**, not Meteora's separately named
one-sided Launch Pool. Use a wide 69-bin Spot position as the current planning
default. The initial position is `PERMANENT_INITIAL`: the bot may open and
observe it, but cannot autonomously compound, rebalance, settle fees, exit, or
withdraw it. Explicit founder withdrawal remains available. Later liquidity
must use separate positions and policy.

This is a durability-first provisional choice, not a performance claim. Spot
distributes liquidity uniformly. Curve adds more opening depth but becomes
thin near the sampled edges; BidAsk deliberately moves inventory toward the
edges and is better reserved for an explicit DCA/edge objective.

## Modeled trade-offs

For Spot / 69 / 50 bps, the funded range is approximately -15.60% to +18.48%.
Buyer capacity contributed by this position alone is approximately 7.67 SOL at
0.5%, 15.37 SOL at 1%, 30.84 SOL at 2%, and 77.88 SOL at 5% maximum modeled
average impact. These figures exclude other LPs, routing, dynamic fees, and
market reaction.

| Bin step | Approximate coverage | Opening capacity at 1% average impact |
| ---: | ---: | ---: |
| 10 bps | -3.34% / +3.46% | 76.79 SOL |
| 25 bps | -8.14% / +8.86% | 30.76 SOL |
| 50 bps | -15.60% / +18.48% | 15.37 SOL |
| 100 bps | -28.70% / +40.26% | 7.70 SOL |
| 200 bps | -49.00% / +96.07% | 3.83 SOL |

## Genuine blockers

1. The real project-token mint is unknown. Its token program, decimals,
   current supply, authorities, and Token-2022 extensions cannot yet be
   verified.
2. Public devnet currently has four `PresetParameter2` accounts; all observed
   on 2026-08-14 use a 10 bps bin step and a 1,000 bps base fee. None matches
   the provisional 50/30 Standard-pool requirement.
3. The represented-price position value is about 263.78 SOL before known
   creation rent. It exceeds the current placeholder execution caps: 10 SOL
   per transaction, 50 SOL per project per 24 hours, and 250 SOL globally per
   24 hours. Cap changes require deliberate treasury approval.
4. Exact conditional account rent, transaction fees, priority fees, existing
   account credits, wallet balance, and transaction simulation require a fresh
   unsigned preflight with the real mint, wallet, and verified preset.
5. Founder review of the exact represented price and an explicit confirmation
   ceremony are required before any execution workflow.
6. Database-backed integration tests remain unavailable until the pending
   migrations are reviewed and deliberately applied; no live migration was
   applied during this work.

## Reproducible read-only checks

```powershell
pnpm strategy:plan -- --token 10000000 --token-decimals 6 --sol 132 --supply 1000000000 --sol-price 75.89 --bin-step 50 --fee-bps 30 --shape SPOT --bins 69
pnpm devnet:presets
pnpm launch:mint -- <mint> <founder-address> 6 1000000000
```

The first two commands have been run successfully. The mint check cannot run
until the real mint and founder withdrawal address are supplied. None of these
commands has a keypair, signer, or send path.

## Primary references

- [Meteora DLMM strategies and use cases](https://docs.meteora.ag/core-products/dlmm/strategies-and-use-cases)
- [Meteora pool creation guide](https://docs.meteora.ag/user-guides/creating-a-liquidity-pool)
- [Meteora TypeScript SDK reference](https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/reference)
- [Meteora DLMM overview](https://docs.meteora.ag/core-products/dlmm/what-is-dlmm)
