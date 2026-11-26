import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Safaricom Daraja does not sign STK callbacks, so the endpoint has to prove
 * the caller some other way. Two independent checks:
 *
 * 1. A secret path segment: POST /api/mpesa/callback/<MPESA_CALLBACK_SECRET>.
 *    Put that full URL in MPESA_CALLBACK_URL; Daraja echoes it back on every
 *    callback, and nobody who has not seen the URL can forge one.
 * 2. Optional source-IP allowlist (MPESA_CALLBACK_ALLOWED_IPS, comma
 *    separated). Left unset it is skipped; set it to the addresses Safaricom
 *    publishes for your integration.
 *
 * In production the guard fails closed: with no secret configured, every
 * callback is refused (startup validation also refuses to boot in that state).
 * Outside production an unset secret only logs a warning, so sandbox and local
 * testing keep working.
 */

const MIN_SECRET_LENGTH = 24;

export function isProductionMpesa(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    String(env.MPESA_ENVIRONMENT || '').trim().toLowerCase() === 'production' ||
    String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
  );
}

function safeEqual(a: string, b: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function normaliseIp(ip: string | undefined): string {
  return String(ip || '').trim().replace(/^::ffff:/i, '');
}

function allowedIps(env: NodeJS.ProcessEnv): string[] {
  return String(env.MPESA_CALLBACK_ALLOWED_IPS || '')
    .split(',')
    .map((entry) => normaliseIp(entry))
    .filter(Boolean);
}

export function mpesaCallbackGuard(req: Request, res: Response, next: NextFunction): void {
  const env = process.env;
  const secret = String(env.MPESA_CALLBACK_SECRET || '').trim();

  if (!secret) {
    if (isProductionMpesa(env)) {
      console.error('[MPESA_CALLBACK] Rejected: MPESA_CALLBACK_SECRET is not configured in production.');
      res.status(503).json({ ResultCode: 1, ResultDesc: 'Callback endpoint is not configured' });
      return;
    }
    console.warn('[MPESA_CALLBACK] MPESA_CALLBACK_SECRET is not set; accepting an unauthenticated callback (non-production only).');
  } else {
    const provided = typeof req.params?.secret === 'string' ? req.params.secret : '';
    if (!provided || !safeEqual(provided, secret)) {
      console.error(`[MPESA_CALLBACK] Rejected: missing or invalid callback secret (ip=${normaliseIp(req.ip)}).`);
      res.sendStatus(404);
      return;
    }
  }

  const allowlist = allowedIps(env);
  if (allowlist.length > 0 && !allowlist.includes(normaliseIp(req.ip))) {
    console.error(`[MPESA_CALLBACK] Rejected: source ip ${normaliseIp(req.ip)} is not in MPESA_CALLBACK_ALLOWED_IPS.`);
    res.sendStatus(403);
    return;
  }

  next();
}

export { MIN_SECRET_LENGTH as MPESA_CALLBACK_SECRET_MIN_LENGTH };
