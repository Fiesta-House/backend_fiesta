// Observability rollup: strategy mix, latency percentiles, fallback/breaker usage,
// escalations by type, and the daily series (GET /api/statistics/observability).
import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../config/prisma';
import { AnalyticsController } from './analytics.controller';

function stubResponse() {
  let body: any;
  const response = {
    status(code: number) { body = { error: `status ${code}` }; return response; },
    json(value: any) { body = value; return value; },
  } as any;
  return { response, result: () => body };
}

test('observability rolls up latency percentiles, strategy mix, fallbacks and escalations', async () => {
  const now = new Date();
  const originalMetrics = prisma.aiJobMetric.findMany;
  const originalEscalations = prisma.escalation.findMany;
  (prisma.aiJobMetric.findMany as any) = async () => [
    { createdAt: now, latencyMs: 100, success: true, isFallback: false, strategyUsed: 'greeting', circuitBreakerTrip: false, platform: 'whatsapp' },
    { createdAt: now, latencyMs: 200, success: true, isFallback: false, strategyUsed: 'runAgent', circuitBreakerTrip: false, platform: 'whatsapp' },
    { createdAt: now, latencyMs: 300, success: true, isFallback: false, strategyUsed: 'runAgent', circuitBreakerTrip: false, platform: 'instagram' },
    { createdAt: now, latencyMs: 400, success: false, isFallback: true, strategyUsed: 'runAgent', circuitBreakerTrip: false, platform: 'whatsapp' },
    { createdAt: now, latencyMs: 1000, success: false, isFallback: true, strategyUsed: 'circuitBreaker', circuitBreakerTrip: true, platform: 'whatsapp' },
    { createdAt: now, latencyMs: null, success: true, isFallback: false, strategyUsed: null, circuitBreakerTrip: false, platform: null },
  ];
  (prisma.escalation.findMany as any) = async () => [
    { escalationType: 'frustration', status: 'OPEN' },
    { escalationType: 'frustration', status: 'RESOLVED' },
    { escalationType: 'quota', status: 'OPEN' },
  ];

  const { response, result } = stubResponse();
  try {
    await new AnalyticsController().getObservability({ query: { days: '7' } } as any, response);
    const body = result();

    assert.deepEqual(body.window.days, 7);
    assert.deepEqual(body.jobs, {
      total: 6, failures: 2, fallbacks: 2, breakerTrips: 1, successRatePct: 66.67, fallbackRatePct: 33.33,
    });
    // nearest-rank percentiles over the 5 numeric latencies [100,200,300,400,1000]
    assert.deepEqual(body.latency, { avgMs: 400, p50Ms: 300, p95Ms: 1000, maxMs: 1000, sampleSize: 5 });

    assert.deepEqual(body.strategyMix, [
      { strategy: 'runAgent', count: 3, sharePct: 50, failures: 1, fallbacks: 1 },
      { strategy: 'greeting', count: 1, sharePct: 16.67, failures: 0, fallbacks: 0 },
      { strategy: 'circuitBreaker', count: 1, sharePct: 16.67, failures: 1, fallbacks: 1 },
      { strategy: 'untracked', count: 1, sharePct: 16.67, failures: 0, fallbacks: 0 },
    ]);
    assert.equal(body.strategyMix[0].count >= body.strategyMix[1].count, true, 'strategies sort by count desc');

    assert.deepEqual(body.byPlatform.find((row: any) => row.platform === 'whatsapp'), {
      platform: 'whatsapp', jobs: 4, fallbacks: 2, fallbackPct: 50, avgLatencyMs: 425,
    });
    assert.deepEqual(body.byPlatform.find((row: any) => row.platform === 'instagram'), {
      platform: 'instagram', jobs: 1, fallbacks: 0, fallbackPct: 0, avgLatencyMs: 300,
    });

    assert.deepEqual(body.escalations, {
      total: 3,
      open: 2,
      byType: [{ type: 'frustration', count: 2 }, { type: 'quota', count: 1 }],
    });

    assert.equal(body.daily.length, 7);
    assert.equal(body.daily.reduce((sum: number, day: any) => sum + day.jobs, 0), 6);
    assert.equal(body.daily.reduce((sum: number, day: any) => sum + day.fallbacks, 0), 2);
  } finally {
    prisma.aiJobMetric.findMany = originalMetrics;
    prisma.escalation.findMany = originalEscalations;
  }
});

test('observability handles an empty window without division errors', async () => {
  const originalMetrics = prisma.aiJobMetric.findMany;
  const originalEscalations = prisma.escalation.findMany;
  (prisma.aiJobMetric.findMany as any) = async () => [];
  (prisma.escalation.findMany as any) = async () => [];

  const { response, result } = stubResponse();
  try {
    await new AnalyticsController().getObservability({ query: {} } as any, response);
    const body = result();
    assert.equal(body.jobs.total, 0);
    assert.equal(body.jobs.successRatePct, 0);
    assert.deepEqual(body.strategyMix, []);
    assert.deepEqual(body.latency, { avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, sampleSize: 0 });
    assert.equal(body.daily.length, 7);
  } finally {
    prisma.aiJobMetric.findMany = originalMetrics;
    prisma.escalation.findMany = originalEscalations;
  }
});
