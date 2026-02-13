import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function initDatabase(): Promise<void> {
  await prisma.$connect();
}

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
}
