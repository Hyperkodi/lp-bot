# Custodial LP optimizer status

Updated 2026-08-13 on `main`, starting from design commit `926d780`.

## Completed

### 1. Ledger schema

- Added immutable `StrategyProfile` / `StrategyProfileVersion` records and
  stamped `ManagedPool` and `Decision` with a profile version.
- Added `ProjectWallet`, `DepositEvent`, `ExecutionIntent`,
  `ExecutionOutcome`, `FeeCharge`, `WithdrawalRequest`, and
  `AddressChangeRequest`.
- `ProjectWallet` persists ciphertext, an encrypted data key, public metadata,
  and no plaintext signing field.
- Added a migration compatibility profile for all retained Phase 1 rows.
- Added database checks that a performance charge is exactly
  `earnedAmount * rateBps / 10000`, with a rate from 0 to 100%, so principal
  cannot be recorded as a fee.

Commits: `85c3f19`, fee invariant in `2321627`.

### 2. Strategy profiles and launch guard

- Added Fee Maximizer, Market Depth, and Treasury Defensive as typed overlays
  on the retained pure engine parameters.
- Stored DLMM shape, default bin step, honest founder-facing trade-off, and the
  24-hour launch-guard value with each profile definition.
- Built idempotent publishing of immutable profile versions.
- Added a pure launch guard that suppresses only `REBALANCE`, preserves the
  complete would-be reason trail, and leaves compounding and exits available.

Commit: `e0aeb26`.

### 3. Custody

- Added one independently generated Solana wallet per project.
- Added AES-256-GCM envelope encryption with a random data key per wallet.
- Added `LocalKmsAdapter`, using a base64-encoded 32-byte
  `LPBOT_LOCAL_KMS_MASTER_KEY` for development only.
- Added an explicit unimplemented cloud KMS adapter; no provider was selected.
- Plaintext is confined to `src/custody`, never returned, and temporary data
  key, secret, and signer buffers are zeroed after use.
- The custody signing API accepts only the literal `devnet` cluster.
- ESLint now permits key-capable imports only in `src/custody`; only
  `src/execution` may import custody. Temporary probes demonstrated both rules
  fail lint and were deleted.

Commit: `22d1ec3`; devnet-only signature tightened in `2321627`.

### 4. Execution pipeline

The pipeline order is implemented as:

1. database kill switch;
2. per-project PostgreSQL advisory transaction lock;
3. durable, unique idempotent intent;
4. Meteora-SDK-only builder boundary;
5. program and destination inspection;
6. per-transaction, project rolling-24-hour, and global rolling-24-hour caps;
7. mandatory simulation;
8. custody signing, send, confirmed action state, finalized terminal state,
   and chain-state reconciliation.

Additional safeguards:

- Signing RPC construction and pipeline execution reject non-devnet endpoints.
- Program inspection covers System, SPL Token, Token-2022, Associated Token,
  Compute Budget, and configured Meteora program ids.
- Economic destinations are restricted to the founder address/ATAs, Armara
  treasury/ATAs during `FEE_SETTLEMENT` only, pool program accounts, or the
  project wallet.
- `SetAuthority`, foreign `CloseAccount`, foreign transfers, foreign programs,
  and intent/notional mismatches abort before signing.
- Unknown confirmations always trigger a chain read before retry. Retries use
  the same intent, are bounded, and partial actions require an SDK-built
  completion path. Otherwise the intent becomes `STUCK` and alerts.
- An ops-alert callback covers kill switch, lock contention, cap trips,
  simulation failures, and reconciler exhaustion.

Commit: `2321627`.

### Additional progress on steps 5 and 6

- Deposit lifecycle handles partial deposits as waiting states, requires
  explicit confirmation, ignores unexpected tokens for strategy purposes, and
  reports post-open top-ups as unallocated.
- Token-safety policy handles legacy SPL and Token-2022 facts, refusing
  permanent delegates, transfer hooks, transfer fees, foreign freeze
  authorities, and non-transferable mints. Founder-held or retained
  authorities require acknowledgement.
- Initial-price ceremony calculates the TOKEN/SOL price and implied FDV,
  requires an exact typed phrase, and switches to explicit join-at-live-price
  mode when a pool already exists.
- `/withdraw` now records an idempotent full-withdrawal request directly from
  the service contract, independent of pool/strategy state and even while the
  execution kill switch is enabled.
- Withdrawal-address changes require confirmation and cannot apply until 24
  hours after the original request.
- Obsolete Phase 1 bot copy claiming the service cannot hold a key was replaced
  with an accurate custodial warning and destination guarantee.

Commit: `7ac7cdb`.

## Verification

- `pnpm typecheck`: pass.
- `pnpm lint`: pass.
- `pnpm test`: 256 pass, 0 skipped when run with the local scratch Postgres at
  `127.0.0.1:55432`; every database suite deletes every table it touches.
- `.env` remains ignored. Its contents were never printed or changed.
- No migration or test was pointed at the Supabase URL.
- No on-chain transaction was signed or sent during this handoff.

## Not completed

### Step 5

- Decode live legacy SPL and Token-2022 mint accounts into the already-tested
  token-safety facts.
- Poll and persist real project-wallet deposit events from devnet.
- Implement the concrete `@meteora-ag/dlmm` recipes for existing-pool lookup,
  customizable pool creation, a 70-bin classic position, add/remove liquidity,
  fee claim, and full withdrawal. The generic SDK-only execution adapter and
  all downstream guards are ready for these recipes.
- Add gas-reserve-aware position sizing to the concrete builder.

### Step 6

- Build the complete multi-message Telegram onboarding conversation: wallet
  creation, withdrawal address, profile selection, price/amount collection,
  deposit progress, acknowledgement, and typed launch confirmation.
- Extend `/status` with custodial balances, fees, launch-guard time, and
  unallocated top-ups.
- Expose the withdrawal-address request/confirmation flow in Telegram and send
  its immediate old/new-context notifications.
- Implement the background withdrawal worker that closes the position, claims
  and settles earned fees, and sweeps principal, unexpected tokens, and the gas
  reserve. `/withdraw` currently records the always-available request but does
  not yet perform the on-chain sweep.

### Step 7

- No custodial devnet end-to-end test has run. The required test must create
  mints, create or find a pool, open a 70-bin position centered correctly,
  force a rebalance, and withdraw through the real pipeline.

## Deliberate TODOs and open decisions

- `TODO(KMS, design §15.1)`: choose and implement the production cloud KMS.
- `TODO(cap-values, design §15.2)`: replace the placeholder 10 SOL per-tx,
  50 SOL per-project/day, and 250 SOL global/day caps after Ryan approves an
  operating policy.
- `TODO(profile-replay)`: tune all three profile parameter sets and the 24-hour
  launch guard from replay/live shadow evidence.
- Choose the performance fee percentage (and whether it differs by profile).
  The schema and principal-protection invariant exist; no rate was chosen.
- Failed launch remains alert-only, acting only on founder instruction. No
  automatic bottom exit was introduced.
- The withdrawal worker must define how it bypasses a general management kill
  switch without bypassing inspection, caps, simulation, or destination rules.
- The legacy `README.md` and `docs/FRONTEND_TELEGRAM_BOT.md` still describe the
  Phase 1 keyless product. Runtime copy is corrected, but those documents need
  a custodial rewrite when the complete onboarding contract is finalized.

## Cold-start continuation

1. Read `lp-shadow/docs/superpowers/specs/2026-08-13-lp-optimizer-design.md`.
2. Start with the concrete devnet Meteora builder behind
   `src/execution/MeteoraSdkBuilder`; reuse
   `lp-shadow/devnet-proof/operator-authority.mjs` for pool creation, bin id 0,
   mint ordering, and 70-bin position details.
3. Add instruction fixtures from real SDK output to harden
   `src/execution/inspect.ts`, especially versioned transactions/address lookup
   tables and every DLMM account role.
4. Wire real chain-state reads before writing the devnet end-to-end test.
5. Do not enable production signing until the open KMS, caps, and fee-rate
   decisions are resolved.
