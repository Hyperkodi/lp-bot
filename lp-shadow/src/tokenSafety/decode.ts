import {
  ExtensionType,
  getExtensionTypes,
  getPermanentDelegate,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';
import type { TokenMintSafetyFacts } from './screen.js';

export type TokenMintAccountDetails = {
  mintAddress: string;
  programId: string;
  decimals: number;
  supplyAtomic: string;
  supplyTokens: string;
  safety: TokenMintSafetyFacts;
};

export function decodeTokenMintDetails(
  mintAddress: PublicKey,
  account: AccountInfo<Buffer>,
): TokenMintAccountDetails {
  const isLegacy = account.owner.equals(TOKEN_PROGRAM_ID);
  const isToken2022 = account.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!isLegacy && !isToken2022) {
    throw new Error(`unsupported token mint owner ${account.owner.toBase58()}`);
  }

  const mint = unpackMint(mintAddress, account, account.owner);
  if (!mint.isInitialized) throw new Error(`token mint ${mintAddress.toBase58()} is not initialized`);

  const extensions = isToken2022 ? getExtensionTypes(mint.tlvData) : [];
  const permanentDelegate = isToken2022 ? getPermanentDelegate(mint)?.delegate ?? null : null;
  return {
    mintAddress: mintAddress.toBase58(),
    programId: account.owner.toBase58(),
    decimals: mint.decimals,
    supplyAtomic: mint.supply.toString(),
    supplyTokens: new Decimal(mint.supply.toString())
      .div(new Decimal(10).pow(mint.decimals))
      .toString(),
    safety: {
      program: isLegacy ? 'LEGACY_SPL' : 'TOKEN_2022',
      mintAuthority: mint.mintAuthority?.toBase58() ?? null,
      freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
      permanentDelegate: permanentDelegate?.toBase58() ?? null,
      hasTransferHook: extensions.includes(ExtensionType.TransferHook),
      hasTransferFee: extensions.includes(ExtensionType.TransferFeeConfig),
      nonTransferable: extensions.includes(ExtensionType.NonTransferable),
    },
  };
}

export function decodeTokenMintAccount(
  mintAddress: PublicKey,
  account: AccountInfo<Buffer>,
): TokenMintSafetyFacts {
  return decodeTokenMintDetails(mintAddress, account).safety;
}

export async function readTokenMintDetails(
  connection: Pick<Connection, 'getAccountInfo'>,
  mintAddress: PublicKey,
): Promise<TokenMintAccountDetails> {
  const account = await connection.getAccountInfo(mintAddress, 'confirmed');
  if (!account) throw new Error(`token mint ${mintAddress.toBase58()} was not found`);
  return decodeTokenMintDetails(mintAddress, account);
}

export async function readTokenMintSafetyFacts(
  connection: Pick<Connection, 'getAccountInfo'>,
  mintAddress: PublicKey,
): Promise<TokenMintSafetyFacts> {
  const account = await connection.getAccountInfo(mintAddress, 'confirmed');
  if (!account) throw new Error(`token mint ${mintAddress.toBase58()} was not found`);
  return decodeTokenMintAccount(mintAddress, account);
}
