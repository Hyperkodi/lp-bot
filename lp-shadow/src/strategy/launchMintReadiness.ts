import Decimal from 'decimal.js';
import { screenTokenMint, type TokenMintAccountDetails } from '../tokenSafety/index.js';

export type LaunchMintRequirement = {
  founderAddress: string;
  expectedDecimals: number;
  expectedSupplyTokens: number | string;
};

export type LaunchMintReadiness = {
  status: 'READY' | 'ACKNOWLEDGEMENT_REQUIRED' | 'BLOCKED';
  mintAddress: string;
  programId: string;
  verifiedDecimals: number;
  onChainSupplyTokens: string;
  blockers: string[];
  warnings: string[];
  readyForUnsignedDraft: boolean;
};

export function assessLaunchMintReadiness(
  mint: TokenMintAccountDetails,
  requirement: LaunchMintRequirement,
): LaunchMintReadiness {
  if (!Number.isInteger(requirement.expectedDecimals)
    || requirement.expectedDecimals < 0
    || requirement.expectedDecimals > 18) {
    throw new Error('expected token decimals must be an integer from 0 to 18');
  }
  const expectedSupply = new Decimal(requirement.expectedSupplyTokens);
  if (!expectedSupply.isFinite() || !expectedSupply.isPositive()) {
    throw new Error('expected token supply must be a finite positive amount');
  }
  const safety = screenTokenMint(mint.safety, requirement.founderAddress);
  const blockers = [...safety.refusals];
  if (mint.decimals !== requirement.expectedDecimals) {
    blockers.push(
      `Entered token decimals ${requirement.expectedDecimals} do not match on-chain decimals ${mint.decimals}.`,
    );
  }
  if (!new Decimal(mint.supplyTokens).equals(expectedSupply)) {
    blockers.push(
      `Entered total supply ${expectedSupply.toString()} does not match current on-chain supply ${mint.supplyTokens}.`,
    );
  }
  const warnings = [...safety.warnings];
  const status = blockers.length > 0
    ? 'BLOCKED'
    : warnings.length > 0
      ? 'ACKNOWLEDGEMENT_REQUIRED'
      : 'READY';
  return {
    status,
    mintAddress: mint.mintAddress,
    programId: mint.programId,
    verifiedDecimals: mint.decimals,
    onChainSupplyTokens: mint.supplyTokens,
    blockers,
    warnings,
    readyForUnsignedDraft: status === 'READY',
  };
}

