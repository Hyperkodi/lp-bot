import { describe, expect, it } from 'vitest';
import {
  confirmDeposit,
  evaluateDepositState,
  type WalletAssetBalance,
} from '../src/deposit/index.js';
import { prepareInitialPrice, verifyPriceConfirmation } from '../src/pool/index.js';
import { screenTokenMint } from '../src/tokenSafety/index.js';

describe('deposit lifecycle', () => {
  const tokenMint = 'PROJECT_TOKEN';
  const balances = (sol: number, token: number, extras: WalletAssetBalance[] = []) => [
    { assetMint: null, amount: sol },
    { assetMint: tokenMint, amount: token },
    ...extras,
  ];

  it('treats partial funding as an explicit waiting state', () => {
    const state = evaluateDepositState({
      expectedSol: 10,
      expectedToken: 1_000_000,
      projectTokenMint: tokenMint,
      balances: balances(10, 400_000),
      positionOpen: false,
    });
    expect(state.status).toBe('AWAITING_DEPOSIT');
    expect(state.missing).toEqual([{ asset: tokenMint, amount: 600_000 }]);
  });

  it('requires explicit confirmation after both expected assets arrive', () => {
    const complete = evaluateDepositState({
      expectedSol: 10,
      expectedToken: 1_000_000,
      projectTokenMint: tokenMint,
      balances: balances(10.5, 1_000_000),
      positionOpen: false,
    });
    expect(complete.status).toBe('DEPOSIT_COMPLETE');
    expect(confirmDeposit(complete)).toMatchObject({ status: 'READY_TO_OPEN' });
  });

  it('reports unexpected tokens and post-open top-ups as unallocated', () => {
    const state = evaluateDepositState({
      expectedSol: 10,
      expectedToken: 1_000_000,
      projectTokenMint: tokenMint,
      balances: balances(12, 1_100_000, [{ assetMint: 'UNEXPECTED', amount: 50 }]),
      positionOpen: true,
    });
    expect(state.status).toBe('POSITION_OPEN');
    expect(state.unallocated).toEqual(
      expect.arrayContaining([
        { asset: 'SOL', amount: 2 },
        { asset: tokenMint, amount: 100_000 },
        { asset: 'UNEXPECTED', amount: 50 },
      ]),
    );
  });
});

describe('token safety screen', () => {
  const safe = {
    program: 'TOKEN_2022' as const,
    mintAuthority: null,
    freezeAuthority: null,
    permanentDelegate: null,
    hasTransferHook: false,
    hasTransferFee: false,
    nonTransferable: false,
  };

  it.each([
    ['permanent delegate', { permanentDelegate: 'delegate' }],
    ['transfer hook', { hasTransferHook: true }],
    ['transfer fee', { hasTransferFee: true }],
    ['non-transferable', { nonTransferable: true }],
    ['foreign freeze authority', { freezeAuthority: 'stranger' }],
  ])('hard-refuses %s', (_label, override) => {
    const result = screenTokenMint({ ...safe, ...override }, 'founder');
    expect(result.allowed).toBe(false);
    expect(result.refusals).not.toHaveLength(0);
  });

  it('warns rather than refuses founder-held authorities', () => {
    const result = screenTokenMint(
      { ...safe, mintAuthority: 'founder', freezeAuthority: 'founder' },
      'founder',
    );
    expect(result.allowed).toBe(true);
    expect(result.requiresAcknowledgement).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });
});

describe('initial-price ceremony', () => {
  it('shows implied TOKEN/SOL price and FDV and requires the exact typed phrase', () => {
    const ceremony = prepareInitialPrice({
      tokenAmount: 1_000_000,
      solAmount: 10,
      tokenSupply: 100_000_000,
      solPriceUsd: 200,
      existingPoolPriceSol: null,
    });
    expect(ceremony.mode).toBe('CREATE');
    expect(ceremony.priceSolPerToken).toBe(0.00001);
    expect(ceremony.impliedFdvSol).toBe(1_000);
    expect(ceremony.impliedFdvUsd).toBe(200_000);
    expect(verifyPriceConfirmation(ceremony, ceremony.confirmationPhrase)).toBe(true);
    expect(verifyPriceConfirmation(ceremony, 'confirm')).toBe(false);
  });

  it('never creates over an existing pair and requires joining at its live price', () => {
    const ceremony = prepareInitialPrice({
      tokenAmount: 1_000_000,
      solAmount: 10,
      tokenSupply: 100_000_000,
      solPriceUsd: 200,
      existingPoolPriceSol: 0.00002,
    });
    expect(ceremony.mode).toBe('JOIN_EXISTING');
    expect(ceremony.priceSolPerToken).toBe(0.00002);
    expect(ceremony.confirmationPhrase).toMatch(/^JOIN AT /);
  });
});
