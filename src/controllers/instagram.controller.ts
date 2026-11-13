
import { Request, Response } from 'express';
import { agentService } from '../services/agent/agent.service';
import { instagramService, InstagramUserProfile } from '../services/messaging/instagram.service';
import * as messageDebouncer from '../services/messaging/debounce.service';
import { visionService } from '../services/vision/vision.service';
import prisma from '../config/prisma';
import dotenv from 'dotenv';

dotenv.config();

const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || 'socialresponder2025';

export class InstagramController {
  // Avoid repeatedly calling Meta when a profile lookup is unavailable.
  // A customer can be retried after six hours.
  private profileLookupAttempts = new Map<string, number>();

  private readonly PROFILE_LOOKUP_COOLDOWN = 6 * 60 * 60 * 1000;

  /**
   * Save profile details returned by Meta or supplied in the webhook.
   */
  private async saveInstagramProfile(
    customerId: string,
    profile: InstagramUserProfile
  ): Promise<void> {
    const username = profile.username?.trim().replace(/^@/, '');
    const profileName = profile.name?.trim();
    const profilePic = profile.profile_pic || profile.profile_picture_url;

    const data: Record<string, any> = {};

    if (username) {
      data.instagramUsername = username;
    }

    if (profileName) {
      data.instagramProfileName = profileName;
    }

    if (profilePic) {
      data.instagramProfilePic = profilePic;
    }

    if (Object.keys(data).length === 0) return;

    // Keep the existing customer name useful for other parts of the system.
    // Do not overwrite a name that a team member has already entered.
    if (profileName) {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { name: true },
      });

      if (
        customer &&
        (!customer.name ||
          customer.name === 'Instagram User' ||
          customer.name === 'Unknown')
      ) {
        data.name = profileName;
      }
    }

    try {
      await prisma.customer.update({
        where: { id: customerId },
        data,
      });

      console.log('[INSTAGRAM_PROFILE] Customer profile updated:', {
        customerId,
        username: username || undefined,
        hasName: Boolean(profileName),
        hasProfilePicture: Boolean(profilePic),
      });
    } catch (error: any) {
      // A username may already be associated with another customer because
      // instagramUsername has a unique database index. Preserve the other
      // profile fields rather than failing the whole update.
      if (error.code === 'P2002' && data.instagramUsername) {
        delete data.instagramUsername;

        if (Object.keys(data).length > 0) {
          await prisma.customer.update({
            where: { id: customerId },
            data,
          });
        }

        console.warn(
          '[INSTAGRAM_PROFILE] Username already belongs to another customer; saved other available profile details.'
        );

        return;
      }

      throw error;
    }
  }

  /**
   * Refresh a customer's profile without blocking message processing.
   */
  private async refreshInstagramProfile(
    customerId: string,
    senderId: string,
    existingProfile: {
      instagramUsername?: string | null;
      instagramProfileName?: string | null;
      instagramProfilePic?: string | null;
    }
  ): Promise<void> {
    const hasUsername = Boolean(existingProfile.instagramUsername);
    const hasName = Boolean(existingProfile.instagramProfileName);
    const hasPicture = Boolean(existingProfile.instagramProfilePic);

    const lastAttempt = this.profileLookupAttempts.get(senderId);
    const now = Date.now();

    if (
      lastAttempt &&
      now - lastAttempt < this.PROFILE_LOOKUP_COOLDOWN
    ) {
      return;
    }

    this.profileLookupAttempts.set(senderId, now);

    // Keep the in-memory map from growing indefinitely.
    if (this.profileLookupAttempts.size > 5000) {
      for (const [id, attemptedAt] of this.profileLookupAttempts.entries()) {
        if (now - attemptedAt >= this.PROFILE_LOOKUP_COOLDOWN) {
          this.profileLookupAttempts.delete(id);
        }
      }
    }

    const profile = await instagramService.getUserProfile(senderId);

    if (profile) {
      await this.saveInstagramProfile(customerId, profile);
    }
  }

  /**
   * Webhook Verification (GET).
   */
  verifyWebhook(req: Request, res: Response) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Instagram Webhook Verified!');
      return res.status(200).send(challenge);
    }

    console.error('Instagram Verification Failed. Token mismatch.');
    return res.sendStatus(403);
  }

  /**
   * Handle Incoming Messages (POST).
   */
  async handleWebhook(req: Request, res: Response) {
    try {
      const body = req.body;

      if (body.object === 'instagram') {
        if (body.entry && body.entry.length > 0) {
          for (const entry of body.entry) {
            if (entry.messaging && entry.messaging.length > 0) {
              for (const event of entry.messaging) {
                if (event.message && !event.message.is_echo) {
                  const senderId = event.sender.id;
                  const msgId = event.message.mid;

                  // Some webhook payloads may include the sender username.
                  // Use it immediately if available; profile lookup fills gaps.
                  const webhookUsername =
                    event.sender?.username ||
                    event.message?.from?.username;

                  const attachment = event.message.attachments?.[0];
                  const attachmentType = attachment?.type;
                  const isImage = attachmentType === 'image';
                  const isNonText = !event.message.text && Boolean(attachmentType);

                  const msgBody = isImage
                    ? (
                        event.message.text
                          ? `[Customer sent an outfit photo: "${event.message.text}"]`
                          : '[Customer sent an outfit photo]'
                      )
                    : isNonText
                      ? `[Customer sent ${attachmentType ? `a${['image', 'audio'].includes(attachmentType) ? 'n' : ''} ${attachmentType}` : 'a message'} - not yet supported by the AI]`
                      : event.message.text;

                  if (isNonText && !attachmentType) continue;

                  console.log(`Instagram message from ${senderId}: ${msgBody}`);

                  // 1. Check for duplicate message.
                  const existingMessage = await prisma.message.findFirst({
                    where: { externalId: msgId },
                  });

                  if (existingMessage) {
                    console.log(`Duplicate message received (${msgId}), skipping.`);
                    continue;
                  }

                  // 2. Ensure customer exists.
                  let customer = await prisma.customer.findFirst({
                    where: { instagramId: senderId },
                  });

                  if (!customer) {
                    customer = await prisma.customer.create({
                      data: {
                        instagramId: senderId,
                        name: 'Instagram User',
                      },
                    });
                  }

                  // 3. Save username from webhook immediately if available.
                  if (
                    webhookUsername &&
                    webhookUsername.trim() &&
                    webhookUsername.replace(/^@/, '') !== customer.instagramUsername
                  ) {
                    try {
                      await this.saveInstagramProfile(customer.id, {
                        username: webhookUsername,
                      });

                      // Refresh the in-memory customer object for the checks below.
                      customer.instagramUsername = webhookUsername
                        .trim()
                        .replace(/^@/, '');
                    } catch (profileError: any) {
                      console.warn(
                        '[INSTAGRAM_PROFILE] Could not save webhook username:',
                        profileError.message
                      );
                    }
                  }

                  // 4. Trigger Meta profile lookup in the background.
                  // Do not await this: message processing should continue even
                  // when Meta denies the profile request or takes too long.
                  void this.refreshInstagramProfile(
                    customer.id,
                    senderId,
                    {
                      instagramUsername: customer.instagramUsername,
                      instagramProfileName: customer.instagramProfileName,
                      instagramProfilePic: customer.instagramProfilePic,
                    }
                  ).catch((profileError: any) => {
                    console.warn(
                      '[INSTAGRAM_PROFILE] Background profile refresh failed:',
                      profileError.message
                    );
                  });

                  // 5. Save inbound message.
                  try {
                    await prisma.message.create({
                      data: {
                        content: msgBody,
                        platform: 'instagram',
                        direction: 'inbound',
                        customerId: customer.id,
                        externalId: msgId,
                        handledBy: isImage ? 'ai' : (isNonText ? 'system' : 'pending'),
                      },
                    });
                  } catch (e: any) {
                    if (e.code === 'P2002') {
                      console.log(
                        `Duplicate message race condition caught (${msgId}), skipping.`
                      );
                      continue;
                    }

                    throw e;
                  }

                  await instagramService.markAsRead(senderId);

                  if (isImage) {
                    console.log(
                      `[INSTAGRAM_WEBHOOK] Analyzing incoming outfit photo for ${customer.id}`
                    );

                    const reply = await visionService.handleIncomingImage({
                      platform: 'instagram',
                      customerId: customer.id,
                      imageUrl: attachment?.payload?.url,
                      caption: event.message.text,
                    });

                    await prisma.message.create({
                      data: {
                        content: reply,
                        platform: 'instagram',
                        direction: 'outbound',
                        customerId: customer.id,
                        handledBy: 'ai',
                      },
                    });

                    await instagramService.sendMessage(senderId, reply);
                  } else if (isNonText) {
                    const reply =
                      "Thanks for sending that! We've received your media and one of our team members will take a look. Feel free to type out your question in the meantime and I'll answer right away.";

                    await prisma.message.create({
                      data: {
                        content: reply,
                        platform: 'instagram',
                        direction: 'outbound',
                        customerId: customer.id,
                        handledBy: 'system',
                      },
                    });

                    await instagramService.sendMessage(senderId, reply);
                  } else {
                    // Debounce bursts of customer messages into one AI turn.
                    messageDebouncer.scheduleTurn(
                      customer.id,
                      () => this.processPendingTurn(customer!.id, senderId)
                    );
                  }
                }
              }
            }
          }
        }

        return res.sendStatus(200);
      }

      return res.sendStatus(404);
    } catch (error: any) {
      console.error('Error handling Instagram webhook:', error);

      if (error.response) {
        console.error(
          'Error response data:',
          JSON.stringify(error.response.data, null, 2)
        );
      }

      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Runs after a customer has paused sending messages.
   * Gathers every inbound message received since the last reply.
   */
  private async processPendingTurn(
    customerId: string,
    senderId: string
  ): Promise<void> {
    try {
      const lastOutbound = await prisma.message.findFirst({
        where: {
          customerId,
          platform: 'instagram',
          direction: 'outbound',
        },
        orderBy: { createdAt: 'desc' },
      });

      const pendingInbound = await prisma.message.findMany({
        where: {
          customerId,
          platform: 'instagram',
          direction: 'inbound',
          ...(lastOutbound
            ? { createdAt: { gt: lastOutbound.createdAt } }
            : {}),
        },
        orderBy: { createdAt: 'asc' },
      });

      if (pendingInbound.length === 0) return;

      const combinedMessage = pendingInbound
        .map(m => m.content)
        .join('\n');

      const recentMessages = await prisma.message.findMany({
        where: {
          customerId,
          createdAt: { lt: pendingInbound[0].createdAt },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      const history = recentMessages.reverse().map(m => ({
        role: (m.direction === 'inbound' ? 'user' : 'assistant') as
          | 'user'
          | 'assistant',
        content: m.content,
      }));

      const aiReply = await agentService.handleMessage(
        customerId,
        combinedMessage,
        history,
        'instagram'
      );

      await prisma.message.create({
        data: {
          content: aiReply,
          platform: 'instagram',
          direction: 'outbound',
          customerId,
          handledBy: 'ai',
        },
      });

      await instagramService.sendMessage(senderId, aiReply);
    } catch (error: any) {
      console.error('Error processing debounced Instagram turn:', error);
    }
  }

  /**
   * Get Instagram Dashboard Stats.
   */
  async getStats(req: Request, res: Response) {
    try {
      const now = new Date();
      const thirtyDaysAgo = new Date(
        now.getTime() - 30 * 24 * 60 * 60 * 1000
      );
      const sevenDaysAgo = new Date(
        now.getTime() - 7 * 24 * 60 * 60 * 1000
      );

      const [
        totalMessages,
        activeConversations,
        messagesThisMonth,
        messagesThisWeek,
        inboundMessages,
        outboundMessages,
        recentMessages,
      ] = await Promise.all([
        prisma.message.count({
          where: { platform: 'instagram' },
        }),
        prisma.message.groupBy({
          by: ['customerId'],
          where: {
            platform: 'instagram',
            createdAt: {
              gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
            },
          },
        }).then(result => result.length),
        prisma.message.count({
          where: {
            platform: 'instagram',
            createdAt: { gte: thirtyDaysAgo },
          },
        }),
        prisma.message.count({
          where: {
            platform: 'instagram',
            createdAt: { gte: sevenDaysAgo },
          },
        }),
        prisma.message.count({
          where: {
            platform: 'instagram',
            direction: 'inbound',
          },
        }),
        prisma.message.count({
          where: {
            platform: 'instagram',
            direction: 'outbound',
          },
        }),
        prisma.message.findMany({
          where: {
            platform: 'instagram',
            createdAt: { gte: sevenDaysAgo },
          },
          select: { createdAt: true },
        }),
      ]);

      const messagesByDay = Array.from({ length: 7 }).map((_, i) => {
        const d = new Date(
          now.getTime() - (6 - i) * 24 * 60 * 60 * 1000
        );

        return {
          date: d.toLocaleDateString('en-US', { weekday: 'short' }),
          count: 0,
        };
      });

      recentMessages.forEach(msg => {
        const d = new Date(msg.createdAt).toLocaleDateString('en-US', {
          weekday: 'short',
        });

        const day = messagesByDay.find(m => m.date === d);
        if (day) day.count++;
      });

      const topCustomerIds = await prisma.message.groupBy({
        by: ['customerId'],
        where: { platform: 'instagram' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      });

      const topCustomers = await Promise.all(
        topCustomerIds.map(async tc => {
          const cust = await prisma.customer.findUnique({
            where: { id: tc.customerId },
          });

          return {
            name:
              cust?.instagramProfileName ||
              cust?.instagramUsername ||
              cust?.name ||
              'Unknown',
            messageCount: tc._count.id,
          };
        })
      );

      return res.json({
        totalMessages,
        activeConversations,
        avgResponseTime: 45,
        messagesThisMonth,
        messagesThisWeek,
        inboundMessages,
        outboundMessages,
        messagesByDay,
        topCustomers,
      });
    } catch (error: any) {
      console.error('Error fetching Instagram stats:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all conversations (latest message per customer).
   */
  async getConversations(req: Request, res: Response) {
    try {
      const customers = await prisma.customer.findMany({
        where: {
          instagramId: {
            not: null,
          },
        },
        include: {
          messages: {
            where: { platform: 'instagram' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      const conversations = customers
        .filter(c => c.messages.length > 0)
        .map(c => ({
          customerId: c.id,
          customerName:
            c.instagramProfileName ||
            c.name ||
            'Instagram User',
          instagramUsername: c.instagramUsername,
          instagramProfilePic: c.instagramProfilePic,
          platformId: c.instagramId,
          latestMessage: c.messages[0].content,
          latestTimestamp: c.messages[0].createdAt,
          unreadCount: 0,
          aiEnabled: c.aiEnabled,
        }))
        .sort(
          (a, b) =>
            new Date(b.latestTimestamp).getTime() -
            new Date(a.latestTimestamp).getTime()
        );

      return res.json({ conversations });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get messages for a specific customer.
   */
  async getMessages(req: Request, res: Response) {
    try {
      const { customerId } = req.query;

      if (!customerId) {
        return res.status(400).json({
          error: 'customerId is required',
        });
      }

      const messages = await prisma.message.findMany({
        where: {
          customerId: customerId as string,
          platform: 'instagram',
        },
        orderBy: { createdAt: 'asc' },
      });

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
   * Send a manual message.
   */
  async sendMessage(req: Request, res: Response) {
    try {
      const { to, message, customerId } = req.body;

      if (!to || !message) {
        return res.status(400).json({
          error: 'to and message are required',
        });
      }

      await instagramService.sendMessage(to, message);

      await prisma.message.create({
        data: {
          content: message,
          platform: 'instagram',
          direction: 'outbound',
          customerId,
          handledBy: 'human',
        },
      });

      return res.json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get Instagram settings.
   */
  async getSettings(req: Request, res: Response) {
    return res.json({
      accessToken: '********',
      verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN,
      webhookUrl: `${process.env.BASE_URL || ''}/webhooks/instagram`,
    });
  }
}

export const instagramController = new InstagramController();
