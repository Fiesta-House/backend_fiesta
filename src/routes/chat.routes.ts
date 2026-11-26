import { Router } from 'express';
import { chatController } from '../controllers/chat.controller';
import { createChatSessionHandler, requireChatSession } from '../middleware/chat-session';
import {
  chatIpDailyLimiter,
  chatIpLimiter,
  chatSessionIssueLimiter,
  chatSessionLimiter,
} from '../middleware/rate-limiters';

const router = Router();

// Public, but rate limited: a visitor asks for a server-issued session first.
router.post('/chat/session', chatSessionIssueLimiter, createChatSessionHandler);

// Order matters: cheap per-address limits first, then identity, then the
// per-session limit (which is keyed by the verified identity).
router.post(
  '/chat',
  chatIpLimiter,
  chatIpDailyLimiter,
  requireChatSession,
  chatSessionLimiter,
  chatController.handleIncomingMessage.bind(chatController),
);

export default router;
