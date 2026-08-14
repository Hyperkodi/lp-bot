import type { Transaction, VersionedTransaction } from '@solana/web3.js';
import { inspectTransaction } from './inspect.js';
import { enforcePositionPolicy, PERMANENT_INITIAL_POSITION_ROLE } from './initialLiquidityPolicy.js';
import type {
  BuiltExecution,
  ChainState,
  ChainStateReader,
  ExecutionBuilder,
  ExecutionCaps,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRpc,
  ExecutionStore,
  StoredIntent,
} from './types.js';

export type ExecutionAlert = {
  kind: 'KILL_SWITCH' | 'LOCK_CONTENTION' | 'CAP_TRIP' | 'SIMULATION_FAILED' | 'RECONCILER_STUCK';
  projectWalletId: string;
  message: string;
};

type PipelineDependencies = {
  store: ExecutionStore;
  builder: ExecutionBuilder;
  rpc: ExecutionRpc;
  chainState: ChainStateReader;
  allowedProgramIds: ReadonlySet<string>;
  caps: ExecutionCaps;
  maxReconcileAttempts?: number;
  alert?(event: ExecutionAlert): Promise<void>;
  sign(
    projectWalletId: string,
    transaction: Transaction | VersionedTransaction,
  ): Promise<Transaction | VersionedTransaction>;
};

function assertCaps(caps: ExecutionCaps) {
  for (const [name, value] of Object.entries(caps)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid execution cap ${name}`);
  }
}

export class ExecutionPipeline {
  private readonly maxReconcileAttempts: number;

  constructor(private readonly dependencies: PipelineDependencies) {
    assertCaps(dependencies.caps);
    this.maxReconcileAttempts = dependencies.maxReconcileAttempts ?? 3;
    if (!Number.isInteger(this.maxReconcileAttempts) || this.maxReconcileAttempts < 1) {
      throw new Error('maxReconcileAttempts must be a positive integer');
    }
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const { store, rpc } = this.dependencies;
    if (await store.isKillSwitchEnabled()) {
      await this.alert('KILL_SWITCH', request, 'execution kill switch is enabled');
      throw new Error('execution kill switch is enabled');
    }
    try {
      return await store.withProjectLock(request.projectWalletId, (lockedStore) =>
        rpc.cluster !== 'devnet' || !rpc.endpoint.toLowerCase().includes('devnet')
          ? Promise.reject(new Error('signed execution is devnet-only'))
          : this.executeLocked(lockedStore, request),
      );
    } catch (error) {
      if (String(error).toLowerCase().includes('lock contention')) {
        await this.alert('LOCK_CONTENTION', request, String(error));
      }
      throw error;
    }
  }

  private async executeLocked(store: ExecutionStore, request: ExecutionRequest): Promise<ExecutionResult> {
    if (!Number.isFinite(request.notionalSol) || request.notionalSol < 0) {
      throw new Error('execution notional must be finite and non-negative');
    }
    await this.enforceDurablePositionPolicy(store, request);
    let intent = await store.findIntent(request.idempotencyKey);
    let recoveryState: ChainState | null = null;
    if (intent) {
      if (intent.status === 'RECONCILED') return { intentId: intent.id, status: intent.status };
      recoveryState = await this.dependencies.chainState.read(intent);
      if (recoveryState.state === 'APPLIED') {
        await store.updateIntent(intent.id, 'RECONCILED');
        return { intentId: intent.id, status: 'RECONCILED' };
      }
      if (recoveryState.state === 'UNKNOWN') return this.stuck(store, request, intent);
      // NOT_APPLIED and PARTIAL are the only states from which retry is safe,
      // and both were established by a chain read under the project lock.
    } else {
      intent = await store.createIntent(request);
    }

    this.assertBuilder(request);
    const built =
      recoveryState?.state === 'PARTIAL'
        ? await this.buildCompletion(request, recoveryState)
        : await this.dependencies.builder.build(request);
    await this.inspectBuilt(request, built);
    await this.checkCaps(store, request, intent.id, built);
    return this.runBuilt(store, request, intent, built);
  }

  private async enforceDurablePositionPolicy(
    store: ExecutionStore,
    request: ExecutionRequest,
  ): Promise<void> {
    const detail = request.detail ?? {};
    enforcePositionPolicy(request.action, detail);
    const candidates = [detail.oldPositionAddress, detail.positionAddress]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const positionAddress of new Set(candidates)) {
      if (await store.isPermanentInitialPosition(request.projectWalletId, positionAddress)) {
        enforcePositionPolicy(request.action, {
          ...detail,
          positionRole: PERMANENT_INITIAL_POSITION_ROLE,
        });
      }
    }
  }

  private assertBuilder(request: ExecutionRequest) {
    if (this.dependencies.builder.source === 'METEORA_SDK') return;
    if (this.dependencies.builder.source === 'WITHDRAWAL_SWEEP' && request.action === 'WITHDRAW') return;
    {
      throw new Error('execution builder must be Meteora SDK, except an explicit full-withdrawal sweep');
    }
  }

  private async inspectBuilt(request: ExecutionRequest, built: BuiltExecution) {
    if (built.transactions.length === 0) throw new Error('Meteora SDK builder returned no transactions');
    for (const item of built.transactions) {
      if (!Number.isFinite(item.notionalSol) || item.notionalSol < 0) {
        throw new Error('Meteora SDK builder returned invalid transaction notional');
      }
      if (item.notionalSol > request.notionalSol) {
        throw new Error('Meteora SDK transaction notional exceeds the recorded intent');
      }
      const addressLookupTables = await this.dependencies.rpc.resolveAddressLookupTables?.(item.transaction);
      inspectTransaction(item.transaction, {
        action: request.action,
        allowedProgramIds: this.dependencies.allowedProgramIds,
        destinations: request.destinations,
        ...(addressLookupTables ? { addressLookupTables } : {}),
      });
    }
  }

  private async checkCaps(
    store: ExecutionStore,
    request: ExecutionRequest,
    intentId: string,
    built: BuiltExecution,
  ) {
    const rolling = await store.rollingNotionalSol(
      request.projectWalletId,
      new Date(Date.now() - 24 * 60 * 60 * 1_000),
      intentId,
    );
    let message: string | null = null;
    if (built.transactions.some((item) => item.notionalSol > this.dependencies.caps.perTransactionSol)) {
      message = 'per-transaction notional cap exceeded';
    } else if (rolling.projectSol + request.notionalSol > this.dependencies.caps.projectRolling24hSol) {
      message = 'project rolling 24-hour cap exceeded';
    } else if (rolling.globalSol + request.notionalSol > this.dependencies.caps.globalRolling24hSol) {
      message = 'global rolling 24-hour cap exceeded';
    }
    if (message) {
      await this.alert('CAP_TRIP', request, message);
      throw new Error(message);
    }
  }

  private async runBuilt(
    store: ExecutionStore,
    request: ExecutionRequest,
    intent: StoredIntent,
    built: BuiltExecution,
  ): Promise<ExecutionResult> {
    let lastSignature: string | undefined;
    let lastOutcomeId: bigint | undefined;
    for (const item of built.transactions) {
      const prepared = this.dependencies.rpc.prepare
        ? await this.dependencies.rpc.prepare(item.transaction, request.destinations.projectWalletAddress)
        : item.transaction;
      const simulation = await this.dependencies.rpc.simulate(prepared);
      if (simulation.err !== null) {
        await store.updateIntent(intent.id, 'SIMULATION_FAILED');
        const errorDetail =
          typeof simulation.err === 'string'
            ? simulation.err
            : JSON.stringify(simulation.err);
        const logs = simulation.logs?.length ? `\n${simulation.logs.join('\n')}` : '';
        const message = `transaction simulation failed: ${errorDetail}${logs}`;
        await this.alert('SIMULATION_FAILED', request, message);
        throw new Error(message);
      }

      const signed = await this.dependencies.sign(request.projectWalletId, prepared);
      const attempt = (await store.countOutcomes(intent.id)) + 1;
      let signature: string;
      try {
        signature = await this.dependencies.rpc.send(signed);
      } catch (error) {
        await store.createOutcome(intent.id, attempt, 'SEND_FAILED');
        await store.updateIntent(intent.id, 'SEND_FAILED');
        throw error;
      }
      lastSignature = signature;
      const outcome = await store.createOutcome(intent.id, attempt, 'SENT', signature);
      lastOutcomeId = outcome.id;
      await store.updateIntent(intent.id, 'SENT');
      try {
        await this.dependencies.rpc.confirm(signature, 'confirmed');
        await store.updateOutcome(outcome.id, 'CONFIRMED');
        await store.updateIntent(intent.id, 'CONFIRMED');
        await this.dependencies.rpc.confirm(signature, 'finalized');
        await store.updateOutcome(outcome.id, 'FINALIZED', { finalizedAt: new Date() });
        await store.updateIntent(intent.id, 'FINALIZED');
      } catch (error) {
        await store.updateOutcome(outcome.id, 'UNKNOWN', { errorMessage: String(error) });
        await store.updateIntent(intent.id, 'UNKNOWN');
        return this.reconcileUnknown(store, request, intent, outcome.id, signature, attempt);
      }
    }

    const chain = await this.dependencies.chainState.read(intent);
    if (chain.state !== 'APPLIED') return this.stuck(store, request, intent, lastSignature);
    if (lastOutcomeId !== undefined) {
      await store.updateOutcome(lastOutcomeId, 'FINALIZED', { chainState: chain.detail });
    }
    await store.updateIntent(intent.id, 'RECONCILED');
    return { intentId: intent.id, status: 'RECONCILED', ...(lastSignature ? { signature: lastSignature } : {}) };
  }

  private async reconcileUnknown(
    store: ExecutionStore,
    request: ExecutionRequest,
    intent: StoredIntent,
    outcomeId: bigint,
    signature: string,
    attempt: number,
  ): Promise<ExecutionResult> {
    const chain = await this.dependencies.chainState.read(intent);
    if (chain.state === 'APPLIED') {
      await store.updateOutcome(outcomeId, 'FINALIZED', {
        chainState: chain.detail,
        finalizedAt: new Date(),
      });
      await store.updateIntent(intent.id, 'RECONCILED');
      return { intentId: intent.id, status: 'RECONCILED', signature };
    }

    await store.updateOutcome(outcomeId, chain.state === 'NOT_APPLIED' ? 'NOT_APPLIED' : 'UNKNOWN', {
      chainState: chain.detail,
    });
    if (
      (chain.state === 'NOT_APPLIED' || chain.state === 'PARTIAL') &&
      attempt < this.maxReconcileAttempts
    ) {
      // A resend becomes legal only after the chain read proved the money was
      // not applied (or identified the exact partial state to complete).
      const retry =
        chain.state === 'PARTIAL'
          ? await this.buildCompletion(request, chain)
          : await this.dependencies.builder.build(request);
      await this.inspectBuilt(request, retry);
      return this.runBuilt(store, request, intent, retry);
    }
    return this.stuck(store, request, intent, signature);
  }

  private buildCompletion(request: ExecutionRequest, state: ChainState): Promise<BuiltExecution> {
    if (!this.dependencies.builder.buildCompletion) {
      throw new Error('Meteora SDK builder has no safe completion for a partial execution');
    }
    return this.dependencies.builder.buildCompletion(request, state);
  }

  private async stuck(
    store: ExecutionStore,
    request: ExecutionRequest,
    intent: StoredIntent,
    signature?: string,
  ): Promise<ExecutionResult> {
    await store.updateIntent(intent.id, 'STUCK');
    await this.alert('RECONCILER_STUCK', request, `execution intent ${intent.id} requires operator review`);
    return { intentId: intent.id, status: 'STUCK', ...(signature ? { signature } : {}) };
  }

  private async alert(kind: ExecutionAlert['kind'], request: ExecutionRequest, message: string) {
    await this.dependencies.alert?.({ kind, projectWalletId: request.projectWalletId, message });
  }
}
