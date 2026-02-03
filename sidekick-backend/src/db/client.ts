import { PrismaClient } from '@prisma/client';

/**
 * Prisma Client instance
 * 
 * Singleton pattern - use this instance throughout the application.
 * Automatically handles connection pooling and query optimization.
 */
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

/**
 * Gracefully disconnect Prisma on application shutdown
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
