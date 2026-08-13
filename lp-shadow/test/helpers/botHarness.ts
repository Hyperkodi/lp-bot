/**
 * A grammY bot driven by synthetic updates, with the service faked and no
 * network anywhere.
 *
 * The handlers are where every confirmed front-end defect lived (stale
 * confirmation cards, pending state, error copy), so they need to be
 * exercised, not just their renderers. `botInfo` is supplied so construction
 * never calls getMe, and an API transformer captures outbound calls instead of
 * performing them.
 */
import type { Bot } from 'grammy';
import type {
  LpShadowService,
  PoolPreview,
  PoolSummary,
  ReplayReport,
  StatusReport,
  StrategyInfo,
  TenantRef,
  VerdictReport,
  WhyReport,
  WithdrawalReceipt,
} from '../../src/service/index.js';
import { createLpBot } from '../../src/bot/bot.js';

export type ApiCall = { method: string; payload: Record<string, unknown> };

export const TEST_CHAT_ID = 4242;

export const FAKE_POOL: PoolSummary = {
  managedPoolId: 'pool-1',
  label: 'SOL-USDC',
  poolAddress: 'So11111111111111111111111111111111111111112',
  mode: 'SHADOW',
  role: 'PRIMARY',
  virtualNavUsd: 10_000,
  strategyVersion: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  daysOfData: 12.5,
};

export const FAKE_PREVIEW: PoolPreview = {
  poolAddress: FAKE_POOL.poolAddress,
  name: 'SOL-USDC',
  tvlUsd: 1_000_000,
  vol24hUsd: 250_000,
  fees24hUsd: 500,
  binStepBps: 10,
  currentPrice: 150,
};

export const FAKE_TENANT: TenantRef = {
  tenantId: 'tenant-1',
  externalUserId: 'user-1',
  telegramChatId: String(TEST_CHAT_ID),
  label: 'Test Project',
};

/** Every service method, recording its calls; override any of them per test. */
export function createFakeService(
  overrides: Partial<LpShadowService> = {},
): LpShadowService & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <T>(method: string, result: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return result;
    };

  const status: StatusReport = {
    pool: FAKE_POOL,
    html: '<b>lp-shadow — SOL-USDC</b>\nNAV strategy $10,180.22',
    verdictPass: false,
  };
  const why: WhyReport = {
    pool: FAKE_POOL,
    lastNonHold: {
      kind: 'REBALANCE',
      ts: '2026-08-12T09:00:00.000Z',
      reasons: ['b. oor dwell PASS: 47.0min out of range, needs 30.0min'],
      applied: true,
    },
    latest: {
      kind: 'HOLD',
      ts: '2026-08-13T06:00:00.000Z',
      reasons: ['a. in range'],
      applied: false,
    },
    decisions24h: { HOLD: 91, REBALANCE: 1 },
  };
  const strategy: StrategyInfo = {
    version: 1,
    note: 'seeded from config/default.toml',
    createdAt: '2026-08-01T00:00:00.000Z',
    params: {
      oorDwellMin: 30,
      edgeOvershootPct: 1,
      settleBandPct: 0.5,
      settleMin: 15,
      costCoverageMultiple: 3,
      inRangeShareEstimate: 0.7,
      minFeesUsd: 5,
      minFeesPctNav: 0.001,
      volTvlFloor: 0.2,
      volTvlDwellHours: 24,
      goLiveMinShadowDays: 28,
      goLiveRegimeChangeRatio: 2,
    },
  };
  const verdict: VerdictReport = {
    pool: FAKE_POOL,
    shadowDays: 12.5,
    hasRegimeChange: false,
    regimeRatio: 1.4,
    beatsHodl: true,
    pass: false,
    lines: ['❌ shadow window 12.5d / 28d', '❌ vol regime change', '✅ strategy beats HODL'],
  };
  const replay: ReplayReport = {
    pool: FAKE_POOL,
    fromTs: '2026-07-14T00:00:00.000Z',
    toTs: '2026-08-13T00:00:00.000Z',
    snapshots: 1440,
    results: [
      {
        variant: 'stamped v1',
        ticks: 1440,
        finalNavUsd: 10_180.22,
        hodlNavUsd: 10_148.12,
        netVsHodlUsd: 32.1,
        fullRangeUsd: 10_100,
        totalFeesUsd: 118.4,
        totalCostsUsd: 86.3,
        rebalances: 6,
        compounds: 3,
        timeInRange: 0.82,
        exited: false,
      },
    ],
  };
  const withdrawal: WithdrawalReceipt = {
    requestId: 'withdrawal-1',
    status: 'REQUESTED',
    withdrawalAddress: 'FounderWithdrawal1111111111111111111111111',
    requestedAt: '2026-08-13T00:00:00.000Z',
  };

  const base: LpShadowService = {
    redeemHandoff: record('redeemHandoff', FAKE_TENANT),
    getTenantByChatId: record('getTenantByChatId', FAKE_TENANT as TenantRef | null),
    previewPool: record('previewPool', FAKE_PREVIEW),
    addPool: record('addPool', FAKE_POOL),
    listPools: record('listPools', [FAKE_POOL]),
    getStatus: record('getStatus', status),
    getWhy: record('getWhy', why),
    getVerdict: record('getVerdict', verdict),
    runReplay: record('runReplay', replay),
    getStrategy: record('getStrategy', strategy),
    pausePool: record('pausePool', { ...FAKE_POOL, mode: 'PAUSED' as const }),
    resumePool: record('resumePool', FAKE_POOL),
    removePool: record('removePool', { ...FAKE_POOL, mode: 'STOPPED' as const }),
    requestWithdrawal: record('requestWithdrawal', withdrawal),
    getBotToken: () => 'test-token',
    close: async () => undefined,
  };

  return Object.assign(base, overrides, { calls });
}

export type Harness = {
  bot: Bot;
  calls: ApiCall[];
  /** Outbound sendMessage texts, in order. */
  texts(): string[];
  /** The most recent sendMessage payload. */
  lastMessage(): Record<string, unknown> | undefined;
  send(text: string): Promise<void>;
  tap(callbackData: string, messageId?: number): Promise<void>;
  reset(): void;
};

export function createHarness(service: LpShadowService): Harness {
  const bot = createLpBot('12345:test-token-value', service);
  const calls: ApiCall[] = [];

  // Intercept every API call: nothing leaves the process, and each call is
  // recorded for assertions. A transformer receives (prev, method, payload,
  // signal) and returns the raw ApiResponse.
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === 'sendMessage'
        ? {
            message_id: calls.length,
            date: 0,
            chat: { id: TEST_CHAT_ID, type: 'private' },
          }
        : true;
    return { ok: true, result } as never;
  });
  // Supplied so construction never calls getMe. Cast rather than enumerated:
  // grammY keeps adding capability flags to UserFromGetMe, none of which mean
  // anything to a test double, and chasing the list breaks on every bump.
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'LP Shadow',
    username: 'lp_shadow_test_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as typeof bot.botInfo;

  let updateId = 0;
  const from = { id: 7, is_bot: false, first_name: 'Ryan' };
  const chat = { id: TEST_CHAT_ID, type: 'private' as const, first_name: 'Ryan' };

  return {
    bot,
    calls,
    texts: () =>
      calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text)),
    lastMessage: () => calls.filter((c) => c.method === 'sendMessage').at(-1)?.payload,
    async send(text: string): Promise<void> {
      updateId += 1;
      await bot.handleUpdate({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(updateId),
          chat,
          from,
          text,
          entities: text.startsWith('/')
            ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }]
            : undefined,
        },
      });
    },
    async tap(callbackData: string, messageId = 1): Promise<void> {
      updateId += 1;
      await bot.handleUpdate({
        update_id: updateId,
        callback_query: {
          id: String(updateId),
          from,
          chat_instance: 'ci',
          data: callbackData,
          message: {
            message_id: messageId,
            date: Math.floor(updateId),
            chat,
            from: { id: 1, is_bot: true, first_name: 'LP Shadow' },
            text: 'card',
          },
        },
      });
    },
    reset(): void {
      calls.length = 0;
    },
  };
}

/** The callback data of the inline button whose label matches `pattern`. */
export function buttonData(
  payload: Record<string, unknown> | undefined,
  pattern: RegExp,
): string | undefined {
  const markup = payload?.reply_markup as
    | { inline_keyboard?: { text: string; callback_data?: string }[][] }
    | undefined;
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      if (pattern.test(button.text)) return button.callback_data;
    }
  }
  return undefined;
}
