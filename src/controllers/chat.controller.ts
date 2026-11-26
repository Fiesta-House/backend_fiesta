import { Request, Response } from 'express';
import { agentService } from '../services/agent/agent.service';
import type { ChatSessionLocals } from '../middleware/chat-session';

const MAX_MESSAGE_CHARS = Number.parseInt(String(process.env.CHAT_MAX_MESSAGE_CHARS ?? ''), 10) || 1000;

export class ChatController {

  /**
   * Endpoint for accepting web chat messages.
   * POST /api/chat
   * Headers: X-Chat-Session: <token from POST /api/chat/session>
   * Body: { message: string }
   *
   * Who is chatting comes from the verified session token, never from the
   * request body, so a visitor cannot speak as another customer.
   */
  async handleIncomingMessage(req: Request, res: Response) {
    try {
      const customerId = (res.locals as Partial<ChatSessionLocals>).chatCustomerId;
      if (!customerId) {
        return res.status(401).json({ error: 'A valid chat session is required.' });
      }

      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }
      if (message.length > MAX_MESSAGE_CHARS) {
        return res.status(413).json({ error: `message must be at most ${MAX_MESSAGE_CHARS} characters` });
      }

      console.log(`Received web chat message from ${customerId} (${message.length} chars)`);

      // Pass directly to the Agent Service which handles RAG + Booking Logic
      const reply = await agentService.handleMessage(customerId, message, [], 'web');

      return res.status(200).json({
        success: true,
        reply: reply
      });
    } catch (error: any) {
      console.error('Error handling chat message:', error);
      return res.status(500).json({ error: 'Internal server error while processing message.' });
    }
  }
}

export const chatController = new ChatController();
