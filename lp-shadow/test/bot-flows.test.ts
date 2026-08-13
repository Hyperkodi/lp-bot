/**
 * The multi-step conversation flows and their inline keyboards.
 *
 * Every confirmed front-end defect lived here — a stale card winning over a
 * corrected one, a stale Cancel wiping out an unrelated live flow, a failed
 * addPool stranding the user — so these are driven through real updates
 * (message, then callback_query) rather than by calling renderers directly.
 */
import { describe, expect, it } from 'vitest';
import { ServiceError, type PoolPreview } from '../src/service/index.js';
import {
  buttonData,
  createFakeService,
  createHarness,
  FAKE_POOL,
  FAKE_PREVIEW,
  type Harness,
} from './helpers/botHarness.js';

/** What the user pastes: deliberately NOT the canonical address previewPool returns. */
const TYPED_ADDRESS = 'TypedByTheUser111111111111111111111111111';

const UNNAMED_PREVIEW: PoolPreview = {
  ...FAKE_PREVIEW,
  poolAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  name: null,
};

type AddInput = { poolAddress: string; label: string; virtualNavUsd: number };
type AddCall = { tenantId: string; input: AddInput };

/**
 * A service whose addPool records its input and echoes the requested size back
 * as the stored pool. Echoing matters: it makes the confirmation the user reads
 * ("… is now shadowing $2,500.00") reveal which size actually won, instead of
 * always reprinting the fixture's $10,000.
 */
function addSpyService(overrides: Partial<Parameters<typeof createFakeService>[0]> = {}): {
  service: ReturnType<typeof createFakeService>;
  added: AddCall[];
} {
  const added: AddCall[] = [];
  const service = createFakeService({
    addPool: async (tenantId, input) => {
      added.push({ tenantId, input });
      return { ...FAKE_POOL, label: input.label, virtualNavUsd: input.virtualNavUsd };
    },
    ...overrides,
  });
  return { service, added };
}

/** Callback data of a button on the newest outbound message, or a loud failure. */
function button(harness: Harness, pattern: RegExp): string {
  const data = buttonData(harness.lastMessage(), pattern);
  if (data === undefined) {
    throw new Error(
      `no button matching ${String(pattern)} on message: ${String(harness.lastMessage()?.text)}`,
    );
  }
  return data;
}

function lastText(harness: Harness): string {
  return harness.texts().at(-1) ?? '';
}

/** The message_id the fake API handed to the newest outbound message. */
function newestMessageId(harness: Harness): number {
  return harness.calls.findLastIndex((call) => call.method === 'sendMessage') + 1;
}

/** Drive /add through to an armed confirmation card and return its buttons. */
async function armCard(
  harness: Harness,
  amount: string,
  address = TYPED_ADDRESS,
): Promise<{ confirm: string; cancel: string; messageId: number }> {
  await harness.send(`/add ${address}`);
  await harness.send(amount);
  return {
    confirm: button(harness, /Shadow it/),
    cancel: button(harness, /^Cancel$/),
    messageId: newestMessageId(harness),
  };
}

describe('/add — happy path', () => {
  it('previews, takes a size, and on "Shadow it" adds the previewed pool at that size', async () => {
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    await harness.send(`/add ${TYPED_ADDRESS}`);

    // The preview asks the sizing question and carries no buttons: the answer
    // is a typed number, not a tap.
    expect(lastText(harness)).toContain('How much would you actually deploy, in USD?');
    expect(harness.lastMessage()?.reply_markup).toBeUndefined();
    expect(service.calls.find((call) => call.method === 'previewPool')?.args).toEqual([
      TYPED_ADDRESS,
    ]);
    expect(added).toHaveLength(0);

    await harness.send('2500');

    const card = harness.lastMessage();
    expect(String(card?.text)).toContain('Confirm shadow pool');
    expect(String(card?.text)).toContain('Size: $2,500.00');
    // Nothing is registered until the tap.
    expect(added).toHaveLength(0);

    const confirm = button(harness, /Shadow it/);
    expect(confirm).toMatch(/^add:confirm:/);
    expect(button(harness, /^Cancel$/)).toMatch(/^add:cancel:/);

    await harness.tap(confirm, newestMessageId(harness));

    // The address registered is the one previewPool resolved, not the raw text
    // the user pasted, and the label comes from the preview's name.
    expect(added).toEqual([
      {
        tenantId: 'tenant-1',
        input: {
          poolAddress: FAKE_PREVIEW.poolAddress,
          label: 'SOL-USDC',
          virtualNavUsd: 2500,
        },
      },
    ]);
    expect(lastText(harness)).toContain('is now shadowing');
    expect(lastText(harness)).toContain('$2,500.00');
  });

  it('labels an unnamed pool with the first 8 characters of its address', async () => {
    const { service, added } = addSpyService({ previewPool: async () => UNNAMED_PREVIEW });
    const harness = createHarness(service);

    const { confirm, messageId } = await armCard(harness, '750');

    // The card shows the same fallback the pool will be stored under, so the
    // user confirms the name they will later see in /pools.
    expect(String(harness.lastMessage()?.text)).toContain('Pool: 9WzDXwBb');

    await harness.tap(confirm, messageId);

    expect(added.map((call) => call.input.label)).toEqual([
      UNNAMED_PREVIEW.poolAddress.slice(0, 8),
    ]);
    expect(added.map((call) => call.input.label)).toEqual(['9WzDXwBb']);
  });

  it('does not add the pool twice when the completed card is tapped again', async () => {
    // Telegram happily delivers a double tap; the second one must be inert.
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    const { confirm, messageId } = await armCard(harness, '1000');
    await harness.tap(confirm, messageId);
    await harness.tap(confirm, messageId);

    expect(added).toHaveLength(1);
    expect(lastText(harness)).toContain('no longer active');
  });
});

describe('/add — size entry', () => {
  it('asks again for anything that is not a positive number, and stays armed', async () => {
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    await harness.send(`/add ${TYPED_ADDRESS}`);

    for (const reply of ['a lot', '0', '-5']) {
      await harness.send(reply);
      expect(lastText(harness)).toBe('Send a positive number in USD, or use /cancel.');
      expect(harness.lastMessage()?.reply_markup).toBeUndefined();
    }
    expect(added).toHaveLength(0);

    // The question must survive the bad answers — otherwise the user has to
    // paste the address again to recover from a typo.
    await harness.send('1200');
    expect(String(harness.lastMessage()?.text)).toContain('Size: $1,200.00');
    expect(button(harness, /Shadow it/)).toMatch(/^add:confirm:/);
  });

  it('rejects a thousands-separated amount instead of reading it as a smaller number', async () => {
    // parseFloat('1,000') is 1 — silently shadowing $1 instead of $1,000 would
    // invalidate every number the agent later reports.
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    await harness.send(`/add ${TYPED_ADDRESS}`);
    await harness.send('1,000');

    expect(lastText(harness)).toBe('Send a positive number in USD, or use /cancel.');
    expect(harness.texts().join('\n')).not.toContain('Confirm shadow pool');
    expect(added).toHaveLength(0);
  });

  it('does not arm the size question when /add is sent without an address', async () => {
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    await harness.send('/add');
    expect(lastText(harness)).toContain('paste a Meteora DLMM pool address');
    expect(service.calls.map((call) => call.method)).not.toContain('previewPool');

    // A stray number afterwards is just chat, not a pool size.
    await harness.send('5000');
    expect(harness.texts()).toHaveLength(1);
    expect(added).toHaveLength(0);
  });
});

describe('/add — corrected and stale cards', () => {
  it('replaces a pending card when a corrected size arrives, and adds the corrected size', async () => {
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    const first = await armCard(harness, '1000');
    await harness.send('2500');

    const second = {
      confirm: button(harness, /Shadow it/),
      messageId: newestMessageId(harness),
    };
    expect(second.confirm).not.toBe(first.confirm);
    expect(String(harness.lastMessage()?.text)).toContain('Size: $2,500.00');
    // The superseded card's buttons are stripped so it cannot be tapped by
    // mistake — the edit must target that older card, not the new one.
    expect(
      harness.calls.filter(
        (call) => call.method === 'editMessageReplyMarkup' && call.payload.message_id === first.messageId,
      ),
    ).toHaveLength(1);

    await harness.tap(second.confirm, second.messageId);

    expect(added.map((call) => call.input.virtualNavUsd)).toEqual([2500]);
    expect(lastText(harness)).toContain('$2,500.00');
    expect(lastText(harness)).not.toContain('$1,000.00');
  });

  it('refuses the superseded card after a correction and still honours the newest one', async () => {
    // The core defect: the old card must never win, and refusing it must not
    // cost the user the flow they just corrected.
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    const stale = await armCard(harness, '1000');
    await harness.send('2500');
    const live = { confirm: button(harness, /Shadow it/), messageId: newestMessageId(harness) };

    await harness.tap(stale.confirm, stale.messageId);

    expect(added).toHaveLength(0);
    expect(lastText(harness)).toBe('That confirmation is no longer active. Start again with /add.');

    await harness.tap(live.confirm, live.messageId);

    expect(added.map((call) => call.input.virtualNavUsd)).toEqual([2500]);
    expect(lastText(harness)).toContain('is now shadowing');
  });

  it('refuses a card left over from an earlier /add run', async () => {
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    const firstRun = await armCard(harness, '1000');
    const secondRun = await armCard(harness, '7000');
    expect(secondRun.confirm).not.toBe(firstRun.confirm);

    await harness.tap(firstRun.confirm, firstRun.messageId);

    expect(added).toHaveLength(0);
    expect(lastText(harness)).toContain('no longer active');

    // The current flow is untouched by the stale tap.
    await harness.tap(secondRun.confirm, secondRun.messageId);
    expect(added.map((call) => call.input.virtualNavUsd)).toEqual([7000]);
  });

  it('does not let a stale Cancel destroy the live flow', async () => {
    // A Cancel that clears pending state unconditionally would silently kill
    // the confirmation the user is actually looking at.
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    const stale = await armCard(harness, '1000');
    const live = await armCard(harness, '3000');

    await harness.tap(stale.cancel, stale.messageId);
    expect(lastText(harness)).toBe('That confirmation is no longer active.');

    await harness.tap(live.confirm, live.messageId);
    expect(added.map((call) => call.input.virtualNavUsd)).toEqual([3000]);
    expect(lastText(harness)).toContain('is now shadowing');
  });

  it('cancels the live card on its own Cancel and adds nothing afterwards', async () => {
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    const card = await armCard(harness, '1000');
    await harness.tap(card.cancel, card.messageId);
    expect(lastText(harness)).toBe('Cancelled.');

    await harness.tap(card.confirm, card.messageId);
    expect(added).toHaveLength(0);
    expect(lastText(harness)).toContain('no longer active');
  });
});

describe('/add — failure recovery', () => {
  it('keeps the confirmation retryable when addPool fails', async () => {
    // The service call happens before the state is cleared, so a transient
    // failure leaves the same button live instead of forcing a fresh /add.
    let failing = true;
    const added: AddCall[] = [];
    const service = createFakeService({
      addPool: async (tenantId, input) => {
        if (failing) throw new ServiceError('POOL_UNREACHABLE', 'meteora lookup failed');
        added.push({ tenantId, input });
        return { ...FAKE_POOL, label: input.label, virtualNavUsd: input.virtualNavUsd };
      },
    });
    const harness = createHarness(service);

    const card = await armCard(harness, '1000');
    await harness.tap(card.confirm, card.messageId);

    expect(added).toHaveLength(0);
    expect(lastText(harness)).toBe(
      "That doesn't look like a reachable Meteora DLMM pool — check the address.",
    );
    // The keyboard must survive: stripping it would strand the user on a dead card.
    expect(harness.calls.filter((call) => call.method === 'editMessageReplyMarkup')).toHaveLength(0);

    failing = false;
    await harness.tap(card.confirm, card.messageId);

    expect(added.map((call) => call.input.virtualNavUsd)).toEqual([1000]);
    expect(lastText(harness)).toContain('is now shadowing');
  });
});

describe('/remove', () => {
  it('confirms first, then removes the named pool and says history is kept', async () => {
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/remove SOL-USDC');

    expect(lastText(harness)).toContain('Stop shadowing');
    expect(lastText(harness)).toContain('SOL-USDC');
    // Nothing is removed by the prompt itself.
    expect(service.calls.map((call) => call.method)).not.toContain('removePool');

    const confirm = button(harness, /Stop shadowing — history is kept/);
    expect(confirm).toMatch(/^remove:confirm:/);

    await harness.tap(confirm, newestMessageId(harness));

    // The pool reference the user typed must reach the service, or the wrong
    // pool gets stopped.
    expect(service.calls.find((call) => call.method === 'removePool')?.args).toEqual([
      'tenant-1',
      'SOL-USDC',
    ]);
    expect(lastText(harness)).toContain('Stopped shadowing');
    expect(lastText(harness)).toContain('History is kept.');
  });

  it('removes nothing when the confirmation is cancelled, and disarms the card', async () => {
    const service = createFakeService();
    const harness = createHarness(service);

    await harness.send('/remove');
    const confirm = button(harness, /Stop shadowing — history is kept/);
    const cancel = button(harness, /^Cancel$/);
    const messageId = newestMessageId(harness);

    await harness.tap(cancel, messageId);

    expect(lastText(harness)).toBe('Cancelled.');
    expect(service.calls.map((call) => call.method)).not.toContain('removePool');

    // The card is dead: tapping confirm afterwards must not resurrect it.
    await harness.tap(confirm, messageId);
    expect(service.calls.map((call) => call.method)).not.toContain('removePool');
    expect(lastText(harness)).toContain('no longer active');
  });
});

describe('/cancel', () => {
  it('clears a pending size question so a later number is not read as a size', async () => {
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    await harness.send(`/add ${TYPED_ADDRESS}`);
    await harness.send('/cancel');
    expect(lastText(harness)).toBe('Cancelled.');

    await harness.send('4000');

    // A stray number in an idle chat gets no reply at all.
    expect(harness.texts()).toHaveLength(2);
    expect(harness.texts().join('\n')).not.toContain('Confirm shadow pool');
    expect(added).toHaveLength(0);
  });

  it('disarms a pending confirmation card', async () => {
    const { service, added } = addSpyService();
    const harness = createHarness(service);

    const card = await armCard(harness, '1000');
    await harness.send('/cancel');
    await harness.tap(card.confirm, card.messageId);

    expect(added).toHaveLength(0);
    expect(lastText(harness)).toContain('no longer active');
  });
});
