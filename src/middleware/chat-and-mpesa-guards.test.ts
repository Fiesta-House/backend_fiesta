import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_SESSION_HEADER, createChatSessionHandler, requireChatSession } from './chat-session';
import { mpesaCallbackGuard } from './mpesa-callback-guard';
import { issueChatSession } from '../services/auth/chat-session.service';

process.env.AUTH_JWT_SECRET = 'a'.repeat(40);

function fakeRes() {
  const res: any = { locals: {}, statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.sendStatus = (code: number) => { res.statusCode = code; return res; };
  return res;
}

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  }
  try { run(); } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

// ---- chat session ----

test('a session request returns a token and a server-generated customer id', () => {
  const res = fakeRes();
  createChatSessionHandler({} as any, res);
  assert.equal(res.statusCode, 201);
  assert.ok(res.body.session_token);
  assert.match(res.body.customer_id, /^web_[0-9a-f]{32}$/);
});

test('chat without a session token is rejected and never reaches the handler', () => {
  const res = fakeRes();
  let called = false;
  requireChatSession({ get: () => undefined } as any, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test('chat with a valid token exposes only the verified customer id', () => {
  const { token, customerId } = issueChatSession();
  const res = fakeRes();
  let called = false;
  const req: any = {
    body: { customerId: '254721840961' }, // a client-supplied id must be ignored
    get: (name: string) => (name.toLowerCase() === CHAT_SESSION_HEADER ? token : undefined),
  };
  requireChatSession(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.locals.chatCustomerId, customerId);
});

// ---- M-Pesa callback guard ----

const SECRET = 's'.repeat(32);

test('production with no secret configured refuses every callback', () => {
  withEnv({ MPESA_ENVIRONMENT: 'production', MPESA_CALLBACK_SECRET: undefined, MPESA_CALLBACK_ALLOWED_IPS: undefined }, () => {
    const res = fakeRes();
    let called = false;
    mpesaCallbackGuard({ params: {}, ip: '1.2.3.4' } as any, res, () => { called = true; });
    assert.equal(res.statusCode, 503);
    assert.equal(called, false);
  });
});

test('a callback with the wrong or missing secret is rejected', () => {
  withEnv({ MPESA_ENVIRONMENT: 'production', MPESA_CALLBACK_SECRET: SECRET, MPESA_CALLBACK_ALLOWED_IPS: undefined }, () => {
    for (const params of [{}, { secret: 'wrong' }, { secret: SECRET + 'x' }]) {
      const res = fakeRes();
      let called = false;
      mpesaCallbackGuard({ params, ip: '1.2.3.4' } as any, res, () => { called = true; });
      assert.equal(res.statusCode, 404);
      assert.equal(called, false);
    }
  });
});

test('a callback with the right secret is let through', () => {
  withEnv({ MPESA_ENVIRONMENT: 'production', MPESA_CALLBACK_SECRET: SECRET, MPESA_CALLBACK_ALLOWED_IPS: undefined }, () => {
    const res = fakeRes();
    let called = false;
    mpesaCallbackGuard({ params: { secret: SECRET }, ip: '1.2.3.4' } as any, res, () => { called = true; });
    assert.equal(called, true);
  });
});

test('when an IP allowlist is set, other addresses are refused even with the secret', () => {
  withEnv({ MPESA_ENVIRONMENT: 'production', MPESA_CALLBACK_SECRET: SECRET, MPESA_CALLBACK_ALLOWED_IPS: '10.0.0.1, 10.0.0.2' }, () => {
    const blocked = fakeRes();
    let blockedCalled = false;
    mpesaCallbackGuard({ params: { secret: SECRET }, ip: '9.9.9.9' } as any, blocked, () => { blockedCalled = true; });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blockedCalled, false);

    const allowed = fakeRes();
    let allowedCalled = false;
    mpesaCallbackGuard({ params: { secret: SECRET }, ip: '::ffff:10.0.0.2' } as any, allowed, () => { allowedCalled = true; });
    assert.equal(allowedCalled, true);
  });
});

test('outside production an unset secret still lets sandbox callbacks through', () => {
  withEnv({ MPESA_ENVIRONMENT: 'sandbox', NODE_ENV: 'development', MPESA_CALLBACK_SECRET: undefined, MPESA_CALLBACK_ALLOWED_IPS: undefined }, () => {
    const res = fakeRes();
    let called = false;
    mpesaCallbackGuard({ params: {}, ip: '1.2.3.4' } as any, res, () => { called = true; });
    assert.equal(called, true);
  });
});
