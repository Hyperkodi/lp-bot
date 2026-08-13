import {
  ComputeBudgetProgram,
  SystemInstruction,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';
import type { DestinationPolicy, ExecutionAction } from './types.js';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export const STANDARD_ALLOWED_PROGRAM_IDS = new Set([
  SystemProgram.programId.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
]);

type InspectionContext = {
  action: ExecutionAction;
  allowedProgramIds: ReadonlySet<string>;
  destinations: DestinationPolicy;
};

function classifyDestination(address: string, policy: DestinationPolicy) {
  if (address === policy.founderWithdrawalAddress || policy.founderTokenAccounts.has(address)) {
    return 'founder';
  }
  if (address === policy.feeTreasuryAddress || policy.feeTreasuryTokenAccounts.has(address)) {
    return 'treasury';
  }
  if (policy.poolProgramAccounts.has(address)) return 'pool';
  if (address === policy.projectWalletAddress) return 'wallet';
  return null;
}

function assertDestination(address: string, context: InspectionContext) {
  const destinationClass = classifyDestination(address, context.destinations);
  if (!destinationClass) throw new Error(`destination allowlist rejected ${address}`);
  if (destinationClass === 'treasury' && context.action !== 'FEE_SETTLEMENT') {
    throw new Error('treasury destination is legal only inside fee settlement');
  }
}

function inspectTokenInstruction(instruction: TransactionInstruction, context: InspectionContext) {
  const opcode = instruction.data[0];
  if (opcode === 6) throw new Error('SetAuthority is forbidden in every execution');
  if (opcode === 3) {
    const destination = instruction.keys[1]?.pubkey.toBase58();
    if (!destination) throw new Error('malformed SPL Token Transfer instruction');
    assertDestination(destination, context);
  } else if (opcode === 12) {
    const destination = instruction.keys[2]?.pubkey.toBase58();
    if (!destination) throw new Error('malformed SPL Token TransferChecked instruction');
    assertDestination(destination, context);
  } else if (opcode === 9) {
    const destination = instruction.keys[1]?.pubkey.toBase58();
    if (!destination) throw new Error('malformed SPL Token CloseAccount instruction');
    assertDestination(destination, context);
  }
}

function inspectLegacyInstruction(instruction: TransactionInstruction, context: InspectionContext) {
  const programId = instruction.programId.toBase58();
  if (!context.allowedProgramIds.has(programId)) {
    throw new Error(`program allowlist rejected ${programId}`);
  }

  if (programId === SystemProgram.programId.toBase58()) {
    const kind = SystemInstruction.decodeInstructionType(instruction);
    if (kind === 'Transfer') {
      assertDestination(SystemInstruction.decodeTransfer(instruction).toPubkey.toBase58(), context);
    } else if (kind === 'Create') {
      assertDestination(SystemInstruction.decodeCreateAccount(instruction).newAccountPubkey.toBase58(), context);
    }
    return;
  }
  if (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) {
    inspectTokenInstruction(instruction, context);
    return;
  }
  if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
    const createdAccount = instruction.keys[1]?.pubkey.toBase58();
    if (!createdAccount) throw new Error('malformed Associated Token instruction');
    assertDestination(createdAccount, context);
    return;
  }
  if (programId === ComputeBudgetProgram.programId.toBase58()) return;

  // For the Meteora instruction itself, every writable non-signer account is
  // an economic destination and must belong to one of the four allowed classes.
  for (const key of instruction.keys) {
    if (key.isWritable && !key.isSigner) assertDestination(key.pubkey.toBase58(), context);
  }
}

export function inspectTransaction(
  transaction: Transaction | VersionedTransaction,
  context: InspectionContext,
): void {
  if (!(transaction instanceof Transaction)) {
    throw new Error('versioned transaction inspection requires resolved address tables');
  }
  for (const instruction of transaction.instructions) inspectLegacyInstruction(instruction, context);
}

