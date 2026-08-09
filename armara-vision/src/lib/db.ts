import { PrismaClient } from "@prisma/client";

// Singleton across hot reloads / serverless invocations in the same runtime.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
