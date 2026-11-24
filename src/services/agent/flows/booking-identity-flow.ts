import dayjs from 'dayjs';
import prisma from '../../../config/prisma';
import {
  PACKAGE_NAMES_FOR_EXTRACTION,
  SERVICE_DURATIONS,
  DEFAULT_DURATION,
} from '../../../config/constants';
import { bookingService } from '../../booking/booking.service';
import { bookingDraftService } from '../../booking/booking-draft.service';
import { nowInBusinessTimezone, inBusinessTimezone } from '../../../utils/time';
import { isBookingForSomeoneElseRequest } from '../replies';

function isAvailableSlotList(result: string[] | { status: string; reason: string }): result is string[] {
  return Array.isArray(result);
}

export function isBookingIdentityCorrection(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /\b(mixing|mixed up)\b.{0,100}\b(session|booking)s?\b/.test(text)
    || /\bthat(?:'s| is) mine\b.{0,100}\b(new|another|separate)\b/.test(text)
    || /\bcreating a new one\b/.test(text);
}

export function getRequestedBookingFromHistory(
  history: { role: 'user' | 'assistant'; content: string }[]
): { recipient: string | null; service: string | null; date: string; time: string } | null {
  const userMessages = history.filter((message) => message.role === 'user');
  const requestedDateTimeMessage = [...userMessages].reverse().find((message) =>
    /\b\d{1,2}(?:st|nd|rd|th)?\b[\s\S]{0,24}\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(message.content)
  );
  if (!requestedDateTimeMessage) return null;

  const match = requestedDateTimeMessage.content.match(
    /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))?(?:,?\s+(\d{4}))?[\s\S]{0,24}?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i
  );
  if (!match) return null;

  const day = Number(match[1]);
  const monthName = match[2]?.slice(0, 3).toLowerCase();
  const monthIndex = monthName
    ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthName)
    : nowInBusinessTimezone().month();
  const explicitYear = match[3] ? Number(match[3]) : null;
  let requestedDate = nowInBusinessTimezone()
    .year(explicitYear || nowInBusinessTimezone().year())
    .month(monthIndex)
    .date(day);
  if (!requestedDate.isValid() || requestedDate.date() !== day || requestedDate.month() !== monthIndex) return null;
  if (!explicitYear && requestedDate.isBefore(nowInBusinessTimezone(), 'day')) {
    requestedDate = monthName ? requestedDate.add(1, 'year') : nowInBusinessTimezone().add(1, 'month').date(day);
  }

  const rawHour = Number(match[4]);
  const minute = Number(match[5] || 0);
  if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
  const hour = rawHour % 12 + (match[6].toLowerCase() === 'pm' ? 12 : 0);
  const service = PACKAGE_NAMES_FOR_EXTRACTION.find((packageName) =>
    userMessages.some((message) => message.content.toLowerCase().includes(packageName.toLowerCase()))
  ) || null;
  const recipientFromCustomer = [...userMessages].reverse()
    .map((message) => message.content.match(/\bfor\s+(?:my\s+(?:sister|brother|friend|husband|wife|partner|mother|father|daughter|son)\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/))
    .find(Boolean)?.[1] || null;

  return {
    recipient: recipientFromCustomer,
    service,
    date: requestedDate.format('YYYY-MM-DD'),
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

export async function getBookingIdentityCorrectionReply(
  customerId: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string> {
  const request = getRequestedBookingFromHistory(history);
  const draft = await bookingDraftService.get(customerId);
  const recipient = draft?.recipientName || request?.recipient;
  if (!request?.service || !request.date || !request.time || !recipient) {
    return 'You’re right, I mixed up the sessions. Your existing appointment will remain unchanged, and I will not treat the separate booking as confirmed. Please confirm the recipient, package, date, and time for the new session.';
  }

  const duration = SERVICE_DURATIONS[request.service.toLowerCase()];
  const slotsResult = await bookingService.getAvailableSlots(request.date, duration || DEFAULT_DURATION);
  if (!isAvailableSlotList(slotsResult) && slotsResult.status === 'closed') {
    return `You’re right, I mixed up the sessions. Your existing appointment is unchanged. The separate ${request.service} request for ${recipient} is not booked; the studio is closed on ${inBusinessTimezone(request.date).format('dddd, D MMMM')}. Please choose another date.`;
  }

  const availableSlots: string[] = Array.isArray(slotsResult) ? slotsResult : [];
  if (!availableSlots.includes(request.time)) {
    const alternatives = availableSlots.slice(0, 4)
      .map((time) => dayjs(`2000-01-01T${time}`).format('h:mm A'))
      .join(', ');
    return `You’re right, I mixed up the sessions. Your existing appointment is unchanged. The separate ${request.service} session for ${recipient} on ${inBusinessTimezone(request.date).format('dddd, D MMMM')} at ${dayjs(`2000-01-01T${request.time}`).format('h:mm A')} is not available, so I have not created another booking. Available times are ${alternatives || 'none'}. Which would work?`;
  }

  return `You’re right, I mixed up the sessions. Your existing appointment is unchanged. I understand this is a separate ${request.service} booking for ${recipient}. ${inBusinessTimezone(request.date).format('dddd, D MMMM')} at ${dayjs(`2000-01-01T${request.time}`).format('h:mm A')} is available, but it is not booked yet. What is ${recipient}’s full name so I can prepare the booking correctly?`;
}

export function shouldClarifyBookingForSomeoneElse(userMessage: string): boolean {
  return isBookingForSomeoneElseRequest(userMessage);
}

export function extractStandaloneFullName(userMessage: string): string | null {
  const candidate = userMessage.trim().replace(/[^a-zA-Z' -]/g, '').replace(/\s+/g, ' ');
  if (!/^[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3}$/.test(candidate)) return null;
  return candidate.split(' ').map((part) => `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`).join(' ');
}

export function shouldCaptureRecipientName(
  userMessage: string,
  history: { role: 'user' | 'assistant', content: string }[]
): boolean {
  const name = extractStandaloneFullName(userMessage);
  if (!name) return false;
  const recentHistory = history.slice(-8);
  const askedAboutBookingSubject = recentHistory
    .filter((message) => message.role === 'assistant')
    .some((message) => /session just for (?:your|her|his)|both (?:of )?you.*photographed together|booking.*for.*sister|booking.*for.*brother/i.test(message.content));
  const bookingForSomeoneElse = recentHistory
    .filter((message) => message.role === 'user')
    .some((message) => shouldClarifyBookingForSomeoneElse(message.content));
  return askedAboutBookingSubject || bookingForSomeoneElse;
}

export async function captureRecipientName(customerId: string, userMessage: string): Promise<string | null> {
  const recipientName = extractStandaloneFullName(userMessage);
  if (!recipientName) return null;

  await prisma.bookingDraft.upsert({
    where: { customerId },
    update: { name: recipientName, recipientName, isForSomeoneElse: true, step: 'service' },
    create: { customerId, name: recipientName, recipientName, isForSomeoneElse: true, step: 'service' },
  });
  return recipientName;
}
