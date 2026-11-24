import prisma from '../../config/prisma';
import { ADDON_CATALOG, PACKAGE_NAMES_FOR_EXTRACTION, SERVICE_DURATIONS } from '../../config/constants';
import { bookingService } from '../booking/booking.service';
import { bookingStateService } from '../booking/booking-state.service';
import { bookingDateFacts, formatCustomerDate, nowInBusinessTimezone } from '../../utils/time';
import { EARLY_SLOT_STEP, alternativeDates, carriedOverStale, closedDateReply, earlySlotsExpired, extractStatedSlots, isUsableName } from './slot-memory';
import { buildBookingProposalConfirmation, formatCustomerTime } from './replies';
import { editionInText } from './reply-voice';

type Message = { role: 'user' | 'assistant'; content: string };
export type BookingStep = 'need_package' | 'need_date' | 'need_time' | 'need_name' | 'need_addon_decision' | 'ready_to_propose';
export type BookingSlots = { service?: string | null; date?: string | null; time?: string | null; name?: string | null; addonsDecided?: boolean };

/** What a collecting draft still needs, in the order it is asked. A first name satisfies the name step. */
export function nextStep(slots: BookingSlots): BookingStep {
  if (!slots.service) return 'need_package';
  if (!slots.date) return 'need_date';
  if (!slots.time) return 'need_time';
  if (!isUsableName(slots.name)) return 'need_name';
  if (!slots.addonsDecided) return 'need_addon_decision';
  return 'ready_to_propose';
}

export const ADDON_DECISION_QUESTION = 'Would you like any optional add-ons, such as an extra outfit or styled wig hire?';
export const ADDON_OTHER_DECISION_QUESTION = 'Would you like any other optional add-ons, such as an extra outfit or styled wig hire?';
export const STEP_QUESTIONS: Record<Exclude<BookingStep, 'ready_to_propose'>, string> = {
  need_package: 'Which edition would you like?',
  need_date: 'What date would suit you?',
  need_time: 'What time would suit you?',
  need_name: 'May I have your name for the booking details?',
  need_addon_decision: ADDON_DECISION_QUESTION,
};

export function editionShortName(service: string): string {
  const canonical = PACKAGE_NAMES_FOR_EXTRACTION.find((name) => name.toLowerCase() === service.trim().toLowerCase()) || service;
  const word = canonical.replace(/^THE\s+/i, '').toLowerCase();
  return `${word[0].toUpperCase()}${word.slice(1)}`;
}

export function addonPickQuestion(service?: string | null): string {
  return `Tell me which you would like${service ? ` for your ${editionShortName(service)} session` : ''}, or say no to skip them.`;
}

function joinTimes(times: string[]): string {
  const labels = times.map(formatCustomerTime);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
}

/** At most four evenly spread times, so a full day is never one long list. */
export function sampleSlots(slots: string[], count = 4): string[] {
  if (slots.length <= count) return slots;
  return Array.from({ length: count }, (_, index) => slots[Math.round(index * (slots.length - 1) / (count - 1))]);
}

function nearestSlots(slots: string[], time: string, count = 3): string[] {
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return [...slots].sort((a, b) => Math.abs(minutes(a) - minutes(time)) - Math.abs(minutes(b) - minutes(time)))
    .slice(0, count).sort((a, b) => minutes(a) - minutes(b));
}

export function openTimesReply(date: string, service: string, slots: string[]): string {
  const shown = sampleSlots(slots);
  const times = shown.length < slots.length ? `Available times include ${joinTimes(shown)}, with others in between.` : `Available times: ${joinTimes(shown)}.`;
  return `${formatCustomerDate(date)} is open for ${editionInText(service)}. ${times} Which time would suit you?`;
}

export function unavailableTimeReply(date: string, time: string, slots: string[]): string {
  const nearest = nearestSlots(slots, time);
  return `${formatCustomerTime(time)} is not available on ${formatCustomerDate(date)}. The nearest open ${nearest.length > 1 ? 'times are' : 'time is'} ${joinTimes(nearest)}. Which would suit you?`;
}

/** Bound to the draft id, so the decision survives the six-message history window but not a new draft. */
export async function recordAddonDecision(customerId: string, draftId: string): Promise<void> {
  return bookingStateService.markAddonsDecided(customerId, draftId);
}

async function addonsDecided(this: any, customerId: string, draft: { id: string; createdAt: Date }, history: Message[]): Promise<boolean> {
  return bookingStateService.hasAddonsDecided(customerId, draft, history, (msg, hist) => this.isDecliningOptionalAddons(msg, hist));
}

export function welcomePrefix(message: string, history: Message[]): string {
  const name = /\bmy name is\b/i.test(message) ? extractStatedSlots(message, history).name : undefined;
  return name ? `Welcome, ${name.split(' ')[0]}. ` : '';
}

export const CARRY_OVER_PREFIX = 'Last time you were looking at';

/** Names only the carried-over details the customer did not restate in this message. */
export function carryOverQuestion(draft: { service?: string | null; date?: string | null; time?: string | null }, restated: BookingSlots): string | null {
  const service = !restated.service ? draft.service : null;
  const date = !restated.date ? draft.date : null;
  const time = !restated.time ? draft.time : null;
  if (!service && !date && !time) return null;
  const when = `${date ? ` on ${formatCustomerDate(date)}` : ''}${time ? ` at ${formatCustomerTime(time)}` : ''}`;
  return service
    ? `${CARRY_OVER_PREFIX} ${editionInText(service)}${when}. Would you like to continue with that, or choose a different one?`
    : `${CARRY_OVER_PREFIX} a session${when}. Would you like to keep that, or choose a different ${date ? 'date' : 'time'}?`;
}

export async function bookingProgressReply(this: any, customerId: string, message: string, history: Message[], decisionJustSaved = false, force = false): Promise<string | null> {
  const reply = await progressReply.call(this, customerId, message, history, decisionJustSaved, force);
  return reply ? `${welcomePrefix(message, history)}${reply}` : reply;
}

/** The customer offered several dates and asked us to choose: take the first one that is open, in her order. */
export async function alternativeDatesReply(this: any, customerId: string, message: string, history: Message[]): Promise<string | null> {
  const dates = alternativeDates(message, history);
  if (dates.length < 2) return null;
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!draft || draft.step !== EARLY_SLOT_STEP || earlySlotsExpired(draft) || carriedOverStale(draft) || draft.isForSomeoneElse || !draft.service) return null;
  const key = Object.keys(SERVICE_DURATIONS).find((value) => draft.service!.toLowerCase().includes(value));
  if (!key) return null;
  const time = extractStatedSlots(message, history).time || draft.time;
  for (const date of dates) {
    const facts = bookingDateFacts(date);
    if (facts.isMonday || facts.isPast) continue;
    const slots = await bookingService.getAvailableSlots(date, SERVICE_DURATIONS[key], undefined, draft.id);
    const open: string[] = Array.isArray(slots) ? slots : [];
    if (!open.length || (time && !open.includes(time))) continue;
    await prisma.bookingDraft.updateMany({ where: { id: draft.id, step: EARLY_SLOT_STEP }, data: { date, ...(time ? { time } : {}), dateTimeIso: null } });
    const lead = date === dates[0] ? `I'll go with ${formatCustomerDate(date)}.`
      : `${formatCustomerDate(dates[0])} is not available${time ? ` at ${formatCustomerTime(time)}` : ''}, so I'll go with ${formatCustomerDate(date)}.`;
    const next = await bookingProgressReply.call(this, customerId, `on ${date}`, history, false, true);
    return next ? `${lead} ${next}` : lead;
  }
  const days = dates.map(formatCustomerDate);
  return `${days.slice(0, -1).join(', ')} and ${days.at(-1)} are not available${time ? ` at ${formatCustomerTime(time)}` : ''}. Which other date would work for you?`;
}

async function progressReply(this: any, customerId: string, message: string, history: Message[], decisionJustSaved: boolean, force: boolean): Promise<string | null> {
  const stated = extractStatedSlots(message, history);
  const dateTimeTurn = Boolean(stated.date || stated.time);
  const declinedNow = this.isDecliningOptionalAddons(message, history);
  const relevant = force || decisionJustSaved || declinedNow || dateTimeTurn || Boolean(stated.name)
    || /\b(?:okay|ok|yes+|so|ready|go ahead|that it|skip|do it|let'?s do it|go for it|book it|lock it in|proceed|confirm|sounds good|that works|ndio|sawa)\b/i.test(message);
  if (!relevant) return null;
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!draft || draft.step !== EARLY_SLOT_STEP || earlySlotsExpired(draft) || draft.isForSomeoneElse || !draft.service) return null;
  if ((!draft.date || !draft.time) && !dateTimeTurn && !force) return null;
  if (draft.date) {
    const facts = bookingDateFacts(draft.date);
    if (facts.isMonday || facts.isPast) return closedDateReply(facts);
    if (draft.date === nowInBusinessTimezone().format('YYYY-MM-DD') && nowInBusinessTimezone().hour() >= 19) {
      return 'The studio is closed for today. Which other date would work for you?';
    }
  }
  const key = Object.keys(SERVICE_DURATIONS).find((value) => draft.service!.toLowerCase().includes(value));
  if (!key) return 'The team will confirm that edition before we continue.';
  if (!draft.date) return STEP_QUESTIONS.need_date;
  const slots = await bookingService.getAvailableSlots(draft.date, SERVICE_DURATIONS[key], undefined, draft.id);
  const open: string[] = Array.isArray(slots) ? slots : [];
  if (!open.length) {
    const today = nowInBusinessTimezone().format('YYYY-MM-DD');
    if (draft.date === today) {
      return `There are no more sessions available today for ${editionInText(draft.service)}. Which other date would work for you?`;
    }
    return `${formatCustomerDate(draft.date)} is fully booked for ${editionInText(draft.service)}. Which other date would work for you?`;
  }
  const selectedTime = stated.time || draft.time;

  if (!selectedTime) {
    return openTimesReply(draft.date, draft.service, open);
  }

  if (!open.includes(selectedTime)) {
    return unavailableTimeReply(draft.date, selectedTime, open);
  }

  // Save the selected time only after checking actual slot availability.
  if (stated.time && stated.time !== draft.time) {
    const updated = await prisma.bookingDraft.updateMany({
      where: {
        id: draft.id,
        step: EARLY_SLOT_STEP,
      },
      data: {
        time: selectedTime,
        dateTimeIso: null,
      },
    });

    if (updated.count === 0) {
      return 'I could not save that time just now. Please choose your preferred time again.';
    }
  }

  const lead = dateTimeTurn
    ? `${formatCustomerTime(selectedTime)} on ${formatCustomerDate(draft.date)} is available for ${editionInText(draft.service)}. `
    : '';
  if (!isUsableName(draft.name)) return `${lead}${STEP_QUESTIONS.need_name}`;
  if (declinedNow) await recordAddonDecision(customerId, draft.id);
  if (!decisionJustSaved && !declinedNow && !await addonsDecided.call(this, customerId, draft, history)) {
    const discussed = history.some((entry) => entry.role === 'user' && ADDON_CATALOG.some((item) => item.match.test(entry.content)));
    return `${lead}${discussed ? ADDON_OTHER_DECISION_QUESTION : ADDON_DECISION_QUESTION}`;
  }
  try {
    const result = await this.executeProposeBookingTool(
  customerId,
  draft.name,
  draft.service,
  `${draft.date}T${selectedTime}`
);

return buildBookingProposalConfirmation(
  draft.service,
  draft.date,
  selectedTime,
  result.depositAmount
);
  } catch {
    return 'The team will help verify these booking details before payment instructions are shared.';
  }
}