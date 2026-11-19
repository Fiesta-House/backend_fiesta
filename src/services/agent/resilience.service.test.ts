import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { scoreSentiment, circuitBreaker, classifyProviderRateLimit, FALLBACK_MESSAGE, PROVIDER_OUTAGE_MESSAGE } from './resilience.service';
import { BUDGET_HANDOFF_REPLY } from './constants';
import { createSchemaAlertLimiter, DatabaseSchemaOutOfDateError, safeSchemaDetails, verifyBookingDraftSchema } from '../../config/schema-readiness';

test('service and circuit fallbacks use the approved neutral handoff', () => {
  assert.equal(FALLBACK_MESSAGE, BUDGET_HANDOFF_REPLY);
  assert.equal(PROVIDER_OUTAGE_MESSAGE, BUDGET_HANDOFF_REPLY);
  assert.doesNotMatch(FALLBACK_MESSAGE, /daily|limit|quota|reset|AI service/i);
});

function isolatedMpesa(environment = 'sandbox', key = 'fake-key', secret = 'fake-secret') {
  const file = path.join(__dirname, '../payment/mpesa.service.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(ts.isClassDeclaration)!;
  const script = ts.transpileModule(`${declaration.getText(source)}\nnew MpesaService();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const calls: { url: string; config: any }[] = [];
  const logs: unknown[][] = [];
  const http = { get: async (url: string, config: any): Promise<any> => {
    calls.push({ url, config });
    return { data: { access_token: 'fake-token', expires_in: '3600' } };
  } };
  const service = new vm.Script(script).runInNewContext({
    exports: {}, axios: { create: () => http }, Buffer,
    ENVIRONMENT: environment, CONSUMER_KEY: key, CONSUMER_SECRET: secret, PASSKEY: 'fake-passkey', BASE_URL: 'https://unused.invalid',
    console: { error: (...args: unknown[]) => logs.push(args) },
  });
  return { service, http, calls, logs };
}

test('M-Pesa OAuth uses Basic key:secret, client_credentials and a cached token', async () => {
  const { service, calls } = isolatedMpesa();
  assert.equal(await service.getAccessToken(), 'fake-token');
  assert.equal(await service.getAccessToken(), 'fake-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/oauth/v1/generate?grant_type=client_credentials');
  assert.equal(calls[0].config.headers.Authorization, `Basic ${Buffer.from('fake-key:fake-secret').toString('base64')}`);
});

test('M-Pesa rejects invalid environment, missing and malformed OAuth credentials before HTTP', async () => {
  for (const args of [['live'], ['Production'], ['sandbox', ''], ['sandbox', ' fake-key'], ['sandbox', 'fake-key', '"fake-secret"']]) {
    const { service, calls } = isolatedMpesa(...args);
    await assert.rejects(service.getAccessToken(), /MPESA_ENVIRONMENT|credentials/);
    assert.equal(calls.length, 0);
  }
});

test('M-Pesa OAuth failure logs bounded Daraja diagnostics without secrets or arbitrary response fields', async () => {
  const { service, http, logs } = isolatedMpesa();
  const encoded = Buffer.from('fake-key:fake-secret').toString('base64');
  http.get = async () => { throw { response: { status: 400, data: {
    errorCode: 'invalid_client', errorMessage: `Wrong app fake-key fake-secret fake-passkey ${encoded}\n${'x'.repeat(700)}`,
    access_token: 'must-not-log-token', headers: { Authorization: encoded },
  } }, message: 'must-not-log-request' }; };
  await assert.rejects(service.getAccessToken(), /Failed to authenticate/);
  const output = JSON.stringify(logs);
  assert.match(output, /invalid_client/);
  assert.match(output, /400/);
  assert.doesNotMatch(output, /fake-key|fake-secret|fake-passkey|must-not-log/);
  assert.equal(output.includes(encoded), false);
  assert.ok((logs[0][1] as any).errorMessage.length <= 500);
});

test('M-Pesa reports empty, plain-text and nested Daraja faults safely', async () => {
  for (const body of ['', 'Invalid client fake-secret', { fault: { faultstring: 'Invalid client fake-key', detail: { errorcode: 'invalid_client' } } }]) {
    const { service, http, logs } = isolatedMpesa();
    http.get = async () => { throw { response: { status: 400, data: body } }; };
    await assert.rejects(service.getAccessToken(), /Failed to authenticate/);
    const output = JSON.stringify(logs);
    assert.match(output, /empty response body|Invalid client/);
    assert.doesNotMatch(output, /fake-key|fake-secret/);
  }
});

test('startup schema probe rejects P2022 safely even when no booking drafts exist', async () => {
  let calls = 0;
  await verifyBookingDraftSchema({ bookingDraft: { findFirst: async ({ select }) => {
    calls++;
    assert.deepEqual(select, { id: true, cancelProposedAt: true });
    return null;
  } } });
  assert.equal(calls, 1);
  await assert.rejects(verifyBookingDraftSchema({ bookingDraft: { findFirst: async () => {
    throw { code: 'P2022', message: 'unsafe connection details must not escape', meta: { modelName: 'BookingDraft', column: 'booking_drafts.cancelProposedAt' } };
  } } }), (error: unknown) => {
    assert.ok(error instanceof DatabaseSchemaOutOfDateError);
    assert.equal(error.code, 'SCHEMA_OUT_OF_DATE');
    assert.equal(error.details.column, 'booking_drafts.cancelProposedAt');
    assert.doesNotMatch(error.message, /unsafe connection/);
    return true;
  });
  assert.deepEqual(safeSchemaDetails({ code: 'P2022', meta: { column: 'postgres://private-data' } }).column, null);
});

test('schema alerts use a bounded process cooldown rather than flooding every message', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 });
  const notify = createSchemaAlertLimiter();
  assert.equal(notify(), true);
  assert.equal(notify(), false);
  context.mock.timers.tick(10 * 60_000);
  assert.equal(notify(), true);
});

test('actual startup functions refuse listener and cron before database readiness', async () => {
  const file = path.join(__dirname, '../../../app.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(ts.isFunctionDeclaration)
    .filter((node) => ['checkDatabaseConnection', 'startBackend'].includes(node.name?.text || ''));
  assert.equal(functions.length, 2);
  const script = ts.transpileModule(`${functions.map((node) => node.getText(source)).join('\n')}\nstartBackend();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const code of [null, 'P2022', 'P1001']) {
    const calls: string[] = [];
    const log: string[] = [];
    const processState = { exitCode: 0 };
    const client = {
      $connect: async () => { calls.push('connect'); if (code === 'P1001') throw { code, message: 'unsafe connection string' }; },
      $disconnect: async () => { calls.push('disconnect'); },
      bookingDraft: { findFirst: async () => { calls.push('probe'); if (code === 'P2022') throw { code, meta: { column: 'booking_drafts.cancelProposedAt' }, message: 'unsafe connection string' }; return null; } },
    };
    await new vm.Script(script).runInNewContext({
      prisma: client, verifyBookingDraftSchema, DatabaseSchemaOutOfDateError, safeSchemaDetails,
      httpServer: { listen: (_port: unknown, ready: () => void) => { calls.push('listen'); ready(); } },
      cronService: { init: () => { calls.push('cron'); } },
      knowledgeRetrieval: { initEmbedder: async () => { calls.push('embedder'); } },
      PORT: 4000, process: processState,
      console: { log: () => {}, warn: () => {}, error: (...args: unknown[]) => { log.push(args.join(' ')); } },
    }, { timeout: 1000 });
    if (code) {
      assert.equal(processState.exitCode, 1);
      assert.equal(calls.includes('listen'), false);
      assert.equal(calls.includes('cron'), false);
      assert.equal(calls.includes('embedder'), false);
      assert.equal(calls.includes('disconnect'), true);
      assert.doesNotMatch(log.join('\n'), /unsafe connection string/);
      if (code === 'P1001') assert.match(log.join('\n'), /"prismaCode":"P1001"/);
    } else {
      assert.deepEqual(calls, ['connect', 'probe', 'listen', 'cron', 'embedder']);
    }
  }
});

test('classifies a Groq daily TPD response without treating it as retryable work', () => {
  const error = {
    status: 429,
    code: 'rate_limit_exceeded',
    message: 'Rate limit reached on tokens per day (TPD). Limit: 200000. Used: 198975.',
  };

  assert.equal(classifyProviderRateLimit(error), 'daily_tpd_exhausted');
});

test('classifies other provider 429 responses separately from daily TPD exhaustion', () => {
  assert.equal(classifyProviderRateLimit({ status: 429, code: 'rate_limit_exceeded', message: 'Too many requests' }), 'transient_rate_limit');
});

test('scoreSentiment: neutral message scores non-negative', () => {
  const { score, sentiment } = scoreSentiment('What time do you open?');
  assert.ok(score >= 0, `expected non-negative score, got ${score}`);
  assert.equal(sentiment, 'neutral');
});

test('scoreSentiment: strong negative keyword scores very negative', () => {
  const { score, sentiment } = scoreSentiment('This is a total scam, I want a refund');
  assert.ok(score <= -0.6, `expected score <= -0.6, got ${score}`);
  assert.equal(sentiment, 'very_negative');
});

test('scoreSentiment: mild negative keyword scores negative but not very_negative', () => {
  const { score, sentiment } = scoreSentiment('I am a bit disappointed with the wait');
  assert.ok(score < 0 && score > -0.6, `expected mild negative score, got ${score}`);
  assert.equal(sentiment, 'negative');
});

test('scoreSentiment: excessive exclamation marks and all-caps push the score down', () => {
  const { score } = scoreSentiment('THIS IS RIDICULOUS WHY HASNT ANYONE REPLIED YET');
  assert.ok(score < 0, `expected a negative score from caps + ridiculous keyword, got ${score}`);
});

test('scoreSentiment: positive keyword scores positive', () => {
  const { score, sentiment } = scoreSentiment('Thank you so much, I love the photos!');
  assert.ok(score > 0, `expected a positive score, got ${score}`);
  assert.ok(sentiment === 'positive' || sentiment === 'very_positive', `expected positive sentiment, got ${sentiment}`);
});

test('scoreSentiment: enthusiastic punctuation on a positive message is not punished as frustration', () => {
  const { score, sentiment } = scoreSentiment('Thank you so much!!! This is amazing!!!');
  assert.ok(score > 0, `enthusiastic exclamation marks on positive text should not flip the score negative, got ${score}`);
  assert.notEqual(sentiment, 'negative');
  assert.notEqual(sentiment, 'very_negative');
});

test('scoreSentiment: Swahili frustration terms are flagged', () => {
  assert.equal(scoreSentiment('Nimechoka kuwaita, hamjibu').sentiment, 'very_negative');
  assert.equal(scoreSentiment('Mnadanganya, utapeli').sentiment, 'very_negative');
  assert.equal(scoreSentiment('Sijajibiwa').sentiment, 'negative');
});

test('circuitBreaker: stays closed below the failure threshold', () => {
  circuitBreaker.recordSuccess(); // reset any state left over from other tests
  assert.equal(circuitBreaker.isOpen(), false);
  circuitBreaker.recordFailure();
  circuitBreaker.recordFailure();
  assert.equal(circuitBreaker.isOpen(), false, 'should not trip after only 2 failures (threshold is 3)');
});

test('circuitBreaker: trips after reaching the failure threshold and blocks calls', () => {
  circuitBreaker.recordSuccess(); // reset
  circuitBreaker.recordFailure();
  circuitBreaker.recordFailure();
  const trippedOnThird = circuitBreaker.recordFailure();
  assert.equal(trippedOnThird, true, 'the third consecutive failure should report that it just tripped the breaker');
  assert.equal(circuitBreaker.isOpen(), true, 'breaker should be open immediately after tripping');
});

test('circuitBreaker: a success resets the failure count', () => {
  circuitBreaker.recordSuccess(); // reset
  circuitBreaker.recordFailure();
  circuitBreaker.recordFailure();
  circuitBreaker.recordSuccess();
  circuitBreaker.recordFailure();
  circuitBreaker.recordFailure();
  assert.equal(circuitBreaker.isOpen(), false, 'failure count should have reset after the success, so two more failures should not trip it');
});
