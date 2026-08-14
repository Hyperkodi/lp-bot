import { parseArgs } from 'node:util';
import {
  LAUNCH_PLAN_SHAPES,
  compareInitialLiquidityPlans,
  planInitialLiquidity,
  type InitialLiquidityLaunchPlan,
  type LaunchPlanInput,
} from '../src/strategy/launchPlanner.js';
import type { DistributionShape } from '../src/types.js';

const USAGE = `Initial-liquidity launch planner (read-only)

Required:
  --token <amount>       Project tokens deposited into initial liquidity
  --sol <amount>         SOL deposited into initial liquidity
  --supply <amount>      Total token supply
  --bin-step <bps>       Meteora bin step in basis points
  --fee-bps <bps>        Pool base fee in basis points
  --sol-price <usd>      SOL/USD display price (required with --buyer-usd)
  --buyer-usd <usd>      Largest launch buyer order to model
    or --buyer-sol <sol> Model the buyer order directly in SOL

Optional:
  --impact-bps <bps>     Acceptable modeled price impact (default: 100 = 1%)
  --gas-reserve <sol>    SOL kept outside the position (default: 0.05)
  --shape <name>         SPOT, CURVE, or BID_ASK; use together with --bins
  --bins <count>         Funded bins, up to 70; use together with --shape
  --json                 Machine-readable output
  --help                 Show this help

Without --shape and --bins, all 12 historically tested shape/width families
are compared using the exact same token and SOL deposit.`;

function numeric(value: string | undefined, label: string): number {
  if (value === undefined || value.trim() === '') throw new Error(`missing --${label}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${label} must be a finite number`);
  return parsed;
}

function optionalNumeric(value: string | undefined, label: string): number | null {
  return value === undefined ? null : numeric(value, label);
}

function shape(value: string | undefined): DistributionShape {
  const normalized = value?.toUpperCase();
  if (!LAUNCH_PLAN_SHAPES.includes(normalized as DistributionShape)) {
    throw new Error('--shape must be SPOT, CURVE, or BID_ASK');
  }
  return normalized as DistributionShape;
}

function money(value: number | null): string {
  return value === null
    ? 'n/a'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

function number(value: number, maximumFractionDigits = 8): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function comparisonTable(plans: InitialLiquidityLaunchPlan[]): string {
  const columns: [string, (plan: InitialLiquidityLaunchPlan) => string][] = [
    ['shape', (plan) => plan.distributionShape],
    ['bins', (plan) => String(plan.fundedRange.totalBins)],
    ['down', (plan) => percent(plan.fundedRange.downsidePct)],
    ['up', (plan) => percent(plan.fundedRange.upsidePct)],
    ['depth', (plan) => plan.buyer.depthWithinImpactUsd === null
      ? `${number(plan.buyer.depthWithinImpactSol, 4)} SOL`
      : money(plan.buyer.depthWithinImpactUsd)],
    ['fill', (plan) => percent(plan.buyer.fillRate)],
    ['impact', (plan) => `${plan.buyer.priceImpactBps.toFixed(1)} bps`],
  ];
  const widths = columns.map(([heading, render]) =>
    Math.max(heading.length, ...plans.map((plan) => render(plan).length)),
  );
  const line = (cells: string[]) => cells.map((cell, index) => cell.padStart(widths[index]!)).join('  ');
  return [
    line(columns.map(([heading]) => heading)),
    line(widths.map((width) => '-'.repeat(width))),
    ...plans.map((plan) => line(columns.map(([, render]) => render(plan)))),
  ].join('\n');
}

function printOpening(plan: InitialLiquidityLaunchPlan): void {
  process.stdout.write('Initial-liquidity launch plan (read-only)\n\n');
  process.stdout.write(`Opening price: ${number(plan.price.priceSolPerToken, 12)} SOL per token\n`);
  process.stdout.write(`Implied FDV: ${number(plan.price.impliedFdvSol, 4)} SOL (${money(plan.price.impliedFdvUsd)})\n`);
  process.stdout.write(
    `Initial position: ${number(plan.deposit.tokenAmount, 4)} tokens + ${number(plan.deposit.positionSolAmount, 4)} SOL`,
  );
  if (plan.deposit.initialLiquidityValueUsd !== null) {
    process.stdout.write(` (${money(plan.deposit.initialLiquidityValueUsd)})`);
  }
  process.stdout.write('\n');
  process.stdout.write(
    `Minimum wallet SOL before creation costs: ${number(plan.deposit.minimumWalletSolBeforeCreationCosts, 4)} (${number(plan.deposit.positionSolAmount, 4)} position + ${number(plan.deposit.gasReserveSol, 4)} reserve)\n`,
  );
  process.stdout.write('Pool creation, account rent, and transaction costs must be quoted and added before funding.\n');
  process.stdout.write(`Pool settings: ${plan.pool.binStepBps} bps bin step, ${plan.pool.baseFeeBps} bps base fee\n`);
  process.stdout.write(`Price confirmation: ${plan.price.confirmationPhrase}\n`);
  process.stdout.write('\nPermanent-position rule: open at pool creation and leave this initial liquidity deposited unless the founder explicitly withdraws.\n');
  process.stdout.write('No automatic compounding, rebalancing, exit, or later top-up is modeled here; founder withdrawal remains available.\n\n');
}

function printSingle(plan: InitialLiquidityLaunchPlan): void {
  printOpening(plan);
  process.stdout.write(`Funded recipe: ${plan.distributionShape}, ${plan.fundedRange.totalBins} bins\n`);
  process.stdout.write(
    `Position account bins: ${plan.positionAccount.lowerBinId} through ${plan.positionAccount.upperBinId} (${plan.positionAccount.width} total)\n`,
  );
  process.stdout.write(
    `Funded bins: ${plan.fundedRange.lowerBinId} through ${plan.fundedRange.upperBinId}; price coverage -${percent(plan.fundedRange.downsidePct)} / +${percent(plan.fundedRange.upsidePct)}\n`,
  );
  process.stdout.write(
    `Funded price range: ${number(plan.fundedRange.lowerPriceSolPerToken, 12)} to ${number(plan.fundedRange.upperPriceSolPerToken, 12)} SOL per token\n`,
  );
  process.stdout.write(
    `Modeled buyer: ${number(plan.buyer.requestedSol, 4)} SOL requested, ${percent(plan.buyer.fillRate)} filled, ${plan.buyer.priceImpactBps.toFixed(1)} bps average impact\n`,
  );
  process.stdout.write(
    `Depth within the impact limit: ${number(plan.buyer.depthWithinImpactSol, 4)} SOL (${money(plan.buyer.depthWithinImpactUsd)})\n`,
  );
  process.stdout.write(
    `Estimated base fee on the modeled fill: ${number(plan.buyer.estimatedBaseFeeSol, 6)} SOL (${money(plan.buyer.estimatedBaseFeeUsd)})\n`,
  );
}

function main(): void {
  const { values } = parseArgs({
    options: {
      token: { type: 'string' },
      sol: { type: 'string' },
      supply: { type: 'string' },
      'sol-price': { type: 'string' },
      'bin-step': { type: 'string' },
      'fee-bps': { type: 'string' },
      'buyer-usd': { type: 'string' },
      'buyer-sol': { type: 'string' },
      'impact-bps': { type: 'string', default: '100' },
      'gas-reserve': { type: 'string', default: '0.05' },
      shape: { type: 'string' },
      bins: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (values['buyer-usd'] !== undefined && values['buyer-sol'] !== undefined) {
    throw new Error('use either --buyer-usd or --buyer-sol, not both');
  }
  if (values['buyer-usd'] === undefined && values['buyer-sol'] === undefined) {
    throw new Error('missing --buyer-usd or --buyer-sol');
  }
  if ((values.shape === undefined) !== (values.bins === undefined)) {
    throw new Error('--shape and --bins must be supplied together');
  }

  const solPriceUsd = optionalNumeric(values['sol-price'], 'sol-price');
  let buyerOrderSol: number;
  if (values['buyer-usd'] !== undefined) {
    if (solPriceUsd === null || solPriceUsd <= 0) {
      throw new Error('--sol-price must be positive when using --buyer-usd');
    }
    buyerOrderSol = numeric(values['buyer-usd'], 'buyer-usd') / solPriceUsd;
  } else {
    buyerOrderSol = numeric(values['buyer-sol'], 'buyer-sol');
  }

  const input: LaunchPlanInput = {
    tokenAmount: numeric(values.token, 'token'),
    solAmount: numeric(values.sol, 'sol'),
    tokenSupply: numeric(values.supply, 'supply'),
    solPriceUsd,
    binStepBps: numeric(values['bin-step'], 'bin-step'),
    baseFeeBps: numeric(values['fee-bps'], 'fee-bps'),
    distributionShape: values.shape === undefined ? 'SPOT' : shape(values.shape),
    totalBins: values.bins === undefined ? 15 : numeric(values.bins, 'bins'),
    buyerOrderSol,
    maxBuyerImpactBps: numeric(values['impact-bps'], 'impact-bps'),
    gasReserveSol: numeric(values['gas-reserve'], 'gas-reserve'),
  };

  if (values.shape !== undefined && values.bins !== undefined) {
    const plan = planInitialLiquidity(input);
    if (values.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else printSingle(plan);
    return;
  }

  const plans = compareInitialLiquidityPlans(input);
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ opening: plans[0], comparisons: plans }, null, 2)}\n`);
    return;
  }
  printOpening(plans[0]!);
  process.stdout.write('Same permanent deposit, compared across the 12 tested recipe families:\n');
  process.stdout.write(`${comparisonTable(plans)}\n\n`);
  const deepest = [...plans].sort(
    (a, b) => b.buyer.depthWithinImpactSol - a.buyer.depthWithinImpactSol,
  )[0]!;
  process.stdout.write(
    `Highest modeled opening depth: ${deepest.distributionShape}/${deepest.fundedRange.totalBins} bins. ` +
    'This is a trade-off comparison, not a production winner.\n',
  );
  process.stdout.write('Depth and impact include only this position; routing, other LPs, dynamic fees, and market reaction are excluded.\n');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Launch planner error: ${message}\n\n${USAGE}\n`);
  process.exitCode = 1;
}
