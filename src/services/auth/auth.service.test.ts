import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createAccessToken, readAccessToken } from './auth.service';

const previousSecret = process.env.AUTH_JWT_SECRET;
process.env.AUTH_JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

after(() => {
  if (previousSecret === undefined) {
    delete process.env.AUTH_JWT_SECRET;
  } else {
    process.env.AUTH_JWT_SECRET = previousSecret;
  }
});

test('access tokens identify the user and reject tampering', () => {
  const token = createAccessToken('admin-user-id');

  assert.equal(readAccessToken(token), 'admin-user-id');
  assert.equal(readAccessToken(`${token}tampered`), null);
});