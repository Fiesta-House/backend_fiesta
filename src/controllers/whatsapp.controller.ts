import { Request, Response } from 'express';
import { agentService } from '../services/agent/agent.service';
import { whatsappService } from '../services/messaging/whatsapp.service';
import { whatsappTemplatesService } from '../services/messaging/whatsapp-templates.service';
import * as messageDebouncer from '../services/messaging/debounce.service';
import prisma from '../config/prisma';
import { retryOnPrismaDisconnect } from '../utils/prisma-retry';
import { visionService } from '../services/vision/vision.service';
import { MAX_HISTORY_MESSAGES } from '../services/agent/constants';
import dotenv from 'dotenv';

dotenv.config();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'socialresponder2025';
const WHATSAPP_PRIVACY_NOTICE = `Welcome to Fiesta House Maternity! 🤍

Before we get started, we'd like to let you know that we may save and process this chat to assist with enquiries, bookings and customer service, in accordance with our Privacy Policy.

You can read our Privacy Policy here:
https://www.fiestahousematernity.com/privacy-policy`;

export class WhatsAppController {
  
  /**
   * Webhook Verification (GET)
   */
  verifyWebhook(req: Request, res: Response) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WhatsApp Webhook Verified!');
      return res.status(200).send(challenge);
    } else {
      console.error('WhatsApp Verification Failed. Token mismatch.');
      return res.sendStatus(403);
    }
  }

  /**
   * Handle Incoming Messages (POST)
   */
  async handleWebhook(req: Request, res: Response) {
    try {
      const body = req.body;

      // Check if it's a WhatsApp message event
      if (body.object === 'whatsapp_business_account') {
        console.log('[WHATSAPP_WEBHOOK] Received business account event:', JSON.stringify({
          entryCount: Array.isArray(body.entry) ? body.entry.length : 0,
          hasChanges: !!(body.entry && body.entry[0] && body.entry[0].changes),
          hasMessages: !!(body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value && body.entry[0].changes[0].value.messages),
          rawBodyKeys: Object.keys(body || {})
        }));
        if (
          body.entry &&
          body.entry[0].changes &&
          body.entry[0].changes[0].value.messages &&
          body.entry[0].changes[0].value.messages[0]
        ) {
          const message = body.entry[0].changes[0].value.messages[0];
          const from = message.from; // Phone number
          const msgId = message.id;
          const msgType = message.type; // 'text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', etc.

          console.log('[WHATSAPP_WEBHOOK] Message payload parsed:', JSON.stringify({
            from,
            msgId,
            msgType,
            textPreview: msgType === 'text' ? (message.text?.body || '').slice(0, 200) : '(non-text)',
            metadataKeys: Object.keys(message || {})
          }));

          // 1. Check for Duplicate Message (Deduplication) - before anything else,
          // so retried webhook deliveries for non-text messages don't re-trigger a reply.
          const existingMessage = await prisma.message.findFirst({
            where: { externalId: msgId }
          });

          if (existingMessage) {
            console.log(`[WHATSAPP_WEBHOOK] Duplicate message received (${msgId}), skipping.`);
            return res.sendStatus(200);
          }

          // 2. Resolve the message content. Non-text messages (images, voice notes,
          // documents, locations, etc.) don't have a `.text.body` - previously these
          // were silently dropped with no reply at all, leaving the customer thinking
          // the bot was broken. Now they get an acknowledgment instead of silence.
          const isImage = msgType === 'image';
          const imageCaption = message.image?.caption || '';
          const NON_TEXT_LABELS: Record<string, string> = {
            image: 'an outfit photo',
            video: 'a video',
            audio: 'a voice note',
            document: 'a document',
            sticker: 'a sticker',
            location: 'a location',
            contacts: 'a contact card',
          };
          const isNonText = msgType !== 'text';
          const msgBody = isImage
            ? (imageCaption ? `[Customer sent an outfit photo: "${imageCaption}"]` : '[Customer sent an outfit photo]')
            : isNonText
              ? `[Customer sent ${NON_TEXT_LABELS[msgType] || 'a message'} - not yet supported by the AI]`
              : (message.text?.body || '');

          if (!isNonText && !msgBody) {
            return res.sendStatus(200);
          }

          console.log(`[WHATSAPP_WEBHOOK] About to process message from ${from} (${msgType}): ${msgBody}`);

          // 2. Ensure Customer exists and Save Inbound Message
          let customer = await prisma.customer.findUnique({ where: { id: from } });
          if (!customer) {
            customer = await prisma.customer.create({
              data: {
                id: from,
                name: 'WhatsApp User',
                phone: from,
                whatsappId: from,
              }
            });
          } else if (!customer.phone || !customer.whatsappId) {
            // Legacy customer rows were created without phone/whatsappId in some
            // flows. Backfill these fields whenever we receive a new inbound
            // WhatsApp message so profile details are no longer blank.
            customer = await prisma.customer.update({
              where: { id: from },
              data: {
                phone: customer.phone || from,
                whatsappId: customer.whatsappId || from,
              }
            });
          }

          try {
            console.log(`[WHATSAPP_WEBHOOK] Saving inbound message ${msgId} to DB for customer ${from}`);
            await prisma.message.create({
              data: {
                content: msgBody,
                platform: 'whatsapp',
                direction: 'inbound',
                customerId: from,
                externalId: msgId,
                handledBy: isImage ? 'ai' : (isNonText ? 'system' : 'pending')
              }
            });
          } catch (e: any) {
            // Backup for the dedup check above: two near-simultaneous webhook
            // deliveries for the same message (a common retry pattern) could
            // both pass the check-then-create race window before either
            // finishes writing. externalId is @unique, so the loser here just
            // means it was already handled - safe to drop.
            if (e.code === 'P2002') {
              console.log(`Duplicate message race condition caught (${msgId}), skipping.`);
              return res.sendStatus(200);
            }
            throw e;
          }

          console.log(`[WHATSAPP_WEBHOOK] Marking message ${msgId} as read`);
          await whatsappService.markAsRead(msgId);

          if (isImage) {
            console.log(`[WHATSAPP_WEBHOOK] Analyzing incoming outfit photo for ${from}`);
            const reply = await visionService.handleIncomingImage({
              platform: 'whatsapp',
              customerId: from,
              imageId: message.image?.id,
              caption: imageCaption
            });
            await prisma.message.create({
              data: { content: reply, platform: 'whatsapp', direction: 'outbound', customerId: from, handledBy: 'ai' }
            });
            await whatsappService.sendMessage(from, reply);
          } else if (isNonText) {
            // Other non-text messages (voice notes, videos, etc.)
            const reply = "Thanks for sending that! We've received your media and one of our team members will take a look. Feel free to type out your question in the meantime and I'll answer right away.";
            await prisma.message.create({
              data: { content: reply, platform: 'whatsapp', direction: 'outbound', customerId: from, handledBy: 'system' }
            });
            await whatsappService.sendMessage(from, reply);
          } else {
            // Debounce: if the customer sends several messages in quick succession,
            // wait for them to pause before running the AI once on the whole burst,
            // instead of firing a separate disjointed reply per message.
            console.log(`[WHATSAPP_WEBHOOK] Scheduling debounced AI turn for ${from}`);
            messageDebouncer.scheduleTurn(from, () => this.processPendingTurn(from));
          }
        }
        return res.sendStatus(200);
      } else {
        // Not a WhatsApp event
        return res.sendStatus(404);
      }
    } catch (error: any) {
      console.error('Error handling WhatsApp webhook:', error);
      if (error.response) {
        console.error('Error response data:', JSON.stringify(error.response.data, null, 2));
      }
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Runs after a customer has paused sending messages (see debounce.service.ts).
   * Gathers every inbound message received since the last reply - which may be
   * more than one if they sent a burst - and processes them as a single turn.
   */
  private async processPendingTurn(customerId: string): Promise<void> {
    try {
      console.log(`[WHATSAPP_TURN] Starting turn processing for customer ${customerId}`);
      const pendingInbound = await retryOnPrismaDisconnect(prisma, () => prisma.message.findMany({
        where: {
          customerId,
          platform: 'whatsapp',
          direction: 'inbound',
          handledBy: 'pending'
        },
        orderBy: { createdAt: 'asc' }
      }));

      if (pendingInbound.length === 0) {
        console.log(`[WHATSAPP_TURN] No pending inbound messages for ${customerId}`);
        return; // nothing unresponded - shouldn't normally happen
      }

      const combinedMessage = pendingInbound.map(m => m.content).join('\n');
      console.log(`[WHATSAPP_TURN] Pending inbound batch for ${customerId}:`, JSON.stringify({
        count: pendingInbound.length,
        preview: combinedMessage.slice(0, 300),
        messageIds: pendingInbound.map(m => m.id)
      }));

      const recentMessages = await retryOnPrismaDisconnect(prisma, () => prisma.message.findMany({
        where: { customerId, createdAt: { lt: pendingInbound[0].createdAt } },
        orderBy: { createdAt: 'desc' },
        take: MAX_HISTORY_MESSAGES
      }));
      const history = recentMessages.reverse().map(m => ({
        role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
        createdAt: m.createdAt,
      }));

      // handleMessage never throws - on any internal failure (provider error,
      // circuit open, rate limited) it resolves to a safe fallback string,
      // logged distinctly in AiJobMetric.
      // Send the privacy notice once, before the customer's first AI response.
// We check the outbound message history rather than the current AI history
// so returning customers are not shown the notice again.
const privacyNoticeSent = await retryOnPrismaDisconnect(prisma, () =>
  prisma.message.findFirst({
    where: {
      customerId,
      platform: 'whatsapp',
      direction: 'outbound',
      content: WHATSAPP_PRIVACY_NOTICE,
    },
    select: { id: true },
  })
);

if (!privacyNoticeSent) {
  console.log(`[WHATSAPP_TURN] Sending first-contact privacy notice to ${customerId}`);

  await prisma.message.create({
    data: {
      content: WHATSAPP_PRIVACY_NOTICE,
      platform: 'whatsapp',
      direction: 'outbound',
      customerId,
      handledBy: 'system',
    },
  });

  await whatsappService.sendMessage(customerId, WHATSAPP_PRIVACY_NOTICE);
}

console.log(`[WHATSAPP_TURN] Calling agentService.handleMessage for ${customerId}`);
const aiReply = await agentService.handleMessage(
  customerId,
  combinedMessage,
  history,
  'whatsapp'
);
      console.log(`[WHATSAPP_TURN] Agent response for ${customerId}:`, JSON.stringify({
        replyPreview: aiReply.slice(0, 200),
        isFallback: aiReply.includes("we're experiencing high demand") || aiReply.includes("we are experiencing high demand")
      }));

      // She wrote again while this reply was being prepared: the next turn answers all her messages together.
      // Payment, booking-change and invoice replies are always sent, because their action has already happened.
      const newerInbound = await retryOnPrismaDisconnect(prisma, () => prisma.message.findFirst({
        where: { customerId, platform: 'whatsapp', direction: 'inbound', handledBy: { not: 'system' }, createdAt: { gt: pendingInbound[pendingInbound.length - 1].createdAt } },
        select: { id: true },
      }));
      if (newerInbound && !/m-?pesa|prompt|deposit|confirmed|cancel|reschedul|invoice|receipt/i.test(aiReply)) {
        console.log(`[WHATSAPP_TURN] Reply superseded by a newer message for ${customerId}; answering the batch in the next turn.`);
        return;
      }

      await prisma.message.create({
        data: { content: aiReply, platform: 'whatsapp', direction: 'outbound', customerId, handledBy: 'ai' }
      });

      await prisma.message.updateMany({
        where: { id: { in: pendingInbound.map(message => message.id) }, handledBy: 'pending' },
        data: { handledBy: 'ai' }
      });

      await whatsappService.sendMessage(customerId, aiReply);
    } catch (error: any) {
      console.error('Error processing debounced WhatsApp turn:', {
        code: error?.code,
        message: error?.message || error,
      });
    }
  }

  /**
   * Get all conversations (latest message per customer)
   */
  async getConversations(req: Request, res: Response) {
    try {
      const customers = await prisma.customer.findMany({
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      const conversations = customers
        .filter(c => c.messages.length > 0)
        .map(c => ({
          customerId: c.id,
          customerName: c.name,
          phone: c.id, // ID is the phone number in our system
          latestMessage: c.messages[0].content,
          latestTimestamp: c.messages[0].createdAt,
          unreadCount: 0, // Placeholder
          aiEnabled: c.aiEnabled
        }))
        .sort((a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime());

      return res.json({ conversations });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get messages for a specific customer
   */
  async getMessages(req: Request, res: Response) {
    try {
      const { customerId } = req.query;
      if (!customerId) return res.status(400).json({ error: 'customerId is required' });

      const messages = await prisma.message.findMany({
        where: { customerId: customerId as string },
        orderBy: { createdAt: 'asc' },
      });

      // Format for frontend
      const formattedMessages = messages.map(m => ({
        id: m.id,
        customerId: m.customerId,
        content: m.content,
        direction: m.direction,
        timestamp: m.createdAt,
      }));

      return res.json({ messages: formattedMessages });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Send a manual message
   */
  async sendMessage(req: Request, res: Response) {
    try {
      const { to, message, customerId } = req.body;
      if (!to || !message) return res.status(400).json({ error: 'to and message are required' });

      await whatsappService.sendMessage(to, message);

      // Save to DB
      await prisma.message.create({
        data: {
          content: message,
          platform: 'whatsapp',
          direction: 'outbound',
          customerId: customerId || to,
          handledBy: 'human'
        }
      });

      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get WhatsApp settings
   */
  async getSettings(req: Request, res: Response) {
    return res.json({
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: '********', // Hide token
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
      webhookUrl: `${process.env.BASE_URL || ''}/webhooks/whatsapp`
    });
  }

  // ============================================================
  // MESSAGE TEMPLATE MANAGEMENT
  // ============================================================

  /**
   * Returns connected WhatsApp Business Account info.
   * Used by the frontend to verify the Meta connection is live.
   */
  async getAccountInfo(req: Request, res: Response) {
    try {
      const info = await whatsappTemplatesService.getAccountInfo();
      return res.json({ connected: true, ...info });
    } catch (error: any) {
      console.error('[WA_TEMPLATES] getAccountInfo error:', error.response?.data || error.message);
      const metaError = error.response?.data?.error;
      return res.status(503).json({
        connected: false,
        error: metaError?.message || 'Unable to verify WhatsApp Business Account connection.',
      });
    }
  }

  /**
   * Retrieves all message templates from Meta for the connected WABA.
   */
  async getTemplates(req: Request, res: Response) {
    try {
      const templates = await whatsappTemplatesService.getTemplates();
      return res.json({ templates });
    } catch (error: any) {
      console.error('[WA_TEMPLATES] getTemplates error:', error.response?.data || error.message);
      const metaError = error.response?.data?.error;
      return res.status(502).json({
        error: metaError?.message || 'Failed to retrieve templates from Meta.',
        code: metaError?.code,
      });
    }
  }

  /**
   * Creates a new WhatsApp message template via Meta Graph API.
   */
  async createTemplate(req: Request, res: Response) {
    try {
      const { name, category, language, body, examples } = req.body;

      // --- Validation ---
      if (!name || !category || !language || !body) {
        return res.status(400).json({ error: 'name, category, language, and body are required.' });
      }

      const nameRegex = /^[a-z0-9_]+$/;
      if (!nameRegex.test(name)) {
        return res.status(400).json({
          error: 'Template name must be lowercase letters, numbers, and underscores only (e.g. order_confirmation).'
        });
      }

      const validCategories = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
      if (!validCategories.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${validCategories.join(', ')}.` });
      }

      const normalizedLanguage = language === 'en' ? 'en_US' : language;
      if (!/^[a-z]{2,3}(?:_[A-Z]{2,3})?$/.test(normalizedLanguage)) {
        return res.status(400).json({ error: 'language must be a valid locale code such as en_US.' });
      }

      const variableMatches = body.match(/{{(\d+)}}/g) || [];
      const variableNumbers = variableMatches.map((match: string) => Number(match.slice(2, -2)));
      const expectedVariables = variableNumbers.length === 0
        ? []
        : Array.from({ length: Math.max(...variableNumbers) }, (_, index) => index + 1);
      const uniqueVariables = Array.from(new Set<number>(variableNumbers)).sort((a, b) => a - b);

      if (uniqueVariables.some((value, index) => value !== expectedVariables[index])) {
        return res.status(400).json({ error: 'Body variables must be sequential placeholders starting at {{1}}.' });
      }

      const exampleValues = Array.isArray(examples)
        ? examples.map((value: unknown) => String(value).trim())
        : [];
      if (expectedVariables.length > 0 && (
        exampleValues.length !== expectedVariables.length || exampleValues.some((value: string) => !value)
      )) {
        return res.status(400).json({
          error: `Provide one example value for each body variable (${expectedVariables.map((value) => `{{${value}}}`).join(', ')}).`,
        });
      }

      // --- Build Meta payload ---
      const payload = {
        name,
        category,
        language: normalizedLanguage,
        ...(expectedVariables.length > 0 ? { parameter_format: 'POSITIONAL' as const } : {}),
        components: [
          {
            type: 'BODY' as const,
            text: body,
            ...(expectedVariables.length > 0 ? { example: { body_text: [exampleValues] } } : {}),
          },
        ],
      };

      const result = await whatsappTemplatesService.createTemplate(payload);
      return res.status(201).json({ success: true, template: result });
    } catch (error: any) {
      console.error('[WA_TEMPLATES] createTemplate error:', error.response?.data || error.message);
      const metaError = error.response?.data?.error;
      return res.status(502).json({
        error: metaError?.message || 'Failed to create template via Meta API.',
        code: metaError?.code,
        error_data: metaError?.error_data,
      });
    }
  }
}

export const whatsappController = new WhatsAppController();
