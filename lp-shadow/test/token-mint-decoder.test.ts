import {
  ACCOUNT_SIZE,
  ACCOUNT_TYPE_SIZE,
  AccountType,
  ExtensionType,
  getTypeLen,
  MINT_SIZE,
  MintLayout,
  PermanentDelegateLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodeTokenMintAccount, decodeTokenMintDetails } from '../src/tokenSafety/index.js';

type TestExtension = { type: ExtensionType; data?: Buffer };

const publicKey = (byte: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte));

function mintAccount(
  owner: PublicKey,
  options: {
    mintAuthority?: PublicKey | null;
    freezeAuthority?: PublicKey | null;
    initialized?: boolean;
    extensions?: TestExtension[];
  } = {},
): AccountInfo<Buffer> {
  const extensions = options.extensions ?? [];
  const extensionLength = extensions.reduce((length, extension) => length + 4 + getTypeLen(extension.type), 0);
  const data = Buffer.alloc(extensions.length ? ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE + extensionLength : MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: options.mintAuthority ? 1 : 0,
      mintAuthority: options.mintAuthority ?? PublicKey.default,
      supply: 1_000_000n,
      decimals: 6,
      isInitialized: options.initialized ?? true,
      freezeAuthorityOption: options.freezeAuthority ? 1 : 0,
      freezeAuthority: options.freezeAuthority ?? PublicKey.default,
    },
    data,
  );

  if (extensions.length) {
    data[ACCOUNT_SIZE] = AccountType.Mint;
    let offset = ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE;
    for (const extension of extensions) {
      const length = getTypeLen(extension.type);
      data.writeUInt16LE(extension.type, offset);
      data.writeUInt16LE(length, offset + 2);
      extension.data?.copy(data, offset + 4);
      offset += 4 + length;
    }
  }

  return { data, executable: false, lamports: 1, owner, rentEpoch: 0 };
}

describe('live token mint decoder', () => {
  it('decodes a legacy SPL mint and its authorities', () => {
    const mintAuthority = publicKey(1);
    const freezeAuthority = publicKey(2);
    const facts = decodeTokenMintAccount(
      publicKey(3),
      mintAccount(TOKEN_PROGRAM_ID, { mintAuthority, freezeAuthority }),
    );

    expect(facts).toEqual({
      program: 'LEGACY_SPL',
      mintAuthority: mintAuthority.toBase58(),
      freezeAuthority: freezeAuthority.toBase58(),
      permanentDelegate: null,
      hasTransferHook: false,
      hasTransferFee: false,
      nonTransferable: false,
    });
  });

  it('returns exact decimals, atomic supply, human supply, and token program for readiness', () => {
    const mint = publicKey(8);
    const details = decodeTokenMintDetails(mint, mintAccount(TOKEN_PROGRAM_ID));
    expect(details).toMatchObject({
      mintAddress: mint.toBase58(),
      programId: TOKEN_PROGRAM_ID.toBase58(),
      decimals: 6,
      supplyAtomic: '1000000',
      supplyTokens: '1',
      safety: { program: 'LEGACY_SPL' },
    });
  });

  it('decodes dangerous Token-2022 mint extensions', () => {
    const delegate = publicKey(4);
    const delegateData = Buffer.alloc(getTypeLen(ExtensionType.PermanentDelegate));
    PermanentDelegateLayout.encode({ delegate }, delegateData);

    const facts = decodeTokenMintAccount(
      publicKey(5),
      mintAccount(TOKEN_2022_PROGRAM_ID, {
        extensions: [
          { type: ExtensionType.PermanentDelegate, data: delegateData },
          { type: ExtensionType.TransferHook },
          { type: ExtensionType.TransferFeeConfig },
          { type: ExtensionType.NonTransferable },
        ],
      }),
    );

    expect(facts).toMatchObject({
      program: 'TOKEN_2022',
      permanentDelegate: delegate.toBase58(),
      hasTransferHook: true,
      hasTransferFee: true,
      nonTransferable: true,
    });
  });

  it('rejects accounts outside the two supported token programs', () => {
    expect(() =>
      decodeTokenMintAccount(publicKey(6), mintAccount(SystemProgram.programId)),
    ).toThrow(/unsupported token mint owner/i);
  });

  it('rejects an uninitialized mint', () => {
    expect(() =>
      decodeTokenMintAccount(
        publicKey(7),
        mintAccount(TOKEN_PROGRAM_ID, { initialized: false }),
      ),
    ).toThrow(/not initialized/i);
  });
});
