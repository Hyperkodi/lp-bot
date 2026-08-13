# Armara LP Bot — custodial launch-liquidity optimizer

**Status:** design r2, awaiting review. No implementation has started.
**Supersedes:** the read-only shadow product framing. The shadow engine itself
is retained — see §12.
**r2:** fixes the destination-allowlist contradiction (§9 vs fee settlement),
adds the deposit lifecycle, initial-price handling, gas reserve, launch guard,
executor lock, fee-asset decision, and an operations section.

## 1. What this is

One tool in Armara's launch suite (alongside the PFP and sticker bots). A
founder who has launched a token uses this bot to create and manage the
token's liquidity pool on Meteora DLMM, without operating an LP strategy
themselves.

The bot holds the funds. The founder deposits SOL and their token into a wallet
the bot generates, chooses a strategy profile, and the bot creates the pool,
opens a position, and manages it — re-centring the range, compounding fees, and
exiting on the founder's instruction.

**Revenue:** a percentage of trading fees the position earns, taken at claim.

### Why the customer changes the design

The previous framing targeted a retail LP deciding between providing liquidity
and simply holding. A founder has no such choice: without liquidity their token
cannot trade at all. Liquidity is infrastructure, not an investment decision.

Two things follow. "Beat HODL" stops being the objective — it is retained as a
diagnostic, not a goal. And the founder's own preference decides what good
looks like, which is why strategy is a product choice (§6) rather than one
canonical answer.

## 2. Non-goals (v1)

- **Not a retail LP product.** One project, one token, one pool per tenant.
- **No trading, swapping for profit, or price support.** The bot manages a
  liquidity range. It does not attempt to move or defend the token's price —
  and it never swaps, which is also why the performance fee is taken in-kind
  (§11).
- **No token creation.** The suite will mint tokens eventually; until then the
  founder brings a mint and it gets screened (§8).
- **No multi-pool portfolio management.** One position per project.
- **Two-sided liquidity only.** Single-sided token-only seeding (launch with no
  SOL treasury) is the most common launch pattern and the strongest candidate
  for the first fast-follow, but it changes NAV, benchmark, and profile shapes
  — it is out of v1 deliberately, not by oversight.
- **No partial withdrawals.** `/withdraw` closes everything and returns
  everything. Partial exit is a fast-follow.

## 3. Custody

The decision, its evidence, and the rejected alternative are recorded in
`docs/OPERATOR_MODEL_FINDINGS.md`. Summary: Meteora's non-custodial operator
mechanism is gated to launch partners, and an anonymous key is rejected with
`UnauthorizedAccess`. Automation therefore requires custody.

**This is the highest-risk component in the system.** A founder's launch
liquidity is often the project's entire treasury, and a key compromise is
unrecoverable and simultaneous across every user. The design treats the signing
key as the crown jewel and everything else as secondary.

### 3.1 Wallet model

One generated Solana keypair per project. No pooled wallet, no shared balances.
The blast radius of any single failure is one project, and on-chain balances
reconcile against ledger balances trivially because they are the same thing.

The project wallet pays its own transaction fees and rent (position accounts,
bin arrays) from deposited SOL. A **gas reserve** (default 0.05 SOL,
configurable) is excluded from position sizing so the wallet can never LP
itself into being unable to sign its own exit. Withdrawal returns the reserve
too, minus the final network fee.

### 3.2 Key storage

Envelope encryption:

- A **master key** lives in a cloud KMS and never leaves it.
- Each wallet's secret key is encrypted with a KMS-derived data key and stored
  as ciphertext in Postgres.
- Plaintext exists only in process memory, only during signing, and is zeroed
  after. It is never logged, never written to disk, never returned by any API,
  and never crosses the service boundary into the bot layer.
- Database compromise alone yields nothing. KMS compromise alone yields
  nothing. Both are required.
- Because wallets are independent keypairs (no shared seed), a suspected leak
  is contained per project and handled by sweeping that wallet to a fresh one —
  re-encryption and rotation never require touching other projects.

Rejected: storing keys in Supabase Vault. It puts the key material and the
ciphertext under the same credential, which defeats the purpose.

Rejected: HD derivation of every wallet from one seed. The backup story is
nicer, but one leaked seed is every project's funds forever.

### 3.3 Destination allowlist

Funds may only ever move to four classes of destination, enforced at the
execution layer (§9) rather than by convention:

1. **The founder's registered withdrawal address** (and its derived token
   ATAs) — principal and the founder's share of fees.
2. **The Armara fee treasury** (a fixed, config-level address) — the
   performance-fee share only, and only inside a fee settlement.
3. **The pool's own program accounts** — deposits into the position.
4. **The project wallet itself** — claims and removals land here first.

Anything else aborts the transaction. The earlier draft omitted (2), which
would have made fee settlement violate the very rule that protects
withdrawals; the allowlist is now explicit that the treasury is a legal
destination *only* for the fee share, never for principal.

Changing the withdrawal address requires confirmation plus a **24-hour delay**,
with an immediate notification on request. Address substitution via a
compromised Telegram account is the most likely attack on this product; the
delay is the defence. Withdrawal to the *currently registered* address is never
delayed (§10).

## 4. Deposit lifecycle

The onboarding gap in r1. Deposits are detected by polling the project wallet;
every state is explicit and the founder always knows which one they are in:

- **AWAITING_DEPOSIT.** Wallet created, founder shown the address and the
  expected assets (SOL + token). The bot reports what has arrived and what is
  missing — partial deposits are normal, not errors.
- **DEPOSIT_COMPLETE.** Both assets present at or above the founder's stated
  amounts. The founder explicitly confirms "go" — the bot never opens a
  position on deposit detection alone, because a founder mid-way through
  funding must not trigger a half-sized launch.
- **Unexpected tokens** (anything that is not SOL or the project token) are
  ignored by the strategy and returned in full at withdrawal.
- **Top-ups after the position is open are not acted on in v1**: they sit in
  the wallet, are reported in `/status`, and are returned at withdrawal. Acting
  on them (growing the position) is a fast-follow with its own confirmation
  flow.

## 5. Pool creation and initial price

For a brand-new token there is no market price — **pool creation sets it**, and
a mispriced pool is drained by arbitrage within seconds. This is the single
most dangerous moment in the product and it gets ceremony proportionate to
that:

- The founder states the intended initial price (or equivalently, the token
  amount and SOL amount to seed — the ratio *is* the price). The bot shows the
  implied price, the implied FDV, and requires a typed confirmation.
- If a DLMM pool for this pair and bin step already exists, the bot does not
  create one — it reports the existing pool and its current price, and the
  founder either accepts joining at that price or aborts. Silently seeding into
  an existing pool at the wrong price is the same drain with extra steps.
- **Bin step** is chosen by strategy profile default (founder-overridable with
  a warning): tighter steps for Fee Maximizer, wider for Market Depth and
  Treasury Defensive.

## 6. Strategy profiles

The founder chooses at onboarding and can change later (a change takes effect
at the next rebalance and is recorded, so the track record stays sliceable).

| Profile | Optimizes for | Shape | Trade-off (shown to the founder in this language) |
| --- | --- | --- | --- |
| **Fee Maximizer** | trading-fee revenue | narrow range hugging the active bin, re-centred aggressively | highest fee capture per dollar; most exposed to impermanent loss and highest rebalance costs |
| **Market Depth** | the token looking liquid and trading with low slippage | wide range, even distribution across bins | flatter fee capture, fewer rebalances, better experience for buyers |
| **Treasury Defensive** | not converting the treasury into the falling side | wide and asymmetric, biased so a dump converts less of the position, conservative re-entry | lowest fee revenue; the profile a founder wants during a volatile launch |

Each profile is a named parameter set over the existing engine: range width
(`widthK`), rebalance patience (`oorDwellMin`, `edgeOvershootPct`,
`settleMin`), cost discipline (`costCoverageMultiple`), and the DLMM liquidity
distribution shape (Spot / Curve / BidAsk).

**Launch guard.** Hour-one price discovery is the most violent regime a token
ever sees and the least like anything the engine was tuned against. For the
first `launchGuardHours` after pool creation (default 24, per-profile
override), rebalancing is disabled regardless of profile: the position holds
its seeded shape, fees compound, and every would-be rebalance is recorded with
its reason trail as evidence for later tuning. The guard converts the riskiest
window from "the untested engine trades violently" to "the bot deliberately
holds still and shows you what it would have done."

**Copy shown to the founder must be honest about the trade-off**, not three
flattering names. Fee Maximizer earns more fees *and* loses more to impermanent
loss; saying only the first half is how a customer ends up feeling cheated by a
result the design promised them.

### 6.1 Schema consequence

The current `StrategyVersion` model assumes one canonical strategy, which made
aggregate claims meaningful. That assumption is now false.

`StrategyProfile` (name, description) gains `StrategyProfileVersion` (profile,
version, params, note). Every `Decision` stamps a profile version. Track-record
queries slice by profile, so "Fee Maximizer beat Market Depth on fee revenue
across 20 launches" stays answerable and no aggregate silently mixes profiles.

New ledger tables beyond the profile pair: `ProjectWallet` (ciphertext, never
plaintext), `DepositEvent`, `ExecutionIntent` / `ExecutionOutcome` (§9),
`FeeCharge` (§11), `WithdrawalRequest`, and `AddressChangeRequest` (with its
delay state). Existing `Snapshot` / `Decision` / benchmark tables carry over.

## 7. SOL-quoted accounting

The shadow engine assumed a stablecoin quote and documented that assumption.
Every pool here is TOKEN/SOL, so both assets move and the assumption is gone.

- **NAV is denominated in SOL** and converted to USD for display using the
  Jupiter SOL price. USD becomes a presentation concern rather than the unit of
  account.
- **The HODL benchmark** is the initial TOKEN+SOL basket marked to market —
  reported as a diagnostic (what liquidity provision cost), explicitly not the
  objective.
- **A new token has no independent price.** Its only price may be the pool
  itself, which is circular. Any USD figure derived from the token is labelled
  pool-derived, and the price-divergence alarm is disabled for the token side
  until an independent Jupiter price exists.
- **Impermanent-loss maths:** per-bin conversion holds as modelled; the
  benchmark and reporting value the SOL leg instead of assuming $1.

## 8. Token safety screen

The founder's token is theirs, but "theirs" is not "safe" — a mint can be
misconfigured, or built with tooling the founder does not fully control. Once
the bot holds it, its behaviour is Armara's problem.

Before a pool is created the mint is screened — legacy SPL and Token-2022
extensions both — and **hard-refused** with a plain explanation for:

- **Permanent delegate** — the mint authority could seize tokens directly out
  of the bot's wallet.
- **Transfer hook** — arbitrary code on every transfer.
- **Transfer fee** — silently breaks every amount the engine computes.
- **Freeze authority held by anyone other than the founder's registered
  address** — the position can be frozen mid-management by a stranger.
- **Non-transferable** — cannot be pooled at all.

Retained mint authority, or freeze authority held by the founder themselves,
gets a recorded warning-and-acknowledgement rather than a refusal — legitimate
projects do both, and the founder freezing their own launch harms only
themselves.

## 9. Execution pipeline

The engine already emits `HOLD / COMPOUND / REBALANCE / EXIT` with a full
reason trail. Execution turns a decision into a signed transaction through a
fixed sequence; any failure aborts before signing:

1. **Kill switch.** A database flag halts all signing immediately, without a
   deploy. Checked first — nothing else is worth doing if it is set.
2. **Executor lock.** A per-project Postgres advisory lock guarantees exactly
   one executor acts on a project at a time. Overlapping deploys and duplicate
   workers are an incident class, not a hypothetical; two processes signing for
   the same wallet must be structurally impossible, not operationally avoided.
3. **Intent recorded** with a unique idempotency key *before* anything is
   built. A crash mid-flight is recoverable because intent always precedes
   action.
4. **Build.** Instructions come from the Meteora SDK only.
5. **Inspect.** Every instruction checked against a **program allowlist**
   (Meteora DLMM, SPL Token, Associated Token, System, Compute Budget) and
   every destination against the §3.3 allowlist. Any `SetAuthority`, any
   `CloseAccount` to a foreign address, any transfer to an address outside
   §3.3 aborts. This is defence against a compromised dependency, not against
   our own code.
6. **Cap check.** Per-transaction notional cap and rolling 24-hour cap, per
   project and global. Exceeding either aborts and alerts.
7. **Simulate.** `simulateTransaction` must succeed. A failed simulation is
   never sent.
8. **Send and confirm** (acted on at `confirmed`; terminal ledger states
   written at `finalized`), then **reconcile**: re-read on-chain state and
   write the actual outcome against the recorded intent.

### 9.1 Partial and unknown outcomes

A rebalance is remove-then-add. If the remove confirms and the add fails, the
funds sit unallocated in the wallet — safe, earning nothing.

The reconciler detects intent without a terminal outcome and **always re-reads
chain state before acting**: a transaction whose status is unknown (expired
blockhash, RPC flap) is resolved by looking, never by blind resend. It retries
the completing action under the same idempotency key a bounded number of times,
then stops, alerts the founder in plain language, and leaves the funds where
they are. **The system never guesses.** Unallocated-but-safe is an acceptable
resting state; a second uncoordinated attempt at the same money is not.

## 10. Founder flows

**Onboarding.** Deep-link handoff from the parent bot (already built) → wallet
generated and shown → withdrawal address registered → strategy profile chosen →
initial price and amounts stated (§5) → deposit (§4) → founder confirms → mint
screen (§8) → pool created or joined → position opened → launch guard active
(§6).

**Ongoing.** `/status` (position, fees earned, NAV in SOL and USD, current
range vs price, launch-guard state, any unallocated balances), `/why` (the
gate-by-gate reason trail — still the differentiator), `/strategy` (view and
change profile), `/pause` (stop managing, keep the position), `/withdraw`.

**Withdrawal.** Always available, never gated on strategy state, never
delayed: close the position, claim fees, settle the performance fee, sweep
everything — principal, fee share, unexpected tokens, gas reserve — to the
registered withdrawal address. If the bot is paused, killed, or mid-anything,
withdrawal still works. **A custodial product that can be slow to return funds
is a custodial product that will be accused of stealing them.**

## 11. Fee model

A configurable percentage of **trading fees earned**, taken at claim (compound
or withdrawal): accrued fees are split, Armara's share to the fee treasury, the
remainder compounded or returned.

- **Taken in-kind, pro-rata in both assets.** DLMM fees accrue in both TOKEN
  and SOL; the bot never swaps (§2), so the fee is taken in whatever the fees
  arrived as. Armara's treasury holding project tokens is a treasury decision,
  not the bot's.
- Recorded per claim in `FeeCharge` with the rate applied, so every charge is
  reconstructable.
- **Only ever from earned trading fees, never principal** — including when the
  position is down.

**Deliberately not net-profit-based.** The founder was always going to provide
liquidity; charging on "profit versus not doing the thing they had to do"
would be incoherent. The ledger computes net-vs-HODL anyway, so changing the
model later is configuration, not rework.

## 12. What is retained from the shadow build

- **The decision engine, cost estimator, and signals** — pure, tested, now
  driving real transactions instead of a simulated position.
- **The replay harness** — how a profile is validated against history before
  it is offered to founders.
- **The shadow simulation** — dry-run mode. Every profile runs in shadow
  alongside live execution; profile changes get justified with evidence.
  During the launch guard it is also the record of what the engine *would*
  have done.
- **The multi-tenant ledger, service contract, and Telegram bot layer.**
- **The `/why` reason trail** — a founder whose treasury just moved is owed an
  explanation, and almost no competitor can give one.

Genuinely new: `custody/`, `execution/`, `strategy/`, the deposit lifecycle,
the token screen, and SOL-quoted accounting.

### Architecture

```
src/
  engine/        decision engine, cost model, signals        [PURE, retained]
  poller/        chain and API reads                          [retained]
  ledger/        tenants, wallets, positions, intents, fees   [extended]
  custody/       key generation, envelope encryption, signing  [NEW]
  execution/     decision -> tx -> inspect -> simulate -> send -> reconcile [NEW]
  strategy/      profiles and their parameter sets             [NEW]
  service/       the contract the bot layer consumes           [retained, extended]
  bot/           grammY Telegram layer                         [retained, extended]
```

Boundary rules, both build-enforced by the existing ESLint mechanism:

1. `engine/` stays pure — no clock, no network, no database.
2. Only `custody/` touches key material; only `execution/` may import
   `custody/`; the bot layer can reach neither. The repo-wide keyless lint rule
   is narrowed to exempt `custody/` alone, so key-capable imports remain a
   build failure everywhere they do not belong.

## 13. Operations

The read-only agent could fail quietly. A custodial one cannot.

- **Operator alerts** (to an Armara ops channel, not the founder): kill-switch
  trips, cap trips, reconciler giving up, simulation failures, executor-lock
  contention, project wallet below gas reserve.
- **Daily reconciliation job:** on-chain balances and position state vs ledger,
  per project. Any drift is an alert, because drift in a custodial system is
  either a bug or an incident.
- **Founder alerts:** launch-guard expiry, every executed action with its
  reason trail, reconciler-stuck notices in plain language, withdrawal-address
  change notices (immediately, to both old context and new).

## 14. Risks

**The strategy is unvalidated.** No profile has evidence behind it, and launch
conditions are the least like anything the engine was tuned against. The launch
guard (§6) narrows this but does not close it. Mitigation: devnet first, then a
small real launch that Armara owns, before a paying customer. This remains the
largest open risk and it is a product risk, not a code risk.

**Custody concentration.** Every project's funds are reachable by one service.
§3, §9 and §13 reduce but do not eliminate this.

**Regulatory.** Holding customer funds and charging a fee for managing them may
carry money-services obligations in Canada. Out of scope here; needs a real
answer before the first paying customer.

**Meteora launch-partner path.** If Armara becomes a launch partner, the
operator model may open and custody could be removed entirely. Worth pursuing
in parallel — it is a materially better product and sales position. `custody/`
stays behind a narrow interface so the swap remains possible.

## 15. Open questions

1. **Which KMS?** Depends on deployment target. Affects `custody/` only.
2. **Cap values.** Per-transaction and daily notional caps need real numbers.
3. **Performance fee percentage**, and whether it varies by profile.
4. **Failed-launch behaviour.** Token goes to zero; position is worthless. Auto
   ic exit, or wait for the founder? Leaning: alert loudly, act only on
   instruction — an automatic exit of a founder's token at the bottom is the
   kind of decision a custodian should not take unilaterally. Needs Ryan's
   call before launch.
5. **`launchGuardHours` default and per-profile values** — 24h is a
   placeholder pending replay evidence from the first launches.
