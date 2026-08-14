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
  --token-decimals <n>   Project token mint decimals (read from the mint)
  --sol <amount>         SOL deposited into initial liquidity
  --supply <amount>      Total token supply
  --bin-step <bps>       Meteora bin step in basis points
  --fee-bps <bps>        Pool base fee in basis points
  --sol-price <usd>      SOL/USD display price (required with --buyer-usd)
  --buyer-usd <usd>      Optional buyer order to model
    or --buyer-sol <sol> Optional buyer order directly in SOL

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
  const onePercentCapacity = (plan: InitialLiquidityLaunchPlan) =>
    plan.buyer.averageImpactCapacity.find((point) => point.maxAverageImpactBps === 100)!;
  const columns: [string, (plan: InitialLiquidityLaunchPlan) => string][] = [
    ['shape', (plan) => plan.distributionShape],
    ['bins', (plan) => String(plan.fundedRange.totalBins)],
    ['down', (plan) => percent(plan.fundedRange.downsidePct)],
    ['up', (plan) => percent(plan.fundedRange.upsidePct)],
    ['depth', (plan) => plan.buyer.depthWithinImpactUsd === null
      ? `${number(plan.buyer.depthWithinImpactSol, 4)} SOL`
      : money(plan.buyer.depthWithinImpactUsd)],
    ['avg<=1%', (plan) => onePercentCapacity(plan).maxOrderUsd === null
      ? `${number(onePercentCapacity(plan).maxOrderSol, 4)} SOL`
      : money(onePercentCapacity(plan).maxOrderUsd)],
    ['fill', (plan) => plan.buyer.requestedSol > 0 ? percent(plan.buyer.fillRate) : 'n/a'],
    ['impact', (plan) => plan.buyer.requestedSol > 0 ? `${plan.buyer.priceImpactBps.toFixed(1)} bps` : 'n/a'],
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
  process.stdout.write(`Intended price: ${number(plan.price.intendedPriceSolPerToken, 12)} SOL per token\n`);
  process.stdout.write(
    `Represented Meteora price: ${number(plan.price.representedPriceSolPerToken, 12)} SOL per token (active bin ${plan.price.activeBinId})\n`,
  );
  process.stdout.write(
    `Price rounding: ${plan.price.roundingDirection}, ${plan.price.deviationBps.toFixed(2)} bps from the intended price\n`,
  );
  process.stdout.write(`Represented FDV: ${number(plan.price.representedFdvSol, 4)} SOL (${money(plan.price.representedFdvUsd)})\n`);
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
  process.stdout.write('Known SDK account rent is estimated below; exact network and conditional account costs still require preflight.\n');
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
    `Known SDK account rent: ${number(plan.creationCost.knownRequiredAccountRentSol, 9)} SOL (${plan.creationCost.binArrayCount} bin arrays)\n`,
  );
  process.stdout.write(
    `Minimum wallet with known account rent: ${number(plan.creationCost.minimumWalletSolWithKnownAccountRent, 9)} SOL, plus network/priority fees and any conditional account rent\n`,
  );
  if (plan.buyer.requestedSol > 0) {
    process.stdout.write(
      `Modeled buyer: ${number(plan.buyer.requestedSol, 4)} SOL requested, ${percent(plan.buyer.fillRate)} filled, ${plan.buyer.priceImpactBps.toFixed(1)} bps average impact\n`,
    );
  } else {
    process.stdout.write('Modeled buyer: no single order supplied; use the capacity curve below.\n');
  }
  process.stdout.write(
    `Depth before marginal price exceeds the impact limit: ${number(plan.buyer.depthWithinImpactSol, 4)} SOL (${money(plan.buyer.depthWithinImpactUsd)})\n`,
  );
  if (plan.buyer.requestedSol > 0) {
    process.stdout.write(
      `Estimated base fee on the modeled fill: ${number(plan.buyer.estimatedBaseFeeSol, 6)} SOL (${money(plan.buyer.estimatedBaseFeeUsd)})\n`,
    );
  }
  process.stdout.write('Buyer capacity by maximum average impact:\n');
  for (const point of plan.buyer.averageImpactCapacity) {
    process.stdout.write(
      `  ${(point.maxAverageImpactBps / 100).toFixed(2)}%: ${number(point.maxOrderSol, 4)} SOL (${money(point.maxOrderUsd)})\n`,
    );
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      token: { type: 'string' },
      'token-decimals': { type: 'string' },
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
    buyerOrderSol = values['buyer-sol'] === undefined
      ? 0
      : numeric(values['buyer-sol'], 'buyer-sol');
  }

  const input: LaunchPlanInput = {
    tokenAmount: numeric(values.token, 'token'),
    tokenDecimals: numeric(values['token-decimals'], 'token-decimals'),
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
  const capacityAtRequestedImpact = (plan: InitialLiquidityLaunchPlan) =>
    plan.buyer.averageImpactCapacity.find(
      (point) => point.maxAverageImpactBps === input.maxBuyerImpactBps,
    )!.maxOrderSol;
  const deepest = [...plans].sort(
    (a, b) => capacityAtRequestedImpact(b) - capacityAtRequestedImpact(a),
  )[0]!;
  process.stdout.write(
    `Highest modeled order capacity at ${(input.maxBuyerImpactBps / 100).toFixed(2)}% average impact: ${deepest.distributionShape}/${deepest.fundedRange.totalBins} bins. ` +
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
