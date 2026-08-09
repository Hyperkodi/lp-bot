// Dune adapter — STUB.
//
// TODO: wire saved Dune queries for metrics no REST API provides well:
//  - holder concentration (top-10 holders %) per token per chain
//  - largest transfers in the last 24h (whale watch)
//  - net mint/redeem by issuer program
// Plan: create the queries in Dune, note their query IDs here, then use the
// Dune API (https://docs.dune.com/api-reference/) execute/results endpoints
// with DUNE_API_KEY. Free tier allows limited executions/day, so results
// should be cached with a long TTL (>= 1h) via fetchJsonCached.
export interface DuneHolderConcentration {
  tokenAddress: string;
  chain: string;
  top10Pct: number;
  holderCount: number;
}

export interface DuneWhaleTransfer {
  chain: string;
  tokenSymbol: string;
  amountUsd: number;
  from: string;
  to: string;
  txHash: string;
  occurredAt: Date;
}

export async function getHolderConcentration(): Promise<DuneHolderConcentration[]> {
  if (!process.env.DUNE_API_KEY) return [];
  // TODO: implement — execute saved query, poll for results.
  throw new Error("Dune adapter not implemented — add saved query IDs first");
}

export async function getWhaleTransfers(): Promise<DuneWhaleTransfer[]> {
  if (!process.env.DUNE_API_KEY) return [];
  // TODO: implement — execute saved query, poll for results.
  throw new Error("Dune adapter not implemented — add saved query IDs first");
}
