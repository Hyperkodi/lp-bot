import type DLMMClass from '@meteora-ag/dlmm';
import type { ActivationType, LbPosition, StrategyType } from '@meteora-ag/dlmm';
import {
  Connection,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  type Transaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { DLMM, sdkExport } from '../poller/dlmmSdk.js';
import type { BuiltExecution, ChainState, ExecutionRequest } from './types.js';

export const CLASSIC_POSITION_WIDTH = 70;
export const GAS_RESERVE_LAMPORTS = 50_000_000n;

export function classicPositionRange(activeBinId: number) {
  if (!Number.isSafeInteger(activeBinId)) throw new Error('active bin id must be a safe integer');
  const lowerBinId = activeBinId - Math.floor(CLASSIC_POSITION_WIDTH / 2);
  return {
    lowerBinId,
    upperBinId: lowerBinId + CLASSIC_POSITION_WIDTH - 1,
    width: CLASSIC_POSITION_WIDTH,
  };
}

export function assertGasReserve(
  walletSolLamports: bigint,
  nativeSolLamports: bigint,
  gasReserveLamports = GAS_RESERVE_LAMPORTS,
) {
  if (walletSolLamports < 0n || nativeSolLamports < 0n || gasReserveLamports < 0n) {
    throw new Error('gas reserve inputs cannot be negative');
  }
  if (nativeSolLamports + gasReserveLamports > walletSolLamports) {
    throw new Error('position sizing would consume the project gas reserve');
  }
}

export interface MeteoraPoolFacade {
  getActiveBin(): Promise<{ binId: number; price: string }>;
  initializePositionPda(value: Record<string, unknown>): Promise<Transaction>;
  addLiquidityByStrategy(value: Record<string, unknown>): Promise<Transaction>;
  removeLiquidity(value: Record<string, unknown>): Promise<Transaction[]>;
  getPosition(publicKey: PublicKey): Promise<unknown>;
  claimAllRewardsByPosition(value: Record<string, unknown>): Promise<Transaction[]>;
}

export interface MeteoraSdkFacade {
  buildCreatePool(value: Record<string, unknown>): Promise<Transaction>;
  loadPool(poolAddress: PublicKey): Promise<MeteoraPoolFacade>;
  derivePositionAddress(
    poolAddress: PublicKey,
    base: PublicKey,
    lowerBinId: BN,
    width: BN,
  ): PublicKey;
}

class RealMeteoraPoolFacade implements MeteoraPoolFacade {
  constructor(private readonly pool: DLMMClass) {}

  getActiveBin() {
    return this.pool.getActiveBin();
  }

  initializePositionPda(value: Record<string, unknown>) {
    type MethodBuilder = {
      accountsPartial(accounts: Record<string, PublicKey>): {
        transaction(): Promise<Transaction>;
      };
    };
    type PoolRuntime = {
      pubkey: PublicKey;
      program: {
        programId: PublicKey;
        methods: { initializePositionPda(lowerBinId: number, width: number): MethodBuilder };
      };
    };
    const runtime = this.pool as unknown as PoolRuntime;
    const lowerBinId = value.lowerBinId as BN;
    const width = value.positionWidth as BN;
    const owner = value.owner as PublicKey;
    const base = value.base as PublicKey;
    const payer = value.payer as PublicKey;
    const eventAuthority = sdkExport<(program: PublicKey) => [PublicKey, number]>(
      'deriveEventAuthority',
    )(runtime.program.programId)[0];
    return runtime.program.methods
      .initializePositionPda(lowerBinId.toNumber(), width.toNumber())
      .accountsPartial({
        payer,
        base,
        position: value.position as PublicKey,
        lbPair: runtime.pubkey,
        owner,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        eventAuthority,
        program: runtime.program.programId,
      })
      .transaction();
  }

  addLiquidityByStrategy(value: Record<string, unknown>) {
    return this.pool.addLiquidityByStrategy({
      positionPubKey: value.positionPubKey as PublicKey,
      totalXAmount: value.totalXAmount as BN,
      totalYAmount: value.totalYAmount as BN,
      strategy: value.strategy as { minBinId: number; maxBinId: number; strategyType: StrategyType },
      user: value.user as PublicKey,
      slippage: value.slippage as number,
    });
  }

  removeLiquidity(value: Record<string, unknown>) {
    return this.pool.removeLiquidity({
      user: value.user as PublicKey,
      position: value.position as PublicKey,
      fromBinId: value.fromBinId as number,
      toBinId: value.toBinId as number,
      bps: value.bps as BN,
      shouldClaimAndClose: value.shouldClaimAndClose as boolean,
      skipUnwrapSOL: value.skipUnwrapSOL as boolean,
    });
  }

  getPosition(publicKey: PublicKey) {
    return this.pool.getPosition(publicKey);
  }

  claimAllRewardsByPosition(value: Record<string, unknown>) {
    return this.pool.claimAllRewardsByPosition({
      owner: value.owner as PublicKey,
      position: value.position as LbPosition,
    });
  }
}

export class RealMeteoraSdkFacade implements MeteoraSdkFacade {
  constructor(private readonly connection: Connection) {}

  buildCreatePool(value: Record<string, unknown>) {
    return DLMM.createCustomizablePermissionlessLbPair2(
      this.connection,
      new BN(value.binStep as number),
      value.tokenXMint as PublicKey,
      value.tokenYMint as PublicKey,
      new BN(value.activeId as number),
      new BN(value.feeBps as number),
      0 as ActivationType,
      false,
      value.creator as PublicKey,
      undefined,
      false,
      undefined,
      undefined,
      { cluster: 'devnet' },
    );
  }

  async loadPool(poolAddress: PublicKey): Promise<MeteoraPoolFacade> {
    const pool = await DLMM.create(this.connection, poolAddress, { cluster: 'devnet' });
    return new RealMeteoraPoolFacade(pool);
  }

  derivePositionAddress(poolAddress: PublicKey, base: PublicKey, lowerBinId: BN, width: BN) {
    const derivePosition = sdkExport<
      (pool: PublicKey, positionBase: PublicKey, lower: BN, positionWidth: BN, program: PublicKey) => [PublicKey, number]
    >('derivePosition');
    return derivePosition(poolAddress, base, lowerBinId, width, devnetProgramId())[0];
  }
}

function devnetProgramId(): PublicKey {
  const programIds = sdkExport<Record<'devnet', string>>('LBCLMM_PROGRAM_IDS');
  return new PublicKey(programIds.devnet);
}

export async function findExistingCustomizablePool(
  connection: Pick<Connection, 'getAccountInfo'>,
  tokenA: PublicKey,
  tokenB: PublicKey,
): Promise<PublicKey | null> {
  const derivePair = sdkExport<
    (tokenX: PublicKey, tokenY: PublicKey, programId: PublicKey) => [PublicKey, number]
  >('deriveCustomizablePermissionlessLbPair');
  const candidates = [
    derivePair(tokenA, tokenB, devnetProgramId())[0],
    derivePair(tokenB, tokenA, devnetProgramId())[0],
  ];
  for (const candidate of candidates) {
    if (await connection.getAccountInfo(candidate, 'confirmed')) return candidate;
  }
  return null;
}

export function deriveMeteoraPoolProgramAccounts(input: {
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  poolAddress: PublicKey;
  lowerBinId?: number;
  upperBinId?: number;
  positionBase?: PublicKey;
}): Set<string> {
  const programId = devnetProgramId();
  const deriveReserve = sdkExport<
    (mint: PublicKey, pool: PublicKey, program: PublicKey) => [PublicKey, number]
  >('deriveReserve');
  const deriveOracle = sdkExport<(pool: PublicKey, program: PublicKey) => [PublicKey, number]>(
    'deriveOracle',
  );
  const deriveBadge = sdkExport<(mint: PublicKey, program: PublicKey) => [PublicKey, number]>(
    'deriveTokenBadge',
  );
  const deriveBitmap = sdkExport<(pool: PublicKey, program: PublicKey) => [PublicKey, number]>(
    'deriveBinArrayBitmapExtension',
  );
  const accounts = new Set<string>([
    input.poolAddress.toBase58(),
    deriveReserve(input.tokenXMint, input.poolAddress, programId)[0].toBase58(),
    deriveReserve(input.tokenYMint, input.poolAddress, programId)[0].toBase58(),
    deriveOracle(input.poolAddress, programId)[0].toBase58(),
    deriveBadge(input.tokenXMint, programId)[0].toBase58(),
    deriveBadge(input.tokenYMint, programId)[0].toBase58(),
    deriveBitmap(input.poolAddress, programId)[0].toBase58(),
  ]);
  if (
    input.lowerBinId !== undefined &&
    input.upperBinId !== undefined &&
    input.positionBase
  ) {
    const lower = new BN(input.lowerBinId);
    const width = new BN(input.upperBinId - input.lowerBinId + 1);
    const derivePosition = sdkExport<
      (pool: PublicKey, base: PublicKey, lowerBin: BN, positionWidth: BN, program: PublicKey) => [PublicKey, number]
    >('derivePosition');
    accounts.add(
      derivePosition(input.poolAddress, input.positionBase, lower, width, programId)[0].toBase58(),
    );
    const indexes = sdkExport<(lowerBin: BN, upperBin: BN) => BN[]>('getBinArrayIndexesCoverage')(
      lower,
      new BN(input.upperBinId),
    );
    const deriveBinArray = sdkExport<
      (pool: PublicKey, index: BN, program: PublicKey) => [PublicKey, number]
    >('deriveBinArray');
    for (const index of indexes) {
      accounts.add(deriveBinArray(input.poolAddress, index, programId)[0].toBase58());
    }
  }
  return accounts;
}

function details(request: ExecutionRequest) {
  if (!request.detail) throw new Error(`${request.action} requires Meteora recipe details`);
  return request.detail;
}

function publicKey(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be a base58 public key`);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a base58 public key`);
  }
}

function integer(value: unknown, name: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value as number;
}

function amount(value: unknown, name: string) {
  try {
    const parsed = BigInt(value as string | number | bigint);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} must be a non-negative integer amount`);
  }
}

function asBn(value: unknown, name: string) {
  return new BN(amount(value, name).toString());
}

function transactionItems(
  transactions: Transaction[],
  phase: string,
  notionalSol: number,
): BuiltExecution['transactions'] {
  return transactions.map((transaction, index) => ({
    phase: transactions.length === 1 ? phase : `${phase}-${index + 1}`,
    notionalSol,
    transaction,
  }));
}

export class MeteoraDevnetRecipes {
  constructor(private readonly sdk: MeteoraSdkFacade) {}

  async build(request: ExecutionRequest): Promise<BuiltExecution> {
    const value = details(request);
    const wallet = publicKey(request.destinations.projectWalletAddress, 'project wallet');
    if (request.action === 'CREATE_POOL') {
      const transaction = await this.sdk.buildCreatePool({
        tokenXMint: publicKey(value.tokenXMint, 'tokenXMint'),
        tokenYMint: publicKey(value.tokenYMint, 'tokenYMint'),
        creator: wallet,
        binStep: integer(value.binStep, 'binStep', 1),
        activeId: integer(value.activeId, 'activeId', -443_636),
        feeBps: integer(value.feeBps, 'feeBps', 0),
      });
      return { transactions: transactionItems([transaction], 'create-pool', request.notionalSol) };
    }

    const poolAddress = publicKey(value.poolAddress, 'poolAddress');
    const pool = await this.sdk.loadPool(poolAddress);
    if (request.action === 'OPEN_POSITION') return this.open(request, value, wallet, poolAddress, pool);
    if (request.action === 'COMPOUND') return this.add(request, value, wallet, pool);
    if (request.action === 'REBALANCE') {
      const removed = await this.remove(
        request,
        {
          ...value,
          positionAddress: value.oldPositionAddress ?? value.positionAddress,
          lowerBinId: value.oldLowerBinId ?? value.lowerBinId,
          upperBinId: value.oldUpperBinId ?? value.upperBinId,
        },
        wallet,
        pool,
      );
      const opened = await this.open(request, value, wallet, poolAddress, pool);
      return { transactions: [...removed.transactions, ...opened.transactions] };
    }
    if (request.action === 'EXIT' || request.action === 'WITHDRAW') {
      return this.remove(request, value, wallet, pool);
    }
    if (request.action === 'FEE_SETTLEMENT') {
      const positionAddress = publicKey(value.positionAddress, 'positionAddress');
      const position = await pool.getPosition(positionAddress);
      const transactions = await pool.claimAllRewardsByPosition({ owner: wallet, position });
      return { transactions: transactionItems(transactions, 'claim-rewards', request.notionalSol) };
    }
    throw new Error(`unsupported Meteora execution action ${request.action}`);
  }

  async buildCompletion(request: ExecutionRequest, state: ChainState): Promise<BuiltExecution> {
    const completed = state.detail.completedPhases;
    if (!Array.isArray(completed) || !completed.every((phase) => typeof phase === 'string')) {
      throw new Error('partial Meteora state must list completedPhases');
    }
    const full = await this.build(request);
    const completedSet = new Set(completed as string[]);
    return { transactions: full.transactions.filter((item) => !completedSet.has(item.phase)) };
  }

  private async open(
    request: ExecutionRequest,
    value: Record<string, unknown>,
    wallet: PublicKey,
    poolAddress: PublicKey,
    pool: MeteoraPoolFacade,
  ): Promise<BuiltExecution> {
    this.checkReserve(value);
    const activeBin = await pool.getActiveBin();
    const centerBinId = value.centerBinId === undefined
      ? activeBin.binId
      : integer(value.centerBinId, 'centerBinId', -443_636);
    const range = classicPositionRange(centerBinId);
    const lower = new BN(range.lowerBinId);
    const width = new BN(range.width);
    const positionAddress = this.sdk.derivePositionAddress(poolAddress, wallet, lower, width);
    const initialize = await pool.initializePositionPda({
      lowerBinId: lower,
      positionWidth: width,
      position: positionAddress,
      owner: wallet,
      base: wallet,
      payer: wallet,
    });
    const add = await pool.addLiquidityByStrategy({
      positionPubKey: positionAddress,
      totalXAmount: asBn(value.tokenXAmount, 'tokenXAmount'),
      totalYAmount: asBn(value.tokenYAmount, 'tokenYAmount'),
      strategy: {
        minBinId: range.lowerBinId,
        maxBinId: range.upperBinId,
        strategyType: 0 as StrategyType,
      },
      user: wallet,
      slippage: typeof value.slippagePct === 'number' ? value.slippagePct : 0.5,
    });
    return {
      transactions: [
        ...transactionItems([initialize], 'initialize-position', 0),
        ...transactionItems([add], 'add-liquidity', request.notionalSol),
      ],
    };
  }

  private async add(
    request: ExecutionRequest,
    value: Record<string, unknown>,
    wallet: PublicKey,
    pool: MeteoraPoolFacade,
  ): Promise<BuiltExecution> {
    this.checkReserve(value);
    const transaction = await pool.addLiquidityByStrategy({
      positionPubKey: publicKey(value.positionAddress, 'positionAddress'),
      totalXAmount: asBn(value.tokenXAmount, 'tokenXAmount'),
      totalYAmount: asBn(value.tokenYAmount, 'tokenYAmount'),
      strategy: {
        minBinId: integer(value.lowerBinId, 'lowerBinId', -443_636),
        maxBinId: integer(value.upperBinId, 'upperBinId', -443_636),
        strategyType: 0 as StrategyType,
      },
      user: wallet,
      slippage: typeof value.slippagePct === 'number' ? value.slippagePct : 0.5,
    });
    return { transactions: transactionItems([transaction], 'add-liquidity', request.notionalSol) };
  }

  private async remove(
    request: ExecutionRequest,
    value: Record<string, unknown>,
    wallet: PublicKey,
    pool: MeteoraPoolFacade,
  ): Promise<BuiltExecution> {
    const transactions = await pool.removeLiquidity({
      user: wallet,
      position: publicKey(value.positionAddress, 'positionAddress'),
      fromBinId: integer(value.lowerBinId, 'lowerBinId', -443_636),
      toBinId: integer(value.upperBinId, 'upperBinId', -443_636),
      bps: new BN(10_000),
      shouldClaimAndClose: true,
      skipUnwrapSOL: false,
    });
    return { transactions: transactionItems(transactions, 'remove-liquidity', request.notionalSol) };
  }

  private checkReserve(value: Record<string, unknown>) {
    assertGasReserve(
      amount(value.walletSolLamports, 'walletSolLamports'),
      amount(value.nativeSolLamports, 'nativeSolLamports'),
      value.gasReserveLamports === undefined
        ? GAS_RESERVE_LAMPORTS
        : amount(value.gasReserveLamports, 'gasReserveLamports'),
    );
  }
}

export function createMeteoraDevnetRecipes(endpoint: string) {
  if (!endpoint.toLowerCase().includes('devnet')) {
    throw new Error('Meteora execution recipes are devnet-only');
  }
  return new MeteoraDevnetRecipes(new RealMeteoraSdkFacade(new Connection(endpoint, 'confirmed')));
}
