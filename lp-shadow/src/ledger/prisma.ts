/**
 * Prisma client. Prisma 7 takes the connection through a driver adapter rather
 * than a `url` in the schema, so the string lives in one place: DATABASE_URL.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

let client: PrismaClient | null = null;

export function getPrisma(databaseUrl: string): PrismaClient {
  if (client) return client;
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

export type { PrismaClient };
