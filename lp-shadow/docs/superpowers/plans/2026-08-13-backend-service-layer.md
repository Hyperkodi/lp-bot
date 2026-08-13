# lp-shadow Backend Service Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Telegram-agnostic service layer (`src/service/`) that the grammY bot front-end consumes, per the contract in `docs/FRONTEND_TELEGRAM_BOT.md` §3, plus the one-time handoff-token mechanism and the ESLint boundary that keeps the bot layer honest.

**Architecture:** A `createService()` factory wires Prisma + config into an `LpShadowService` object of thin, ownership-checked functions over the existing registry/report/replay modules. Handoff tokens are opaque 32-char random strings stored one-time in `KeyValue` (scope `global`, key `handoff:<token>`) — server-side storage is strictly stronger than the signed-token sketch in PHASE_1_5 §2 (revocable, one-time by construction, fits Telegram's 64-char start payload). No schema migration needed.

**Tech Stack:** TypeScript ESM, Prisma 7 (pg adapter), zod, vitest, node:crypto (randomBytes only — no key derivation).

**Spec:** `docs/FRONTEND_TELEGRAM_BOT.md` (contract), `docs/PHASE_1_5_MULTI_TENANT.md` (product).

## Global Constraints

- No wallet/keypair/signing code; the ESLint no-key rule stays on `src/**`.
- `decision/`, `virtual/`, `signals/`, `binMath.ts` are untouched.
- Service functions that act on a pool must scope every query by `tenantId`.
- All DB-backed tests follow the `describe.skipIf(!hasDatabase)` pattern from `test/loop.test.ts` and truncate what they touch.
- Errors surfaced to the bot are `ServiceError` with a `code` from the contract union and a message safe to show a user.

---

### Task 1: Errors + contract types

**Files:**
- Create: `src/service/errors.ts` — `ServiceErrorCode` union (exact §3 list), `class ServiceError extends Error { constructor(code, message) }`.
- Create: `src/service/types.ts` — `TenantRef`, `PoolSummary`, `PoolPreview`, `StatusReport`, `DecisionDetail`, `WhyReport`, `StrategyInfo`, `VerdictReport`, `ReplayReport` exactly as in the spec §3.

**Interfaces:** Produces every type later tasks import. No logic, no tests beyond typecheck.

- [ ] Write both files verbatim from the spec. Run `pnpm typecheck`.

### Task 2: Handoff tokens

**Files:**
- Create: `src/service/handoff.ts`
- Create: `scripts/issue-handoff.ts` (CLI: `--user <id> --label <label> [--ttl-min 15]`)
- Test: `test/service.test.ts` (started here, extended in later tasks)
- Modify: `package.json` — add script `"handoff:issue": "tsx scripts/issue-handoff.ts"`

**Interfaces:**
- Produces: `newHandoffToken(): string` (24 random bytes, base64url, 32 chars, charset `[A-Za-z0-9_-]`); `issueHandoff(prisma, { externalUserId, label, ttlMinutes? }): Promise<{ token: string; expiresAt: Date }>`; `redeemHandoff(prisma, token, telegramChatId): Promise<TenantRef>`.
- Storage: `KeyValue { scope: 'global', key: 'handoff:'+token, value: { externalUserId, label, exp } }`; redeem deletes the row then `upsertTenant` (registry) in one transaction; unknown → `HANDOFF_INVALID`, expired → delete + `HANDOFF_EXPIRED`.

- [ ] Pure test first: token length/charset/uniqueness. DB tests: issue→redeem creates tenant; second redeem → `HANDOFF_INVALID`; `ttlMinutes: -1` → `HANDOFF_EXPIRED`. Implement, `pnpm test`.

### Task 3: Pool registry service (preview / add / list / resolve / mode)

**Files:**
- Create: `src/service/pools.ts`
- Modify: `src/poller/meteoraApi.ts` — add `name?: string` to `PoolStats` and map `body.name` (additive).
- Test: extend `test/service.test.ts` (mock `../src/poller/meteoraApi.js` with `vi.mock`)

**Interfaces:**
- Produces: `previewPool(address): Promise<PoolPreview>` (base58-validate via `new PublicKey(address)` → `INVALID_INPUT`; fetch failure or missing `binStepBps` → `POOL_UNREACHABLE`); `addPool(prisma, strategy, tenantId, { poolAddress, label, virtualNavUsd })` (nav > 0 else `INVALID_INPUT`; P2002 → `DUPLICATE_POOL`); `listPools(prisma, tenantId): Promise<PoolSummary[]>` (`daysOfData` = first-snapshot → now); `resolvePoolRow(prisma, tenantId, ref?)` → full row incl. `strategyVersion` (omitted ref: sole non-STOPPED pool else `NO_POOLS`/`POOL_AMBIGUOUS`; ref matches id, address, then case-insensitive label; >1 label match → `POOL_AMBIGUOUS` listing labels in message); `setMode(prisma, tenantId, ref, mode)` (pause: SHADOW→PAUSED; resume: PAUSED→SHADOW; remove: any→STOPPED once; wrong start state → `INVALID_INPUT`); `toPoolSummary(row, daysOfData)`.

- [ ] Tests: resolve by label/address/omitted, ambiguity, duplicate add, mode transitions incl. resume-on-STOPPED rejection. Implement, `pnpm test`.

### Task 4: Reports service (status / why / strategy / verdict)

**Files:**
- Create: `src/service/reports.ts`
- Test: extend `test/service.test.ts` (insert Snapshot/Decision rows directly)

**Interfaces:**
- Consumes: `buildDailyReport`, `evaluateGoLive` (report/daily.js), `paramsForPool`+`toParams`+`loadRawConfig` (config.js), `resolvePoolRow`.
- Produces: `getStatus` → `{ pool, html: buildDailyReport(...).text, verdictPass }` with `includeGoLive: true` (the bot has no weekly cadence; on-demand status always shows the gate); `getWhy` → lastNonHold (any age), latest, `decisions24h` via `groupBy kind`; `getStrategy` → latest StrategyVersion (`NOT_FOUND`-free: seed guarantees one); `getVerdict` → spread of `evaluateGoLive`.

- [ ] Tests: `getWhy` returns reasons arrays and 24h counts; `getVerdict` fails all three gates on an empty pool. Implement, `pnpm test`.

### Task 5: Replay service

**Files:**
- Modify: `src/replay/replay.ts` — `export` on existing `loadSnapshots` and `loadVariants` (no body changes).
- Create: `src/service/replay.ts`

**Interfaces:**
- Produces: `runReplayForPool(prisma, row, opts?: { fromDays? })`: overlay pool address/label/nav on `config/default.toml` via `applyOverrides` (mirrors replay `main()`), variants from `config/sweep.toml`, `runVariant` per variant, never persists (`ReplayRun` stays a CLI artifact), returns `ReplayReport` (events dropped; `snapshots: stored.length`).

- [ ] Test: 0-snapshot pool → `snapshots: 0`, `results: []`… then with seeded synthetic snapshots the baseline variant returns finite NAV. Implement, `pnpm test`.

### Task 6: `createService()` factory + barrel + boundary + deps

**Files:**
- Create: `src/service/api.ts` — `createService()`: `loadEnv`, `getPrisma`, `publishStrategyVersion(configParams, 'seeded from config/default.toml')` (idempotent), binds every contract method with the tenant-scoping glue; `getBotToken()` returns `env.TELEGRAM_BOT_TOKEN`; `close()` → `disconnectPrisma()`.
- Create: `src/service/index.ts` — barrel re-exporting the contract surface only.
- Modify: `eslint.config.js` — new block for `src/bot/**/*.ts`: `no-restricted-imports` banning `**/ledger/**`, `**/poller/**`, `**/decision/**`, `**/virtual/**`, `**/signals/**`, `**/replay/**`, `**/report/**`, `**/generated/**`, `**/config.js`, `**/binMath.js`.
- Modify: `package.json` — scripts `"bot": "tsx src/bot/main.ts"`; dependency `grammy` (pnpm add, lockfile updated) so the FE needs no dependency changes.
- Modify: `README.md` — short "Bot layer" section pointing at the two docs and the boundary rule.

- [ ] End-to-end DB test through `createService()`: redeem → add (mocked stats) → status/why/verdict → pause → remove. `pnpm typecheck && pnpm lint && pnpm test`. Commit.

## Self-Review Notes

- Spec coverage: every `LpShadowService` method in FRONTEND spec §3 lands in Tasks 2–6; §4 command backings all resolve to a method; handoff CLI (spec §8.2) is Task 2.
- Deviation from PHASE_1_5 §2 recorded above (stored one-time token vs signed payload) with rationale.
- `/settings` intentionally absent (PHASE_1_5 §6: parameters through `/replay` only; sizing changes = `/remove` + `/add`).
