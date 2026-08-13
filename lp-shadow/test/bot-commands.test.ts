/**
 * The command surface: routing, pool-argument pass-through, the tenant gate,
 * onboarding copy, and the transport invariants every reply must satisfy.
 *
 * Everything here is driven through synthetic Telegram updates, so a break
 * anywhere between grammY's command matcher, the handler, and the renderer
 * shows up as a wrong service call or wrong user-visible text.
 */
import { describe, expect, it } from 'vitest';
import { BOT_COMMANDS } from '../src/bot/bot.js';
import {
  createFakeService,
  createHarness,
  FAKE_POOL,
  FAKE_TENANT,
  TEST_CHAT_ID,
} from './helpers/botHarness.js';

/** Verbatim from docs/FRONTEND_TELEGRAM_BOT.md §5. */
const NOT_REGISTERED =
  "This chat isn't linked to an account yet. Ask the Armara bot for an LP-agent link — it hands you off here with a one-time token.";

const CHAT = String(TEST_CHAT_ID);

type CommandCase = {
  command: string;
  /** The one service method this command must reach. */
  method: string;
  /** Exact service arguments when the user gives no pool reference. */
  argsWithoutRef: unknown[];
  /** Exact service arguments for `<command> SOL-USDC`. */
  argsWithRef: unknown[];
  /** Fragments the person in the chat must actually see. */
  contains: string[];
};

/**
 * The read/act commands. `argsWithRef` encodes the contract from §4: the raw
 * remainder is passed verbatim to the service, which does the matching — and
 * the two commands that take no `[pool]` must ignore a trailing word rather
 * than quietly turning it into a filter.
 */
const COMMANDS: CommandCase[] = [
  {
    command: '/pools',
    method: 'listPools',
    argsWithoutRef: ['tenant-1'],
    argsWithRef: ['tenant-1'],
    contains: ['Pools', 'SOL-USDC', 'SHADOW', '$10,000.00', '12.5'],
  },
  {
    command: '/status',
    method: 'getStatus',
    argsWithoutRef: ['tenant-1', undefined],
    argsWithRef: ['tenant-1', 'SOL-USDC'],
    contains: ['NAV strategy $10,180.22'],
  },
  {
    command: '/why',
    method: 'getWhy',
    argsWithoutRef: ['tenant-1', undefined],
    argsWithRef: ['tenant-1', 'SOL-USDC'],
    contains: [
      'Why — SOL-USDC',
      'REBALANCE',
      '• b. oor dwell PASS: 47.0min out of range, needs 30.0min',
      'Since then: HOLD ×91',
    ],
  },
  {
    command: '/strategy',
    method: 'getStrategy',
    // The strategy is global and versioned: it takes neither tenant nor pool.
    argsWithoutRef: [],
    argsWithRef: [],
    contains: [
      'Strategy v1',
      'seeded from config/default.toml',
      'oorDwellMin: 30',
      'the advisory gate: enough days, a regime change, and beating HODL',
    ],
  },
  {
    command: '/replay',
    method: 'runReplay',
    argsWithoutRef: ['tenant-1', undefined],
    argsWithRef: ['tenant-1', 'SOL-USDC'],
    contains: ['Replay — SOL-USDC', 'Snapshots: 1440', 'stamped v1', '+$32.10'],
  },
  {
    command: '/verdict',
    method: 'getVerdict',
    argsWithoutRef: ['tenant-1', undefined],
    argsWithRef: ['tenant-1', 'SOL-USDC'],
    contains: [
      'Verdict — SOL-USDC',
      '❌ shadow window 12.5d / 28d',
      '✅ strategy beats HODL',
      'KEEP SHADOWING.',
    ],
  },
  {
    command: '/pause',
    method: 'pausePool',
    argsWithoutRef: ['tenant-1', undefined],
    argsWithRef: ['tenant-1', 'SOL-USDC'],
    contains: ['<b>SOL-USDC</b> is now paused.'],
  },
  {
    command: '/resume',
    method: 'resumePool',
    argsWithoutRef: ['tenant-1', undefined],
    argsWithRef: ['tenant-1', 'SOL-USDC'],
    contains: ['<b>SOL-USDC</b> is shadowing again.'],
  },
];

/** Every command that must refuse to do anything for an unlinked chat (§4). */
const GATED_COMMANDS = [
  '/add So11111111111111111111111111111111111111112',
  '/pools',
  '/status',
  '/why',
  '/strategy',
  '/replay',
  '/verdict',
  '/pause',
  '/resume',
  '/remove',
  '/cancel',
];

describe('command routing', () => {
  it.each(COMMANDS)(
    '$command calls $method with no pool reference and renders a readable reply',
    async ({ command, method, argsWithoutRef, contains }) => {
      const service = createFakeService();
      const harness = createHarness(service);

      await harness.send(command);

      // Exactly the tenant lookup plus the one command method: a handler that
      // reached for extra data (or the wrong report) fails here.
      expect(service.calls.map((call) => call.method)).toEqual([
        'getTenantByChatId',
        method,
      ]);
      expect(service.calls[1]?.args).toEqual(argsWithoutRef);

      const reply = harness.texts().join('\n');
      for (const fragment of contains) expect(reply).toContain(fragment);
    },
  );

  it.each(COMMANDS)(
    '$command passes the pool argument through to the service verbatim',
    async ({ command, method, argsWithRef }) => {
      const service = createFakeService();
      const harness = createHarness(service);

      await harness.send(`${command} SOL-USDC`);

      const call = service.calls.find((entry) => entry.method === method);
      expect(call?.args).toEqual(argsWithRef);
    },
  );

  it('passes an awkward pool reference through untouched apart from trimming', async () => {
    // The service owns matching (id / address / label, case-insensitive), so
    // the bot must not split on whitespace, lowercase, or HTML-escape the ref
    // on the way in — any of those would silently change which pool is meant.
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/status   Ryan & Co / Pool #2  ');

    expect(service.calls.find((call) => call.method === 'getStatus')?.args).toEqual([
      'tenant-1',
      'Ryan & Co / Pool #2',
    ]);
  });

  it('honours a command addressed to the bot by username, argument intact', async () => {
    // Telegram appends @botname in groups; dropping the argument there would
    // silently target the wrong pool.
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/pause@lp_shadow_test_bot SOL-USDC');

    expect(service.calls.find((call) => call.method === 'pausePool')?.args).toEqual([
      'tenant-1',
      'SOL-USDC',
    ]);
    expect(harness.texts().join('\n')).toContain('is now paused');
  });

  it('answers every command it advertises in the Telegram menu', async () => {
    // BOT_COMMANDS is what setMyCommands publishes: a listed command with no
    // handler is a dead menu entry.
    for (const { command } of BOT_COMMANDS) {
      const service = createFakeService();
      const harness = createHarness(service);

      await harness.send(`/${command}`);

      expect(harness.texts(), `/${command} sent no reply`).not.toHaveLength(0);
    }
  });
});

describe('tenant gate', () => {
  it.each(GATED_COMMANDS)(
    '%s refuses an unlinked chat with the not-registered copy and touches nothing else',
    async (command) => {
      const lookups: string[] = [];
      const service = createFakeService({
        getTenantByChatId: async (telegramChatId: string) => {
          lookups.push(telegramChatId);
          return null;
        },
      });
      const harness = createHarness(service);

      await harness.send(command);

      expect(lookups).toEqual([CHAT]);
      // Overridden methods bypass the recorder, so an empty `calls` is proof
      // that no other service method ran — nothing acts before the gate.
      expect(service.calls).toEqual([]);
      expect(harness.texts()).toEqual([NOT_REGISTERED]);
    },
  );

  it('lets /help through without a tenant lookup at all', async () => {
    // /help is the escape hatch for someone who has not been handed off yet;
    // it must never depend on registration.
    const lookups: string[] = [];
    const service = createFakeService({
      getTenantByChatId: async (telegramChatId: string) => {
        lookups.push(telegramChatId);
        return null;
      },
    });
    const harness = createHarness(service);

    await harness.send('/help');

    expect(lookups).toEqual([]);
    expect(service.calls).toEqual([]);
    expect(harness.texts().join('\n')).toContain('LP Shadow commands');
  });
});

describe('/start', () => {
  it('redeems a handoff token against this chat and welcomes the user', async () => {
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/start handoff-token-abc');

    // The token path must not also consult getTenantByChatId: the chat is
    // being bound right now, so a pre-existing tenant is not a precondition.
    expect(service.calls).toEqual([
      { method: 'redeemHandoff', args: ['handoff-token-abc', CHAT] },
    ]);
    const reply = harness.texts().join('\n');
    expect(reply).toContain('I never ask for a private key and I cannot hold one.');
    expect(reply).toContain('/add');
  });

  it('greets a returning user by label when no token is given', async () => {
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/start');

    expect(service.calls).toEqual([{ method: 'getTenantByChatId', args: [CHAT] }]);
    expect(harness.texts()).toEqual([
      "Welcome back, <b>Test Project</b>. Use /pools to see what you're shadowing.",
    ]);
  });

  it('escapes the tenant label in the returning-user greeting', async () => {
    // The label comes from the parent bot, not from us: unescaped markup here
    // would break the message (Telegram 400) or inject formatting.
    const service = createFakeService({
      getTenantByChatId: async () => ({ ...FAKE_TENANT, label: 'Ryan & <b>Co</b>' }),
    });
    const harness = createHarness(service);

    await harness.send('/start');

    const reply = harness.texts().join('\n');
    expect(reply).toContain('Ryan &amp; &lt;b&gt;Co&lt;/b&gt;');
    expect(reply).not.toContain('<b>Co</b>');
  });

  it('sends the not-registered copy with no token and no tenant', async () => {
    const service = createFakeService({ getTenantByChatId: async () => null });
    const harness = createHarness(service);

    await harness.send('/start');

    expect(service.calls).toEqual([]);
    expect(harness.texts()).toEqual([NOT_REGISTERED]);
  });
});

describe('/help', () => {
  it('lists every registered command and restates the keyless guarantee', async () => {
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/help');

    const reply = harness.texts().join('\n');
    for (const { command } of BOT_COMMANDS) {
      expect(reply, `/help omits /${command}`).toContain(`/${command}`);
    }
    expect(reply).toContain('never ask for or hold a private key');
  });

  it('never advertises a command that would need a key or funds', async () => {
    // §7: the absence of these is the product guarantee. Help is where a
    // regression would first become visible to a user.
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/help');

    const reply = harness.texts().join('\n');
    for (const forbidden of ['/wallet', '/harvest', '/rebalance', '/close', '/settings']) {
      expect(reply).not.toContain(forbidden);
    }
  });
});

describe('/status HTML', () => {
  it('sends the service-rendered html byte for byte, without re-escaping it', async () => {
    // StatusReport.html is already Telegram-ready (§6). Escaping it a second
    // time would show users literal &amp;amp; and &lt;b&gt; instead of a
    // formatted report.
    const html =
      '<b>lp-shadow — SOL-USDC</b>\nNAV $10,180.22 &amp; HODL $10,148.12\nfees > costs\n<pre>in range 82%</pre>';
    const service = createFakeService({
      getStatus: async () => ({ pool: FAKE_POOL, html, verdictPass: false }),
    });
    const harness = createHarness(service);

    await harness.send('/status');

    expect(harness.texts()).toEqual([html]);
    expect(String(harness.lastMessage()?.text)).not.toContain('&amp;amp;');
  });
});

describe('transport invariants', () => {
  it('sends exactly one HTML reply with link previews disabled for every command', async () => {
    const service = createFakeService();
    const harness = createHarness(service);
    const commands = [
      '/start',
      '/help',
      '/pools',
      '/status',
      '/why',
      '/strategy',
      '/replay',
      '/verdict',
      '/pause',
      '/resume',
      // /remove replies with an inline keyboard: its extra options must be
      // merged onto the defaults, not replace them.
      '/remove',
    ];

    for (const command of commands) await harness.send(command);

    const messages = harness.calls.filter((call) => call.method === 'sendMessage');
    expect(messages).toHaveLength(commands.length);
    for (const message of messages) {
      expect(message.payload.parse_mode).toBe('HTML');
      expect(message.payload.link_preview_options).toEqual({ is_disabled: true });
      expect(String(message.payload.text).length).toBeGreaterThan(0);
    }
  });
});
