/**
 * Error mapping, resilience, and spec-copy compliance for the Telegram layer.
 *
 * These are the guarantees a user actually feels when something breaks: a
 * ServiceError has to arrive as sentence the person in the chat can act on, an
 * unexpected error must arrive as the one generic line (and nothing else), a
 * failure must not take the next command down with it, and the onboarding copy
 * must say what docs/FRONTEND_TELEGRAM_BOT.md says it says.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ServiceError, type ServiceErrorCode } from '../src/service/index.js';
import { BOT_COMMANDS } from '../src/bot/bot.js';
import { createFakeService, createHarness, FAKE_POOL, TEST_CHAT_ID } from './helpers/botHarness.js';

/** docs §2 — the only copy an unexpected (non-ServiceError) failure may produce. */
const GENERIC_ERROR = "Something went wrong on my end — that's been logged. Try again in a minute.";

/**
 * docs §5, "Welcome (after successful handoff)". The doc's `*would*` is
 * markdown italics; Telegram HTML spells the same emphasis `<i>would</i>`.
 * Everything else is character-for-character from the doc, with the doc's
 * blockquote line-wrapping removed.
 */
const WELCOME =
  'Your private key never belongs in chat. I create one dedicated custodial wallet for this ' +
  'project, then manage its Meteora position under the strategy you choose.' +
  '\n\n' +
  'Funds can move only to your registered withdrawal address, the position, this project wallet, ' +
  'or the Armara fee treasury for earned fees. /withdraw is always available.';

/** docs §5, "Not registered" — verbatim, unwrapped. */
const NOT_REGISTERED =
  "This chat isn't linked to an account yet. Ask the Armara bot for an LP-agent " +
  'link — it hands you off here with a one-time token.';

/** docs §7 — these must not exist; their absence is the product guarantee. */
const FORBIDDEN_COMMANDS = ['/wallet', '/harvest', '/rebalance', '/close', '/settings'];

/** A service message distinctive enough that leaking it is unmistakable. */
const SERVICE_MESSAGE = 'Two pools match that name — say alpha or beta.';

type Expectation =
  /** docs §5 prescribes exact copy for this code. */
  | { readonly exact: string; readonly showsMessage?: never }
  /** docs §3/§5: "others: show ServiceError.message". */
  | { readonly exact?: never; readonly showsMessage: true };

/**
 * Every ServiceErrorCode and the copy the user must get for it.
 *
 * Typed as a total `Record<ServiceErrorCode, …>`, so adding a code to the union
 * without deciding its copy fails `tsc` here; the runtime check below
 * ("covers every ServiceErrorCode…") re-parses src/service/errors.ts so it also
 * fails as a *test*, not just as a type error.
 */
const EXPECTED_COPY: Record<ServiceErrorCode, Expectation> = {
  HANDOFF_INVALID: { exact: "That link didn't check out — ask the Armara bot for a fresh one." },
  HANDOFF_EXPIRED: {
    exact:
      "That link expired — they're one-time and short-lived. Ask the Armara bot for a fresh one.",
  },
  CHAT_ALREADY_LINKED: { showsMessage: true },
  ACCOUNT_SUSPENDED: { showsMessage: true },
  NOT_REGISTERED: { showsMessage: true },
  POOL_NOT_FOUND: { showsMessage: true },
  POOL_AMBIGUOUS: { showsMessage: true },
  NO_POOLS: { exact: 'No pools yet — add one with /add.' },
  DUPLICATE_POOL: { exact: 'Already shadowing that pool.' },
  POOL_UNREACHABLE: {
    exact: "That doesn't look like a reachable Meteora DLMM pool — check the address.",
  },
  INVALID_INPUT: { showsMessage: true },
};

/** Shapes that mean a raw JS error escaped into the chat instead of copy. */
function stackLeakIn(text: string): string | null {
  for (const marker of ['ServiceError:', 'Error:', '.ts:', 'node_modules', '    at ']) {
    if (text.includes(marker)) return marker;
  }
  return /\n\s*at \S+/.test(text) ? 'stack frame' : null;
}

/** Non-null when the formatting tags in `html` are not properly nested. */
function tagBalanceError(html: string): string | null {
  const stack: string[] = [];
  for (const match of html.matchAll(/<\/?(b|i|pre|code)>/g)) {
    const tag = match[1]!;
    if (match[0].startsWith('</')) {
      if (stack.pop() !== tag) return `stray ${match[0]}`;
    } else {
      stack.push(tag);
    }
  }
  return stack.length > 0 ? `unclosed <${stack.join('>, <')}>` : null;
}

const stripTags = (html: string): string => html.replaceAll(/<\/?(b|i|pre|code)>/g, '');

describe('ServiceError mapping (docs §3, §5)', () => {
  it('covers every ServiceErrorCode declared in src/service/errors.ts', () => {
    // Read the union at runtime so a newly added code fails *this* test, not
    // only the type-check — an unhandled code would otherwise reach users as
    // whatever the default branch happens to do.
    const source = readFileSync(new URL('../src/service/errors.ts', import.meta.url), 'utf8');
    const declaration = /export type ServiceErrorCode\s*=([^;]+);/.exec(source)?.[1];
    expect(declaration, 'could not find the ServiceErrorCode union in errors.ts').toBeTruthy();

    const declared = [...(declaration ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
    expect(declared.length).toBeGreaterThan(5);
    expect([...declared].sort()).toEqual(Object.keys(EXPECTED_COPY).sort());
  });

  for (const [code, expectation] of Object.entries(EXPECTED_COPY) as [
    ServiceErrorCode,
    Expectation,
  ][]) {
    it(`answers a ${code} failure with user-facing copy, not the generic fallback`, async () => {
      const service = createFakeService({
        getStatus: async () => {
          throw new ServiceError(code, SERVICE_MESSAGE);
        },
      });
      const harness = createHarness(service);

      await harness.send('/status');

      const texts = harness.texts();
      expect(texts).toHaveLength(1);
      const text = texts[0]!;

      // A ServiceError is written for the chat; falling back to the generic
      // line would throw away the one thing that tells the user what to do.
      expect(text).not.toBe(GENERIC_ERROR);
      expect(stackLeakIn(text)).toBeNull();
      // The enum name is a wire value, never copy.
      expect(text).not.toContain(code);

      if (expectation.exact !== undefined) {
        expect(text).toBe(expectation.exact);
      } else {
        expect(text).toContain(SERVICE_MESSAGE);
      }
    });
  }

  it('shows the service message for CHAT_ALREADY_LINKED instead of welcoming the user in', async () => {
    // Recently added code: a chat that is already bound to another account must
    // not be greeted as if the handoff had worked.
    const message = 'This chat is already linked to another account.';
    const service = createFakeService({
      redeemHandoff: async () => {
        throw new ServiceError('CHAT_ALREADY_LINKED', message);
      },
    });
    const harness = createHarness(service);

    await harness.send('/start handoff-token-1');

    expect(harness.texts()).toEqual([message]);
    expect(harness.texts().join('')).not.toContain('Add your first pool');
  });

  it('shows the service message for ACCOUNT_SUSPENDED and runs no further service work', async () => {
    // Recently added code: the tenant lookup fails, so the command must stop
    // there rather than continue with an unresolved tenant.
    const message = 'That account is suspended — contact Armara support.';
    // An overridden method bypasses the harness's `calls` recorder, so count
    // the lookups here; `service.calls` then holds only the *other* methods.
    let lookups = 0;
    const service = createFakeService({
      getTenantByChatId: async () => {
        lookups += 1;
        throw new ServiceError('ACCOUNT_SUSPENDED', message);
      },
    });
    const harness = createHarness(service);

    await harness.send('/pools');

    expect(harness.texts()).toEqual([message]);
    expect(lookups).toBe(1);
    expect(service.calls).toEqual([]);
  });

  it('escapes HTML in a service message so the reply cannot be mangled or injected', async () => {
    // Service messages are plain text (docs §6). Passing "<b>" through raw
    // would make Telegram reject the message with a parse error.
    const service = createFakeService({
      getStatus: async () => {
        throw new ServiceError('POOL_AMBIGUOUS', 'Matches <b>alpha</b> & <beta>.');
      },
    });
    const harness = createHarness(service);

    await harness.send('/status');

    const text = harness.texts()[0]!;
    expect(text).toBe('Matches &lt;b&gt;alpha&lt;/b&gt; &amp; &lt;beta&gt;.');
    expect(tagBalanceError(text)).toBeNull();
  });
});

describe('unexpected errors (docs §2)', () => {
  it('replies with exactly the generic copy and leaks neither message nor stack', async () => {
    const secret = 'ECONNREFUSED 10.0.0.9:5432 password=hunter2';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = createFakeService({
        listPools: async () => {
          throw new Error(secret);
        },
      });
      const harness = createHarness(service);

      await harness.send('/pools');

      expect(harness.texts()).toEqual([GENERIC_ERROR]);
      expect(harness.texts().join('')).not.toContain(secret);
      expect(stackLeakIn(harness.texts()[0]!)).toBeNull();

      // …and the detail that was withheld from the chat is in the log instead.
      expect(logged).toHaveBeenCalled();
      expect(String(logged.mock.calls[0]?.[0])).toContain(secret);
    } finally {
      logged.mockRestore();
    }
  });

  it('does not leak a thrown non-Error value either', async () => {
    // A rejected promise carrying a plain object still hits the same catch;
    // String()-ing it into the chat would be the same leak.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = createFakeService({
        getWhy: async () => {
          throw { internal: 'dsn=postgres://user:pw@host/db' };
        },
      });
      const harness = createHarness(service);

      await harness.send('/why');

      expect(harness.texts()).toEqual([GENERIC_ERROR]);
      expect(harness.texts().join('')).not.toContain('postgres://');
    } finally {
      logged.mockRestore();
    }
  });
});

describe('resilience across updates', () => {
  it('serves /pools normally after a previous command threw', async () => {
    // The handlers share one bot instance and one pending-state map; a throw
    // must not leave middleware or state wedged for the next update.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = createFakeService({
        getStatus: async () => {
          throw new Error('boom');
        },
      });
      const harness = createHarness(service);

      await harness.send('/status');
      expect(harness.texts()).toEqual([GENERIC_ERROR]);
      harness.reset();

      await harness.send('/pools');

      expect(service.calls.map((call) => call.method)).toContain('listPools');
      const text = harness.texts().join('\n');
      expect(text).toContain(FAKE_POOL.label);
      expect(text).not.toContain(GENERIC_ERROR);
    } finally {
      logged.mockRestore();
    }
  });

  it('recovers when a ServiceError and an unexpected error arrive back to back', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = createFakeService({
        getVerdict: async () => {
          throw new ServiceError('NO_POOLS', 'no pools');
        },
        getStrategy: async () => {
          throw new Error('kaboom');
        },
      });
      const harness = createHarness(service);

      await harness.send('/verdict');
      await harness.send('/strategy');
      await harness.send('/pools');

      expect(harness.texts()).toEqual([
        'No pools yet — add one with /add.',
        GENERIC_ERROR,
        expect.stringContaining(FAKE_POOL.label),
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps the /remove confirmation usable when removePool fails, then retries', async () => {
    // The tapped card is the only entry point to the destructive action; if a
    // failed tap dropped the pending state, the user would be stuck.
    let attempts = 0;
    const service = createFakeService({
      removePool: async () => {
        attempts += 1;
        if (attempts === 1) throw new ServiceError('POOL_NOT_FOUND', 'No pool matches that.');
        return { ...FAKE_POOL, mode: 'STOPPED' as const };
      },
    });
    const harness = createHarness(service);

    await harness.send('/remove');
    const card = harness.lastMessage();
    const confirm = (
      (card?.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] })
        .inline_keyboard.flat()
        .find((button) => /stop shadowing/i.test(button.text))
    )?.callback_data;
    expect(confirm).toBeDefined();
    harness.reset();

    await harness.tap(confirm!);
    expect(harness.texts()).toEqual(['No pool matches that.']);
    harness.reset();

    // Second tap on the same card: the state survived the failure.
    await harness.tap(confirm!);
    expect(harness.texts().join('\n')).toContain(`Stopped shadowing ${FAKE_POOL.label}`.slice(0, 17));
    expect(harness.texts().join('\n')).not.toContain('no longer active');
    expect(attempts).toBe(2);
  });
});

describe('onboarding copy (docs §5)', () => {
  it('sends the welcome verbatim after a successful handoff', async () => {
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/start one-time-token');

    expect(service.calls).toContainEqual({
      method: 'redeemHandoff',
      args: ['one-time-token', String(TEST_CHAT_ID)],
    });
    expect(harness.texts()).toEqual([WELCOME]);
    // The safety guarantee is the first thing said, per docs §1.
    expect(harness.texts()[0]!.startsWith('Your private key never belongs in chat.')).toBe(
      true,
    );
  });

  it('sends the not-registered copy verbatim when /start has no token and no tenant', async () => {
    const service = createFakeService({ getTenantByChatId: async () => null });
    const harness = createHarness(service);

    await harness.send('/start');

    expect(harness.texts()).toEqual([NOT_REGISTERED]);
    expect(service.calls.map((call) => call.method)).not.toContain('redeemHandoff');
  });

  it('gates every tenant command behind the same not-registered copy', async () => {
    // docs §4: "Every command except /start and /help first resolves the
    // tenant … null => the not-registered copy."
    let lookups = 0;
    const service = createFakeService({
      getTenantByChatId: async () => {
        lookups += 1;
        return null;
      },
    });
    const harness = createHarness(service);

    const commands = ['/pools', '/status', '/why', '/replay', '/verdict', '/pause', '/resume'];
    for (const command of commands) {
      harness.reset();
      await harness.send(command);
      expect(harness.texts(), `after ${command}`).toEqual([NOT_REGISTERED]);
    }
    expect(lookups).toBe(commands.length);
    // Nothing beyond the lookup may run for an unlinked chat: no listPools, no
    // getStatus, and above all no pausePool/resumePool state change.
    expect(service.calls).toEqual([]);
  });
});

describe('out of scope commands (docs §7)', () => {
  for (const command of FORBIDDEN_COMMANDS) {
    it(`ignores ${command} entirely — no service call, no reply`, async () => {
      const service = createFakeService();
      const harness = createHarness(service);

      await harness.send(`${command} 100`);

      expect(service.calls).toEqual([]);
      expect(harness.calls).toEqual([]);
    });
  }

  it('does not advertise any out-of-scope command in the Telegram menu', async () => {
    // BOT_COMMANDS is what main.ts hands to setMyCommands, i.e. the list the
    // user sees when they type "/".
    const registered = BOT_COMMANDS.map((entry) => `/${entry.command}`);
    for (const command of FORBIDDEN_COMMANDS) {
      expect(registered).not.toContain(command);
    }
  });

  it('never asks for a private key, and says so out loud', async () => {
    const service = createFakeService();
    const harness = createHarness(service);

    for (const command of [
      '/start one-time-token',
      '/help',
      '/pools',
      '/status',
      '/why',
      '/strategy',
      '/replay',
      '/verdict',
      '/pause',
      '/resume',
      '/remove',
      '/withdraw',
      '/add So11111111111111111111111111111111111111112',
      '/cancel',
    ]) {
      await harness.send(command);
    }

    const texts = harness.texts();
    // The guarantee has to be stated (docs §1: "The onboarding copy states the
    // guarantee out loud"), otherwise the checks below pass vacuously.
    expect(texts.filter((text) => /private key/i.test(text)).length).toBeGreaterThanOrEqual(2);

    for (const text of texts) {
      // No request-shaped mention, in any command's output.
      expect(text).not.toMatch(/(send|paste|enter|share|provide|give|type|what)[^.]{0,40}private key/i);
      // Every sentence that mentions one must be the denial.
      for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        if (/private key/i.test(sentence)) expect(sentence).toMatch(/never/i);
      }
    }
  });
});

describe('oversized payloads (docs §2)', () => {
  it('splits a >4096-char status report into valid, complete messages', async () => {
    // A real /status is server-rendered HTML with a <pre> block; the split has
    // to survive both the 4096 cap and Telegram's per-message HTML parsing.
    const row = 'HOLD  2026-08-13T06:00:00Z  in range, fees below floor\n';
    const html = `<b>lp-shadow — SOL-USDC</b>\nNAV strategy $10,180.22\n<pre>${row.repeat(
      120,
    )}</pre>\nVerdict: KEEP SHADOWING.`;
    expect(html.length).toBeGreaterThan(4096);

    const service = createFakeService({
      getStatus: async () => ({ pool: FAKE_POOL, html, verdictPass: false }),
    });
    const harness = createHarness(service);

    await harness.send('/status');

    const texts = harness.texts();
    expect(texts.length).toBeGreaterThan(1);
    for (const [index, text] of texts.entries()) {
      expect(text.length, `chunk ${index} length`).toBeLessThanOrEqual(4096);
      expect(text.length).toBeGreaterThan(0);
      expect(tagBalanceError(text), `chunk ${index} tags`).toBeNull();
    }

    // "never truncate silently": only the re-balancing tags may differ.
    expect(texts.map(stripTags).join('')).toBe(stripTags(html));
    // Every part is still sent with the parse mode the content assumes.
    for (const call of harness.calls.filter((entry) => entry.method === 'sendMessage')) {
      expect(call.payload.parse_mode).toBe('HTML');
      expect(call.payload.link_preview_options).toEqual({ is_disabled: true });
    }
  });
});
