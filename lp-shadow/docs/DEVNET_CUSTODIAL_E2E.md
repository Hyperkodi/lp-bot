# Custodial devnet end-to-end proof

This proof uses only disposable local PostgreSQL state, Solana devnet, and an
encrypted throwaway project wallet. It must never be pointed at mainnet or a
hosted production database.

## Safety gates

- `DATABASE_URL` must resolve to `localhost` or `127.0.0.1`, and its database
  name must contain `devnet`.
- `RPC_URL` must contain `devnet`.
- The development KMS master key is created inside custody at
  `.devnet-e2e/local-kms.key`. The directory is ignored by Git. The key and
  project signing material are never printed.
- The project wallet is resumable. Only its public address is printed so an
  external devnet faucet can fund it.
- LP actions use the guarded execution pipeline: durable intent, lock,
  allowlists, caps, simulation, custody signing, confirmation, and chain-state
  reconciliation.

## Run

Set a disposable local database and the public devnet RPC in the current shell:

```powershell
$env:DATABASE_URL = 'postgresql://lpshadow@127.0.0.1:55432/lpshadow_devnet_e2e2_20260813?schema=public'
$env:RPC_URL = 'https://api.devnet.solana.com'
pnpm prisma:migrate
pnpm e2e:devnet
```

If the RPC faucet is rate-limited, fund the printed project address with at
least 1 devnet SOL through an alternate faucet and run the same command again.
Never send mainnet SOL or any real token.

## Required proof sequence

The runner must complete and reconcile each stage:

1. encrypted project and founder wallets;
2. devnet SOL plus two disposable SPL mints;
3. idempotent deposit observation and mint screening;
4. customizable Meteora pool creation;
5. exact 70-bin classic position;
6. forced one-bin recentering;
7. full liquidity removal and position closure;
8. token-account closure and founder sweep, leaving the project wallet empty.

The script exits non-zero on any failed simulation, rejected inspection,
unreconciled intent, remaining position, token account, or SOL balance.

## Current local run

The resumable public project address is
`DqjRQTAqUWzAYNFvcRJUGH9A3tzRhzcNEwjCA13g4jXV`. After receiving 2.5 devnet
SOL, the runner printed `DEVNET E2E PASS` on 2026-08-13. It created pool
`8UnHvKBF27rC2UAUE3Z2qU1B4aqdiF1tXjUGUzcNEb9d`, reconciled pool creation,
open, rebalance, full removal, and founder-sweep intents, then independently
verified that the project wallet held 0 SOL, both project token accounts were
closed, and no position remained open.

The finalized pool-creation signature was
`9hsFyvwxVuwuS8W6wkQzBAWzZRzJbNAkLUsKytyQuXEqBD1AvBjgjq2CgFqAW8CAfzTWzaY2zcRkuxBhhLYjPGi`.
The finalized founder-sweep signature was
`5vaiQjH5kCtTWdpuU9dAyJ3VqfD7AQBKcrSBdBHRC6yQi46WYgpSBsWVxx7gECq3DD1sSs7N4TShc5KJGYscgRSs`.
