import { PACKAGE_NAMES_FOR_EXTRACTION } from '../../config/constants';
import { EARLY_SLOT_STEP, isUsableName, sanitizeSlotValue } from './slot-memory';
import { normalizeQuotes } from './regex';
import { inBusinessTimezone } from '../../utils/time';

type ConfirmedSession = { status: string; service: string; dateTime: Date };

export function isCustomerNameQuestion(message: string): boolean {
  return /\bwhat(?:'s|s| is)\s+my\s+(?:full\s+)?name\b|\b(?:do|can)\s+you\s+(?:know|remember|recall)\s+my\s+(?:full\s+)?name\b|\b(?:tell|remind)\s+me\s+(?:of\s+)?my\s+name\b|\bwhat\s+name\s+(?:do you have|have you saved)\s+for me\b/i.test(normalizeQuotes(message));
}

export function savedCustomerNameReply(name?: string | null): string {
  const savedName = name ? sanitizeSlotValue(name) : '';
  return isUsableName(savedName) && !/^(?:send|resend|show|give|share)\s+me\b/i.test(savedName)
    ? `I have your name saved as ${savedName}.`
    : "I don't have your name saved yet. What name should I use?";
}

export function confirmedSessionReply(booking: ConfirmedSession): string {
  return `Your ${editionInText(booking.service).replace(/^the /, '')} session on ${inBusinessTimezone(booking.dateTime).format('dddd, D MMMM YYYY [at] h:mm A')} remains confirmed.`;
}

export function editionInText(name: string): string {
  const canonical = PACKAGE_NAMES_FOR_EXTRACTION.find((edition) => edition.toLowerCase() === name.trim().toLowerCase());
  if (!canonical) return name;
  const label = canonical.replace(/^THE /, '').toLowerCase();
  return `the ${label[0].toUpperCase()}${label.slice(1)} edition`;
}

export function repeatedCollectionQuestion(
  modelReply: string,
  draft: { step: string; name?: string | null; service?: string | null; date?: string | null; time?: string | null } | null,
  customerName?: string | null,
  userMessage = '',
  upcomingBooking?: ConfirmedSession | null,
): string | null {
  const reply = normalizeQuotes(modelReply);
  const asksForName = /\b(?:what(?:'s| is)|give|tell|share|provide|have)\b[^?]{0,60}\b(?:your|the)\s+(?:full\s+)?name\b/i.test(reply);
  if (!draft && upcomingBooking?.status === 'confirmed' && reply.includes('?')
    && !/\b(?:book|schedule|reserve|change|different|recommend|compare|instead|correct)\b|\b(?:new|another|second|separate)\s+(?:session|shoot|booking|appointment)\b/i.test(userMessage)
    && (asksForName || /\b(?:which|what)\s+(?:package|edition)\b|\b(?:share|give|tell|provide|have)\b[^?]{0,60}\b(?:the\s+package|preferred\s+(?:date|time))\b/i.test(reply))) {
    return confirmedSessionReply(upcomingBooking);
  }
  if (!draft && isUsableName(customerName) && reply.includes('?') && asksForName
    && !/\b(?:change|correct|recipient|someone else)\b/i.test(userMessage)) return savedCustomerNameReply(customerName);
  if (draft?.step !== EARLY_SLOT_STEP || !reply.includes('?') || /\b(?:change|different|recommend|compare|instead|correct)\b/i.test(userMessage)) return null;
  const name = draft.name || (customerName && !/^(?:Unknown|WhatsApp User)$/i.test(customerName) ? customerName : null);
  const repeatsName = isUsableName(name) && asksForName;
  const asksEditionChoice =
    /\b(?:which|what)\s+(?:package|edition)\b/i.test(reply)
    || /\b(?:bloom|muse|icon|legend|queen|empress|goddess)\b[\s\S]{0,40}\bor\b[\s\S]{0,40}\b(?:bloom|muse|icon|legend|queen|empress|goddess)\b/i.test(reply)
    || /\b(?:looking to book|would you like to book|prefer a different edition)\b/i.test(reply);
  const userAlreadyNamedEdition =
    /\b(?:bloom|muse|icon|legend|queen|empress|goddess)\b/i.test(userMessage)
    && /\b(?:already|said|chose|chosen|choosen|picked|selected|muse|bloom|icon|legend|queen|empress|goddess)\b/i.test(userMessage);
  const repeatsEdition = asksEditionChoice && (Boolean(draft.service) || userAlreadyNamedEdition);
  if (!repeatsName && !repeatsEdition) return null;
  if (!draft.service && !userAlreadyNamedEdition) return 'Which edition would you like to consider?';
  if (!draft.date && !/\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th)?)\b/i.test(userMessage)) {
    return 'What date would suit you?';
  }
  if (!draft.time && !/\b\d{1,2}(?:[:.\s]\d{2})?\s*(?:am|pm)\b/i.test(userMessage)) {
    return 'What time would suit you?';
  }
  return 'Your session details are noted. Would you like to go ahead?';
}

export function needsUnchangedReassurance(message: string): boolean {
  return /\b(?:did|does|will|would|have|has)\b.*\b(?:change|changed|affect)\b.*\b(?:booking|edition|package|date)\b/i.test(message);
}