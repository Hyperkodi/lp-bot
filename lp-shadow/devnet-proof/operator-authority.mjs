/**
 * DEVNET SECURITY PROOF — can a Meteora DLMM operator steal from a position it
 * manages but does not own?
 *
 * This decides whether an automated LP optimiser can be non-custodial. Reading
 * the program source was inconclusive: `authorize_modify_position` lets the
 * operator modify liquidity, and the `ModifyLiquidity` account context
 * constrains the destination token accounts only by mint — nothing binds them
 * to the position owner. A `validate_outflow_to_ata_of_position_owner` trait
 * exists, but every published copy of the handler body is stubbed, so whether
 * it runs can only be settled on-chain.
 *
 * The test: create a pool from mints we control, have the OPERATOR open a
 * position OWNED BY SOMEONE ELSE, fund it, then have the operator try to
 * withdraw that liquidity into the OPERATOR'S OWN token accounts.
 *
 *   withdrawal succeeds -> the operator can drain users. Custodial in all but
 *                          name; the non-custodial design is dead.
 *   withdrawal rejected -> outflows are bound to the owner. Non-custodial
 *                          automation is real.
 *
 * DEVNET ONLY. Keys are throwaway, generated into the scratch directory,
 * never into the repo. No mainnet endpoint is referenced anywhere in this file.
 *
 * Run:  node devnet-proof/operator-authority.mjs
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const DLMM = require('@meteora-ag/dlmm');
// spl-token is present in the DLMM package's dependency tree; resolving it
// through there avoids adding a dependency to the product package for a probe.
const spl = require(createRequire(require.resolve('@meteora-ag/dlmm')).resolve('@solana/spl-token'));

const DEVNET = 'https://api.devnet.solana.com';
const KEY_DIR =
  process.env.PROOF_KEY_DIR ??
  'C:/Users/USER/AppData/Local/Temp/claude/c--Users-USER-Desktop-ClaudeCode-Armara-LPBot/3c0a3c0b-668c-4ca6-82c1-2d3ce1d8276c/scratchpad/devnet-keys';

const log = (...a) => console.log(...a);
const step = (s) => log(`\n=== ${s} ===`);

function loadOrCreate(name) {
  mkdirSync(KEY_DIR, { recursive: true });
  const path = join(KEY_DIR, `${name}.json`);
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  return kp;
}

async function ensureSol(conn, kp, name, minSol = 1) {
  const bal = await conn.getBalance(kp.publicKey);
  log(`  ${name}: ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL (${kp.publicKey.toBase58()})`);
  if (bal >= minSol * LAMPORTS_PER_SOL) return;
  log(`    airdropping to ${name}...`);
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    log(`    ok: ${(await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL} SOL`);
  } catch (e) {
    log(`    airdrop FAILED (devnet faucets are rate limited): ${String(e.message).slice(0, 140)}`);
  }
}

async function main() {
  const conn = new Connection(DEVNET, 'confirmed');

  step('participants');
  // owner   = the "user" whose funds are at stake
  // operator= the "bot"; manages the position, must NOT be able to take funds
  // (the operator's own token accounts are the theft destination)
  const owner = loadOrCreate('owner');
  const operator = loadOrCreate('operator');
  // Only the operator is funded. The owner holding nothing is deliberate: any
  // tokens that end up in the operator's accounts demonstrably came out of a
  // position the operator does not own.
  await ensureSol(conn, operator, 'operator');
  log(`  owner:    0 SOL by design (${owner.publicKey.toBase58()})`);
  if ((await conn.getBalance(operator.publicKey)) < 0.5 * LAMPORTS_PER_SOL) {
    log('\nABORT: operator has insufficient devnet SOL to pay for setup.');
    process.exitCode = 1;
    return;
  }

  step('create two mints we control');
  const mintX = await spl.createMint(conn, operator, operator.publicKey, null, 6);
  const mintY = await spl.createMint(conn, operator, operator.publicKey, null, 6);
  log(`  X ${mintX.toBase58()}`);
  log(`  Y ${mintY.toBase58()}`);

  const opX = await spl.getOrCreateAssociatedTokenAccount(conn, operator, mintX, operator.publicKey);
  const opY = await spl.getOrCreateAssociatedTokenAccount(conn, operator, mintY, operator.publicKey);
  // The owner's token accounts must exist: they are where honest withdrawals
  // should land, and the comparison point if the operator's balance grows.
  const ownX = await spl.getOrCreateAssociatedTokenAccount(conn, operator, mintX, owner.publicKey);
  await spl.getOrCreateAssociatedTokenAccount(conn, operator, mintY, owner.publicKey);
  await spl.mintTo(conn, operator, mintX, opX.address, operator, 1_000_000_000);
  await spl.mintTo(conn, operator, mintY, opY.address, operator, 1_000_000_000);
  log('  minted 1000 X and 1000 Y to the operator');

  step('create a DLMM pool');
  const binStep = new BN(25);
  const feeBps = new BN(30);
  let pool;
  try {
    const tx = await DLMM.createCustomizablePermissionlessLbPair(
      conn,
      binStep,
      mintX,
      mintY,
      new BN(0), // activeId: DLMM bin ids are signed and centred on 0 = price 1.0
      feeBps,
      0, // ActivationType.Slot
      false, // hasAlphaVault
      operator.publicKey,
      null, // activationPoint
      false, // creatorPoolOnOffControl
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [operator], { commitment: 'confirmed' });
    log(`  pool created: ${sig}`);
  } catch (e) {
    log(`  pool creation failed: ${String(e.message).slice(0, 300)}`);
    if (e.logs) log('  logs:', e.logs.slice(-8).join('\n        '));
    process.exitCode = 1;
    return;
  }

  // The program sorts the mint pair, so try both orderings and keep whichever
  // address actually exists on chain.
  const programId = new PublicKey(DLMM.LBCLMM_PROGRAM_IDS.devnet);
  let lbPair = null;
  for (const [a, b] of [
    [mintX, mintY],
    [mintY, mintX],
  ]) {
    const [candidate] = DLMM.deriveCustomizablePermissionlessLbPair(a, b, programId);
    if (await conn.getAccountInfo(candidate)) {
      lbPair = candidate;
      break;
    }
  }
  if (!lbPair) {
    log('  pool account not found at either derived address');
    process.exitCode = 1;
    return;
  }
  log(`  pair: ${lbPair.toBase58()}`);
  pool = await DLMM.create(conn, lbPair, { cluster: 'devnet' });

  step('operator opens a position OWNED BY the user');
  const base = Keypair.generate();
  const activeBin = await pool.getActiveBin();
  // The program derives the position PDA from the width it receives, and the
  // SDK hardcodes that to DEFAULT_BIN_PER_POSITION — anything else fails the
  // seeds constraint.
  const WIDTH = 70;
  const lowerBinId = new BN(activeBin.binId - Math.floor(WIDTH / 2));
  const posTx = await pool.initializePositionByOperator({
    lowerBinId,
    positionWidth: new BN(WIDTH),
    owner: owner.publicKey, // the user owns it
    feeOwner: owner.publicKey, // fees belong to the user
    operator: operator.publicKey, // the bot manages it
    payer: operator.publicKey,
    base: base.publicKey,
    lockReleasePoint: new BN(0), // no lock: user must always be able to exit
  });
  const posSig = await sendAndConfirmTransaction(conn, posTx, [operator, base], {
    commitment: 'confirmed',
  });
  log(`  position opened by operator: ${posSig}`);

  const [position] = await pool.getPositionsByUserAndLbPair(owner.publicKey).then((r) => r.userPositions);
  if (!position) {
    log('  could not locate the created position');
    process.exitCode = 1;
    return;
  }
  log(`  position: ${position.publicKey.toBase58()}`);

  step('operator funds the position');
  const addTx = await pool.addLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: operator.publicKey,
    totalXAmount: new BN(100_000_000),
    totalYAmount: new BN(100_000_000),
    strategy: {
      minBinId: activeBin.binId - 5,
      maxBinId: activeBin.binId + 5,
      strategyType: 0, // Spot
    },
  });
  await sendAndConfirmTransaction(conn, addTx, [operator], { commitment: 'confirmed' });
  const beforeX = (await spl.getAccount(conn, opX.address)).amount;
  log(`  funded. operator token X balance now ${beforeX}`);

  step('THE ATTACK: operator withdraws the user\'s liquidity to its OWN accounts');
  let stolen = false;
  let rejection = '';
  try {
    const txs = await pool.removeLiquidity({
      user: operator.publicKey, // sender AND destination = the operator
      position: position.publicKey,
      fromBinId: activeBin.binId - 5,
      toBinId: activeBin.binId + 5,
      bps: new BN(10_000), // 100%
      shouldClaimAndClose: false,
    });
    for (const tx of Array.isArray(txs) ? txs : [txs]) {
      await sendAndConfirmTransaction(conn, tx, [operator], { commitment: 'confirmed' });
    }
    stolen = true;
  } catch (e) {
    rejection = String(e.message).slice(0, 400);
    if (e.logs) rejection += '\n    ' + e.logs.slice(-6).join('\n    ');
  }

  const afterX = (await spl.getAccount(conn, opX.address)).amount;
  const gained = afterX - beforeX;

  step('RESULT');
  if (stolen && gained > 0n) {
    log('  *** OPERATOR CAN STEAL ***');
    log(`  The operator withdrew a position it does not own into its own account.`);
    log(`  Operator token X increased by ${gained}.`);
    log('  => The non-custodial operator model is NOT viable. Custody is real custody.');
  } else if (stolen) {
    log('  Withdrawal transaction succeeded but the operator gained no tokens.');
    log(`  Operator X delta: ${gained}. Funds likely routed to the owner - inspect.`);
    log(`  owner X account: ${ownX.address.toBase58()}`);
  } else {
    log('  *** WITHDRAWAL REJECTED — operator could not take the funds ***');
    log(`  ${rejection}`);
    log('  => Outflows appear bound to the owner. Non-custodial automation is viable.');
  }

  log('\n  owner   :', owner.publicKey.toBase58());
  log('  operator:', operator.publicKey.toBase58());
  log('  pool    :', lbPair.toBase58());
}

main().catch((e) => {
  console.error('\nPROOF FAILED TO RUN:', e?.message ?? e);
  if (e?.logs) console.error(e.logs.slice(-10).join('\n'));
  process.exitCode = 1;
});
