import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { assessLaunchMintReadiness } from '../src/strategy/launchMintReadiness.js';
import type { TokenMintAccountDetails } from '../src/tokenSafety/index.js';

const address = (byte: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();

function mint(overrides: Partial<TokenMintAccountDetails> = {}): TokenMintAccountDetails {
  return {
    mintAddress: address(1),
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    decimals: 6,
    supplyAtomic: '1000000000000000',
    supplyTokens: '1000000000',
    safety: {
      program: 'LEGACY_SPL',
      mintAuthority: null,
      freezeAuthority: null,
      permanentDelegate: null,
      hasTransferHook: false,
      hasTransferFee: false,
      nonTransferable: false,
    },
    ...overrides,
  };
}

const requirement = {
  founderAddress: address(2),
  expectedDecimals: 6,
  expectedSupplyTokens: 1_000_000_000,
};

describe('launch mint readiness', () => {
  it('accepts an exact, authority-free supported mint', () => {
    expect(assessLaunchMintReadiness(mint(), requirement)).toMatchObject({
      status: 'READY',
      verifiedDecimals: 6,
      onChainSupplyTokens: '1000000000',
      blockers: [],
      warnings: [],
      readyForUnsignedDraft: true,
    });
  });

  it('blocks mismatched decimals and supply', () => {
    const result = assessLaunchMintReadiness(mint({ decimals: 9 }), {
      ...requirement,
      expectedSupplyTokens: '999999999',
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/decimals/i),
      expect.stringMatching(/total supply/i),
    ]));
    expect(result.readyForUnsignedDraft).toBe(false);
  });

  it('blocks unsafe extensions and requires acknowledgement for retained authority', () => {
    const unsafe = assessLaunchMintReadiness(mint({
      safety: { ...mint().safety, hasTransferFee: true },
    }), requirement);
    expect(unsafe.status).toBe('BLOCKED');
    expect(unsafe.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/transfer fee/i)]));

    const warning = assessLaunchMintReadiness(mint({
      safety: { ...mint().safety, mintAuthority: requirement.founderAddress },
    }), requirement);
    expect(warning.status).toBe('ACKNOWLEDGEMENT_REQUIRED');
    expect(warning.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/mint authority/i)]));
    expect(warning.readyForUnsignedDraft).toBe(false);
  });
});
