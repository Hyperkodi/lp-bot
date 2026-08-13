import {
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ExecutionPipeline,
  DevnetRpc,
  TOKEN_PROGRAM_ID,
  inspectTransaction,
  type BuiltExecution,
  type ChainStateReader,
  type ExecutionBuilder,
  type ExecutionRequest,
  type ExecutionRpc,
  type ExecutionStore,
  type StoredIntent,
} from '../src/execution/index.js';
import { loadRawConfig, toExecutionConfig } from '../src/config.js';

const address = (fill: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => fill));
const projectWallet = address(1);
const founder = address(2);
const treasury = address(3);
const poolAccount = address(4);
const meteoraProgram = address(5);

const policy = {
  projectWalletAddress: projectWallet.toBase58(),
  founderWithdrawalAddress: founder.toBase58(),
  founderTokenAccounts: new Set<string>(),
  feeTreasuryAddress: treasury.toBase58(),
  feeTreasuryTokenAccounts: new Set<string>(),
  poolProgramAccounts: new Set([poolAccount.toBase58()]),
};

function transaction(...instructions: TransactionInstruction[]): Transaction {
  const tx = new Transaction({
    feePayer: projectWallet,
    recentBlockhash: '11111111111111111111111111111111',
  });
  if (instructions.length > 0) tx.add(...instructions);
  return tx;
}

describe('execution transaction inspection', () => {
  const allowedProgramIds = new Set([SystemProgram.programId.toBase58(), meteoraProgram.toBase58()]);

  it('accepts founder withdrawals and pool deposits', () => {
    expect(() =>
      inspectTransaction(
        transaction(
          SystemProgram.transfer({ fromPubkey: projectWallet, toPubkey: founder, lamports: 1 }),
          new TransactionInstruction({
            programId: meteoraProgram,
            keys: [{ pubkey: poolAccount, isSigner: false, isWritable: true }],
            data: Buffer.alloc(0),
          }),
        ),
        { action: 'WITHDRAW', allowedProgramIds, destinations: policy },
      ),
    ).not.toThrow();
  });

  it('rejects an unapproved program before signing', () => {
    expect(() =>
      inspectTransaction(
        transaction(new TransactionInstruction({ programId: address(9), keys: [], data: Buffer.alloc(0) })),
        { action: 'COMPOUND', allowedProgramIds, destinations: policy },
      ),
    ).toThrow(/program.*allowlist/i);
  });

  it('rejects transfers to a foreign destination', () => {
    expect(() =>
      inspectTransaction(
        transaction(SystemProgram.transfer({ fromPubkey: projectWallet, toPubkey: address(8), lamports: 1 })),
        { action: 'WITHDRAW', allowedProgramIds, destinations: policy },
      ),
    ).toThrow(/destination.*allowlist/i);
  });

  it('allows the treasury only for fee settlement', () => {
    const tx = transaction(
      SystemProgram.transfer({ fromPubkey: projectWallet, toPubkey: treasury, lamports: 1 }),
    );
    expect(() =>
      inspectTransaction(tx, { action: 'WITHDRAW', allowedProgramIds, destinations: policy }),
    ).toThrow(/treasury.*fee settlement/i);
    expect(() =>
      inspectTransaction(tx, { action: 'FEE_SETTLEMENT', allowedProgramIds, destinations: policy }),
    ).not.toThrow();
  });

  it('rejects SetAuthority and a foreign CloseAccount destination', () => {
    const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
    const tokenAllowed = new Set([...allowedProgramIds, TOKEN_PROGRAM_ID]);
    const setAuthority = new TransactionInstruction({
      programId: tokenProgram,
      keys: [{ pubkey: projectWallet, isSigner: true, isWritable: true }],
      data: Buffer.from([6]),
    });
    expect(() =>
      inspectTransaction(transaction(setAuthority), {
        action: 'COMPOUND',
        allowedProgramIds: tokenAllowed,
        destinations: policy,
      }),
    ).toThrow(/SetAuthority/);

    const closeForeign = new TransactionInstruction({
      programId: tokenProgram,
      keys: [
        { pubkey: poolAccount, isSigner: false, isWritable: true },
        { pubkey: address(8), isSigner: false, isWritable: true },
        { pubkey: projectWallet, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    });
    expect(() =>
      inspectTransaction(transaction(closeForeign), {
        action: 'EXIT',
        allowedProgramIds: tokenAllowed,
        destinations: policy,
      }),
    ).toThrow(/destination allowlist/);
  });

  it('inspects a versioned transaction after resolving its address lookup table', () => {
    const lookup = new AddressLookupTableAccount({
      key: address(10),
      state: {
        deactivationSlot: 18_446_744_073_709_551_615n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [founder],
      },
    });
    const message = new TransactionMessage({
      payerKey: projectWallet,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        SystemProgram.transfer({ fromPubkey: projectWallet, toPubkey: founder, lamports: 1 }),
      ],
    }).compileToV0Message([lookup]);
    const versioned = new VersionedTransaction(message);

    expect(() =>
      inspectTransaction(versioned, {
        action: 'WITHDRAW',
        allowedProgramIds,
        destinations: policy,
      }),
    ).toThrow(/resolved address tables/i);
    expect(() =>
      inspectTransaction(versioned, {
        action: 'WITHDRAW',
        allowedProgramIds,
        destinations: policy,
        addressLookupTables: [lookup],
      }),
    ).not.toThrow();
  });
});

describe('execution configuration', () => {
  it('loads explicit placeholder caps and refuses a mainnet signing RPC', () => {
    const config = toExecutionConfig(loadRawConfig('config/default.toml'));
    expect(config.cluster).toBe('devnet');
    expect(config.caps.perTransactionSol).toBeGreaterThan(0);
    expect(config.maxReconcileAttempts).toBeGreaterThan(0);
    expect(() => new DevnetRpc('https://api.mainnet-beta.solana.com')).toThrow(/devnet-only/i);
  });
});

class MemoryStore implements ExecutionStore {
  events: string[] = [];
  killed = false;
  intent: StoredIntent | null = null;
  projectRollingSol = 0;
  globalRollingSol = 0;
  status = '';
  outcomes = 0;

  async isKillSwitchEnabled() {
    this.events.push('kill-switch');
    return this.killed;
  }
  async withProjectLock<T>(
    _projectWalletId: string,
    work: (store: ExecutionStore) => Promise<T>,
  ): Promise<T> {
    this.events.push('lock');
    return work(this);
  }
  async findIntent(_idempotencyKey: string) {
    this.events.push('find-intent');
    return this.intent;
  }
  async createIntent(request: ExecutionRequest) {
    this.events.push('create-intent');
    this.intent = {
      id: 'intent-1',
      projectWalletId: request.projectWalletId,
      idempotencyKey: request.idempotencyKey,
      action: request.action,
      notionalSol: request.notionalSol,
      status: 'RECORDED',
    };
    return this.intent;
  }
  async rollingNotionalSol() {
    this.events.push('caps');
    return { projectSol: this.projectRollingSol, globalSol: this.globalRollingSol };
  }
  async countOutcomes() {
    return this.outcomes;
  }
  async createOutcome(_intentId: string, _attempt: number, status: string, signature?: string) {
    this.outcomes += 1;
    this.events.push(`outcome:${status}`);
    return { id: 1n, status, signature: signature ?? null };
  }
  async updateOutcome(_id: bigint, status: string) {
    this.events.push(`outcome:${status}`);
  }
  async updateIntent(_id: string, status: string) {
    this.status = status;
    this.events.push(`intent:${status}`);
    if (this.intent) this.intent.status = status;
  }
}

function request(): ExecutionRequest {
  return {
    projectWalletId: 'wallet-1',
    idempotencyKey: 'decision-1:compound',
    action: 'COMPOUND',
    notionalSol: 2,
    destinations: policy,
  };
}

function harness(maxReconcileAttempts?: number) {
  const store = new MemoryStore();
  const tx = transaction();
  const builder: ExecutionBuilder = {
    source: 'METEORA_SDK',
    async build(): Promise<BuiltExecution> {
      store.events.push('build');
      return { transactions: [{ phase: 'compound', notionalSol: 2, transaction: tx }] };
    },
  };
  const rpc: ExecutionRpc = {
    cluster: 'devnet',
    endpoint: 'https://api.devnet.solana.com',
    async simulate() {
      store.events.push('simulate');
      return { err: null };
    },
    async send() {
      store.events.push('send');
      return 'signature-1';
    },
    async confirm(_signature, commitment) {
      store.events.push(commitment);
    },
  };
  const chainState: ChainStateReader = {
    async read() {
      store.events.push('reconcile-read');
      return { state: 'APPLIED', detail: { position: 'updated' } };
    },
  };
  const pipeline = new ExecutionPipeline({
    store,
    builder,
    rpc,
    chainState,
    allowedProgramIds: new Set([SystemProgram.programId.toBase58(), meteoraProgram.toBase58()]),
    caps: { perTransactionSol: 10, projectRolling24hSol: 20, globalRolling24hSol: 100 },
    maxReconcileAttempts,
    async sign(_walletId, value) {
      store.events.push('sign');
      return value;
    },
  });
  return { store, pipeline, rpc, chainState };
}

describe('execution pipeline ordering', () => {
  it('records intent before build, simulates before signing, and reconciles after finalization', async () => {
    const { store, pipeline } = harness();
    const result = await pipeline.execute(request());

    expect(result.status).toBe('RECONCILED');
    expect(store.events).toEqual([
      'kill-switch',
      'lock',
      'find-intent',
      'create-intent',
      'build',
      'caps',
      'simulate',
      'sign',
      'send',
      'outcome:SENT',
      'intent:SENT',
      'confirmed',
      'outcome:CONFIRMED',
      'intent:CONFIRMED',
      'finalized',
      'outcome:FINALIZED',
      'intent:FINALIZED',
      'reconcile-read',
      'outcome:FINALIZED',
      'intent:RECONCILED',
    ]);
  });

  it('checks the kill switch before taking a lock or building', async () => {
    const { store, pipeline } = harness();
    store.killed = true;
    await expect(pipeline.execute(request())).rejects.toThrow(/kill switch/i);
    expect(store.events).toEqual(['kill-switch']);
  });

  it('never signs or sends a failed simulation', async () => {
    const { store, pipeline, rpc } = harness();
    rpc.simulate = async () => {
      store.events.push('simulate');
      return { err: 'program error' };
    };
    await expect(pipeline.execute(request())).rejects.toThrow(/simulation/i);
    expect(store.events).not.toContain('sign');
    expect(store.events).not.toContain('send');
  });

  it('stops before simulation when a rolling cap would be exceeded', async () => {
    const { store, pipeline } = harness();
    store.projectRollingSol = 19;
    await expect(pipeline.execute(request())).rejects.toThrow(/project.*24-hour cap/i);
    expect(store.events).not.toContain('simulate');
  });

  it('re-reads chain state after an unknown confirmation and never blind-resends', async () => {
    const { store, pipeline, rpc } = harness();
    rpc.confirm = async (_signature, commitment) => {
      store.events.push(commitment);
      if (commitment === 'confirmed') throw new Error('RPC flap');
    };
    const result = await pipeline.execute(request());
    expect(result.status).toBe('RECONCILED');
    expect(store.events.filter((event) => event === 'send')).toHaveLength(1);
    expect(store.events.indexOf('reconcile-read')).toBeGreaterThan(store.events.indexOf('confirmed'));
  });

  it('retries under the same intent only after chain state proves it was not applied', async () => {
    const { store, pipeline, rpc, chainState } = harness();
    let confirmationCalls = 0;
    rpc.confirm = async (_signature, commitment) => {
      store.events.push(commitment);
      confirmationCalls += 1;
      if (confirmationCalls === 1) throw new Error('unknown first send');
    };
    let reads = 0;
    chainState.read = async () => {
      store.events.push('reconcile-read');
      reads += 1;
      return reads === 1
        ? { state: 'NOT_APPLIED', detail: {} }
        : { state: 'APPLIED', detail: { position: 'updated' } };
    };

    const result = await pipeline.execute(request());
    expect(result.status).toBe('RECONCILED');
    expect(store.events.filter((event) => event === 'send')).toHaveLength(2);
    expect(store.events.filter((event) => event === 'create-intent')).toHaveLength(1);
    expect(store.events.indexOf('reconcile-read')).toBeLessThan(store.events.lastIndexOf('build'));
  });

  it('bounds recovery attempts and leaves unknown funds in a stuck safe state', async () => {
    const { store, pipeline, rpc, chainState } = harness(2);
    rpc.confirm = async (_signature, commitment) => {
      store.events.push(commitment);
      throw new Error('still unknown');
    };
    chainState.read = async () => {
      store.events.push('reconcile-read');
      return { state: 'NOT_APPLIED', detail: {} };
    };
    const result = await pipeline.execute(request());
    expect(result.status).toBe('STUCK');
    expect(store.events.filter((event) => event === 'send')).toHaveLength(2);
  });
});
