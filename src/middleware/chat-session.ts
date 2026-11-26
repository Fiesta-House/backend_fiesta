import type { NextFunction, Request, Response } from 'express';
import { issueChatSession, verifyChatSession } from '../services/auth/chat-session.service';

export const CHAT_SESSION_HEADER = 'x-chat-session';

/** Shape of what the guard leaves on res.locals for the chat controller. */
export type ChatSessionLocals = { chatCustomerId: string };

/**
 * POST /api/chat/session - hands an anonymous visitor a signed session token.
 * The visitor does not choose its identity; the server generates it.
 */
export function createChatSessionHandler(req: Request, res: Response): void {
  const session = issueChatSession();
  res.status(201).json({
    session_token: session.token,
    customer_id: session.customerId,
    expires_at: new Date(session.expiresAt).toISOString(),
  });
}

/**
 * Requires a valid chat session token in the X-Chat-Session header and exposes
 * the verified customer id as res.locals.chatCustomerId. Anything the client
 * puts in the request body as "customerId" is never trusted.
 */
export function requireChatSession(req: Request, res: Response, next: NextFunction): void {
  const session = verifyChatSession(req.get(CHAT_SESSION_HEADER));
  if (!session) {
    res.status(401).json({ error: 'A valid chat session is required. Start one with POST /api/chat/session.' });
    return;
  }
  (res.locals as ChatSessionLocals).chatCustomerId = session.customerId;
  next();
}
