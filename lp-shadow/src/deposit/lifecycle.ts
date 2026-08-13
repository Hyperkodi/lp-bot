export type WalletAssetBalance = { assetMint: string | null; amount: number };
export type DepositAssetAmount = { asset: string; amount: number };

export type DepositState = {
  status: 'AWAITING_DEPOSIT' | 'DEPOSIT_COMPLETE' | 'READY_TO_OPEN' | 'POSITION_OPEN';
  receivedSol: number;
  receivedToken: number;
  missing: DepositAssetAmount[];
  unexpected: DepositAssetAmount[];
  unallocated: DepositAssetAmount[];
};

export type DepositStateInput = {
  expectedSol: number;
  expectedToken: number;
  projectTokenMint: string;
  balances: readonly WalletAssetBalance[];
  positionOpen: boolean;
};

function checkedAmount(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  return value;
}

export function evaluateDepositState(input: DepositStateInput): DepositState {
  const expectedSol = checkedAmount(input.expectedSol, 'expected SOL');
  const expectedToken = checkedAmount(input.expectedToken, 'expected token');
  const totals = new Map<string, number>();
  for (const balance of input.balances) {
    const asset = balance.assetMint ?? 'SOL';
    totals.set(asset, (totals.get(asset) ?? 0) + checkedAmount(balance.amount, `balance for ${asset}`));
  }
  const receivedSol = totals.get('SOL') ?? 0;
  const receivedToken = totals.get(input.projectTokenMint) ?? 0;
  const missing: DepositAssetAmount[] = [];
  if (receivedSol < expectedSol) missing.push({ asset: 'SOL', amount: expectedSol - receivedSol });
  if (receivedToken < expectedToken) {
    missing.push({ asset: input.projectTokenMint, amount: expectedToken - receivedToken });
  }
  const unexpected = [...totals.entries()]
    .filter(([asset]) => asset !== 'SOL' && asset !== input.projectTokenMint)
    .map(([asset, amount]) => ({ asset, amount }));
  const unallocated = input.positionOpen
    ? [
        ...(receivedSol > expectedSol ? [{ asset: 'SOL', amount: receivedSol - expectedSol }] : []),
        ...(receivedToken > expectedToken
          ? [{ asset: input.projectTokenMint, amount: receivedToken - expectedToken }]
          : []),
        ...unexpected,
      ]
    : unexpected;

  return {
    status: input.positionOpen
      ? 'POSITION_OPEN'
      : missing.length === 0
        ? 'DEPOSIT_COMPLETE'
        : 'AWAITING_DEPOSIT',
    receivedSol,
    receivedToken,
    missing,
    unexpected,
    unallocated,
  };
}

export function confirmDeposit(state: DepositState): DepositState {
  if (state.status !== 'DEPOSIT_COMPLETE') {
    throw new Error('deposit can be confirmed only after both expected assets have arrived');
  }
  return { ...state, status: 'READY_TO_OPEN' };
}

