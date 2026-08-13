import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { LocalKmsAdapter, createEncryptedWallet, signTransaction } from '../src/custody/index.js';
import {
  DevnetMeteoraChainStateReader,
  DevnetRpc,
  ExecutionPipeline,
  MeteoraSdkBuilder,
  PrismaExecutionStore,
  RealMeteoraSdkFacade,
  SolanaMeteoraChainStateSource,
  SolanaWithdrawalSweepBalanceSource,
  STANDARD_ALLOWED_PROGRAM_IDS,
  WithdrawalSweepBuilder,
  WithdrawalSweepChainStateReader,
  classicPositionRange,
  createMeteoraDevnetRecipes,
  createPrismaCustodySigner,
  deriveMeteoraPoolProgramAccounts,
  type DestinationPolicy,
  type ChainStateReader,
  type ExecutionBuilder,
  type ExecutionRequest,
} from '../src/execution/index.js';
import {
  DepositPoller,
  DevnetDepositHistorySource,
  PrismaDepositEventStore,
} from '../src/deposit/index.js';
import { disconnectPrisma, getPrisma } from '../src/ledger/prisma.js';
import { DLMM, sdkExport } from '../src/poller/dlmmSdk.js';
import { readTokenMintSafetyFacts, screenTokenMint } from '../src/tokenSafety/index.js';

const endpoint = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const databaseUrl = process.env.DATABASE_URL ?? '';
if (!endpoint.toLowerCase().includes('devnet')) throw new Error('E2E RPC must be devnet');
const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !database.pathname.includes('devnet')) {
  throw new Error('E2E database must be a local disposable database whose name contains devnet');
}

const connection = new Connection(endpoint, 'confirmed');
const prisma = getPrisma(databaseUrl);
const kms = await LocalKmsAdapter.fromDevelopmentKeyFile('.devnet-e2e/local-kms.key');
const runId = 'current';
const log = (message: string) => process.stdout.write(`${message}\n`);

async function sendSetup(wallet: Awaited<ReturnType<typeof createEncryptedWallet>>, transaction: Transaction) {
  const latest = await connection.getLatestBlockhash('confirmed');
  transaction.feePayer = new PublicKey(wallet.publicKey);
  transaction.recentBlockhash = latest.blockhash;
  const simulation = await connection.simulateTransaction(
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: transaction.feePayer,
        recentBlockhash: transaction.recentBlockhash,
        instructions: transaction.instructions,
      }).compileToLegacyMessage(),
    ),
    { sigVerify: false, commitment: 'confirmed' },
  );
  if (simulation.value.err) {
    throw new Error(`devnet setup simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  const signed = await signTransaction(kms, wallet, transaction, 'devnet');
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 2,
  });
  await connection.confirmTransaction({ signature, ...latest }, 'finalized');
  return signature;
}

async function fund(wallet: PublicKey) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const balance = await connection.getBalance(wallet, 'confirmed');
    if (balance >= LAMPORTS_PER_SOL) return balance;
    log(`Requesting throwaway devnet SOL for ${wallet.toBase58()} (attempt ${attempt}/3)...`);
    try {
      const signature = await connection.requestAirdrop(wallet, 2 * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    } catch (error) {
      if (attempt === 3) {
        throw new Error(
          `devnet faucet failed after three attempts. Fund ${wallet.toBase58()} with at least 1 devnet SOL, then rerun: ${String(error)}`,
        );
      }
    }
  }
  return connection.getBalance(wallet, 'confirmed');
}

async function createTestMint(
  wallet: Awaited<ReturnType<typeof createEncryptedWallet>>,
  founder: PublicKey,
  suffix: string,
) {
  const walletAddress = new PublicKey(wallet.publicKey);
  const seed = `lpbot-${suffix}-${runId}`.slice(0, 32);
  const mint = await PublicKey.createWithSeed(walletAddress, seed, TOKEN_PROGRAM_ID);
  const walletAta = getAssociatedTokenAddressSync(mint, walletAddress);
  const founderAta = getAssociatedTokenAddressSync(mint, founder);
  if (await connection.getAccountInfo(mint, 'confirmed')) {
    return { mint, walletAta, founderAta };
  }
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE, 'confirmed');
  const transaction = new Transaction().add(
    SystemProgram.createAccountWithSeed({
      fromPubkey: walletAddress,
      basePubkey: walletAddress,
      seed,
      newAccountPubkey: mint,
      lamports: rent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint, 6, walletAddress, null),
    createAssociatedTokenAccountIdempotentInstruction(walletAddress, walletAta, walletAddress, mint),
    createAssociatedTokenAccountIdempotentInstruction(walletAddress, founderAta, founder, mint),
    createMintToInstruction(mint, walletAta, walletAddress, 1_000_000_000n),
  );
  await sendSetup(wallet, transaction);
  return { mint, walletAta, founderAta };
}

function pipeline(
  builder: ExecutionBuilder = new MeteoraSdkBuilder(createMeteoraDevnetRecipes(endpoint)),
  chainState: ChainStateReader = new DevnetMeteoraChainStateReader(
    new SolanaMeteoraChainStateSource(endpoint),
  ),
) {
  const rpc = new DevnetRpc(endpoint);
  return new ExecutionPipeline({
    store: new PrismaExecutionStore(prisma),
    builder,
    rpc,
    chainState,
    allowedProgramIds: new Set([
      ...STANDARD_ALLOWED_PROGRAM_IDS,
      sdkExport<Record<'devnet', string>>('LBCLMM_PROGRAM_IDS').devnet,
    ]),
    caps: { perTransactionSol: 10, projectRolling24hSol: 50, globalRolling24hSol: 250 },
    sign: createPrismaCustodySigner(prisma, kms),
    async alert(event) {
      log(`Execution alert ${event.kind}: ${event.message}`);
    },
  });
}

async function execute(
  request: ExecutionRequest,
  builder?: ExecutionBuilder,
  chainState?: ChainStateReader,
) {
  const result = await pipeline(builder, chainState).execute(request);
  log(`${request.action}: ${result.status}${result.signature ? ` (${result.signature})` : ''}`);
  if (result.status !== 'RECONCILED') throw new Error(`${request.action} did not reconcile`);
}

async function main() {
  log('Creating encrypted throwaway project and founder wallets...');
  const existing = await prisma.tenant.findUnique({
    where: { externalUserId: `devnet-e2e-${runId}` },
    include: { projectWallet: true },
  });
  const generatedWallet = existing?.projectWallet ? null : await createEncryptedWallet(kms);
  const generatedFounder = existing?.projectWallet ? null : await createEncryptedWallet(kms);
  const wallet = existing?.projectWallet
    ? {
        publicKey: existing.projectWallet.publicKey,
        keyCiphertext: Uint8Array.from(existing.projectWallet.keyCiphertext),
        encryptedDataKey: Uint8Array.from(existing.projectWallet.encryptedDataKey),
        kmsKeyId: existing.projectWallet.kmsKeyId,
      }
    : generatedWallet!;
  const founderPublicKey = existing?.projectWallet?.withdrawalAddress ?? generatedFounder!.publicKey;
  const walletAddress = new PublicKey(wallet.publicKey);
  const founderAddress = new PublicKey(founderPublicKey);
  const tenant = existing ??
    (await prisma.tenant.create({
      data: {
        externalUserId: `devnet-e2e-${runId}`,
        telegramChatId: `devnet-e2e-chat-${runId}`,
        label: `Devnet E2E ${runId}`,
      },
    }));
  const walletRow = existing?.projectWallet ??
    (await prisma.projectWallet.create({
      data: {
        tenantId: tenant.id,
        publicKey: wallet.publicKey,
        withdrawalAddress: founderPublicKey,
        keyCiphertext: Buffer.from(wallet.keyCiphertext),
        encryptedDataKey: Buffer.from(wallet.encryptedDataKey),
        kmsKeyId: wallet.kmsKeyId,
      },
    }));

  log(`Throwaway project wallet: ${wallet.publicKey}`);

  await fund(walletAddress);
  log('Creating and funding two disposable legacy SPL mints...');
  const tokenX = await createTestMint(wallet, founderAddress, 'x');
  const tokenY = await createTestMint(wallet, founderAddress, 'y');
  const safety = screenTokenMint(await readTokenMintSafetyFacts(connection, tokenX.mint), wallet.publicKey);
  if (!safety.allowed) throw new Error(`mint screen refused test mint: ${safety.refusals.join('; ')}`);

  const depositPoller = new DepositPoller(
    new DevnetDepositHistorySource(endpoint),
    new PrismaDepositEventStore(prisma),
  );
  await depositPoller.poll(walletRow.id, walletAddress);
  const deposits = await prisma.depositEvent.count({ where: { projectWalletId: walletRow.id } });
  if (deposits < 3) throw new Error(`expected SOL and token deposits, observed only ${deposits}`);
  log(`Verified ${deposits} persisted idempotent deposit events.`);

  const programId = new PublicKey(
    sdkExport<Record<'devnet', string>>('LBCLMM_PROGRAM_IDS').devnet,
  );
  const derivePair = sdkExport<
    (tokenA: PublicKey, tokenB: PublicKey, program: PublicKey) => [PublicKey, number]
  >('deriveCustomizablePermissionlessLbPair');
  const poolAddress = derivePair(tokenX.mint, tokenY.mint, programId)[0];
  const projectTokenAccounts = new Set([tokenX.walletAta.toBase58(), tokenY.walletAta.toBase58()]);
  const founderTokenAccounts = new Set([tokenX.founderAta.toBase58(), tokenY.founderAta.toBase58()]);
  const basePolicy = {
    projectWalletAddress: wallet.publicKey,
    projectTokenAccounts,
    founderWithdrawalAddress: founderPublicKey,
    founderTokenAccounts,
    feeTreasuryAddress: founderPublicKey,
    feeTreasuryTokenAccounts: founderTokenAccounts,
  };

  await execute({
    projectWalletId: walletRow.id,
    idempotencyKey: `${runId}:create-pool`,
    action: 'CREATE_POOL',
    notionalSol: 0.1,
    destinations: {
      ...basePolicy,
      poolProgramAccounts: deriveMeteoraPoolProgramAccounts({
        tokenXMint: tokenX.mint,
        tokenYMint: tokenY.mint,
        poolAddress,
      }),
    },
    detail: {
      tokenXMint: tokenX.mint.toBase58(),
      tokenYMint: tokenY.mint.toBase58(),
      poolAddress: poolAddress.toBase58(),
      binStep: 25,
      activeId: 0,
      feeBps: 30,
    },
  });

  const realSdk = new RealMeteoraSdkFacade(connection);
  const pool = await realSdk.loadPool(poolAddress);
  const active = await pool.getActiveBin();
  const firstRange = classicPositionRange(active.binId);
  const firstPosition = realSdk.derivePositionAddress(
    poolAddress,
    walletAddress,
    new BN(firstRange.lowerBinId),
    new BN(firstRange.width),
  );
  const walletSolLamports = await connection.getBalance(walletAddress, 'confirmed');
  const firstPolicy: DestinationPolicy = {
    ...basePolicy,
    poolProgramAccounts: deriveMeteoraPoolProgramAccounts({
      tokenXMint: tokenX.mint,
      tokenYMint: tokenY.mint,
      poolAddress,
      lowerBinId: firstRange.lowerBinId,
      upperBinId: firstRange.upperBinId,
      positionBase: walletAddress,
    }),
  };
  await execute({
    projectWalletId: walletRow.id,
    idempotencyKey: `${runId}:open`,
    action: 'OPEN_POSITION',
    notionalSol: 0.1,
    destinations: firstPolicy,
    detail: {
      poolAddress: poolAddress.toBase58(),
      positionAddress: firstPosition.toBase58(),
      lowerBinId: firstRange.lowerBinId,
      upperBinId: firstRange.upperBinId,
      tokenXAmount: '100000000',
      tokenYAmount: '100000000',
      walletSolLamports: walletSolLamports.toString(),
      nativeSolLamports: '0',
    },
  });

  const secondRange = classicPositionRange(active.binId + 1);
  const secondPosition = realSdk.derivePositionAddress(
    poolAddress,
    walletAddress,
    new BN(secondRange.lowerBinId),
    new BN(secondRange.width),
  );
  const rebalanceAccounts = new Set([
    ...firstPolicy.poolProgramAccounts,
    ...deriveMeteoraPoolProgramAccounts({
      tokenXMint: tokenX.mint,
      tokenYMint: tokenY.mint,
      poolAddress,
      lowerBinId: secondRange.lowerBinId,
      upperBinId: secondRange.upperBinId,
      positionBase: walletAddress,
    }),
  ]);
  await execute({
    projectWalletId: walletRow.id,
    idempotencyKey: `${runId}:rebalance`,
    action: 'REBALANCE',
    notionalSol: 0.1,
    destinations: { ...basePolicy, poolProgramAccounts: rebalanceAccounts },
    detail: {
      poolAddress: poolAddress.toBase58(),
      oldPositionAddress: firstPosition.toBase58(),
      oldLowerBinId: firstRange.lowerBinId,
      oldUpperBinId: firstRange.upperBinId,
      newPositionAddress: secondPosition.toBase58(),
      lowerBinId: secondRange.lowerBinId,
      upperBinId: secondRange.upperBinId,
      centerBinId: active.binId + 1,
      tokenXAmount: '100000000',
      tokenYAmount: '100000000',
      walletSolLamports: (await connection.getBalance(walletAddress, 'confirmed')).toString(),
      nativeSolLamports: '0',
    },
  });

  await execute({
    projectWalletId: walletRow.id,
    idempotencyKey: `${runId}:withdraw`,
    action: 'WITHDRAW',
    notionalSol: 0.1,
    destinations: {
      ...basePolicy,
      poolProgramAccounts: deriveMeteoraPoolProgramAccounts({
        tokenXMint: tokenX.mint,
        tokenYMint: tokenY.mint,
        poolAddress,
        lowerBinId: secondRange.lowerBinId,
        upperBinId: secondRange.upperBinId,
        positionBase: walletAddress,
      }),
    },
    detail: {
      poolAddress: poolAddress.toBase58(),
      positionAddress: secondPosition.toBase58(),
      lowerBinId: secondRange.lowerBinId,
      upperBinId: secondRange.upperBinId,
    },
  });

  const finalPool = (await DLMM.create(connection, poolAddress, { cluster: 'devnet' })) as {
    getPositionsByUserAndLbPair(owner: PublicKey): Promise<{ userPositions: unknown[] }>;
  };
  const remaining = await finalPool.getPositionsByUserAndLbPair(walletAddress);
  if (remaining.userPositions.length !== 0) throw new Error('withdrawal left a Meteora position open');

  const sweepBalances = new SolanaWithdrawalSweepBalanceSource(endpoint);
  const preSweepLamports = await connection.getBalance(walletAddress, 'confirmed');
  await execute(
    {
      projectWalletId: walletRow.id,
      idempotencyKey: `${runId}:founder-sweep`,
      action: 'WITHDRAW',
      notionalSol: preSweepLamports / LAMPORTS_PER_SOL,
      destinations: {
        ...basePolicy,
        poolProgramAccounts: new Set(),
      },
      detail: {
        sweep: true,
        projectWalletAddress: wallet.publicKey,
        tokenAccounts: [
          {
            source: tokenX.walletAta.toBase58(),
            destination: tokenX.founderAta.toBase58(),
            mint: tokenX.mint.toBase58(),
            decimals: 6,
          },
          {
            source: tokenY.walletAta.toBase58(),
            destination: tokenY.founderAta.toBase58(),
            mint: tokenY.mint.toBase58(),
            decimals: 6,
          },
        ],
        finalFeeLamports: 5_000,
        expectedRemainingLamports: 0,
      },
    },
    new WithdrawalSweepBuilder(sweepBalances),
    new WithdrawalSweepChainStateReader(sweepBalances),
  );
  if ((await connection.getBalance(walletAddress, 'confirmed')) !== 0) {
    throw new Error('founder sweep left SOL in the project wallet');
  }
  if ((await connection.getAccountInfo(tokenX.walletAta, 'confirmed')) !== null) {
    throw new Error('founder sweep left the project token X account open');
  }
  if ((await connection.getAccountInfo(tokenY.walletAta, 'confirmed')) !== null) {
    throw new Error('founder sweep left the project token Y account open');
  }
  log('DEVNET E2E PASS: deposit -> screen -> pool -> 70 bins -> rebalance -> close -> founder sweep.');
  log('No production signing was enabled.');
}

try {
  await main();
} finally {
  await disconnectPrisma();
}
