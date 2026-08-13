/**
 * On-chain pool state via the Meteora DLMM TypeScript SDK (@meteora-ag/dlmm).
 *
 * READ-ONLY. `DLMM.create` takes a `Connection` and a pool address; it never
 * asks for a wallet, and no code path here builds, signs or sends anything.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { log } from '../logger.js';
import { DLMM, sdkExport } from './dlmmSdk.js';
import { binArrayIndex, BINS_PER_BIN_ARRAY } from './sdkConstants.js';

type DlmmInstance = Awaited<ReturnType<typeof DLMM.create>>;

const deriveBinArray = sdkExport<
  (lbPair: PublicKey, index: BN, programId: PublicKey) => [PublicKey, number]
>('deriveBinArray');

export type OnChainSnapshot = {
  ts: number;
  activeBinId: number;
  activePrice: number;
  binStepBps: number;
  feeBps: number;
  liqActiveBin: number;
  liqNearby: { binId: number; liquidity: number }[];
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Bin-array indexes around the active bin that already exist on chain. */
  existingBinArrayIndexes: Set<number>;
};

function toUiAmount(amount: BN, decimals: number): number {
  return Number(amount.toString()) / 10 ** decimals;
}

export class PoolReader {
  private constructor(
    private readonly connection: Connection,
    private readonly dlmm: DlmmInstance,
    private readonly poolAddress: PublicKey,
    private readonly nearbyBins: number,
  ) {}

  static async create(
    rpcUrl: string,
    poolAddress: string,
    nearbyBins = 40,
  ): Promise<PoolReader> {
    const connection = new Connection(rpcUrl, 'confirmed');
    const pubkey = new PublicKey(poolAddress);
    const dlmm = await DLMM.create(connection, pubkey);
    log.info(
      `pool ${poolAddress} loaded: binStep=${dlmm.lbPair.binStep}bps ` +
        `tokenX=${dlmm.tokenX.publicKey.toBase58()} tokenY=${dlmm.tokenY.publicKey.toBase58()}`,
    );
    return new PoolReader(connection, dlmm, pubkey, nearbyBins);
  }

  get baseDecimals(): number {
    return this.dlmm.tokenX.mint.decimals;
  }

  get quoteDecimals(): number {
    return this.dlmm.tokenY.mint.decimals;
  }

  get baseMint(): string {
    return this.dlmm.tokenX.publicKey.toBase58();
  }

  get quoteMint(): string {
    return this.dlmm.tokenY.publicKey.toBase58();
  }

  /**
   * One poll. Throws on RPC failure — the caller skips the tick rather than
   * inventing a snapshot (§13).
   */
  async snapshot(ts: number): Promise<OnChainSnapshot> {
    await this.dlmm.refetchStates();

    const activeBin = await this.dlmm.getActiveBin();
    const activePrice = Number(activeBin.pricePerToken);
    if (!Number.isFinite(activePrice) || activePrice <= 0) {
      throw new Error(`pool returned a nonsensical active price: ${activeBin.pricePerToken}`);
    }

    const binStepBps = this.dlmm.lbPair.binStep;
    // `getDynamicFee()` returns the *total* fee (base + variable) as a
    // percentage, so bps is that times 100.
    const feeBps = this.dlmm.getDynamicFee().toNumber() * 100;

    const baseDecimals = this.baseDecimals;
    const quoteDecimals = this.quoteDecimals;
    const liqActiveBin =
      toUiAmount(activeBin.xAmount, baseDecimals) * activePrice +
      toUiAmount(activeBin.yAmount, quoteDecimals);

    const { bins } = await this.dlmm.getBinsAroundActiveBin(this.nearbyBins, this.nearbyBins);
    const liqNearby = bins.map((bin) => ({
      binId: bin.binId,
      liquidity:
        toUiAmount(bin.xAmount, baseDecimals) * Number(bin.pricePerToken) +
        toUiAmount(bin.yAmount, quoteDecimals),
    }));

    const existingBinArrayIndexes = await this.existingBinArrays(activeBin.binId);

    return {
      ts,
      activeBinId: activeBin.binId,
      activePrice,
      binStepBps,
      feeBps,
      liqActiveBin,
      liqNearby,
      baseMint: this.baseMint,
      quoteMint: this.quoteMint,
      baseDecimals,
      quoteDecimals,
      existingBinArrayIndexes,
    };
  }

  /**
   * Which bin arrays around the active bin already exist. Feeds the sunk-rent
   * component of the rebalance cost estimate — an array that has to be created
   * costs real, non-refundable lamports.
   */
  private async existingBinArrays(activeBinId: number): Promise<Set<number>> {
    const lo = binArrayIndex(activeBinId - BINS_PER_BIN_ARRAY);
    const hi = binArrayIndex(activeBinId + BINS_PER_BIN_ARRAY);
    const indexes: number[] = [];
    for (let i = lo; i <= hi; i++) indexes.push(i);

    const keys = indexes.map(
      (i) => deriveBinArray(this.poolAddress, new BN(i), this.dlmm.program.programId)[0],
    );
    const infos = await this.connection.getMultipleAccountsInfo(keys);

    const existing = new Set<number>();
    infos.forEach((info, idx) => {
      if (info !== null) existing.add(indexes[idx]!);
    });
    return existing;
  }
}
