# lp-bot

The Armara LP agent: a Telegram-native service that watches Meteora DLMM pools
on Solana and reports what active liquidity management *would* have earned,
against simply holding the tokens, net of realistic costs.

It holds no keys and cannot sign a transaction. That is enforced, not merely
intended — lint fails the build on any import capable of holding or deriving a
key, and the only Jupiter endpoint reachable from this repo is `/quote`.

## Layout

| Path | What it is |
| --- | --- |
| [`lp-shadow/`](lp-shadow/) | Phase 1 + 1.5: the shadow engine, the ledger, the service layer, and the Telegram bot |

Phase 2 — the signing pipeline, for pools that clear the go-live gate — does
not exist yet and would live beside `lp-shadow/` rather than inside it, so the
keyless guarantee stays a property of this component rather than a promise
about a mode.

## Start here

- [`lp-shadow/README.md`](lp-shadow/README.md) — what the strategy does, how it
  decides, and what the simulation does and does not model
- [`lp-shadow/docs/PHASE_1_5_MULTI_TENANT.md`](lp-shadow/docs/PHASE_1_5_MULTI_TENANT.md) — the
  multi-tenant, Telegram-native design
- [`lp-shadow/docs/FRONTEND_TELEGRAM_BOT.md`](lp-shadow/docs/FRONTEND_TELEGRAM_BOT.md) — the
  service contract between the bot and the back end

```sh
cd lp-shadow
pnpm install
cp .env.example .env      # DATABASE_URL and RPC_URL
pnpm prisma:migrate
pnpm test
```

## History

This repository previously held Clipmuse, an unrelated Python video-clip
backend. That code was removed in favour of the LP agent; it remains reachable
in the git history at commit `d4c9cca` if it is ever wanted again.
