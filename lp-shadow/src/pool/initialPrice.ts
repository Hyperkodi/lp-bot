export type InitialPriceInput = {
  tokenAmount: number;
  solAmount: number;
  tokenSupply: number;
  solPriceUsd: number | null;
  existingPoolPriceSol: number | null;
};

export type InitialPriceCeremony = {
  mode: 'CREATE' | 'JOIN_EXISTING';
  priceSolPerToken: number;
  impliedFdvSol: number;
  impliedFdvUsd: number | null;
  confirmationPhrase: string;
};

function positive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive`);
}

function displayNumber(value: number): string {
  return Number(value.toPrecision(12)).toString();
}

export function prepareInitialPrice(input: InitialPriceInput): InitialPriceCeremony {
  positive(input.tokenAmount, 'token amount');
  positive(input.solAmount, 'SOL amount');
  positive(input.tokenSupply, 'token supply');
  if (input.solPriceUsd !== null) positive(input.solPriceUsd, 'SOL USD price');
  if (input.existingPoolPriceSol !== null) positive(input.existingPoolPriceSol, 'existing pool price');

  const mode = input.existingPoolPriceSol === null ? 'CREATE' : 'JOIN_EXISTING';
  const price =
    input.existingPoolPriceSol === null
      ? new Decimal(input.solAmount).div(input.tokenAmount)
      : new Decimal(input.existingPoolPriceSol);
  const priceSolPerToken = price.toNumber();
  const impliedFdvSol = price.mul(input.tokenSupply).toNumber();
  const confirmationPhrase =
    mode === 'CREATE'
      ? `CONFIRM PRICE ${displayNumber(priceSolPerToken)} SOL`
      : `JOIN AT ${displayNumber(priceSolPerToken)} SOL`;
  return {
    mode,
    priceSolPerToken,
    impliedFdvSol,
    impliedFdvUsd:
      input.solPriceUsd === null ? null : new Decimal(impliedFdvSol).mul(input.solPriceUsd).toNumber(),
    confirmationPhrase,
  };
}

export function verifyPriceConfirmation(ceremony: InitialPriceCeremony, typed: string): boolean {
  return typed.trim() === ceremony.confirmationPhrase;
}
import Decimal from 'decimal.js';

