// Harness self-tests: golden-set validation, expectation scoring, and a handful
// of real offline end-to-end runs through AgentService routing.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OFFLINE_DATABASE_URL,
  OFFLINE_LLM_MARKER,
  createOfflineAgent,
  evaluateExpectation,
  loadGoldenSet,
  runCase,
  validateGoldenSet,
  type EvalAgentHandle,
  type GoldenCase,
} from './harness';

test('the shipped golden set loads and is structurally valid', () => {
  const cases = loadGoldenSet();
  assert.ok(cases.length >= 8, 'expected at least 8 golden cases');
  const ids = cases.map((kase) => kase.id);
  assert.equal(new Set(ids).size, ids.length, 'case ids must be unique');
  for (const kase of cases) {
    assert.deepEqual(validateGoldenSet([kase]), [], kase.id);
  }
});

test('validateGoldenSet reports duplicate ids, unknown expectations and missing fields', () => {
  const errors = validateGoldenSet([
    { id: 'dup', category: 'a', message: 'hi', expect: { strategy: 'greeting' } },
    { id: 'dup', category: 'a', message: 'hi', expect: { strategy: 'greeting' } },
    { id: 'bad-expect', category: 'a', message: 'hi', expect: { madeUpKey: true } },
    { id: 'no-message', category: 'a', expect: { strategy: 'greeting' } },
    { id: 'skipped-quietly', category: 'a', message: 'hi', skip: true, expect: { strategy: 'greeting' } },
  ]);
  assert.ok(errors.some((e) => e.includes('duplicate case id "dup"')));
  assert.ok(errors.some((e) => e.includes('unknown expectation "madeUpKey"')));
  assert.ok(errors.some((e) => e.includes('"no-message" is missing a message')));
  assert.ok(errors.some((e) => e.includes('"skipped-quietly" is skipped without a skipReason')));
});

test('evaluateExpectation passes on matching observations and names each mismatch', () => {
  const observed = { reply: 'We are open Tuesday to Sunday.', strategy: 'openingHours', reachedLlm: false, escalations: [] };
  assert.deepEqual(evaluateExpectation({
    strategy: 'openingHours', reachesLlm: false, contains: ['Tuesday'], notContains: ['fallback'],
  }, observed), []);

  const failures = evaluateExpectation({
    strategy: 'greeting', reachesLlm: true, contains: ['Monday'], notContains: ['Sunday'], forbidMatches: ['open'],
  }, observed);
  const checks = failures.map((failure) => failure.check).sort();
  assert.deepEqual(checks, ['contains', 'forbidMatches', 'notContains', 'reachesLlm', 'strategy']);
});

function caseOf(id: string, expect: GoldenCase['expect'], overrides: Partial<GoldenCase> = {}): GoldenCase {
  return { id, category: 'unit', message: 'Hello', expect, ...overrides };
}

test('offline end-to-end: deterministic routes answer without the model layer', async () => {
  const handle = createOfflineAgent();
  try {
    const greeting = await runCase(handle, caseOf('unit-greeting', {
      reachesLlm: false, notStrategies: ['noMatchingRoute', 'circuitBreaker'],
    }), 'offline');
    assert.equal(greeting.error, undefined, greeting.error);
    assert.equal(greeting.pass, true, JSON.stringify(greeting.failures));
    assert.equal(greeting.reachedLlm, false);
    assert.ok(greeting.strategy && greeting.strategy !== 'runAgent', `strategy=${greeting.strategy}`);

    const hours = await runCase(handle, caseOf('unit-opening-hours', {
      strategy: 'openingHours', reachesLlm: false, contains: ['Tuesday to Sunday'],
    }, { message: 'What are your opening hours?' }), 'offline');
    assert.equal(hours.pass, true, JSON.stringify(hours.failures));
  } finally {
    process.env.DATABASE_URL = OFFLINE_DATABASE_URL;
  }
});

test('offline end-to-end: an off-topic question is redirected without the model layer', async () => {
  const handle = createOfflineAgent();
  const result = await runCase(handle, caseOf('unit-off-topic', {
    strategy: 'scopeBoundary', reachesLlm: false, contains: ['Fiesta House'],
  }, { message: 'What is the capital of France?' }), 'offline');
  assert.equal(result.pass, true, JSON.stringify(result.failures));
  assert.equal(result.reachedLlm, false);
});

test('offline end-to-end: the LLM layer is detected when routing falls through to runAgent', async () => {
  const handle = createOfflineAgent();
  const result = await runCase(handle, caseOf('unit-llm-fallthrough', {
    reachesLlm: true, equals: OFFLINE_LLM_MARKER,
  }, { message: 'Tell me something I have never heard about cloud formation patterns in the Andes' }), 'offline');
  assert.equal(result.reachedLlm, true, JSON.stringify(result.failures));
  assert.equal(result.strategy, 'runAgent');
});

test('offline end-to-end: an open circuit breaker short-circuits to the fallback and closes again', async () => {
  const handle: EvalAgentHandle = createOfflineAgent();
  const tripped = await runCase(handle, caseOf('unit-breaker', {
    strategy: 'circuitBreaker', reachesLlm: false,
  }, { setup: 'tripCircuitBreaker' }), 'offline');
  assert.equal(tripped.pass, true, JSON.stringify(tripped.failures));

  // The harness resets the breaker afterwards, so the next turn routes normally.
  const after = await runCase(handle, caseOf('unit-after-breaker', {
    reachesLlm: false, notStrategies: ['circuitBreaker', 'noMatchingRoute'],
  }), 'offline');
  assert.equal(after.pass, true, JSON.stringify(after.failures));
});

test('offline runs pin the database to an unreachable address', () => {
  createOfflineAgent();
  assert.equal(process.env.DATABASE_URL, OFFLINE_DATABASE_URL);
});
