# Can an LP optimiser manage user positions without custody?

**Answer: no — not via Meteora's operator mechanism.** Tested on devnet against
the live program on 2026-08-13.

This decides the architecture of the automated optimiser, so the evidence is
recorded here rather than summarised in a chat message.

## The question

To rebalance someone's liquidity automatically, the bot needs authority over
their position. Meteora's DLMM program has an `operator` concept that looked
like it might allow management without custody: a position stores `owner`,
`fee_owner` and `operator` as separate fields, and the SDK exposes
`initializePositionByOperator`.

If an arbitrary key could be named operator, users would keep ownership and
receive fees while the bot only managed the range — no custody, and a total
server compromise would cost users their strategy rather than their money.

## What the program actually does

**Operators can modify liquidity.** From `position_authorize.rs`:

```rust
pub fn authorize_modify_position(position, sender) -> Result<bool> {
    Ok(position.owner == sender || position.operator == sender)
}
```

**But withdrawal destinations are not bound to the owner at the account level.**
The `ModifyLiquidity` context — shared by add *and* remove liquidity —
constrains the destination token accounts only by mint:

```rust
#[account(mut, token::mint = token_x_mint)]
pub user_token_x: Box<InterfaceAccount<'info, TokenAccount>>,
```

A `PositionLiquidityFlowValidator::validate_outflow_to_ata_of_position_owner`
trait exists, but every published copy of the handler body is stubbed, so
whether it runs could not be settled by reading source.

**And an arbitrary key cannot become an operator at all.** This is the finding
that settles it. Creating an operator-managed position with a freshly generated
keypair fails against the deployed program:

```
Program log: Instruction: InitializePositionByOperator
Program log: AnchorError thrown in
  programs/lb_clmm/src/instructions/position/initialize_position_by_operator.rs:72.
  Error Code: UnauthorizedAccess. Error Number: 6031.
```

The plausible innocent explanations were ruled out: the position PDA seeds
constraint passed on this attempt, and the operator held a balance of token X
(the program has a separate "Missing token amount as token launch owner proof"
error, which was not the one raised).

`initializePositionByOperator` appears in Meteora's *seed liquidity* flow for
token launches, and `position_authorize.rs` references
`assert_eq_launch_pool_admin`. The mechanism is for launch partners Meteora
authorises — not a general delegation primitive third parties can use.

## Consequences

- The non-custodial operator design is **not available**. It was not a question
  of whether an operator could be trusted; we cannot become one.
- Automating position management therefore requires either **custody** (the bot
  holds keys to a wallet containing the user's funds) or **user-signed
  actions** (the bot proposes, the user approves each one — which is not
  automation).
- Ryan chose custody knowing the trade-offs, so custody is the baseline.

## What this changes about the build

Custody is not a smaller version of the operator design; it is a different
system with a different threat model. A compromise of the signing key drains
every user at once, so the design must treat the key as the crown jewel:
hardware or KMS-backed signing, withdrawal destinations allowlisted to the
depositing user, per-transaction and daily notional caps, mandatory
`simulateTransaction` before send, and a database kill switch that halts
signing without a deploy.

None of that was needed while the agent was read-only. All of it is needed
before a single real deposit.

## Reproducing

`devnet-proof/operator-authority.mjs` — devnet only, throwaway keys generated
into a scratch directory outside the repo. It creates two mints, creates a DLMM
pool, and attempts `initializePositionByOperator` with a generated operator.

The script also contains the theft test that was never reached: had the
position been created, the operator would have called `removeLiquidity` with
its *own* token accounts as the destination, proving whether outflows are bound
to the owner. That question remains open and is now moot for this product.
