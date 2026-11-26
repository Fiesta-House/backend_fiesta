import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import type { ChatSessionLocals } from './chat-session';

/**
 * Rate limits for the public endpoints. Limits are per instance (in-memory
 * store), the same as the login limiter; move to a shared store before running
 * more than one instance. All of them are tunable by env without a deploy of
 * code, and every rejection is a clean 429 JSON body.
 */

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const tooMany = (error: string) => ({ error });

/** Starting a chat session: stops one address farming fresh identities. */
export const chatSessionIssueLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: intFromEnv('CHAT_SESSIONS_PER_IP_PER_HOUR', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Too many chat sessions started. Please try again later.'),
});

/** Chat messages per address per minute (covers shared-NAT visitors). */
export const chatIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: intFromEnv('CHAT_MESSAGES_PER_IP_PER_MINUTE', 40),
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Too many messages. Please slow down.'),
});

/** Chat messages per address per day: a hard ceiling on LLM spend per source. */
export const chatIpDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: intFromEnv('CHAT_MESSAGES_PER_IP_PER_DAY', 500),
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Daily message limit reached. Please contact the studio on WhatsApp.'),
});

/** Chat messages per session per minute. Runs after the session is verified. */
export const chatSessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: intFromEnv('CHAT_MESSAGES_PER_SESSION_PER_MINUTE', 12),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const locals = (req.res?.locals ?? {}) as Partial<ChatSessionLocals>;
    return locals.chatCustomerId || 'unauthenticated';
  },
  message: tooMany('Too many messages. Please slow down.'),
});

/**
 * M-Pesa callbacks. Safaricom sends few, so this is generous: it only exists to
 * cap abuse of the public URL, not to throttle real payments or retries.
 */
export const mpesaCallbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: intFromEnv('MPESA_CALLBACKS_PER_IP_PER_MINUTE', 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ResultCode: 1, ResultDesc: 'Too many requests' },
});
