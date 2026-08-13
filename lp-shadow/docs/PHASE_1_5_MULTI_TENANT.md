# Phase 1.5 — multi-tenant shadow, Telegram-native

The merge of the Armara LP agent product surface (Telegram-first, many projects,
one bot) with the Phase 1 engine's discipline (no keys, costed decisions, HODL
benchmark, deterministic replay).

**Status: the data layer is built** — schema, registry, scoped persistence and a
multi-pool loop all ship in this repo. The Telegram layer is still a sketch.

The claim it rests on: **the shadow report is a sellable product on its own.**
It needs no keys, no capital, and no permission from the project — every input is
public on-chain or public API. It is also the only way to build a track record
before you have customers.

Phase 1.5 ships that. Phase 2 adds signing, for pools that cleared the gate.

---

## 1. What changes, in one line each

| Area | Phase 1 today | Phase 1.5 |
| --- | --- | --- |
| Tenancy | one pool, hardcoded in TOML | many pools, many tenants, rows in Postgres |
| Config | `config/default.toml` | one versioned `StrategyVersion`, seeded from the TOML |
| Sizing | `virtual_nav_usd` in TOML | `ManagedPool.virtualNavUsd`, per pool |
| Interface | one daily Telegram report | full command tree, per tenant chat |
| Cursors | global `KeyValue` keys | `(scope, key)` — scope is a pool id, tenant id, or `global` |
| Loop | one `PoolReader` + one `LoopState` | a map of them, one per active pool |
| Lifecycle | process starts and stops | `mode` column: `SHADOW`, `PAUSED`, `STOPPED` |

Nothing in `decision/`, `virtual/`, `signals/` or `binMath.ts` changes at all. The
pure layer already takes `Params` as an argument, so "per-tenant parameters" is
already its native shape. That was the point of keeping it pure.

---

## 2. Schema

### New models

```prisma
model Tenant {
  id             String   @id @default(cuid())
  /// The parent bot's user/account id. Source of truth lives there.
  externalUserId String   @unique
  /// The solo chat this tenant was handed off into.
  telegramChatId String   @unique
  label          String
  status         String   @default("ACTIVE")
  createdAt      DateTime @default(now())
  pools          ManagedPool[]
}

model StrategyVersion {
  id         String   @id @default(cuid())
  version    Int      @unique
  paramsJson Json     // the flat Params object, minus per-pool sizing
  note       String   // required: why this version exists
  createdAt  DateTime @default(now())
}

model ManagedPool {
  id                String @id @default(cuid())
  tenantId          String
  strategyVersionId String
  poolAddress       String
  label             String
  /// Strategy is canonical; size is not.
  virtualNavUsd     Decimal @db.Decimal(38, 18)
  /// PRIMARY (the project's real size) | REFERENCE (fixed size for comparability)
  role              String  @default("PRIMARY")
  /// SHADOW | PAUSED | STOPPED
  mode              String  @default("SHADOW")
  stoppedAt         DateTime?

  @@unique([tenantId, poolAddress, role])
}
```

**Identity is imported, never established.** The parent bot authenticates the
user and hands off; `upsertTenant` records the result. The LP module owns no
authentication. The handoff should carry a short-lived signed token in a deep
link (`t.me/<bot>?start=<token>`) rather than trusting a bare `chat_id` — anyone
can message a bot, and the signature is what proves a real account is behind it.

**One canonical strategy, versioned.** Per-pool parameter copies would give you
twenty uncomparable experiments and no aggregate claim. `publishStrategyVersion`
is a no-op when the parameters are unchanged, so a restart does not churn
versions. (It compares with a canonical key ordering — Postgres `jsonb` does not
preserve key order, and a naive `JSON.stringify` comparison silently publishes a
new version on every boot.)

**The strategy version is stamped on every `Decision`.** That dissolves the
pin-vs-migrate dilemma: pools can be moved to a new version freely, and any
aggregate claim can still be sliced by version.

### Changes to existing models

Add to `Snapshot`, `VirtualPositionEvent`, `BenchmarkMark`, `ReplayRun`:

```prisma
  managedPoolId String
  managedPool   ManagedPool @relation(fields: [managedPoolId], references: [id], onDelete: Cascade)

  @@index([managedPoolId, ts])
```

Add the same to `Decision`. It is reachable through `Snapshot`, but denormalising
it means "last 24h of decisions for this pool" is one index scan instead of a
join, and that query runs on every `/status`.

`ReplayEvent` inherits scope through `ReplayRun`; leave it alone.

### KeyValue

```prisma
model KeyValue {
  /// "global", a ManagedPool id, or a Tenant id.
  scope     String
  key       String
  value     Json
  updatedAt DateTime @updatedAt

  @@id([scope, key])
}
```

A non-null `scope` rather than a nullable `managedPoolId`, because Postgres treats
`NULL` as distinct from `NULL` in unique constraints — a nullable FK would silently
fail to enforce uniqueness on exactly the global rows it needs to.

Scope assignment:

- `pool:cumulativeTradeFeeUsd` → scope = ManagedPool id (per pool)
- `benchmark:state` → scope = ManagedPool id (per pool)
- `report:lastDailyReportDay` → scope = **Tenant** id (one report per chat per day,
  covering all their pools)

### Migration

Applied as `20260813053730_multi_tenant`. It adds required foreign keys, so it
only runs cleanly against empty tables — which is why it was done before the
first real shadow run rather than after. If you have already collected data,
drop and re-migrate; there is nothing worth keeping yet.

---

## 3. Command tree

Remapped from the Armara plan for a keyless agent. The shape is theirs; the
capabilities are what shadow mode can actually back.

| Command | What it does | Backed by |
| --- | --- | --- |
| deep-link handoff | verify the parent bot's signed token, upsert the tenant | `upsertTenant` |
| `/add <pool url or address>` | validate the pool, show pair / TVL / 24h volume / bin step, confirm, create in `SHADOW` | `fetchPoolStats`, `PoolReader.create` |
| `/pools` | list this tenant's pools with mode and days of data | `ManagedPool` |
| `/status [pool]` | NAV vs HODL vs full-range, fees, costs, time in range, current range vs price | `buildDailyReport` |
| `/why [pool]` | the full gate-by-gate reason trail of the last non-HOLD decision, and how close the open gates are | `Decision.reasonsJson` |
| `/strategy` | show the canonical strategy and what each gate is for (read-only) | `StrategyVersion` |
| `/replay [pool]` | run the parameter sweep over stored snapshots, return the comparison table | `runVariant` |
| `/verdict [pool]` | the three go-live conditions and where each stands | `evaluateGoLive` |
| `/pause`, `/resume` | `mode` between `SHADOW` and `PAUSED` | `setPoolMode` |
| `/remove` | `mode` → `STOPPED`, keep the history | `setPoolMode` |

Push notifications, unchanged from Phase 1: daily report at 07:00 tenant-local,
immediate EXIT alert, immediate price-divergence alert.

### Deliberately absent

`/wallet`, `/harvest`, `/rebalance` (force-execute), `/close`. Every one requires a
key. Their absence is not an unfinished feature — it is the product guarantee, and
the onboarding copy should say so in the first message:

> I never ask for a private key and I cannot hold one. I watch your pool and tell
> you what active management *would* have earned, against just holding. When the
> evidence says it's worth doing, you decide what happens next.

### `/why` is the differentiator

Every rule-based competitor logs what it did. Almost none log what it *didn't* do
and why. We already store the full gate trail on every tick, including the HOLDs —
so `/why` can answer "why didn't you rebalance when we went out of range this
morning?" with:

```
b. oor dwell PASS: 47.0min out of range, needs 30.0min
c. edge overshoot PASS: 1.83% past nearest edge, needs 1.00%
d. settled FAIL: price still running — do not rebalance into a trend
e. cost coverage PASS: expected 7d recapture $41.20 vs 3.0x est. cost $28.14
```

A treasury can read that and disagree with it. That is worth more to a project
than a higher headline APR, and an LLM-in-the-loop design structurally cannot
produce it.

---

## 4. Loop changes

```
boot:
  pools = ManagedPool.findMany({ mode: 'SHADOW' })
  for each: reader = PoolReader.create(rpc, pool.poolAddress)
            state  = bootstrap(prisma, params(pool), reader, pool.id)
  runners = Map<managedPoolId, { reader, state, params }>

tick (every snapshot_interval_sec):
  for each runner: tick(...)  // unchanged internals, scoped writes
  reconcile: pick up newly added pools, drop paused ones
```

`tick` itself needs only the `managedPoolId` threaded into the five persist calls.
Its logic is untouched.

**Capacity.** Each tick is roughly three RPC calls per pool (`refetchStates`,
`getBinsAroundActiveBin`, `getMultipleAccountsInfo`) plus one Meteora API call, one
Jupiter price call, one Jupiter quote, one priority-fee call. At a 45s interval,
100 pools is about 7 RPC/s and 2 Meteora req/s — comfortably inside Helius paid
tiers and the datapi's 30 rps limit. The binding constraint arrives around several
hundred pools, and the fix then is staggering ticks rather than sharding.

**Shared fetches.** SOL price and the priority-fee estimate are identical across
every pool on a given tick. Fetch once per tick, not once per pool. Worth doing at
the same time as the multi-tenancy change, since it's the same code path.

---

## 5. Build order

| Step | Work | Effort |
| --- | --- | --- |
| 1 | ~~Schema + scoped persist + multi-pool loop~~ | **done** |
| 2 | grammY bot: `/start`, `/add`, `/pools`, `/status`, `/why` | ~2 days |
| 3 | `/settings`, `/replay`, `/verdict`, `/pause`, `/remove` | ~1 day |
| 4 | Onboarding copy, inline keyboards, error states | ~1 day |

Step 1 is done. What exists now: `src/ledger/registry.ts` (tenants, strategy
versions, pools, and the survivorship-safe `trackRecord` query), pool-scoped
persistence, and a loop that ticks every `SHADOW` pool and reconciles additions
and pauses without a restart. Shared price fetching happens once per tick across
all pools rather than once per pool.

`pnpm replay` and `pnpm report` are both pool-scoped (`--pool <id>`, defaulting
to the oldest pool and all active pools respectively).

---

## 6. Decisions, settled

**A tenant is a user, not a chat.** The parent bot hands users into a solo chat,
so ownership is unambiguous. If a project team later needs a shared view, the fix
is a `Tenant` → `Organization` layer, not a chat binding.

**The project picks the size; a reference run keeps things comparable.** Size is
not cosmetic — fixed costs dominate a small position and self-dilution plus
slippage eat a large one, so there is a viable band and it differs per pool. A
project asking "should *we* do this" needs their own number. The `REFERENCE` role
exists so a fixed-size run can sit alongside the real one and feed the cross-pool
track record.

Because `virtualNavUsd` is just a `Param`, `/replay` can sweep it, which turns
sizing into an answerable question rather than a guess:

```
size      final NAV     vs HODL   fees    costs   rebal
 $10,000    10,180.22   +$32.10   118.40   86.30      6
 $50,000    51,640.05  +$390.50   604.20   93.15      6
$250,000   252,100.80  −$410.20  2,180.60 271.40      6
```

**One canonical strategy.** Parameters are exposed through `/replay` only, so a
project can see what a different setting would have done without fragmenting the
record. Promote a change to canonical only when the sweep wins across the whole
portfolio, not one pool.

## 7. The survivorship rule

The sellable artifact is "beat HODL on N of M pools." That number is worthless —
actively misleading — if pools that did badly get quietly dropped.

`trackRecord()` in `src/ledger/registry.ts` therefore counts `STOPPED` pools, and
a test asserts it. The decision is made once, in one place, rather than at each
call site where it would eventually be gotten wrong. Credibility is very hard to
add back to a number after the fact.
