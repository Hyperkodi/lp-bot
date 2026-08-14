# lp-shadow — Telegram bot layer (front-end spec)

This document is the complete specification for the **Telegram front-end** of
lp-shadow Phase 1.5. It is written for an implementer who has *not* read the
rest of this repo. Everything the bot layer is allowed to touch is defined
here; the rest of the codebase is off-limits and enforced by ESLint.

Read `docs/PHASE_1_5_MULTI_TENANT.md` §3 for the product rationale. This file
is the buildable contract.

---

## 1. The split

| Side | Owns | Lives in |
| --- | --- | --- |
| **Back-end** (already built) | engine, ledger, pollers, reports, replay, and the **service layer** `src/service/` | everything except `src/bot/` |
| **Front-end** (this spec) | grammY bot: command routing, conversation state, HTML rendering, inline keyboards, onboarding copy, error presentation | `src/bot/**` only |

**The boundary rule (ESLint-enforced, allowlist):** files in `src/bot/` may
import only `src/service/index.js`, sibling files in `src/bot/`, `grammy`,
and `node:` built-ins. Every other import — deep service files, `ledger/`,
`poller/`, the generated Prisma client, `@prisma/*`, `@solana/web3.js`,
`scripts/`, anything — fails `pnpm lint`, and dynamic `import()` is banned
outright. All data access goes through the service contract below.

**The product guarantee:** this bot never asks for, receives, or stores a
private key, and has no code path that could sign a transaction. The repo's
lint rules fail the build on key-capable imports. The onboarding copy states
the guarantee out loud (see §5).

## 2. Runtime

- Entry point: `src/bot/main.ts`, started with `pnpm bot` (script exists).
- Library: `grammy` (already in `package.json`). Long polling, no webhook.
- Obtain the bot token via `service.getBotToken()` — do not read `process.env`.
  If the token is empty, log an error and exit with code 1.
- The bot process is separate from the shadow loop (`pnpm dev`). Both talk to
  the same Postgres through the service layer. The bot must not start the loop.
- Send all messages with `parse_mode: 'HTML'` and `link_preview_options:
  { is_disabled: true }`.
- Telegram messages cap at 4096 chars. Split longer payloads on line breaks
  into sequential messages; never truncate silently.
- Wrap every handler in a try/catch: `ServiceError` maps to friendly copy
  (§6); anything else logs the stack and replies
  "Something went wrong on my end — that's been logged. Try again in a minute."

## 3. The service contract

Everything below is exported from `src/service/index.js`. Signatures are
authoritative — the back-end implements exactly this.

```ts
import {
  createService,
  ServiceError,
  type LpShadowService,
  type TenantRef, type PoolSummary, type PoolPreview,
  type StatusReport, type WhyReport, type DecisionDetail,
  type StrategyInfo, type VerdictReport, type ReplayReport,
} from '../service/index.js';

// Connects to Postgres, seeds the canonical strategy if absent. Call once at boot.
const service: LpShadowService = await createService();

type LpShadowService = {
  /** Deep-link handoff: verify a one-time token from the parent bot, bind it to this chat. */
  redeemHandoff(token: string, telegramChatId: string): Promise<TenantRef>;
  /** null when this chat has never been handed off. */
  getTenantByChatId(telegramChatId: string): Promise<TenantRef | null>;

  /** Validate a pool address and fetch its public stats for the /add preview. */
  previewPool(poolAddress: string): Promise<PoolPreview>;
  /** Register a pool in SHADOW mode under the canonical strategy. */
  addPool(tenantId: string, input: {
    poolAddress: string; label: string; virtualNavUsd: number;
  }): Promise<PoolSummary>;
  listPools(tenantId: string): Promise<PoolSummary[]>;

  /**
   * poolRef may be a managedPoolId, a pool address, or a label
   * (case-insensitive). Omitted => the tenant's only non-stopped pool.
   */
  getStatus(tenantId: string, poolRef?: string): Promise<StatusReport>;
  getWhy(tenantId: string, poolRef?: string): Promise<WhyReport>;
  getVerdict(tenantId: string, poolRef?: string): Promise<VerdictReport>;
  /** Window defaults to the last 30 days; pass fromDays to widen or narrow. */
  runReplay(tenantId: string, poolRef?: string, opts?: { fromDays?: number }): Promise<ReplayReport>;
  getStrategy(): Promise<StrategyInfo>;
  /** Read-only initial-liquidity planning; never builds or sends a transaction. */
  planInitialLiquidity(input: InitialLiquidityPlanRequest): Promise<InitialLiquidityPlanningReport>;

  pausePool(tenantId: string, poolRef?: string): Promise<PoolSummary>;   // SHADOW -> PAUSED
  resumePool(tenantId: string, poolRef?: string): Promise<PoolSummary>;  // PAUSED -> SHADOW
  removePool(tenantId: string, poolRef?: string): Promise<PoolSummary>;  // -> STOPPED (history kept)

  getBotToken(): string;
  close(): Promise<void>;
};

type TenantRef = { tenantId: string; externalUserId: string; telegramChatId: string; label: string };

type PoolSummary = {
  managedPoolId: string; label: string; poolAddress: string;
  mode: 'SHADOW' | 'PAUSED' | 'STOPPED'; role: 'PRIMARY' | 'REFERENCE';
  virtualNavUsd: number; strategyVersion: number;
  createdAt: string;      // ISO 8601
  daysOfData: number;     // 0 when no snapshots yet
};

type PoolPreview = {
  poolAddress: string;
  name: string | null;        // e.g. "SOL-USDC"
  tvlUsd: number | null; vol24hUsd: number | null; fees24hUsd: number | null;
  binStepBps: number | null; currentPrice: number | null;
};

type StatusReport = {
  pool: PoolSummary;
  /** Telegram-ready HTML (NAV vs HODL vs full-range, fees, costs, time in
   *  range, pool stats, recent decisions). Send as-is; do NOT re-escape. */
  html: string;
  verdictPass: boolean;
};

type DecisionDetail = { kind: string; ts: string; reasons: string[]; applied: boolean };

type WhyReport = {
  pool: PoolSummary;
  lastNonHold: DecisionDetail | null;  // most recent COMPOUND/REBALANCE/EXIT, any age
  latest: DecisionDetail | null;       // most recent decision of any kind
  decisions24h: Record<string, number>; // e.g. { HOLD: 91, COMPOUND: 1 }
};

type StrategyInfo = { version: number; note: string; createdAt: string; params: Record<string, unknown> };

type VerdictReport = {
  pool: PoolSummary;
  shadowDays: number; hasRegimeChange: boolean; regimeRatio: number;
  beatsHodl: boolean; pass: boolean;
  lines: string[];   // three pre-rendered "✅/❌ ..." plain-text lines — escape before embedding in HTML
};

type ReplayReport = {
  pool: PoolSummary;
  fromTs: string; toTs: string;
  snapshots: number;           // 0 => nothing to replay yet
  results: {
    variant: string; ticks: number;
    finalNavUsd: number; hodlNavUsd: number; netVsHodlUsd: number; fullRangeUsd: number;
    totalFeesUsd: number; totalCostsUsd: number;
    rebalances: number; compounds: number; timeInRange: number; exited: boolean;
  }[];
};
```

`ServiceError` has a `code` field (union below) and a human-oriented
`message`. Never show raw messages of *unexpected* errors to the user;
`ServiceError.message` is written to be shown.

```ts
type ServiceErrorCode =
  | 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'CHAT_ALREADY_LINKED' | 'ACCOUNT_SUSPENDED'
  | 'NOT_REGISTERED'
  | 'POOL_NOT_FOUND' | 'POOL_AMBIGUOUS' | 'NO_POOLS' | 'DUPLICATE_POOL'
  | 'POOL_UNREACHABLE' | 'INVALID_INPUT';
```

## 4. Command tree

Register all commands with `setMyCommands` at boot so Telegram shows the menu.

| Command | Behavior |
| --- | --- |
| `/start <token>` | `redeemHandoff(token, chatId)`; on success send the welcome (§5). No token: if `getTenantByChatId` finds a tenant, send the returning-user greeting; otherwise send the not-registered copy. |
| `/help` | List commands with one-line descriptions, restate the keyless guarantee. |
| `/add <address>` | `previewPool`; render preview (name, TVL, 24h vol, 24h fees, bin step); ask "How much would you actually deploy, in USD?"; the next plain number message from that chat completes it; then an inline-keyboard confirm (Shadow it / Cancel) calls `addPool` with `label = preview.name ?? address.slice(0, 8)`. |
| `/launchplan` | Prompt for token amount, SOL amount, total supply, verified token decimals, and SOL/USD. Render the read-only 69-bin Spot planning default, cost estimate, buyer-capacity curve, and remaining blockers. Explicitly say that nothing launches, signs, or moves funds. |
| `/pools` | `listPools`; table of label, mode, size, days of data. Empty: point at `/add`. |
| `/status [pool]` | `getStatus`; send `html` as-is. |
| `/why [pool]` | `getWhy`; render §5 layout from the structured fields. |
| `/strategy` | `getStrategy`; version, note, date, then the gate parameters grouped (rebalance / compound / exit / golive keys) with one-line explanations from §5. |
| `/replay [pool]` | `runReplay`; `snapshots === 0` => "No stored snapshots yet — the loop needs to run first." Else render the variants as an aligned `<pre>` table (variant, net vs HODL, fees, costs, rebal, in-range). |
| `/verdict [pool]` | `getVerdict`; the three lines, then "GATE CLEAR — worth discussing next steps." or "KEEP SHADOWING." |
| `/pause [pool]`, `/resume [pool]` | `pausePool` / `resumePool`; confirm what changed. |
| `/remove [pool]` | Inline-keyboard confirm ("Stop shadowing — history is kept") then `removePool`. |

Every command except `/start` and `/help` first resolves the tenant via
`getTenantByChatId`; `null` => the not-registered copy (§5). `[pool]` is the
raw remainder of the message text, passed to the service verbatim (trimmed);
the service does the matching.

**Conversation state** (the pending `/add` size question, `/launchplan` input, and pending
confirmations) may live in an in-memory `Map<chatId, PendingState>` — this is
v1, a restart may drop a pending prompt mid-flow and that is acceptable. A
fresh `/add` or `/cancel` clears the chat's pending state.

## 5. Copy

Verbatim where quoted; match the register elsewhere: plain, confident, no
hype, no emoji outside status marks (✅ ❌ ⚠️ 🚨).

**Welcome (after successful handoff):**
> I never ask for a private key and I cannot hold one. I watch your pool and
> tell you what active management *would* have earned, against just holding.
> When the evidence says it's worth doing, you decide what happens next.
>
> Add your first pool with /add — paste a Meteora DLMM pool address.

**Not registered:**
> This chat isn't linked to an account yet. Ask the Armara bot for an LP-agent
> link — it hands you off here with a one-time token.

**`/why` layout:** header with pool label; if `lastNonHold` exists: kind +
timestamp, then each reason as a `•` bullet line (escape HTML). Then "Since
then: HOLD ×N" from `decisions24h`. If `lastNonHold` is null: "No non-HOLD
decisions yet. The latest tick decided:" followed by `latest` reasons — that
trail shows which gates are open and how close the closed ones are.

**`/strategy` gate explanations (one line each, reuse verbatim):**
- exit: "leave when the pool's volume/TVL stays under the floor too long"
- rebalance: "re-centre only when out of range, past the edge, settled, and the fees would repay the cost"
- compound: "fold pending fees back in once they clear the minimum"
- golive: "the advisory gate: enough days, a regime change, and beating HODL"

**Errors (§3 codes):** `HANDOFF_INVALID` → "That link didn't check out — ask
the Armara bot for a fresh one."; `HANDOFF_EXPIRED` → "That link expired —
they're one-time and short-lived. Ask the Armara bot for a fresh one.";
`NO_POOLS` → "No pools yet — add one with /add."; `POOL_AMBIGUOUS` → show the
matching labels and ask which; `DUPLICATE_POOL` → "Already shadowing that
pool."; `POOL_UNREACHABLE` → "That doesn't look like a reachable Meteora DLMM
pool — check the address."; others: show `ServiceError.message`.

## 6. Escaping rule

`StatusReport.html` is already HTML — send untouched. Everything else the bot
composes is plain text that must pass through an `escapeHtml` (escape `&`,
`<`, `>`) before being wrapped in the bot's own `<b>`/`<i>`/`<pre>` tags.
Reasons strings, labels, and `VerdictReport.lines` are plain text.

## 7. Out of scope — do not build

- `/wallet`, `/harvest`, `/rebalance`, `/close`, `/settings` — absent by
  design; their absence is the product guarantee (and sizing changes are
  `/remove` + `/add`, which keeps the evidence honest).
- No webhooks, no HTTP server, no database migrations, no new dependencies,
  no changes outside `src/bot/`, no edits to the service layer — if the
  contract seems wrong, stop and flag it instead of patching around it.

### Initial-liquidity planning extension

`/launchplan` is the only launch-related command. It is read-only and cannot
confirm or execute a launch. For this extension, pure planning additions to the
service contract are in scope; signing, sending, webhooks, HTTP endpoints,
database migrations, and new dependencies remain out of scope. This extension
supersedes the older bot-only boundary above only for the pure planning method.

## 8. Acceptance

1. `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass (bot handlers should
   be structured so command → service call → render is testable; a vitest
   file for the renderers with fixture data is expected — test that `/why`
   escapes `<` in reasons, `/replay` renders a 0-snapshot report, chunking
   splits >4096-char payloads).
2. With `DATABASE_URL` + `TELEGRAM_BOT_TOKEN` set, `pnpm bot` starts, and the
   full flow works against a scratch DB: issue a token with
   `pnpm handoff:issue --user test-1 --label "Test"`, deep-link `/start`,
   `/add` a real DLMM pool address through the confirm flow, `/pools`,
   `/status`, `/why`, `/pause`, `/resume`, `/remove`.
3. `git grep -iE 'keypair|mnemonic|private.?key' src/bot/` returns nothing.
