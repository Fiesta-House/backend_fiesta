import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../config/prisma';
import { AnalyticsController } from './analytics.controller';

test('model usage separates providers and records failed requests without tokens', async () => {
  const originalFindMany = prisma.aiModelUsage.findMany;
  const originalAggregate = prisma.customer.aggregate;
  const originalCustomerFindMany = prisma.customer.findMany;
  const now = new Date();
  (prisma.aiModelUsage.findMany as any) = async () => [
    { createdAt: now, provider: 'gemini', model: 'gemini-2.5-flash', inputTokens: 30, outputTokens: 12, totalTokens: 42, status: 'success', failover: true, errorCode: null },
    { createdAt: now, provider: 'groq', model: 'openai/gpt-oss-20b', inputTokens: 0, outputTokens: 0, totalTokens: 0, status: 'failed', failover: false, errorCode: '429' },
    { createdAt: now, provider: 'groq', model: 'openai/gpt-oss-20b', inputTokens: 20, outputTokens: 8, totalTokens: 28, status: 'success', failover: false, errorCode: null },
    { createdAt: now, provider: 'groq2', model: 'openai/gpt-oss-20b', inputTokens: 9, outputTokens: 3, totalTokens: 12, status: 'success', failover: true, errorCode: null },
    { createdAt: now, provider: 'gemini2', model: 'gemini-2.5-flash', inputTokens: 5, outputTokens: 2, totalTokens: 7, status: 'success', failover: true, errorCode: null },
  ];
  (prisma.customer.aggregate as any) = async () => ({ _sum: { totalTokensUsed: 2095943 } });
  (prisma.customer.findMany as any) = async () => [
    { id: 'one', name: 'Joan', totalTokensUsed: 120, dailyTokenUsage: 30, tokenResetDate: now },
    { id: 'two', name: 'Sharon', totalTokensUsed: 80, dailyTokenUsage: 18, tokenResetDate: new Date(now.getTime() - 2 * 86400_000) },
  ];
  let result: any;
  const response = { json: (value: any) => { result = value; return value; } } as any;
  try {
    await new AnalyticsController().getModelUsage({ query: { days: '7' } } as any, response);
    assert.deepEqual(result.summary, {
      groq: { inputTokens: 20, outputTokens: 8, totalTokens: 28, calls: 2, failures: 1 },
      groq2: { inputTokens: 9, outputTokens: 3, totalTokens: 12, calls: 1, failures: 0 },
      gemini: { inputTokens: 30, outputTokens: 12, totalTokens: 42, calls: 1, failures: 0 },
      gemini2: { inputTokens: 5, outputTokens: 2, totalTokens: 7, calls: 1, failures: 0 },
    });
    assert.equal(result.allTimeTokens, 2095943);
    assert.deepEqual(result.customerUsage, [
      { id: 'one', name: 'Joan', totalTokens: 120, todayTokens: 30 },
      { id: 'two', name: 'Sharon', totalTokens: 80, todayTokens: 0 },
    ]);
    assert.equal(result.daily.length, 7);
    assert.equal(result.daily.at(-1).groq, 28);
    assert.equal(result.daily.at(-1).groq2, 12);
    assert.equal(result.daily.at(-1).gemini, 42);
    assert.equal(result.daily.at(-1).gemini2, 7);
    assert.equal(result.recent[0].failover, true);
    assert.equal(result.groqCooldownUntil, null);
  } finally {
    prisma.aiModelUsage.findMany = originalFindMany;
    prisma.customer.aggregate = originalAggregate;
    prisma.customer.findMany = originalCustomerFindMany;
  }
});