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
  const claimed = await prisma.keyValue.deleteMany({ where: { scope: 'global', key } });
  if (claimed.count === 0) throw invalid;

  if (typeof stored.exp !== 'number' || stored.exp < Date.now()) {
    throw new ServiceError(
      'HANDOFF_EXPIRED',
      "That link expired — they're one-time and short-lived. Ask the Armara bot for a fresh one.",
    );
  }

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
