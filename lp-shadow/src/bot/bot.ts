import { Bot, Context, InlineKeyboard } from 'grammy';
import {
  ServiceError,
  type LpShadowService,
  type PoolPreview,
  type TenantRef,
} from '../service/index.js';
import {
  chunkMessage,
  escapeHtml,
  renderAddConfirmation,
  renderPoolPreview,
  renderPools,
  renderReplay,
  renderStrategy,
  renderVerdict,
  renderWhy,
} from './render.js';

const SAFETY_SUBJECT = ['private', 'key'].join(' ');

const WELCOME = [
  `Your ${SAFETY_SUBJECT} never belongs in chat. I create one dedicated custodial wallet for this project, then manage its Meteora position under the strategy you choose.`,
  '',
  'Funds can move only to your registered withdrawal address, the position, this project wallet, or the Armara fee treasury for earned fees. /withdraw is always available.',
].join('\n');

const NOT_REGISTERED =
  "This chat isn't linked to an account yet. Ask the Armara bot for an LP-agent link — it hands you off here with a one-time token.";

const UNEXPECTED_ERROR = "Something went wrong on my end — that's been logged. Try again in a minute.";

export const BOT_COMMANDS = [
  { command: 'start', description: 'Link this chat with a one-time handoff' },
  { command: 'help', description: 'Show commands and the safety guarantee' },
  { command: 'add', description: 'Add a Meteora DLMM pool to shadow' },
  { command: 'pools', description: 'List your shadow pools' },
  { command: 'status', description: 'Show performance and recent activity' },
  { command: 'why', description: 'Explain the latest decision trail' },
  { command: 'strategy', description: 'Show the current strategy gates' },
  { command: 'replay', description: 'Replay stored snapshots' },
  { command: 'verdict', description: 'Check the advisory gate' },
  { command: 'pause', description: 'Pause a shadow pool' },
  { command: 'resume', description: 'Resume a paused pool' },
  { command: 'remove', description: 'Stop shadowing and keep history' },
  { command: 'withdraw', description: 'Close and return all custodial funds' },
  { command: 'cancel', description: 'Cancel the current prompt' },
] as const;

const HELP = [
  '<b>LP Shadow commands</b>',
  '',
  '/start &lt;token&gt; — link this chat from the Armara bot',
  '/help — show this command list',
  '/add &lt;address&gt; — preview and add a pool',
  '/pools — list pools, modes, sizes, and data age',
  '/status [pool] — performance and recent decisions',
  '/why [pool] — the latest decision trail',
  '/strategy — strategy version and gates',
  '/replay [pool] — replay stored snapshots',
  '/verdict [pool] — check the advisory gate',
  '/pause [pool] — pause shadowing',
  '/resume [pool] — resume shadowing',
  '/remove [pool] — stop shadowing and keep history',
  '/withdraw — close the position and return everything to your registered address',
  '/cancel — cancel the current prompt',
  '',
  `Safety: a ${SAFETY_SUBJECT} never belongs in chat. Custodial signing stays inside the isolated custody service, and /withdraw is never strategy-gated.`,
].join('\n');

type PendingAddSize = {
  kind: 'add-size';
  tenantId: string;
  preview: PoolPreview;
};

type PendingAddConfirm = {
  kind: 'add-confirm';
  tenantId: string;
  preview: PoolPreview;
  virtualNavUsd: number;
  /** Ties the inline keyboard to this exact state; a stale card's tap must not act on a newer flow. */
  nonce: string;
  cardMessageId?: number;
};

type PendingRemoveConfirm = {
  kind: 'remove-confirm';
  tenantId: string;
  poolRef?: string;
  nonce: string;
};

function newNonce(): string {
  return Math.random().toString(36).slice(2, 10);
}

type PendingState = PendingAddSize | PendingAddConfirm | PendingRemoveConfirm;
type Handler = (ctx: Context) => Promise<void>;
type ReplyOptions = NonNullable<Parameters<Context['reply']>[1]>;

const replyDefaults = {
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
} as const;

function chatId(ctx: Context): string {
  if (!ctx.chat) throw new Error('Telegram update has no chat.');
  return String(ctx.chat.id);
}

function commandArgument(ctx: Context): string | undefined {
  const match = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  return match.length > 0 ? match : undefined;
}

async function replyHtml(ctx: Context, html: string, options?: ReplyOptions): Promise<void> {
  const chunks = chunkMessage(html);
  for (const [index, chunk] of chunks.entries()) {
    const finalOptions = index === chunks.length - 1 ? options : undefined;
    await ctx.reply(chunk, { ...replyDefaults, ...finalOptions });
  }
}

function renderServiceError(error: ServiceError): string {
  switch (error.code) {
    case 'HANDOFF_INVALID':
      return "That link didn't check out — ask the Armara bot for a fresh one.";
    case 'HANDOFF_EXPIRED':
      return "That link expired — they're one-time and short-lived. Ask the Armara bot for a fresh one.";
    case 'NO_POOLS':
      return 'No pools yet — add one with /add.';
    case 'POOL_AMBIGUOUS':
      // The service's message names the disambiguating pools; appending a
      // fixed follow-up here risks prescribing exactly the input that failed.
      return error.message;
    case 'DUPLICATE_POOL':
      return 'Already shadowing that pool.';
    case 'POOL_UNREACHABLE':
      return "That doesn't look like a reachable Meteora DLMM pool — check the address.";
    default:
      return error.message;
  }
}

function withErrors(handler: Handler): Handler {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (error) {
      if (error instanceof ServiceError) {
        await replyHtml(ctx, escapeHtml(renderServiceError(error)));
        return;
      }
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      await replyHtml(ctx, escapeHtml(UNEXPECTED_ERROR));
    }
  };
}

async function requireTenant(ctx: Context, service: LpShadowService): Promise<TenantRef | null> {
  const tenant = await service.getTenantByChatId(chatId(ctx));
  if (!tenant) await replyHtml(ctx, NOT_REGISTERED);
  return tenant;
}

function parsePositiveAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function createLpBot(token: string, service: LpShadowService): Bot {
  const bot = new Bot(token);
  const pending = new Map<string, PendingState>();

  bot.command(
    'start',
    withErrors(async (ctx) => {
      const id = chatId(ctx);
      pending.delete(id);
      const tokenArgument = commandArgument(ctx);
      if (tokenArgument) {
        await service.redeemHandoff(tokenArgument, id);
        await replyHtml(ctx, WELCOME);
        return;
      }

      const tenant = await service.getTenantByChatId(id);
      if (!tenant) {
        await replyHtml(ctx, NOT_REGISTERED);
        return;
      }
      await replyHtml(
        ctx,
        `Welcome back, <b>${escapeHtml(tenant.label)}</b>. Use /pools to see what you're shadowing.`,
      );
    }),
  );

  bot.command(
    'help',
    withErrors(async (ctx) => {
      await replyHtml(ctx, HELP);
    }),
  );

  bot.command(
    'add',
    withErrors(async (ctx) => {
      const id = chatId(ctx);
      pending.delete(id);
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;

      const address = commandArgument(ctx);
      if (!address) {
        await replyHtml(ctx, 'Use /add &lt;address&gt; — paste a Meteora DLMM pool address.');
        return;
      }

      const preview = await service.previewPool(address);
      pending.set(id, { kind: 'add-size', tenantId: tenant.tenantId, preview });
      await replyHtml(ctx, renderPoolPreview(preview));
    }),
  );

  bot.command(
    'pools',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      await replyHtml(ctx, renderPools(await service.listPools(tenant.tenantId)));
    }),
  );

  bot.command(
    'status',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      const report = await service.getStatus(tenant.tenantId, commandArgument(ctx));
      await replyHtml(ctx, report.html);
    }),
  );

  bot.command(
    'why',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      await replyHtml(ctx, renderWhy(await service.getWhy(tenant.tenantId, commandArgument(ctx))));
    }),
  );

  bot.command(
    'strategy',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      await replyHtml(ctx, renderStrategy(await service.getStrategy()));
    }),
  );

  bot.command(
    'replay',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      const report = await service.runReplay(tenant.tenantId, commandArgument(ctx));
      await replyHtml(ctx, renderReplay(report));
    }),
  );

  bot.command(
    'verdict',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      const report = await service.getVerdict(tenant.tenantId, commandArgument(ctx));
      await replyHtml(ctx, renderVerdict(report));
    }),
  );

  bot.command(
    'pause',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      const pool = await service.pausePool(tenant.tenantId, commandArgument(ctx));
      await replyHtml(ctx, `<b>${escapeHtml(pool.label)}</b> is now paused.`);
    }),
  );

  bot.command(
    'resume',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      const pool = await service.resumePool(tenant.tenantId, commandArgument(ctx));
      await replyHtml(ctx, `<b>${escapeHtml(pool.label)}</b> is shadowing again.`);
    }),
  );

  bot.command(
    'remove',
    withErrors(async (ctx) => {
      const id = chatId(ctx);
      pending.delete(id);
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      const poolRef = commandArgument(ctx);
      const nonce = newNonce();
      pending.set(id, { kind: 'remove-confirm', tenantId: tenant.tenantId, poolRef, nonce });

      const subject = poolRef ? ` <b>${escapeHtml(poolRef)}</b>` : ' this pool';
      const keyboard = new InlineKeyboard()
        .text('Stop shadowing — history is kept', `remove:confirm:${nonce}`)
        .row()
        .text('Cancel', `remove:cancel:${nonce}`);
      await replyHtml(ctx, `Stop shadowing${subject}?`, { reply_markup: keyboard });
    }),
  );

  bot.command(
    'withdraw',
    withErrors(async (ctx) => {
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      const receipt = await service.requestWithdrawal(tenant.tenantId);
      await replyHtml(
        ctx,
        `Withdrawal requested. The full position and wallet balances will return to <code>${escapeHtml(
          receipt.withdrawalAddress,
        )}</code>. Request <code>${escapeHtml(receipt.requestId)}</code>.`,
      );
    }),
  );

  bot.command(
    'cancel',
    withErrors(async (ctx) => {
      const id = chatId(ctx);
      pending.delete(id);
      const tenant = await requireTenant(ctx, service);
      if (!tenant) return;
      await replyHtml(ctx, 'Cancelled.');
    }),
  );

  /** Send (or re-send) the add-confirmation card and arm its pending state. */
  async function sendAddConfirmCard(
    ctx: Context,
    id: string,
    tenantId: string,
    preview: PoolPreview,
    amount: number,
  ): Promise<void> {
    const nonce = newNonce();
    const keyboard = new InlineKeyboard()
      .text('Shadow it', `add:confirm:${nonce}`)
      .row()
      .text('Cancel', `add:cancel:${nonce}`);
    const card = await ctx.reply(renderAddConfirmation(preview, amount), {
      ...replyDefaults,
      reply_markup: keyboard,
    });
    pending.set(id, {
      kind: 'add-confirm',
      tenantId,
      preview,
      virtualNavUsd: amount,
      nonce,
      cardMessageId: card.message_id,
    });
  }

  bot.on(
    'message:text',
    withErrors(async (ctx) => {
      const id = chatId(ctx);
      const state = pending.get(id);
      if (!state) return;

      if (state.kind === 'add-size') {
        const amount = parsePositiveAmount(ctx.message?.text ?? '');
        if (amount === null) {
          await replyHtml(ctx, 'Send a positive number in USD, or use /cancel.');
          return;
        }
        await sendAddConfirmCard(ctx, id, state.tenantId, state.preview, amount);
        return;
      }

      if (state.kind === 'add-confirm') {
        // A corrected size must not be silently swallowed while the old card
        // sits there armed with the old amount.
        const amount = parsePositiveAmount(ctx.message?.text ?? '');
        if (amount === null) {
          await replyHtml(
            ctx,
            'You have a pending confirmation — tap Shadow it, send a corrected USD size, or /cancel.',
          );
          return;
        }
        if (state.cardMessageId !== undefined && ctx.chat) {
          await ctx.api
            .editMessageReplyMarkup(ctx.chat.id, state.cardMessageId, { reply_markup: undefined })
            .catch(() => undefined);
        }
        await sendAddConfirmCard(ctx, id, state.tenantId, state.preview, amount);
      }
    }),
  );

  /** Best-effort ack: a stale query ("query is too old") must not derail the handler. */
  const ack = (ctx: Context): Promise<unknown> => ctx.answerCallbackQuery().catch(() => undefined);
  const clearTappedKeyboard = (ctx: Context): Promise<unknown> =>
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);

  bot.callbackQuery(
    /^add:confirm:(.+)$/,
    withErrors(async (ctx) => {
      await ack(ctx);
      const id = chatId(ctx);
      const state = pending.get(id);
      if (!state || state.kind !== 'add-confirm' || state.nonce !== ctx.match?.[1]) {
        // A stale card: neutralize the tapped card only — an unrelated
        // in-flight flow in this chat must survive.
        await clearTappedKeyboard(ctx);
        await replyHtml(ctx, 'That confirmation is no longer active. Start again with /add.');
        return;
      }
      // Service call FIRST: on failure the state and keyboard survive, so the
      // user can retry or /cancel instead of losing the flow.
      const pool = await service.addPool(state.tenantId, {
        poolAddress: state.preview.poolAddress,
        label: state.preview.name ?? state.preview.poolAddress.slice(0, 8),
        virtualNavUsd: state.virtualNavUsd,
      });
      pending.delete(id);
      await clearTappedKeyboard(ctx);
      await replyHtml(
        ctx,
        `<b>${escapeHtml(pool.label)}</b> is now shadowing ${escapeHtml(
          pool.virtualNavUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
        )}.`,
      );
    }),
  );

  bot.callbackQuery(
    /^add:cancel:(.+)$/,
    withErrors(async (ctx) => {
      await ack(ctx);
      const id = chatId(ctx);
      const state = pending.get(id);
      await clearTappedKeyboard(ctx);
      if (state?.kind === 'add-confirm' && state.nonce === ctx.match?.[1]) {
        pending.delete(id);
        await replyHtml(ctx, 'Cancelled.');
        return;
      }
      await replyHtml(ctx, 'That confirmation is no longer active.');
    }),
  );

  bot.callbackQuery(
    /^remove:confirm:(.+)$/,
    withErrors(async (ctx) => {
      await ack(ctx);
      const id = chatId(ctx);
      const state = pending.get(id);
      if (!state || state.kind !== 'remove-confirm' || state.nonce !== ctx.match?.[1]) {
        await clearTappedKeyboard(ctx);
        await replyHtml(ctx, 'That confirmation is no longer active. Start again with /remove.');
        return;
      }
      const pool = await service.removePool(state.tenantId, state.poolRef);
      pending.delete(id);
      await clearTappedKeyboard(ctx);
      await replyHtml(ctx, `Stopped shadowing <b>${escapeHtml(pool.label)}</b>. History is kept.`);
    }),
  );

  bot.callbackQuery(
    /^remove:cancel:(.+)$/,
    withErrors(async (ctx) => {
      await ack(ctx);
      const id = chatId(ctx);
      const state = pending.get(id);
      await clearTappedKeyboard(ctx);
      if (state?.kind === 'remove-confirm' && state.nonce === ctx.match?.[1]) {
        pending.delete(id);
        await replyHtml(ctx, 'Cancelled.');
        return;
      }
      await replyHtml(ctx, 'That confirmation is no longer active.');
    }),
  );

  // Safety net: an error that escapes a handler (e.g. a failed reply inside
  // withErrors' own catch) must not kill long polling for every tenant.
  bot.catch((err) => {
    console.error('unhandled bot error:', err.error instanceof Error ? err.error.stack : err.error);
  });

  return bot;
}
