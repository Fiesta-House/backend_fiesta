import { NextFunction, Request, Response } from 'express';
import prisma from '../config/prisma';
import { readAccessToken } from '../services/auth/auth.service';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
  adminOnly = false,
): Promise<void> {
  const authorization = req.get('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const userId = token ? readAccessToken(token) : null;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });

  if (!user || !user.isActive) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (adminOnly && user.role !== 'admin') {
    res.status(403).json({ error: 'Administrator access required' });
    return;
  }

  res.locals.authUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  } satisfies AuthenticatedUser;
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, res, next);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, res, next, true);
}

export async function requireApiAuthentication(req: Request, res: Response, next: NextFunction): Promise<void> {
  const path = req.originalUrl.split('?')[0];
  const publicPaths = new Set([
    // Web chat: /api/chat is gated by a signed chat-session token (see
    // middleware/chat-session.ts) and rate limited, not by an admin JWT.
    '/api/chat',
    '/api/chat/session',
    '/api/whatsapp',
    '/api/instagram',
    '/api/mpesa/callback',
    // Meta redirects the browser here without an admin JWT
    '/api/integrations/instagram/callback',
  ]);

  // Daraja callbacks arrive at /api/mpesa/callback/<secret>; the route's own
  // guard (middleware/mpesa-callback-guard.ts) checks the secret and source.
  const isMpesaCallbackWithSecret = /^\/api\/mpesa\/callback\/[^/]+$/.test(path);

  if (publicPaths.has(path) || isMpesaCallbackWithSecret) {
    next();
    return;
  }

  await requireAdmin(req, res, next);
}