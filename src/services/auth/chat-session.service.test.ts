import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_SESSION_TTL_MS,
  issueChatSession,
  verifyChatSession,
  WEB_CHAT_ID_PREFIX,
} from './chat-session.service';

process.env.AUTH_JWT_SECRET = 'a'.repeat(40);
delete process.env.CHAT_SESSION_SECRET;

test('an issued session verifies and carries a server-generated web id', () => {
  const issued = issueChatSession();
  assert.ok(issued.customerId.startsWith(WEB_CHAT_ID_PREFIX));
  assert.deepEqual(verifyChatSession(issued.token), {
    customerId: issued.customerId,
    expiresAt: issued.expiresAt,
  });
});

test('every session gets a different identity', () => {
  assert.notEqual(issueChatSession().customerId, issueChatSession().customerId);
});

test('a tampered payload is rejected', () => {
  const { token } = issueChatSession();
  const [, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sid: 'web_' + '0'.repeat(32), exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifyChatSession(`${forged}.${signature}`), null);
});

test('a customer id that is not a web id cannot be smuggled in, even with a valid signature shape', () => {
  const { token } = issueChatSession();
  const [payload] = token.split('.');
  const swapped = Buffer.from(JSON.stringify({ sid: '254721840961', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifyChatSession(`${swapped}.${token.split('.')[1]}`), null);
  assert.ok(payload.length > 0);
});

test('a tampered signature is rejected', () => {
  const { token } = issueChatSession();
  const [payload, signature] = token.split('.');
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  assert.equal(verifyChatSession(`${payload}.${flipped}`), null);
});

test('an expired session is rejected', () => {
  const issuedAt = Date.now() - CHAT_SESSION_TTL_MS - 1000;
  const { token } = issueChatSession(issuedAt);
  assert.equal(verifyChatSession(token), null);
});

test('garbage, empty and non-string tokens are rejected', () => {
  for (const value of ['', 'abc', 'a.b.c', '.', 'x'.repeat(600), undefined, null, 42, {}]) {
    assert.equal(verifyChatSession(value), null);
  }
});

test('a token signed under a different secret is rejected', () => {
  const { token } = issueChatSession();
  process.env.AUTH_JWT_SECRET = 'b'.repeat(40);
  try {
    assert.equal(verifyChatSession(token), null);
  } finally {
    process.env.AUTH_JWT_SECRET = 'a'.repeat(40);
  }
});

test('an admin-style JWT is never accepted as a chat session', () => {
  const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl';
  assert.equal(verifyChatSession(jwtLike), null);
});
