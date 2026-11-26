import crypto from 'crypto';

/**
 * Anonymous web-chat sessions.
 *
 * The web chat is public, so the server (not the browser) decides who a chat
 * visitor is. A visitor asks for a session, gets a signed token, and every chat
 * request is attributed to the customer id inside that token. A client can no
 * longer pass someone else's id (e.g. a WhatsApp phone number) and read or act
 * on that customer's bookings.
 *
 * Tokens are HMAC-signed with node:crypto. They are not JWTs and use a key
 * derived with a different label, so an admin access token can never be
 * accepted here, and a chat token can never be accepted as an admin token.
 */

export const WEB_CHAT_ID_PREFIX = 'web_';
export const CHAT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_LABEL = 'fiesta-web-chat-session-key.v1';
const SIGNATURE_LABEL = 'web-chat-session.v1:';
const SESSION_ID_PATTERN = /^web_[0-9a-f]{32}$/;

export type ChatSession = {
  customerId: string;
  expiresAt: number;
};

export type IssuedChatSession = ChatSession & { token: string };

function signingKey(): Buffer {
  const explicit = process.env.CHAT_SESSION_SECRET?.trim();
  if (explicit) {
    if (explicit.length < 32) {
      throw new Error('CHAT_SESSION_SECRET must be at least 32 characters');
    }
    return crypto.createHmac('sha256', explicit).update(KEY_LABEL).digest();
  }

  const base = process.env.AUTH_JWT_SECRET;
  if (!base || base.length < 32) {
    throw new Error('AUTH_JWT_SECRET must be configured with at least 32 characters');
  }
  return crypto.createHmac('sha256', base).update(KEY_LABEL).digest();
}

function sign(payload: string): string {
  return crypto
    .createHmac('sha256', signingKey())
    .update(SIGNATURE_LABEL + payload)
    .digest('base64url');
}

export function issueChatSession(now: number = Date.now()): IssuedChatSession {
  const customerId = WEB_CHAT_ID_PREFIX + crypto.randomBytes(16).toString('hex');
  const expiresAt = now + CHAT_SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ sid: customerId, exp: expiresAt })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, customerId, expiresAt };
}

export function verifyChatSession(token: unknown, now: number = Date.now()): ChatSession | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const customerId = decoded?.sid;
    const expiresAt = decoded?.exp;
    if (typeof customerId !== 'string' || !SESSION_ID_PATTERN.test(customerId)) return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
    return { customerId, expiresAt };
  } catch {
    return null;
  }
}
