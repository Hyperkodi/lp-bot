# Armara LP Bot — custodial launch-liquidity optimizer

**Status:** design, awaiting review. No implementation has started.
**Supersedes:** the read-only shadow product framing. The shadow engine itself
is retained — see §11.

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
looks like, which is why strategy is a product choice (§5) rather than one
canonical answer.

## 2. Non-goals

- **Not a retail LP product.** One project, one token, one pool per tenant.
- **No trading, swapping for profit, or price support.** The bot manages a
  liquidity range. It does not attempt to move or defend the token's price.
- **No token creation.** The suite will mint tokens eventually; until then the
  founder brings a mint and it gets screened (§7).
- **No multi-pool portfolio management.** One position per project at launch.

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

Rejected: storing keys in Supabase Vault. It puts the key material and the
ciphertext under the same credential, which defeats the purpose.

Rejected: HD derivation of every wallet from one seed. The backup story is
nicer, but one leaked seed is every project's funds forever, with no possibility
of per-wallet rotation.

### 3.3 Withdrawal address binding

At onboarding the founder registers a **withdrawal address**, and it is the
only destination the bot will ever send funds to. Changing it requires a
confirmation step and a mandatory delay (see §9), because address substitution
is the highest-value attack against a custodial bot and the one most likely to
arrive via a compromised Telegram account rather than a compromised server.

## 4. Architecture

```
src/
  engine/        decision engine, cost model, signals        [PURE, retained]
  poller/        chain and API reads                          [retained]
  ledger/        Postgres: tenants, wallets, positions, actions, fees
  custody/       key generation, envelope encryption, signing  [NEW]
  execution/     decision -> transaction -> simulate -> send -> reconcile [NEW]
  strategy/      profiles and their parameter sets             [NEW]
  service/       the contract the bot layer consumes           [retained, extended]
  bot/           grammY Telegram layer                         [retained, extended]
```

The existing architectural rule holds and gains a second clause:

1. `engine/` is pure — no clock, no network, no database. This is what makes
   replay trustworthy.
2. **Only `custody/` may touch key material, and only `execution/` may call it.**
   The bot layer cannot reach either. Enforced by the existing ESLint boundary
   mechanism, extended with a rule that fails the build on any import of
   `custody/` from outside `execution/`.

The keyless lint rule that currently guards the whole repo is narrowed rather
than deleted: it continues to apply to every directory except `custody/`, so
key-capable imports remain a build failure everywhere they do not belong.

## 5. Strategy profiles

The founder chooses at onboarding and can change later (a change takes effect
at the next rebalance and is recorded, so the track record stays sliceable).

| Profile | Optimizes for | Shape | Trade-off |
| --- | --- | --- | --- |
| **Fee Maximizer** | trading-fee revenue | narrow range hugging the active bin, re-centred aggressively | highest fee capture per dollar; most exposed to impermanent loss and highest rebalance costs |
| **Market Depth** | the token looking liquid and trading with low slippage | wide range, even distribution across bins | flatter fee capture, fewer rebalances, better experience for buyers |
| **Treasury Defensive** | not converting the treasury into the falling side | wide and asymmetric, biased so a dump converts less of the position, conservative re-entry | lowest fee revenue; the profile a founder wants during a volatile launch |

Each profile is a named parameter set over the existing engine: range width
(`widthK`), rebalance patience (`oorDwellMin`, `edgeOvershootPct`,
`settleMin`), cost discipline (`costCoverageMultiple`), and the DLMM liquidity
distribution shape (Spot / Curve / BidAsk).

**Copy shown to the founder must be honest about the trade-off**, not three
flattering names. Fee Maximizer earns more fees *and* loses more to impermanent
loss; saying only the first half is how a customer ends up feeling cheated by a
result the design promised them.

### 5.1 Schema consequence

The current `StrategyVersion` model assumes one canonical strategy across all
pools, which is what made an aggregate claim meaningful. That assumption is now
false.

`StrategyProfile` (name, description) gains `StrategyProfileVersion`
(profile, version, params, note). Every `Decision` already stamps a strategy
version; it now stamps a profile version. Track-record queries slice by profile,
so "Fee Maximizer beat Market Depth on fee revenue across 20 launches" stays
answerable and no aggregate silently mixes profiles.

## 6. SOL-quoted accounting

The shadow engine assumed a stablecoin quote and documented that assumption.
Every pool here is TOKEN/SOL, so both assets move and the assumption is gone.

- **NAV is denominated in SOL** and converted to USD for display using the
  Jupiter SOL price. USD becomes a presentation concern rather than the unit of
  account.
- **The HODL benchmark** is the initial TOKEN+SOL basket marked to market. It
  is reported as a diagnostic — it tells a founder what the liquidity provision
  cost them — but it is explicitly **not** the objective, because the founder
  had no realistic alternative to providing liquidity.
- **A new token has no reliable USD price.** Its only price may be the pool
  itself, which is circular. So: any USD figure derived from the token is
  labelled as pool-derived, and the price-divergence alarm is disabled for the
  token side until an independent Jupiter price exists.
- **Impermanent loss maths changes.** With two volatile assets, per-bin
  conversion still holds (the existing simulation models it correctly), but the
  benchmark and reporting need the SOL leg valued, not assumed to be $1.

## 7. Token safety screen

The founder's token is theirs, but "theirs" is not "safe" — a mint can be
misconfigured, or the founder may be launching something they bought tooling
for and do not fully control. Once the bot holds it, its behaviour is Armara's
problem.

Before a pool is created, the mint is screened and **rejected** for:

- **Permanent delegate** — the mint authority could seize tokens directly out
  of the bot's wallet.
- **Transfer hook** — arbitrary code on every transfer.
- **Transfer fee** — silently breaks every amount the engine computes.
- **Freeze authority still live** — the position can be frozen mid-management.
- **Non-transferable** — cannot be pooled at all.

Mint and freeze authority may be retained by the founder for legitimate
reasons; the bot warns rather than refuses, records the acknowledgement, and
proceeds. Everything above is a hard refusal with a plain explanation.

## 8. Execution pipeline

The engine already emits `HOLD / COMPOUND / REBALANCE / EXIT` with a full
reason trail. Today nothing acts on them. Execution turns a decision into a
signed transaction through a fixed sequence, and any failure aborts before
signing:

1. **Intent recorded.** The decision is written to the ledger with a unique
   idempotency key *before* anything is built. A crash mid-flight is
   recoverable because intent always precedes action.
2. **Build.** Instructions come from the Meteora SDK only.
3. **Inspect.** Every instruction is checked against a **program allowlist**
   (Meteora DLMM, SPL Token, Associated Token, System, Compute Budget). Any
   `SetAuthority`, `CloseAccount` to a foreign address, or `SystemProgram`
   transfer to an address that is not the registered withdrawal address aborts
   the transaction. This is defence against a compromised dependency, not
   against our own code.
4. **Cap check.** Per-transaction notional cap and rolling 24-hour cap, both
   per project and globally. Exceeding either aborts and alerts.
5. **Kill switch.** A database flag halts all signing immediately, without a
   deploy. Checked here, on every action.
6. **Simulate.** `simulateTransaction` must succeed. A failed simulation is
   never sent.
7. **Send and confirm**, then **reconcile**: re-read on-chain state and write
   the actual outcome against the recorded intent.

### 8.1 Partial failure

A rebalance is remove-then-add. If the remove confirms and the add fails, the
project's funds are sitting unallocated in the wallet — safe, but earning
nothing and outside any position.

The reconciler detects intent without a matching terminal outcome, retries the
completing action with the same idempotency key, and after a bounded number of
attempts stops, alerts the founder in plain language, and leaves the funds
where they are. **The system never guesses.** Unallocated-but-safe is an
acceptable resting state; a second uncoordinated attempt at the same money is
not.

## 9. Founder flows

**Onboarding.** Deep-link handoff from the parent bot (already built) → the bot
generates a wallet and shows its address → founder registers a withdrawal
address → chooses a strategy profile → deposits SOL and token → bot confirms
the deposit, screens the mint (§7), creates the pool, opens the position.

**Ongoing.** `/status` (position, fees earned, NAV in SOL and USD, current
range vs price), `/why` (the gate-by-gate reason trail — retained from the
shadow product and still the differentiator), `/strategy` (view and change
profile), `/pause` (stop managing, keep the position), `/withdraw`.

**Withdrawal.** Always available, never gated on strategy state: close the
position, claim fees, settle the performance fee, send everything to the
registered withdrawal address. If the bot is paused, killed, or the strategy is
mid-anything, withdrawal still works. **A custodial product that can be slow to
return funds is a custodial product that will be accused of stealing them.**

**Changing the withdrawal address** requires confirmation plus a 24-hour delay,
with a notification sent immediately on request. If a founder's Telegram is
compromised, that delay is the only thing standing between the attacker and the
treasury.

## 10. Fee model

A configurable percentage of **trading fees earned**, taken at claim: when the
engine compounds or the founder withdraws, accrued fees are split — Armara's
share to a treasury address, the remainder compounded or returned.

Recorded per claim in the ledger with the fee rate applied, so every charge is
reconstructable. Fees are only ever taken from *earned trading fees*, never
from principal — including when the position is down.

**Deliberately not net-profit-based.** For this customer, fees earned is the
honest measure: they were always going to provide liquidity, so charging on
"profit versus not doing the thing they had to do" would be incoherent. The
ledger computes net-vs-HODL anyway, so a change of model later is a
configuration decision rather than a rewrite.

## 11. What is retained from the shadow build

Most of it, and it is worth being precise because it is the difference between
this being a rewrite and an extension:

- **The decision engine, cost estimator, and signals** — pure, tested, and now
  drive real transactions instead of a simulated position.
- **The replay harness** — becomes how a strategy profile is validated against
  history before it is offered to founders.
- **The shadow simulation** — becomes dry-run mode. Every profile runs in
  shadow alongside live execution, which is how a profile change is justified
  with evidence rather than opinion.
- **The multi-tenant ledger, service contract, and Telegram bot layer.**
- **The `/why` reason trail**, which matters more now: a founder whose position
  just moved is owed an explanation, and almost no competitor can give one.

Genuinely new: `custody/`, `execution/`, `strategy/`, the token screen, and
SOL-quoted accounting.

## 12. Risks

**The strategy is unvalidated.** No shadow run ever completed, so no profile has
evidence behind it. Launch conditions — hour-one price discovery on a brand-new
token — are the most violent regime a token ever experiences and the least like
anything the engine was tuned against. Mitigation: devnet first, then a small
real launch that Armara owns, before a paying customer. This is the largest
open risk in the project and it is a product risk, not a code risk.

**Custody concentration.** Every project's funds are reachable by one service.
Mitigations in §3 and §8 reduce but do not eliminate this.

**Regulatory.** Holding customer funds and charging a fee for managing them may
carry money-services obligations in Canada. Out of scope for this document, and
worth a real answer before the first paying customer rather than after.

**Meteora launch-partner path.** If Armara becomes a launch partner, the
operator model may become available and custody could be removed entirely —
users would keep ownership and the bot would only manage the range. Worth
pursuing in parallel; it would be a materially better product and a stronger
sales position. The architecture keeps `custody/` behind a narrow interface so
that swap remains possible.

## 13. Open questions

1. **Which KMS?** Depends on where this deploys. Affects `custody/` only.
2. **Cap values.** Per-transaction and daily notional caps need real numbers.
3. **Performance fee percentage**, and whether it varies by profile.
4. **Does the bot create the pool, or also handle the token launch itself?**
   Assumed pool-only here.
5. **What happens at a launch that fails** — token goes to zero, position is
   worthless. Does the bot exit automatically, or wait to be told?
