// rwa.xyz adapter — STUB.
//
// TODO: rwa.xyz's institutional API is request-only (https://rwa.xyz — apply
// for API access). Once credentials are granted:
//  - set RWA_XYZ_API_KEY in .env
//  - implement getTokenizedEquityUniverse() against their /assets endpoints
//    to reconcile our seeded universe (holder counts and distributed value
//    are notably better there than anywhere public)
//  - map their issuer taxonomy onto our Issuer slugs
export interface RwaXyzAssetRecord {
  symbol: string;
  issuer: string;
  distributedValueUsd: number | null;
  holderCount: number | null;
}

export async function getTokenizedEquityUniverse(): Promise<RwaXyzAssetRecord[]> {
  if (!process.env.RWA_XYZ_API_KEY) return [];
  // TODO: implement once API access is granted.
  throw new Error("rwa.xyz adapter not implemented — institutional API access pending");
}
