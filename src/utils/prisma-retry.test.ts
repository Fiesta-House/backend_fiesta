import assert from 'node:assert/strict';
import test from 'node:test';
import { retryOnPrismaDisconnect } from './prisma-retry';

test('reconnects once and retries a read after Prisma P1017', async () => {
  let disconnects = 0;
  let connects = 0;
  let attempts = 0;
  const prisma = {
    $disconnect: async () => { disconnects++; },
    $connect: async () => { connects++; },
  };

  const result = await retryOnPrismaDisconnect(prisma, async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('connection closed'), { code: 'P1017' });
    return 'read succeeded';
  });

  assert.equal(result, 'read succeeded');
  assert.equal(attempts, 2);
  assert.equal(disconnects, 1);
  assert.equal(connects, 1);
});

test('does not retry unrelated Prisma errors', async () => {
  let attempts = 0;
  let reconnects = 0;
  const prisma = {
    $disconnect: async () => { reconnects++; },
    $connect: async () => { reconnects++; },
  };
  const error = Object.assign(new Error('record missing'), { code: 'P2025' });

  await assert.rejects(retryOnPrismaDisconnect(prisma, async () => {
    attempts++;
    throw error;
  }), error);

  assert.equal(attempts, 1);
  assert.equal(reconnects, 0);
});