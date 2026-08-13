import type { Transaction, VersionedTransaction } from '@solana/web3.js';

export type ExecutionAction =
  | 'CREATE_POOL'
  | 'OPEN_POSITION'
  | 'COMPOUND'
  | 'REBALANCE'
  | 'EXIT'
  | 'WITHDRAW'
  | 'FEE_SETTLEMENT';

export type DestinationPolicy = {
  projectWalletAddress: string;
  founderWithdrawalAddress: string;
  founderTokenAccounts: ReadonlySet<string>;
  feeTreasuryAddress: string;
  feeTreasuryTokenAccounts: ReadonlySet<string>;
  poolProgramAccounts: ReadonlySet<string>;
};

export type ExecutionRequest = {
  projectWalletId: string;
  managedPoolId?: string;
  decisionId?: bigint;
  idempotencyKey: string;
  action: ExecutionAction;
  notionalSol: number;
  destinations: DestinationPolicy;
  detail?: Record<string, unknown>;
};

export type BuiltTransaction = {
  phase: string;
  notionalSol: number;
  transaction: Transaction | VersionedTransaction;
};

export type BuiltExecution = { transactions: BuiltTransaction[] };

export interface ExecutionBuilder {
  /** Builders with any other provenance are rejected before build. */
  readonly source: 'METEORA_SDK';
  build(request: ExecutionRequest): Promise<BuiltExecution>;
  buildCompletion?(request: ExecutionRequest, state: ChainState): Promise<BuiltExecution>;
}

export type StoredIntent = {
  id: string;
  projectWalletId: string;
  idempotencyKey: string;
  action: string;
  notionalSol: number;
  status: string;
};

export type StoredOutcome = { id: bigint; status: string; signature: string | null };

export interface ExecutionStore {
  isKillSwitchEnabled(): Promise<boolean>;
  withProjectLock<T>(
    projectWalletId: string,
    work: (lockedStore: ExecutionStore) => Promise<T>,
  ): Promise<T>;
  findIntent(idempotencyKey: string): Promise<StoredIntent | null>;
  createIntent(request: ExecutionRequest): Promise<StoredIntent>;
  rollingNotionalSol(
    projectWalletId: string,
    since: Date,
    excludeIntentId?: string,
  ): Promise<{ projectSol: number; globalSol: number }>;
  countOutcomes(intentId: string): Promise<number>;
  createOutcome(intentId: string, attempt: number, status: string, signature?: string): Promise<StoredOutcome>;
  updateOutcome(
    id: bigint,
    status: string,
    detail?: { chainState?: Record<string, unknown>; errorMessage?: string; finalizedAt?: Date },
  ): Promise<void>;
  updateIntent(id: string, status: string): Promise<void>;
}

export interface ExecutionRpc {
  readonly cluster: 'devnet';
  readonly endpoint: string;
  simulate(transaction: Transaction | VersionedTransaction): Promise<{ err: unknown; logs?: string[] }>;
  send(transaction: Transaction | VersionedTransaction): Promise<string>;
  confirm(signature: string, commitment: 'confirmed' | 'finalized'): Promise<void>;
}

export type ChainState = {
  state: 'APPLIED' | 'NOT_APPLIED' | 'PARTIAL' | 'UNKNOWN';
  detail: Record<string, unknown>;
};

export interface ChainStateReader {
  read(intent: StoredIntent): Promise<ChainState>;
}

export type ExecutionCaps = {
  perTransactionSol: number;
  projectRolling24hSol: number;
  globalRolling24hSol: number;
};

export type ExecutionResult = { intentId: string; status: string; signature?: string };
