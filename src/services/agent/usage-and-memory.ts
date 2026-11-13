
import prisma from '../../config/prisma';
import { DAILY_TOKEN_CAP } from './resilience.service';
import { notifyAdmin } from '../notifications/notification.service';

export async function touchCustomerMemory(
  customerId: string,
  userMessage: string,
  platform: string
): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId }
  });

  if (!customer) return;

  const summary =
    userMessage.length > 200
      ? userMessage.slice(0, 200) + '…'
      : userMessage;

  const existing = await prisma.customerMemory.findUnique({
    where: { customerId }
  });

  await prisma.customerMemory.upsert({
    where: { customerId },
    update: {
      relationshipStage:
        existing?.relationshipStage === 'new' || !existing
          ? 'interested'
          : existing.relationshipStage,
      lastInteractionSummary: summary,
      preferredChannel: platform
    },
    create: {
      customerId,
      relationshipStage: 'interested',
      lastInteractionSummary: summary,
      preferredChannel: platform
    }
  });
}

export async function escalate(
  customerId: string,
  escalationType: string,
  description: string,
  sentimentScore?: number
): Promise<void> {
  try {
    await prisma.escalation.create({
      data: {
        customerId,
        escalationType,
        description,
        status: 'OPEN',
        sentimentScore
      }
    });

    let alertTitle = `Customer ${customerId} needs attention`;
    let alertMessage = description;

    try {
      const parsed = JSON.parse(description);

      if (parsed.event === 'quota_handoff_requested') {
        const who =
          parsed.customerName || parsed.customerPhone || customerId;

        alertTitle = `Customer Handoff: ${who} (Token Cap)`;
        alertMessage =
          parsed.note ||
          `Customer reached daily token cap. Booking state: ${parsed.bookingSummary || 'none'}.`;
      }
    } catch {
      // Plain text description.
    }

    await notifyAdmin(
      'escalation',
      alertTitle,
      alertMessage,
      { customerId, escalationType, sentimentScore }
    );
  } catch (err) {
    console.error('Failed to create escalation:', err);
  }
}

export async function logAiJobMetric(data: {
  customerId: string;
  platform: string;
  success: boolean;
  latencyMs: number;
  failureReason?: string;
  isFallback?: boolean;
  circuitBreakerTrip?: boolean;
  circuitBreakerReason?: string;
  strategyUsed?: string;
}): Promise<void> {
  try {
    await prisma.aiJobMetric.create({ data });
  } catch (err) {
    console.error('Failed to log AI job metric:', err);
  }
}

export async function checkTokenBudget(
  customerId: string
): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production') return true;

  const exemptNumbers = (process.env.EXEMPT_TOKEN_CAP_NUMBERS || '')
    .split(',')
    .map(n => n.trim().replace(/\D/g, ''))
    .filter(Boolean);

  const cleanId = customerId.replace(/\D/g, '');

  if (cleanId && exemptNumbers.includes(cleanId)) {
    return true;
  }

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      dailyTokenUsage: true,
      tokenResetDate: true
    }
  });

  if (!customer) return true;

  const isNewDay =
    !customer.tokenResetDate ||
    customer.tokenResetDate.toDateString() !== new Date().toDateString();

  const currentUsage = isNewDay ? 0 : customer.dailyTokenUsage;

  return currentUsage < DAILY_TOKEN_CAP;
}

export async function recordTokenUsage(
  customerId: string,
  tokensUsed: number
): Promise<void> {
  if (tokensUsed <= 0) return;

  try {
    const now = new Date();

    // Historical reporting uses UTC calendar days.
    const usageDate = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
      )
    );

    await prisma.$transaction(
      async (tx) => {
        const customer = await tx.customer.findUnique({
          where: { id: customerId },
          select: {
            dailyTokenUsage: true,
            tokenResetDate: true
          }
        });

        if (!customer) return;

        // Preserve the existing customer rate-limit counter behaviour.
        const isNewDay =
          !customer.tokenResetDate ||
          customer.tokenResetDate.toDateString() !== now.toDateString();

        await tx.customer.update({
          where: { id: customerId },
          data: {
            dailyTokenUsage: isNewDay
              ? tokensUsed
              : { increment: tokensUsed },
            tokenResetDate: now,
            totalTokensUsed: { increment: tokensUsed }
          }
        });

        // Persist the historical daily total separately.
        await tx.customerDailyTokenUsage.upsert({
          where: {
            customerId_date: {
              customerId,
              date: usageDate
            }
          },
          create: {
            customerId,
            date: usageDate,
            totalTokens: tokensUsed
          },
          update: {
            totalTokens: { increment: tokensUsed }
          }
        });
      },
      {
        maxWait: 10000,
        timeout: 20000
      }
    );
  } catch (err) {
    console.error(
      'Failed to record token usage:',
      err
    );
  }
}
