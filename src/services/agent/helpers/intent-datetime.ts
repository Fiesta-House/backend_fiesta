import dayjs from 'dayjs';
import {
  findExplicitDate,
  findExplicitDayOfMonth,
  resolveCalendarDate,
} from '../extraction';
import {
  businessDay,
  bookingDateFacts,
  nowInBusinessTimezone,
} from '../../../utils/time';
import { RESCHEDULE_KEYWORD_PATTERN, normalizeQuotes } from '../regex';
import { ADDON_CATALOG } from '../../../config/constants';

export function messageContainsExplicitDateTimeSignal(message: string): boolean {
  return messageContainsExplicitDateSignal(message) && messageContainsExplicitTimeSignal(message);
}

export function messageContainsExplicitDateSignal(message: string): boolean {
  const text = message.toLowerCase();
  return findExplicitDayOfMonth(text) !== null
    || /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|next\s+week)\b|\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/.test(text);
}

export function messageContainsExplicitTimeSignal(message: string): boolean {
  const text = message.toLowerCase();
  // Matches: "2pm", "2:30pm", "2.30pm", "14:30", "14.30", "2:30", "2.30"
  return /\b\d{1,2}(?:[:.\u{FF0E}]\d{2})?\s*(?:am|pm)\b|\b\d{1,2}[:.\u{FF0E}]\d{2}\b/iu.test(text);
}

export function hasRescheduleDateTimeSignal(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const hasDate = messageContainsExplicitDateSignal(userMessage);
  const hasTime = messageContainsExplicitTimeSignal(userMessage);
  if (hasDate && hasTime) return true;
  if (!hasDate && !hasTime) return false;
  const recentUserMessages = history.filter((m) => m.role === 'user').slice(-3).map((m) => m.content);
  return hasDate
    ? recentUserMessages.some((m) => messageContainsExplicitTimeSignal(m))
    : recentUserMessages.some((m) => messageContainsExplicitDateSignal(m));
}

export function getContextualBookingWeekdayDate(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): string | null {
  const weekdayPattern = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
  const bookingContextPattern = /\b(slots?|availability|available|booking|book|session|appointment|schedule)\b/i;
  const contextualText = weekdayPattern.test(userMessage)
    ? userMessage
    : [...history].reverse().find((message) =>
      bookingContextPattern.test(message.content) && weekdayPattern.test(message.content)
    )?.content;
  const weekdayName = contextualText?.match(weekdayPattern)?.[1]?.toLowerCase();
  if (!weekdayName) return null;

  const weekdays: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const weekday = weekdays[weekdayName];
  const explicitDate = contextualText?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (explicitDate && dayjs(explicitDate).isValid() && dayjs(explicitDate).day() === weekday) {
    return explicitDate;
  }

  const now = nowInBusinessTimezone();
  let date = now.day(weekday);
  if (date.isBefore(now, 'day') || (date.isSame(now, 'day') && /\bnext\b/i.test(contextualText || ''))) {
    date = date.add(7, 'day');
  }
  return date.format('YYYY-MM-DD');
}

export function getAuthoritativeRequestedDate(
  userMessage: string,
  proposedDate: string,
  extractedDate?: string | null,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): string {
  const explicit = findExplicitDate(userMessage);
  if (explicit?.month === null && extractedDate && !/\b(?:19|20)\d{2}\b/.test(userMessage)) {
    const facts = bookingDateFacts(extractedDate);
    if (!facts.isPast && businessDay(extractedDate).date() === explicit.day) return extractedDate;
  }
  const statedDate = resolveCalendarDate(userMessage);
  if (statedDate) return statedDate;
  const hasDayOfMonth = findExplicitDayOfMonth(userMessage) !== null;
  if (!hasDayOfMonth) {
    const weekdayDate = getContextualBookingWeekdayDate(userMessage, history);
    return weekdayDate || proposedDate;
  }
  if (!extractedDate) return proposedDate;
  bookingDateFacts(extractedDate);
  return extractedDate;
}

export function getWeekdayReply(
  userMessage: string,
  history: { role: 'user' | 'assistant', content: string }[] = []
): string | null {
  const statedDate = resolveCalendarDate(userMessage);
  if (statedDate) {
    const date = businessDay(statedDate);
    return `${date.format('D MMMM YYYY')} is a ${date.format('dddd')}.`;
  }
  const match = userMessage.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (!match) return null;

  const day = Number(match[1]);
  if (day < 1 || day > 31) return null;

  const recentDateMention = [...history]
    .reverse()
    .map((message) => message.content.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/i))
    .find((dateMatch) => dateMatch && Number(dateMatch[1]) === day);

  if (recentDateMention) {
    const contextualDate = businessDay(resolveCalendarDate(recentDateMention[0])!);
    if (contextualDate.isValid()) {
      return `${contextualDate.format('MMMM D, YYYY')} is a ${contextualDate.format('dddd')}.`;
    }
  }

  const current = nowInBusinessTimezone();
  let date = current.date(day);
  if (date.isBefore(current, 'day')) date = date.add(1, 'month');

  return `${date.format('MMMM D, YYYY')} is a ${date.format('dddd')}.`;
}

export function inferIntent(userMessage: string): { intent: string; confidence: number; rule: string } {
  const text = userMessage.toLowerCase();

  if (RESCHEDULE_KEYWORD_PATTERN.test(text)) return { intent: 'reschedule', confidence: 0.92, rule: 'reschedule_keywords' };
  if (/(\bbook(?:s|ed|ing)?\b|appointment|session)/.test(text)) return { intent: 'booking', confidence: 0.88, rule: 'booking_keywords' };
  if (/(\bpa(?:y|ys|ying|id|yment|yments)\b|mpesa|deposit|receipt|balance)/.test(text)) return { intent: 'payment', confidence: 0.9, rule: 'payment_keywords' };
  if (/(price|cost|package|rate|services|service list)/.test(text)) return { intent: 'pricing', confidence: 0.86, rule: 'pricing_keywords' };
  if (/(where|location|located|address)/.test(text)) return { intent: 'location', confidence: 0.9, rule: 'location_keywords' };
  if (/(time|hours|open|close|availability|available|how long|duration)/.test(text)) return { intent: 'availability', confidence: 0.82, rule: 'availability_keywords' };

  return { intent: 'general_inquiry', confidence: 0.35, rule: 'fallback_default' };
}

export function inferOutcome(aiResponse: string, isFallback: boolean): string {
  if (isFallback) return 'escalated';

  const text = aiResponse.toLowerCase();
  if (text.includes('m-pesa') && text.includes('deposit')) return 'booked';
  if (text.includes('rescheduled')) return 'resolved';
  if (text.includes('team member') || text.includes('follow up')) return 'escalated';

  return 'resolved';
}

export function getUnverifiedActionReply(
  modelReply: string,
  done: { rescheduled: boolean; cancelled: boolean; noteSaved: boolean }
): string | null {
  const reply = normalizeQuotes(modelReply);
  const claimsRescheduled = /\b(?:has been|have been|is now|i've|i have|successfully)\s+(?:rescheduled|moved)\b/i.test(reply);
  if (claimsRescheduled && !done.rescheduled) {
    return "Sorry, I haven't been able to apply that reschedule yet, so your booking is still on its original date and time. Please send the new date and time together (e.g. \"8th October at 3pm\") and I'll confirm it.";
  }
  const claimsCancelled = /\b(?:has been|have been|i've|i have|successfully)\s+cancell?ed\b/i.test(reply);
  if (claimsCancelled && !done.cancelled) {
    return "Sorry, I haven't been able to cancel that booking yet - it is still active. Please tell me the date of the session you'd like to cancel.";
  }
  const claimsAddonSaved = /\b(?:i've|i have)\s+(?:added|noted|included|recorded)\b|\bhas been added\b/i.test(reply)
    && (/add-?on|extra/i.test(reply) || ADDON_CATALOG.some((item) => item.match.test(reply)));
  if (claimsAddonSaved && !done.noteSaved) {
    return "Sorry, I couldn't save that add-on just yet. Please tell me the add-on and quantity (e.g. \"2 extra outfits\") and I'll record it.";
  }
  return null;
}
