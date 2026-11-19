// Phase 2: respond() logs each turn in the background without blocking or crashing the reply.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentService } from './agent.service';
import { SCHEMA_MAINTENANCE_REPLY } from '../../config/schema-readiness';

const PAYMENT_PROPOSAL = {
  role: 'assistant' as const,
  content: "Great, I can hold THE ICON for 2026-10-10 at 15:00. The deposit is KSH 2000. If that works for you, just reply yes and I'll send the M-Pesa prompt.",
};

const settle = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

function createAgent(overrides: Record<string, unknown> = {}) {
  const metrics: any[] = [];
  const learnings: any[] = [];
  const agent = new AgentService() as any;
  Object.assign(agent, {
    checkTokenBudget: async () => true,
    decorateTemplateEmoji: async (_customer: string, _platform: string, reply: string) => reply,
    getBookingProgressReply: async () => null,
    trackSentiment: async () => {},
    escalate: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    runAgent: async () => ({ content: 'LLM reply', tokensUsed: 0 }),
    logAiJobMetric: async (data: any) => { metrics.push(data); },
    logConversationLearning: async (data: any) => { learnings.push(data); },
    ...overrides,
  });
  return { agent, metrics, learnings };
}

test('missing-column failures alert schema mismatch instead of suggesting a retry', async (context) => {
  const alerts: any[] = [];
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  context.after(() => { console.error = originalError; });
  const error = { code: 'P2022', message: 'connection details must never be logged', meta: { modelName: 'BookingDraft', column: 'booking_drafts.cancelProposedAt' } };
  const { agent, metrics } = createAgent({
    runAgent: async () => { throw error; },
    escalate: async (_customer: string, _type: string, description: string) => { alerts.push(JSON.parse(description)); },
  });
  const first = await agent.handleMessage('schema-customer', 'can I exchange my outfit', [], 'whatsapp');
  const second = await agent.handleMessage('schema-customer', 'Hello again', [], 'whatsapp');
  await settle();
  assert.equal(first, SCHEMA_MAINTENANCE_REPLY);
  assert.equal(second, SCHEMA_MAINTENANCE_REPLY);
  assert.doesNotMatch(first, /try again|cancelProposedAt|P2022/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'database_schema_out_of_date');
  assert.equal(alerts[0].column, 'booking_drafts.cancelProposedAt');
  assert.equal(alerts[0].customerMessage, 'can I exchange my outfit');
  assert.ok(metrics.every((metric) => metric.failureReason === 'database_schema_out_of_date'));
  assert.match(logged.join('\n'), /SCHEMA_OUT_OF_DATE/);
  assert.doesNotMatch(logged.join('\n'), /connection details must never be logged/);
});

test('schema mismatch in draft pre-guard or slot capture uses the same maintenance path', async () => {
  const error = { code: 'P2022', meta: { modelName: 'BookingDraft', column: 'booking_drafts.cancelProposedAt' } };
  for (const boundary of ['clearStaleCancellationDraftBeforeRouting', 'rememberBookingSlots', 'tryImmediateConfirmation']) {
    const alerts: unknown[] = [];
    const { agent, metrics } = createAgent({
      [boundary]: async () => { throw error; },
      runAgent: async () => { assert.fail('schema failure must stop before provider work'); },
      escalate: async (_customer: string, _type: string, description: string) => { alerts.push(JSON.parse(description)); },
    });
    const confirming = boundary === 'tryImmediateConfirmation';
    const message = confirming
    ? 'yes'
    : boundary === 'rememberBookingSlots'
      ? 'I would like to book a maternity session'
      : 'Hello';
  const reply = await agent.handleMessage('schema-boundary', message, confirming ? [PAYMENT_PROPOSAL] : [], 'whatsapp');
    await settle();
    assert.equal(reply, SCHEMA_MAINTENANCE_REPLY);
    assert.equal(alerts.length, 1);
    assert.equal(metrics[0].failureReason, 'database_schema_out_of_date');
  }
});

test('the reply is returned without waiting for logging to finish', async () => {
  const { agent } = createAgent({
    logAiJobMetric: () => new Promise(() => {}),
    logConversationLearning: () => new Promise(() => {}),
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('reply was blocked by logging')), 1000));
  const reply = await Promise.race([agent.handleMessage('customer-1', 'thanks', [], 'whatsapp'), timeout]);
  assert.match(reply as string, /You are welcome/);
});

test('logging failures (sync throw or rejection) never reach the caller or become unhandled rejections', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (message: string) => { logged.push(String(message)); };

  const { agent } = createAgent({
    logAiJobMetric: () => { throw new Error('metric table locked'); },
    logConversationLearning: async () => { throw new Error('learning insert failed'); },
  });

  try {
    const reply = await agent.handleMessage('customer-1', 'thanks', [], 'whatsapp');
    assert.match(reply, /You are welcome/);
    await settle();
    assert.deepEqual(unhandled, []);
    assert.ok(logged.some((line) => /Failed to log AI job metric/.test(line)));
    assert.ok(logged.some((line) => /Failed to log conversation learning/.test(line)));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    console.error = originalError;
  }
});

test('a successful deterministic reply records the same metric and learning fields as before', async () => {
  const { agent, metrics, learnings } = createAgent();
  const reply = await agent.handleMessage('customer-1', 'thanks', [], 'whatsapp');
  await settle();

  assert.equal(metrics.length, 1);
  assert.deepEqual(Object.keys(metrics[0]).sort(), ['customerId', 'latencyMs', 'platform', 'strategyUsed', 'success']);
  assert.equal(metrics[0].success, true);
  assert.equal(typeof metrics[0].strategyUsed, 'string');
  assert.ok(metrics[0].strategyUsed.length > 0, 'every reply must record the layer that produced it');
  assert.equal(typeof metrics[0].latencyMs, 'number');
  assert.deepEqual(
    { ...learnings[0], latencyMs: 0 },
    { customerId: 'customer-1', userMessage: 'thanks', aiResponse: reply, platform: 'whatsapp', latencyMs: 0, wasSuccessful: true, isFallback: false }
  );
});

test('a failed quick confirmation records a fallback with the failure reason', async () => {
  const { agent, metrics, learnings } = createAgent({
    tryImmediateConfirmation: async () => { throw new Error('db down'); },
  });
  await agent.handleMessage('customer-1', 'yes', [PAYMENT_PROPOSAL], 'whatsapp');
  await settle();

  assert.equal(metrics[0].success, false);
  assert.equal(metrics[0].isFallback, true);
  assert.equal(metrics[0].failureReason, 'db down');
  assert.equal(learnings[0].wasSuccessful, false);
  assert.equal(learnings[0].isFallback, true);
});

test('an LLM reply with a failure type is logged as a fallback', async () => {
  const { agent, metrics, learnings } = createAgent({
    runAgent: async () => ({ content: 'Sorry, I lost the thread there.', tokensUsed: 0, failureType: 'empty_model_response' }),
  });
  const reply = await agent.handleMessage('customer-1', 'can I exchange my outfit', [], 'whatsapp');
  await settle();

  assert.equal(reply, 'Sorry, I lost the thread there.');
  assert.equal(metrics[0].failureReason, 'empty_model_response');
  assert.equal(metrics[0].isFallback, true);
  assert.equal(learnings[0].isFallback, true);
});

test('a provider failure is logged as a fallback with the failure reason', async () => {
  const { agent, metrics } = createAgent({
    runAgent: async () => { throw Object.assign(new Error('tokens per day (TPD) limit reached'), { status: 429, code: 'rate_limit_exceeded' }); },
  });
  await agent.handleMessage('customer-1', 'can I exchange my outfit', [], 'whatsapp');
  await settle();

  assert.equal(metrics[0].success, false);
  assert.equal(metrics[0].isFallback, true);
  assert.ok(metrics[0].failureReason);
});
