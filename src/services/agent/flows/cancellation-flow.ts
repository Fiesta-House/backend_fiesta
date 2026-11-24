import prisma from '../../../config/prisma';
import {
  CANCELLATION_PROPOSAL_TTL_MS,
  RESCHEDULE_COLLECTING_STEP,
} from '../constants';
import { PACKAGE_NAMES_FOR_EXTRACTION } from '../../../config/constants';
import { BookingExtractor } from '../extraction';
import { paymentLapsed } from '../slot-memory';
import { inBusinessTimezone } from '../../../utils/time';
import { getBookingPolicyWindow } from '../../../utils/booking-policy';
import { buildCancellationProposal } from '../replies';
import { escalate } from '../usage-and-memory';

export function isCancellationConfirmation(userMessage: string): boolean {
  const normalized = userMessage.trim().toLowerCase().replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:yes+|yeah|yep|ndio|confirm(?:ed)?)(?: please)?$/.test(normalized);
}

export function isCancellationDecline(userMessage: string): boolean {
  const normalized = userMessage.trim().toLowerCase().replace(/[.!?,]/g, '').replace(/\s+/g, ' ');
  return /^(?:no(?:\s+(?:thanks|thank you|keep it|keep my booking|keep the booking|keep my session|keep the session))?|keep it|keep my booking|keep the booking|keep my session|keep the session|leave it|leave it unchanged|don't cancel|do not cancel)$/.test(normalized);
}

export function hasPendingCancellationProposal(
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
  return /if you want me to cancel this booking, reply yes to confirm/i.test(previousAssistantMessage);
}

export function isCancellationProposalExpired(
  draft: { cancelProposedAt?: Date | string | null },
  now = Date.now()
): boolean {
  const proposedAt = draft.cancelProposedAt ? new Date(draft.cancelProposedAt).getTime() : NaN;
  return !Number.isFinite(proposedAt) || now - proposedAt >= CANCELLATION_PROPOSAL_TTL_MS;
}

export async function clearStaleCancellationDraftBeforeRouting(
  customerId: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string | null> {
  const previousMessageWasCancellationProposal = hasPendingCancellationProposal(history);
  const isConfirmation = isCancellationConfirmation(userMessage);
  if (!previousMessageWasCancellationProposal) return null;

  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (draft?.step !== 'cancel_confirm') return null;

  if (isCancellationProposalExpired(draft)) {
    await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
    return isConfirmation
      ? 'That cancellation proposal expired, so your booking was not changed. If you still want to cancel it, please ask again.'
      : null;
  }

  if (isConfirmation || isCancellationDecline(userMessage)) return null;

  await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
  return isConfirmation
    ? 'I could not verify a current cancellation proposal, so your booking was not changed. Please tell me which session you want to cancel.'
    : null;
}

export function hasPendingCancellationSelection(
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
  return /which session would you like me to cancel\?/i.test(previousAssistantMessage);
}

export function hasCancellationBookingSelector(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  const date = BookingExtractor.regexExtract(userMessage).date;
  const time = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{2}:\d{2}\b/i.test(text);
  const service = PACKAGE_NAMES_FOR_EXTRACTION.some((packageName) =>
    text.includes(packageName.toLowerCase().replace(/ package$/i, ''))
  );
  return Boolean(date || time || service);
}

export function shouldUseCancellationRequest(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const text = userMessage.toLowerCase();
  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  const resetPrompted = /clear it and start fresh/i.test(lastAssistant);
  const clearOrReset = /^(?:(?:please\s+)?clear\s+(?:it|that|this|the\s+draft|the\s+request)|start\s+fresh|start\s+over|reset)[.!]?$/i.test(text.trim())
    || (resetPrompted && /^(?:yes|clear\s+it|start\s+fresh|please|do\s+that)[.!]?$/i.test(text.trim()));
  const explicitRequest = /^(?:please\s+)?cancel(?:\s+please)?[!. ]*$/.test(text.trim())
    || /\b(?:please\s+)?cancel\s+(?:my|the|this|that|it|booking|appointment|session|shoot)\b/.test(text)
    || /\b(?:i want|i need|i'd like|i would like|can i|could i|may i) to? cancel\b/.test(text)
    || /\b(?:can|could|would) you cancel\b/.test(text)
    || clearOrReset;
  return explicitRequest || (hasPendingCancellationSelection(history)
    && hasCancellationBookingSelector(userMessage));
}

/** "Cancel that" while only an unpaid new-booking request is open: withdraw it, since nothing was booked or charged. */
export async function withdrawUnpaidBookingRequest(customerId: string, draft: any, userMessage: string): Promise<string | null> {
  if (!draft || draft.bookingId || !['collecting_slots', 'awaiting_confirmation', 'payment_pending'].includes(draft.step)) return null;
  if (draft.step === 'payment_pending' && !paymentLapsed(draft)) {
    return 'No payment has been taken. If you would rather not continue, just do not enter your M-Pesa PIN; the prompt expires on its own and nothing is charged. The studio team can also help on 0720 111928.';
  }
  // With a confirmed session as well, "cancel" may mean that session, so the existing two-step flow decides.
  if (await prisma.booking.count({ where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } } })) return null;
  if (await prisma.payment.findFirst({ where: { bookingDraftId: draft.id, status: 'success' }, select: { id: true } })) return null;
  await prisma.payment.updateMany({ where: { bookingDraftId: draft.id, status: { not: 'success' } }, data: { status: 'cancelled' } });
  const removed = await prisma.bookingDraft.deleteMany({ where: { id: draft.id, step: draft.step } });
  if (!removed.count) return null;
  const unhappy = /\b(?:disappoint\w*|frustrat\w*|upset|angry|annoy\w*|terrible|useless|not happy|unhappy)\b/i.test(userMessage);
  if (unhappy) {
    await escalate(customerId, 'booking', `Customer withdrew an unpaid booking request and is unhappy: "${userMessage.slice(0, 300)}". Nothing was booked or charged. Please follow up personally.`);
  }
  return `Done, I've cancelled that booking request. Nothing was booked and no payment was taken.${unhappy
    ? " I'm sorry it has been frustrating. A member of our team will reach out to you."
    : ' If you change your mind, just message us here.'}`;
}

export async function proposeCancellation(
  customerId: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<{ reply: string; proposed: boolean }> {
  const existingDraft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  const withdrawn = await withdrawUnpaidBookingRequest(customerId, existingDraft, userMessage);
  if (withdrawn) return { reply: withdrawn, proposed: false };
  if (existingDraft?.step === RESCHEDULE_COLLECTING_STEP) {
    await prisma.bookingDraft.deleteMany({ where: { id: existingDraft.id, step: RESCHEDULE_COLLECTING_STEP } });
  } else if (existingDraft?.step && existingDraft.step !== 'cancel_confirm') {
    const draftDescription = existingDraft.step === 'payment_pending'
      ? 'An M-Pesa payment prompt is already pending'
      : existingDraft.step === 'awaiting_confirmation'
        ? 'A booking proposal is already awaiting your confirmation'
        : existingDraft.step === 'reschedule_confirm'
          ? 'A reschedule proposal is already awaiting your confirmation'
          : 'A booking is already being prepared';
    return {
      reply: `${draftDescription}, so I have not changed that request or started a cancellation. Please finish that step or ask the studio team to help.`,
      proposed: false,
    };
  }

  const upcomingBookings = await prisma.booking.findMany({
    where: { customerId, status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
    orderBy: { dateTime: 'asc' },
  });
  if (upcomingBookings.length === 0) {
    return { reply: 'I could not find an upcoming booking to cancel.', proposed: false };
  }

  const extractedDate = BookingExtractor.regexExtract(userMessage).date as string | null;
  const timeMatch = userMessage.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{2}):(\d{2})\b/i);
  let requestedTime: string | null = null;
  if (timeMatch) {
    if (timeMatch[4]) {
      requestedTime = `${timeMatch[4]}:${timeMatch[5]}`;
    } else {
      const rawHour = Number(timeMatch[1]);
      const hour = rawHour % 12 + (timeMatch[3].toLowerCase() === 'pm' ? 12 : 0);
      requestedTime = `${String(hour).padStart(2, '0')}:${String(Number(timeMatch[2] || 0)).padStart(2, '0')}`;
    }
  }
  const text = userMessage.toLowerCase();
  const requestedPackage = PACKAGE_NAMES_FOR_EXTRACTION.find((packageName) =>
    text.includes(packageName.toLowerCase().replace(/ package$/i, ''))
  );
  const hasSelector = Boolean(extractedDate || requestedTime || requestedPackage);
  let matches = upcomingBookings;
  if (extractedDate) {
    matches = matches.filter((booking) => inBusinessTimezone(booking.dateTime).format('YYYY-MM-DD') === extractedDate);
  }
  if (requestedTime) {
    matches = matches.filter((booking) => inBusinessTimezone(booking.dateTime).format('HH:mm') === requestedTime);
  }
  if (requestedPackage) {
    matches = matches.filter((booking) => booking.service.toLowerCase().includes(requestedPackage.toLowerCase()));
  }

  const describeBooking = (booking: { service: string; dateTime: Date }) => {
    const localDateTime = inBusinessTimezone(booking.dateTime);
    return `${booking.service} on ${localDateTime.format('dddd, D MMMM YYYY')} at ${localDateTime.format('h:mm A')}`;
  };
  if ((!hasSelector && upcomingBookings.length > 1) || matches.length !== 1) {
    const options = upcomingBookings.map((booking) => `- ${describeBooking(booking)}`).join('\n');
    const prompt = hasSelector && matches.length === 0
      ? `I could not match that to an upcoming session. Please choose one of these:\n${options}\nWhich session would you like me to cancel?`
      : `I found more than one upcoming session:\n${options}\nWhich session would you like me to cancel?`;
    return { reply: prompt, proposed: false };
  }

  const booking = matches[0];
  const localDateTime = inBusinessTimezone(booking.dateTime);
  const date = localDateTime.format('YYYY-MM-DD');
  const time = localDateTime.format('HH:mm');
  await prisma.bookingDraft.upsert({
    where: { customerId },
    update: {
      bookingId: booking.id,
      service: booking.service,
      date,
      time,
      dateTimeIso: booking.dateTime.toISOString(),
      cancelProposedAt: new Date(),
      step: 'cancel_confirm',
    },
    create: {
      customerId,
      bookingId: booking.id,
      service: booking.service,
      date,
      time,
      dateTimeIso: booking.dateTime.toISOString(),
      cancelProposedAt: new Date(),
      step: 'cancel_confirm',
    },
  });

  const refundEligible = getBookingPolicyWindow(booking.dateTime).cancellationRefundEligible;
  const refundPosition = refundEligible
    ? 'It is more than 72 hours away and is eligible for a refund under the policy. Eligibility does not confirm a refund amount or that money has been returned.'
    : 'It is 72 hours away or less and is not automatically refundable under the policy.';
  return {
    reply: buildCancellationProposal(booking.service, describeBooking(booking), refundPosition),
    proposed: true,
  };
}
