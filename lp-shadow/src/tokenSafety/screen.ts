export type TokenMintSafetyFacts = {
  program: 'LEGACY_SPL' | 'TOKEN_2022';
  mintAuthority: string | null;
  freezeAuthority: string | null;
  permanentDelegate: string | null;
  hasTransferHook: boolean;
  hasTransferFee: boolean;
  nonTransferable: boolean;
};

export type TokenSafetyResult = {
  allowed: boolean;
  refusals: string[];
  warnings: string[];
  requiresAcknowledgement: boolean;
};

export function screenTokenMint(
  facts: TokenMintSafetyFacts,
  founderAddress: string,
): TokenSafetyResult {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (facts.permanentDelegate) {
    refusals.push('Permanent delegate can seize tokens from the project wallet.');
  }
  if (facts.hasTransferHook) refusals.push('Transfer hook runs arbitrary code on every transfer.');
  if (facts.hasTransferFee) refusals.push('Transfer fee makes position amounts unreliable.');
  if (facts.nonTransferable) refusals.push('Non-transferable tokens cannot be pooled.');
  if (facts.freezeAuthority && facts.freezeAuthority !== founderAddress) {
    refusals.push('Freeze authority is held by an address other than the registered founder.');
  } else if (facts.freezeAuthority === founderAddress) {
    warnings.push('You retain freeze authority and can freeze the managed position.');
  }
  if (facts.mintAuthority) {
    warnings.push('Mint authority is still active and can change the circulating supply.');
  }
  return {
    allowed: refusals.length === 0,
    refusals,
    warnings,
    requiresAcknowledgement: refusals.length === 0 && warnings.length > 0,
  };
}

