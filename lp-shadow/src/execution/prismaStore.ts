import type { PrismaClient } from '../generated/prisma/client.js';
import type { InputJsonValue, TransactionClient } from '../generated/prisma/internal/prismaNamespace.js';
import type {
  ExecutionRequest,
  ExecutionStore,
  StoredIntent,
  StoredOutcome,
} from './types.js';

const COUNTED_NOTIONAL_STATUSES = ['SENT', 'CONFIRMED', 'FINALIZED', 'RECONCILED', 'UNKNOWN', 'STUCK'];

function intentDto(row: {
  id: string;
  projectWalletId: string;
  idempotencyKey: string;
  action: string;
  notionalSol: { toString(): string };
  status: string;
}): StoredIntent {
  return { ...row, notionalSol: Number(row.notionalSol.toString()) };
}

export class PrismaExecutionStore implements ExecutionStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly db: TransactionClient = prisma,
  ) {}

  async isKillSwitchEnabled(): Promise<boolean> {
    const row = await this.db.keyValue.findUnique({
      where: { scope_key: { scope: 'global', key: 'execution.kill_switch' } },
      select: { value: true },
    });
    if (!row) return false;
    if (typeof row.value === 'boolean') return row.value;
    return Boolean(
      row.value && typeof row.value === 'object' && !Array.isArray(row.value) && row.value.enabled === true,
    );
  }

  async withProjectLock<T>(
    projectWalletId: string,
    work: (lockedStore: ExecutionStore) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (transaction) => {
        const [row] = await transaction.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${projectWalletId}, 0)) AS acquired
        `;
        if (!row?.acquired) throw new Error(`executor lock contention for project ${projectWalletId}`);
        return work(new PrismaExecutionStore(this.prisma, transaction));
      },
      { maxWait: 10_000, timeout: 300_000 },
    );
  }

  async findIntent(idempotencyKey: string): Promise<StoredIntent | null> {
    const row = await this.db.executionIntent.findUnique({ where: { idempotencyKey } });
    return row ? intentDto(row) : null;
  }

  async createIntent(request: ExecutionRequest): Promise<StoredIntent> {
    const row = await this.db.executionIntent.create({
      data: {
        projectWalletId: request.projectWalletId,
        managedPoolId: request.managedPoolId,
        decisionId: request.decisionId,
        idempotencyKey: request.idempotencyKey,
        action: request.action,
        notionalSol: request.notionalSol.toFixed(18),
        status: 'RECORDED',
        detailJson: request.detail as InputJsonValue | undefined,
      },
    });
    return intentDto(row);
  }

  async rollingNotionalSol(
    projectWalletId: string,
    since: Date,
    excludeIntentId?: string,
  ): Promise<{ projectSol: number; globalSol: number }> {
    const baseWhere = {
      createdAt: { gte: since },
      status: { in: COUNTED_NOTIONAL_STATUSES },
      ...(excludeIntentId ? { id: { not: excludeIntentId } } : {}),
    };
    const [project, global] = await Promise.all([
      this.db.executionIntent.aggregate({
        where: { ...baseWhere, projectWalletId },
        _sum: { notionalSol: true },
      }),
      this.db.executionIntent.aggregate({ where: baseWhere, _sum: { notionalSol: true } }),
    ]);
    return {
      projectSol: Number(project._sum.notionalSol?.toString() ?? 0),
      globalSol: Number(global._sum.notionalSol?.toString() ?? 0),
    };
  }

  async countOutcomes(intentId: string): Promise<number> {
    return this.db.executionOutcome.count({ where: { intentId } });
  }

  async createOutcome(
    intentId: string,
    attempt: number,
    status: string,
    signature?: string,
  ): Promise<StoredOutcome> {
    return this.db.executionOutcome.create({
      data: { intentId, attempt, status, signature },
      select: { id: true, status: true, signature: true },
    });
  }

  async updateOutcome(
    id: bigint,
    status: string,
    detail: { chainState?: Record<string, unknown>; errorMessage?: string; finalizedAt?: Date } = {},
  ): Promise<void> {
    await this.db.executionOutcome.update({
      where: { id },
      data: {
        status,
        chainStateJson: detail.chainState as InputJsonValue | undefined,
        errorMessage: detail.errorMessage,
        finalizedAt: detail.finalizedAt,
      },
    });
  }

  async updateIntent(id: string, status: string): Promise<void> {
    await this.db.executionIntent.update({ where: { id }, data: { status } });
  }
}
