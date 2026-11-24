import dayjs from 'dayjs';
import prisma from '../../../config/prisma';
import {
  safeSchemaDetails,
  SCHEMA_MAINTENANCE_REPLY,
} from '../../../config/schema-readiness';
import { DAILY_TOKEN_CAP } from '../resilience.service';
import { parseMpesaMessage, isValidTillPayment } from '../till-payment';
import { notifyAdmin } from '../../notifications/notification.service';
import { escalate } from '../usage-and-memory';
import {
  bookingDateFacts,
  nowInBusinessTimezone,
} from '../../../utils/time';
import {
  carriedOverStale,
  extractStatedSlots,
  rememberBookingSlots as storeEarlySlots,
  closedDateReply,
  sameDayClosedReply,
  EARLY_SLOT_STEP,
} from '../slot-memory';
import { carryOverQuestion, welcomePrefix } from '../booking-progress';
import { isPlainGreeting, isDeferral } from '../conversation-flow.matcher';
import { previousMessageRequestsConfirmation } from '../replies';

export async function handleSchemaMismatch(
  customerId: string,
  userMessage: string,
  platform: string,
  error: unknown,
  shouldAlertSchemaMismatch: () => boolean
): Promise<{ reply: string; outcome: { success: boolean; isFallback: boolean; failureReason: string } }> {
  const details = safeSchemaDetails(error);
  console.error('[AGENT_FLOW] SCHEMA_OUT_OF_DATE: booking automation requires an operator-reviewed migration.', JSON.stringify(details));
  if (shouldAlertSchemaMismatch()) {
    await escalate(customerId, 'error', JSON.stringify({
      event: 'database_schema_out_of_date', ...details, platform,
      customerMessage: userMessage.slice(0, 1000), requiresOperatorAction: true,
      note: 'Stop live automated testing. Review any booking/payment side effects before retrying. Verify target and backup, then apply only approved SQL; do not run prisma db push.',
    }));
  } else {
    console.warn('[AGENT_FLOW] schema_alert=suppressed reason=cooldown');
  }
  return { reply: SCHEMA_MAINTENANCE_REPLY, outcome: { success: false, isFallback: true, failureReason: 'database_schema_out_of_date' } };
}

export async function captureMpesaMessage(
  customerId: string,
  userMessage: string,
  platform: string
): Promise<'not_waiting' | 'waiting' | 'received'> {
  if (platform !== 'whatsapp' && platform !== 'web') {
    return 'not_waiting';
  }

  try {
    const draft = await prisma.bookingDraft.findUnique({
      where: { customerId },
    });

    const awaitingPaymentMessage =
      draft?.step === 'awaiting_payment_message';

    const parsed = parseMpesaMessage(userMessage);

    // Only a complete confirmation for our configured Buy Goods Till
    // can trigger automatic booking completion.
    const validTillPayment = isValidTillPayment(userMessage);

    if (!validTillPayment) {
      // Keep the draft waiting. The message can still be handled
      // conversationally, but cannot trigger booking completion.
      return awaitingPaymentMessage ? 'waiting' : 'not_waiting';
    }

    // A valid Till receipt without a matching pending booking
    // requires manual matching by the studio.
    if (!awaitingPaymentMessage) {
      await escalate(
        customerId,
        'booking',
        JSON.stringify({
          event: 'mpesa_payment_message_received',
          ...parsed,
          booking: null,
          draftStep: draft?.step ?? null,
          requiresManualMatching: true,
          customerMessage: userMessage.slice(0, 2000),
          action:
            'A valid Fiesta House Maternity Till receipt was received, but no matching payment-waiting booking draft was found. Match it against the M-Pesa statement and outstanding customer payments. Do not associate it with an unrelated or stale draft, and do not confirm payment until verified.',
        })
      );
    }

    return 'received';
  } catch (error) {
    console.error(
      '[AGENT_FLOW] Could not process an M-Pesa payment message:',
      error
    );

    return 'waiting';
  }
}

export async function escalateQuotaHandoff(customerId: string, userMessage: string, platform: string): Promise<void> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { name: true, phone: true }
  });
  const customerLabel = customer?.name && customer.name !== 'WhatsApp User'
    ? `${customer.name} (${customer.phone || customerId})`
    : customer?.phone || customerId;
  const bookingSummary = draft?.service
    ? `Package: ${draft.service}${draft.date ? `, Date: ${draft.date}` : ''}${draft.time ? `, Time: ${draft.time}` : ''}`
    : 'No active booking draft';

  const readableMessage = `Customer ${customerLabel} reached the daily automated conversation limit. Latest message: "${userMessage.slice(0, 200)}". Current booking state: ${bookingSummary}. A studio team member must claim this handoff and reply.`;

  await escalate(
    customerId,
    'quota',
    JSON.stringify({
      event: 'quota_handoff_requested',
      platform,
      customerName: customer?.name || null,
      customerPhone: customer?.phone || null,
      bookingSummary,
      customerMessage: userMessage.slice(0, 2000),
      dailyTokenCap: DAILY_TOKEN_CAP,
      requiresHumanReply: true,
      responseTarget: 'within the business day',
      assignedOwner: null,
      note: readableMessage,
    })
  );
}

export async function notifyRescheduleAdmin(params: {
  customerId: string;
  event: 'proposed' | 'confirmed' | 'failed';
  service?: string;
  oldDateTime?: Date;
  newDate?: string;
  newTime?: string;
  newDateTime?: Date;
  reason?: string;
}): Promise<void> {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: params.customerId },
      select: { name: true, phone: true }
    });

    const actor = customer?.name && customer.name !== 'WhatsApp User'
      ? `${customer.name} (${customer.phone || params.customerId})`
      : customer?.phone || params.customerId;

    if (params.event === 'proposed') {
      await notifyAdmin(
        'reschedule',
        `Reschedule proposed: ${actor}`,
        `${params.service || 'Session'} proposed from ${params.oldDateTime ? dayjs(params.oldDateTime).format('YYYY-MM-DD HH:mm') : 'current slot'} to ${params.newDate} ${params.newTime}. Awaiting customer confirmation.`,
        {
          customerId: params.customerId,
          event: params.event,
          service: params.service,
          oldDateTime: params.oldDateTime?.toISOString(),
          newDate: params.newDate,
          newTime: params.newTime,
        }
      );
      return;
    }

    if (params.event === 'confirmed') {
      await notifyAdmin(
        'reschedule',
        `Reschedule confirmed: ${actor}`,
        `${params.service || 'Session'} moved from ${params.oldDateTime ? dayjs(params.oldDateTime).format('YYYY-MM-DD HH:mm') : 'previous slot'} to ${params.newDateTime ? dayjs(params.newDateTime).format('YYYY-MM-DD HH:mm') : `${params.newDate} ${params.newTime}`}.`,
        {
          customerId: params.customerId,
          event: params.event,
          service: params.service,
          oldDateTime: params.oldDateTime?.toISOString(),
          newDateTime: params.newDateTime?.toISOString(),
        }
      );
      return;
    }

    await notifyAdmin(
      'reschedule',
      `Reschedule failed: ${actor}`,
      `Reschedule attempt failed: ${params.reason || 'Unknown reason'}`,
      {
        customerId: params.customerId,
        event: params.event,
        service: params.service,
        newDate: params.newDate,
        newTime: params.newTime,
        reason: params.reason,
      }
    );
  } catch (err) {
    console.error('Failed to emit reschedule admin notification:', err);
  }
}

/**
 * Carry-over only: a stale draft for today is lapsed unless its time is still ahead.
 * Date-only drafts are treated as lapsed because the customer has already moved on.
 */
export function isLapsedCarryOver(draft: { date?: string | null; time?: string | null }): boolean {
  if (!draft.date) return false;
  if (bookingDateFacts(draft.date).isPast) return true;
  const now = nowInBusinessTimezone();
  if (draft.date !== now.format('YYYY-MM-DD')) return false;
  return draft.time ? draft.time <= now.format('HH:mm') : true;
}

/** On a booking turn, a draft untouched for over two hours is confirmed instead of being presented as current. */
export async function getCarryOverConfirmation(
  customerId: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string | null> {
  const stated = extractStatedSlots(userMessage, history);
  const bookingTurn = Object.keys(stated).length > 0 || isPlainGreeting(userMessage)
    || /\b(?:book\w*|session|appointment|shoot|available|availability|free|open|slots?|yes+|ok(?:ay)?|continue|ready|go ahead)\b/i.test(userMessage);
  if (!bookingTurn || isDeferral(userMessage) || previousMessageRequestsConfirmation(history)
    || /\b(?:cancel\w*|reschedul\w*|invoice|receipt|pay\w*|deposit|m-?pesa|refund\w*)\b/i.test(userMessage)) return null;
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!draft || draft.isForSomeoneElse || !carriedOverStale(draft)) return null;
  const pastDate = isLapsedCarryOver(draft);
  const question = carryOverQuestion(pastDate ? { ...draft, date: null, time: null } : draft, stated);
  if (!question && !pastDate) return null;

  if (stated.name) {
    await prisma.customer.update({
      where: { id: customerId },
      data: { name: stated.name },
    }).catch(() => { });
  }

  const patch: any = pastDate
    ? { date: null, time: null, dateTimeIso: null }
    : { step: EARLY_SLOT_STEP };
  if (stated.date) patch.date = stated.date;
  if (stated.name) patch.name = stated.name;
  if (stated.time) patch.time = stated.time;

  // Marks the draft as touched (updatedAt), so the customer's answer next turn uses it.
  await prisma.bookingDraft.updateMany({
    where: { id: draft.id, step: EARLY_SLOT_STEP },
    data: patch,
  });
  if (!question) return null;
  // Do not capture or overwrite booking details before the customer
  // confirms that the older booking enquiry is still relevant.
  const statedFacts = stated.date ? bookingDateFacts(stated.date) : null;
  const closed = statedFacts && (statedFacts.isMonday || statedFacts.isPast)
    ? closedDateReply(statedFacts)
    : sameDayClosedReply({ date: stated.date, time: stated.time });
  return `${welcomePrefix(userMessage, history)}${question}${closed ? `\n${closed}` : ''}`;
}

export async function rememberBookingSlots(
  customerId: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string | null> {
  return await getCarryOverConfirmation(customerId, userMessage, history)
    ?? storeEarlySlots(customerId, userMessage, history);
}
