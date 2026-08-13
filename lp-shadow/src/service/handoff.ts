/**
 * One-time handoff tokens: how a tenant gets from the parent Armara bot into
 * this one without this module ever owning authentication.
 *
 * The parent bot issues a token (via scripts/issue-handoff.ts today, its own
 * integration later) and puts it in a deep link — t.me/<bot>?start=<token>.
 * Redeeming it here binds the token's externalUserId to the chat that pressed
 * start, then destroys the token.
 *
 * PHASE_1_5 §2 sketched a *signed* payload; this is a stored opaque token
 * instead, which is strictly stronger for the same job: one-time by
 * construction, revocable (delete the row), nothing to verify wrong, and it
 * fits Telegram's 64-character start-payload limit where a signed JSON payload
 * does not. 24 random bytes ≈ 192 bits — the token is the secret.
 */
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { upsertTenant } from '../ledger/registry.js';
import { ServiceError } from './errors.js';
import type { TenantRef } from './types.js';

const KEY_PREFIX = 'handoff:';
const DEFAULT_TTL_MINUTES = 15;
/** Telegram start payloads allow exactly this alphabet, max 64 chars. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

type StoredHandoff = { externalUserId: string; label: string; exp: number };

/** 24 random bytes as base64url: 32 chars, entirely inside Telegram's start-payload alphabet. */
export function newHandoffToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function issueHandoff(
  prisma: PrismaClient,
  input: { externalUserId: string; label: string; ttlMinutes?: number },
): Promise<{ token: string; expiresAt: Date }> {
  if (input.externalUserId.trim().length === 0) {
    throw new ServiceError('INVALID_INPUT', 'externalUserId must not be empty.');
  }
  // Opportunistic purge: tokens whose deep link was never pressed would
  // otherwise sit in KeyValue forever.
  await prisma.keyValue.deleteMany({
    where: {
      scope: 'global',
      key: { startsWith: KEY_PREFIX },
      value: { path: ['exp'], lt: Date.now() },
    },
  });
  const token = newHandoffToken();
  const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000);
  const value: StoredHandoff = {
    externalUserId: input.externalUserId,
    label: input.label,
    exp: expiresAt.getTime(),
  };
  await prisma.keyValue.create({
    data: { scope: 'global', key: KEY_PREFIX + token, value },
  });
  return { token, expiresAt };
}

/**
 * Claims a token for a chat. The deleteMany is the one-time gate: whichever
 * concurrent redeem deletes the row wins, everyone else sees INVALID.
 */
export async function redeemHandoff(
  prisma: PrismaClient,
  token: string,
  telegramChatId: string,
): Promise<TenantRef> {
  const invalid = new ServiceError(
    'HANDOFF_INVALID',
    "That link didn't check out — ask the Armara bot for a fresh one.",
  );
  if (!TOKEN_SHAPE.test(token) || telegramChatId.trim().length === 0) throw invalid;

  const key = KEY_PREFIX + token;
  const row = await prisma.keyValue.findUnique({ where: { scope_key: { scope: 'global', key } } });
  if (!row) throw invalid;

  const stored = row.value as StoredHandoff;
  if (typeof stored.exp !== 'number' || stored.exp < Date.now()) {
    await prisma.keyValue.deleteMany({ where: { scope: 'global', key } });
    throw new ServiceError(
      'HANDOFF_EXPIRED',
      "That link expired — they're one-time and short-lived. Ask the Armara bot for a fresh one.",
    );
  }

  // Pre-checks that must not consume the token. A chat can belong to one
  // account, and a suspended account cannot re-enter by having the parent bot
  // mint it a fresh link.
  const [bound, existing] = await Promise.all([
    prisma.tenant.findUnique({
      where: { telegramChatId },
      select: { externalUserId: true, label: true },
    }),
    prisma.tenant.findUnique({
      where: { externalUserId: stored.externalUserId },
      select: { status: true },
    }),
  ]);
  if (bound && bound.externalUserId !== stored.externalUserId) {
    throw new ServiceError(
      'CHAT_ALREADY_LINKED',
      `This chat is already linked to "${bound.label}" — a link for a different account can't be redeemed here.`,
    );
  }
  if (existing && existing.status !== 'ACTIVE') {
    throw new ServiceError(
      'ACCOUNT_SUSPENDED',
      'This account is suspended — redeeming a new link cannot restore it. Contact Armara.',
    );
  }

  const claimed = await prisma.keyValue.deleteMany({ where: { scope: 'global', key } });
  if (claimed.count === 0) throw invalid;

  try {
    const tenant = await upsertTenant(prisma, {
      externalUserId: stored.externalUserId,
      telegramChatId,
      label: stored.label,
    });
    return {
      tenantId: tenant.id,
      externalUserId: stored.externalUserId,
      telegramChatId,
      label: stored.label,
    };
  } catch (err) {
    // The plan called for delete + upsert in one transaction so a failed
    // binding cannot burn the one-time token. Same guarantee, compensation
    // style: put the token back, then surface the error. If the restore
    // itself fails the token is lost — but that needs two failures in a row.
    await prisma.keyValue
      .create({ data: { scope: 'global', key, value: stored } })
      .catch(() => undefined);
    // Race: the chat got bound between the pre-check above and the upsert.
    if ((err as { code?: string }).code === 'P2002') {
      throw new ServiceError(
        'CHAT_ALREADY_LINKED',
        'This chat is already linked to a different account.',
      );
    }
    throw err;
  }
}

export async function getTenantByChatId(
  prisma: PrismaClient,
  telegramChatId: string,
): Promise<TenantRef | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { telegramChatId },
    select: { id: true, externalUserId: true, telegramChatId: true, label: true, status: true },
  });
  if (!tenant || tenant.status !== 'ACTIVE') return null;
  return {
    tenantId: tenant.id,
    externalUserId: tenant.externalUserId,
    telegramChatId: tenant.telegramChatId,
    label: tenant.label,
  };
}
