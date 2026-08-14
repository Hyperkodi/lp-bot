import { Connection, PublicKey } from '@solana/web3.js';
import { assessLaunchMintReadiness } from '../src/strategy/launchMintReadiness.js';
import { readTokenMintDetails } from '../src/tokenSafety/index.js';

const [mintText, founderText, decimalsText, supplyText, endpoint = 'https://api.devnet.solana.com'] =
  process.argv.slice(2);
if (!mintText || !founderText || decimalsText === undefined || !supplyText) {
  throw new Error(
    'usage: pnpm launch:mint -- <mint> <founder-address> <expected-decimals> <expected-supply> [devnet-rpc]',
  );
}
if (!endpoint.toLowerCase().includes('devnet')) {
  throw new Error('launch mint readiness is devnet-only');
}

const mintAddress = new PublicKey(mintText);
const founderAddress = new PublicKey(founderText).toBase58();
const expectedDecimals = Number(decimalsText);
const connection = new Connection(endpoint, 'confirmed');
const details = await readTokenMintDetails(connection, mintAddress);
const readiness = assessLaunchMintReadiness(details, {
  founderAddress,
  expectedDecimals,
  expectedSupplyTokens: supplyText,
});

console.log(JSON.stringify({
  mode: 'READ_ONLY_DEVNET_MINT_READINESS',
  readiness,
  safety: details.safety,
}, null, 2));

