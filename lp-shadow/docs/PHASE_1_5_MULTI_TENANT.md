# Phase 1.5 — multi-tenant shadow, Telegram-native

Design sketch. Not built. This is the merge of the Armara LP agent product surface
(Telegram-first, many projects, one bot) with the Phase 1 engine's discipline (no
keys, costed decisions, HODL benchmark, deterministic replay).

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
| Config | `config/default.toml` | `ManagedPool.paramsJson`, seeded from the TOML defaults |
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
  label          String
  /// The Telegram chat this tenant is bound to. Reports and alerts go here.
  telegramChatId String   @unique
  status         String   @default("ACTIVE")  // ACTIVE | SUSPENDED
  createdAt      DateTime @default(now())
  pools          ManagedPool[]
}

model ManagedPool {
  id          String   @id @default(cuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  poolAddress String
  label       String
  /// The flat Params object for this pool, as JSON. Seeded from the shipped
  /// defaults; edited through /settings.
  paramsJson  Json
  /// SHADOW | PAUSED | STOPPED.
  ///
  /// Phase 1.5 accepts no other value, and the loop asserts it. When Phase 2
  /// adds LIVE this column is where the kill switch lives — flip to PAUSED and
  /// the agent stops acting without a deploy.
  mode        String   @default("SHADOW")
  createdAt   DateTime @default(now())

  snapshots  Snapshot[]
  decisions  Decision[]
  events     VirtualPositionEvent[]
  benchmarks BenchmarkMark[]
  replayRuns ReplayRun[]

  /// One shadow run per pool per tenant. Two different tenants may shadow the
  /// same pool independently with different parameters.
  @@unique([tenantId, poolAddress])
  @@index([mode])
}
```

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

The current database holds exactly one pool's data with no way to attribute it.
If this is done **before** the first real run, it is a clean `migrate dev` against
an empty database. If done after, every existing row needs backfilling with a
synthesised `ManagedPool` — recoverable, but a migration you have to think about
while six weeks of irreplaceable evidence sits in the table.

Do it while the table is empty.

---

## 3. Command tree

Remapped from the Armara plan for a keyless agent. The shape is theirs; the
capabilities are what shadow mode can actually back.

| Command | What it does | Backed by |
| --- | --- | --- |
| `/start` | register tenant, bind the chat | `Tenant` |
| `/add <pool url or address>` | validate the pool, show pair / TVL / 24h volume / bin step, confirm, create in `SHADOW` | `fetchPoolStats`, `PoolReader.create` |
| `/pools` | list this tenant's pools with mode and days of data | `ManagedPool` |
| `/status [pool]` | NAV vs HODL vs full-range, fees, costs, time in range, current range vs price | `buildDailyReport` |
| `/why [pool]` | the full gate-by-gate reason trail of the last non-HOLD decision, and how close the open gates are | `Decision.reasonsJson` |
| `/settings [pool]` | edit `width_k`, dwell, overshoot, cost coverage | `applyOverrides` + zod |
| `/replay [pool]` | run the parameter sweep over stored snapshots, return the comparison table | `runVariant` |
| `/verdict [pool]` | the three go-live conditions and where each stands | `evaluateGoLive` |
| `/pause`, `/resume` | `mode` between `SHADOW` and `PAUSED` | `ManagedPool.mode` |
| `/remove` | `mode` → `STOPPED`, keep the history | `ManagedPool.mode` |

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
| 1 | Schema + scoped persist + multi-pool loop | ~1 day |
| 2 | grammY bot: `/start`, `/add`, `/pools`, `/status`, `/why` | ~2 days |
| 3 | `/settings`, `/replay`, `/verdict`, `/pause`, `/remove` | ~1 day |
| 4 | Onboarding copy, inline keyboards, error states | ~1 day |

Step 1 is the only one with a deadline attached, because it is free now and
expensive after the first real run.

---

## 6. Decisions needed before step 1

**Is a tenant a Telegram chat or a Telegram user?** Binding to a chat lets a whole
project team share one view, which is what a treasury actually wants — but any
member can then change parameters. Binding to a user gives clean ownership and a
worse group experience. Recommendation: bind to the chat, record which user issued
each mutating command.

**Who picks the virtual NAV?** Letting each project choose makes the number feel
relevant to them. Fixing it at $10k across every pool makes results comparable, and
comparability is what turns twenty shadow runs into a track record. Recommendation:
fix it, and show percentages rather than dollars in the report.

**One strategy or per-project parameters?** This is the important one, and it isn't
really a technical question.

If every project tunes its own `width_k` and dwell, you have twenty uncomparable
experiments and no aggregate claim. If everyone runs the same canonical strategy,
then after twenty pools you can say: *our strategy beat HODL on fourteen of twenty
pools over an average of six weeks, net of costs* — and that sentence is the entire
business.

Recommendation: one canonical strategy in production, parameters exposed through
`/replay` only, so a project can *see* what a different setting would have done
without fragmenting the record. Promote a parameter change to canonical only when
the sweep says it wins across the whole portfolio, not one pool.
