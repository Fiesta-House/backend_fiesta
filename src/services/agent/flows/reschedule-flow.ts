import dayjs from 'dayjs';
import prisma from '../../../config/prisma';
import {
  SERVICE_DURATIONS,
  DEFAULT_DURATION,
  PACKAGE_NAME_PATTERN,
} from '../../../config/constants';
import {
  RESCHEDULE_COLLECTING_STEP,
  RESCHEDULE_CONTEXT_TTL_MS,
} from '../constants';
import { EARLY_SLOT_STEP } from '../slot-memory';
import { RESCHEDULE_KEYWORD_PATTERN } from '../regex';
import { inBusinessTimezone, businessDay } from '../../../utils/time';
import { getBookingPolicyWindow } from '../../../utils/booking-policy';
import { formatCustomerTime } from '../replies';
import { editionInText } from '../reply-voice';
import { resolveCalendarDate } from '../extraction';
import { rescheduleTargetText, ConversationFlowMatcher } from '../conversation-flow.matcher';
import { bookingService } from '../../booking/booking.service';
import { formatBookingDuration as formatAppointmentDuration } from '../appointment-replies';
import { executeProposeRescheduleTool } from '../booking-tools';
import { messageContainsExplicitDateTimeSignal } from '../helpers/intent-datetime';

const conversationFlows = new ConversationFlowMatcher();

export function shouldUseRescheduleRequestReply(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return RESCHEDULE_KEYWORD_PATTERN.test(text)
    && !messageContainsExplicitDateTimeSignal(userMessage)
    && !conversationFlows.isTimeOnlyRescheduleRequest(userMessage);
}

export function shouldUseRescheduleWithdrawalReply(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const text = userMessage.toLowerCase().trim();
  const withdrawal = /\b(let'?s|we should)\s+(not|don't|do not)\s+(reschedule|change|move|postpone)\b|\b(no|never mind|nevermind|forget it)\b.*\b(reschedule|change|move|postpone)\b|\bkeep\s+(the|my|this)\s+(original|current)\s+(date|time|booking|session)\b/.test(text);
  if (!withdrawal) return false;

  return history.slice(-6).some((message) =>
    message.role === 'assistant' && /reschedul|move|forfeit.*deposit|within 72 hours/i.test(message.content)
  );
}

export async function withdrawPendingReschedule(customerId: string): Promise<void> {
  await prisma.bookingDraft.deleteMany({
    where: { customerId, step: { in: ['reschedule_confirm', RESCHEDULE_COLLECTING_STEP] } },
  });
}

export function isRescheduleWithin72Hours(bookingDateTime: Date, now = new Date()): boolean {
  return getBookingPolicyWindow(bookingDateTime, now).rescheduleForfeitsDeposit;
}

export function getReschedulePolicyMessage(): string {
  return 'Your session is within 72 hours. According to our policy, rescheduling now will forfeit your deposit. Would you still like to proceed? If yes, please share your preferred date and time.';
}

export function shouldConfirmRescheduleWithdrawal(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const normalized = userMessage.trim().toLowerCase().replace(/[!?.,]/g, '').replace(/\s+/g, ' ');
  if (!/^(sure|yes|yeah|yep|okay|ok)$/.test(normalized)) return false;
  const lastAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
  return /^(?:understood[.!]?\s*)?we(?:'ll| will) keep your original session date and time\b|^yes\.\s*your original session date and time are still booked\b/i.test(lastAssistantMessage.trim());
}

/** Stores which booking is being moved, so later turns (or a reminder in between) cannot lose it. */
export async function rememberRescheduleContext(customerId: string, booking: { id: string; service: string }): Promise<void> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  const replaceable = !draft || draft.step === RESCHEDULE_COLLECTING_STEP || draft.step === 'reschedule_confirm'
    || (draft.step === EARLY_SLOT_STEP && !draft.service && !draft.date);
  if (!replaceable) return;
  const data = { step: RESCHEDULE_COLLECTING_STEP, bookingId: booking.id, service: booking.service, date: null, time: null, dateTimeIso: null };
  if (draft) await prisma.bookingDraft.updateMany({ where: { id: draft.id, step: draft.step }, data });
  else await prisma.bookingDraft.create({ data: { customerId, ...data } }).catch((error: any) => { if (error?.code !== 'P2002') throw error; });
}

export function isActiveRescheduleDraft(draft: { step: string; updatedAt?: Date | null } | null): boolean {
  if (!draft || (draft.step !== RESCHEDULE_COLLECTING_STEP && draft.step !== 'reschedule_confirm')) return false;
  return !draft.updatedAt || Date.now() - new Date(draft.updatedAt).getTime() < RESCHEDULE_CONTEXT_TTL_MS;
}

export async function getRescheduleTimeReply(customerId: string): Promise<string | null> {
  const booking = await prisma.booking.findFirst({
    where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
    orderBy: { dateTime: 'asc' },
    select: { id: true, service: true, dateTime: true },
  });
  if (!booking) return null;
  await rememberRescheduleContext(customerId, booking);

  if (isRescheduleWithin72Hours(booking.dateTime)) {
    return getReschedulePolicyMessage();
  }

  return `Of course. Your ${booking.service} session is currently on ${inBusinessTimezone(booking.dateTime).format('dddd, MMMM D')} at ${inBusinessTimezone(booking.dateTime).format('h:mm A')}. What time would work better for you that day?`;
}

/**
 * Reschedule of an existing confirmed booking: the booking is the source of truth, so only the
 * changed fields come from the message ("same day" or no date keeps the booking's date).
 */
export async function getRescheduleSelectionReply(
  customerId: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
  notifyRescheduleAdmin?: (params: any) => Promise<void>
): Promise<string | null> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!isActiveRescheduleDraft(draft) && !conversationFlows.isRescheduleQuestion(history)) return null;
  if (draft?.step === RESCHEDULE_COLLECTING_STEP && /\b(?:new|another|second|separate) (?:booking|session|shoot)\b|\bbook (?:a|another|the)\b/i.test(userMessage)) {
    await prisma.bookingDraft.deleteMany({ where: { id: draft.id, step: RESCHEDULE_COLLECTING_STEP } });
    return null;
  }
  const namedEdition = userMessage.match(new RegExp(`\\b(?:${PACKAGE_NAME_PATTERN})\\b`, 'i'))?.[0]?.toLowerCase();
  // Naming a different edition is a package change, not a pure date/time move; leave it to the general flow.
  const isOtherEdition = (service: string | null | undefined) => Boolean(namedEdition && service && !service.toLowerCase().includes(namedEdition));
  if (isOtherEdition(draft?.service)) return null;

  const booking = await prisma.booking.findFirst({
    where: { customerId, status: 'confirmed', dateTime: { gte: new Date() }, ...(draft?.bookingId && isActiveRescheduleDraft(draft) ? { id: draft.bookingId } : {}) },
    orderBy: { dateTime: 'asc' },
    select: { id: true, service: true, dateTime: true },
  });
  if (!booking || isOtherEdition(booking.service)) return null;

  const current = inBusinessTimezone(booking.dateTime);
  const existingDate = current.format('YYYY-MM-DD');
  const edition = editionInText(booking.service);
  let statedDate: string | null;
  try {
    statedDate = resolveCalendarDate(rescheduleTargetText(userMessage));
  } catch {
    return `That calendar date is not valid. Which date and time would you like for your session for ${edition}?`;
  }
  const newDate = statedDate || (draft?.step === RESCHEDULE_COLLECTING_STEP ? draft.date : null) || existingDate;
  const newDateLabel = businessDay(newDate).format('dddd, D MMMM');
  const newTime = conversationFlows.parseCustomerTime(rescheduleTargetText(userMessage));
  if (!newTime) {
    if (!statedDate && /\b(?:busy|unavailable|can't|cannot|not free|not available|other date|another date)\b/i.test(userMessage)) {
      return `Which new date and time would suit you for your session for ${edition}?`;
    }
    if (statedDate && draft?.step === RESCHEDULE_COLLECTING_STEP) {
      await prisma.bookingDraft.updateMany({ where: { id: draft.id, step: RESCHEDULE_COLLECTING_STEP, bookingId: booking.id }, data: { date: statedDate } });
    }
    return `What time on ${newDateLabel} would you like for your session for ${edition}?`;
  }
  if (newDate === existingDate && newTime === current.format('HH:mm')) {
    return `Your session for ${edition} is already on ${newDateLabel} at ${formatCustomerTime(newTime)}. Which other time would you like?`;
  }

  if (draft && draft.step === EARLY_SLOT_STEP && !draft.service && !draft.date) {
    // Slot memory can mistake a reschedule time for a new booking; that empty draft must not block the change.
    await prisma.bookingDraft.deleteMany({ where: { id: draft.id, step: EARLY_SLOT_STEP, service: null, date: null } });
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => booking.service.toLowerCase().includes(key));
  const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
  const slotsResult: any = await bookingService.getAvailableSlots(newDate, duration, booking.id);
  if (slotsResult?.status === 'closed') {
    return `${newDateLabel} is not available (${slotsResult.reason}). Which other date and time would you like?`;
  }
  const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
  if (!availableSlots.includes(newTime)) {
    if (!availableSlots.length) return `${newDateLabel} is fully booked. Which other date would work for you?`;
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const nearest = [...availableSlots]
      .sort((a, b) => Math.abs(minutes(a) - minutes(newTime)) - Math.abs(minutes(b) - minutes(newTime)))
      .slice(0, 3)
      .sort((a, b) => minutes(a) - minutes(b));
    const latest = availableSlots[availableSlots.length - 1];
    const reason = minutes(newTime) > minutes(latest)
      ? ` Your session runs ${formatAppointmentDuration(duration)}, so the latest start that day is ${formatCustomerTime(latest)}.`
      : '';
    return `${formatCustomerTime(newTime)} is not available on ${newDateLabel}.${reason} The closest available times are ${nearest.map(formatCustomerTime).join(', ')}. Which would work for you?`;
  }

  let result: { service: string; oldDateTime: Date };
  try {
    result = await executeProposeRescheduleTool(customerId, newDate, newTime);
  } catch (error: any) {
    console.error('[AGENT_FLOW] Reschedule proposal failed:', error?.message || error);
    return /^I have not changed your current request/.test(error?.message || '')
      ? error.message
      : 'I could not prepare that change, so your session is unchanged. The studio team can help on 0720 111928.';
  }
  if (notifyRescheduleAdmin) {
    await notifyRescheduleAdmin({
      customerId,
      event: 'proposed',
      service: result.service,
      oldDateTime: result.oldDateTime,
      newDate,
      newTime,
    });
  }

  const sameDay = newDate === existingDate;
  const from = sameDay ? formatCustomerTime(current.format('HH:mm')) : `${current.format('dddd, D MMMM')} at ${formatCustomerTime(current.format('HH:mm'))}`;
  const to = sameDay ? formatCustomerTime(newTime) : `${newDateLabel} at ${formatCustomerTime(newTime)}`;
  const policy = isRescheduleWithin72Hours(booking.dateTime)
    ? ' Because your session is within 72 hours, moving it will forfeit your deposit under our policy.'
    : ' Your edition and extras stay the same.';
  return `${newDateLabel} at ${formatCustomerTime(newTime)} is available. I can move your session for ${edition} from ${from} to ${to}.${policy} Would you like me to confirm the change?`;
}

export async function getInitialRescheduleReply(
  customerId: string,
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  notifyRescheduleAdmin?: (params: any) => Promise<void>
): Promise<string> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (draft && !isActiveRescheduleDraft(draft)
    && !(draft.step === EARLY_SLOT_STEP && !draft.service && !draft.date)) {
    const reason = draft.step === 'payment_pending'
      ? 'A deposit-payment step is still open on your account. Its payment status must be checked before I can start rescheduling.'
      : draft.step === 'awaiting_confirmation'
      ? 'A saved booking proposal is still awaiting your decision. It needs to be resolved before I can start rescheduling.'
      : draft.step === EARLY_SLOT_STEP
      ? 'Unfinished booking details are still saved on your account. They need to be checked before I can replace that request with a reschedule.'
      : 'Another saved booking step needs to be checked before I can start rescheduling.';
    return `I have not changed your current request or your session. ${reason} The studio team can help review it on 0720 111928. No session has been moved or cancelled by this request.`;
  }
  const bookings = await prisma.booking.findMany({
    where: { customerId, status: 'confirmed', dateTime: { gte: new Date() },
      ...(isActiveRescheduleDraft(draft) && draft?.bookingId ? { id: draft.bookingId } : {}) },
    orderBy: { dateTime: 'asc' }, take: 2, select: { id: true, service: true, dateTime: true },
  });
  if (!bookings.length) return 'I could not find an upcoming confirmed session to reschedule. The studio team can help check your booking.';
  if (bookings.length > 1) return `You have more than one upcoming session: ${bookings.map(booking => `${editionInText(booking.service)} on ${inBusinessTimezone(booking.dateTime).format('D MMMM YYYY [at] h:mm A')}`).join('; ')}. Which session would you like to reschedule?`;
  const booking = bookings[0];
  await rememberRescheduleContext(customerId, booking);
  const target = rescheduleTargetText(message);
  if (conversationFlows.hasRescheduleSlotSignal(target)) {
    const selection = await getRescheduleSelectionReply(customerId, target, history, notifyRescheduleAdmin);
    if (selection) return selection;
  }
  if (isRescheduleWithin72Hours(booking.dateTime)) return getReschedulePolicyMessage();
  if (conversationFlows.isTimeOnlyRescheduleRequest(message) || /\bother time\b/i.test(message)) {
    return `Of course. Your ${booking.service} session is currently on ${inBusinessTimezone(booking.dateTime).format('dddd, MMMM D')} at ${inBusinessTimezone(booking.dateTime).format('h:mm A')}. What time would work better for you that day?`;
  }
  return `Which new date and time would suit you for your session for ${editionInText(booking.service)}? Your current booking remains unchanged until you confirm a proposed change.`;
}

