import prisma from '../../../config/prisma';
import {
  ADDON_CATALOG,
  PACKAGE_NAMES_FOR_EXTRACTION,
  type AddonCatalogItem,
} from '../../../config/constants';
import { inBusinessTimezone } from '../../../utils/time';
import { addonDetail } from '../addon-capture';
import {
  ADDON_BALANCE_REPLY,
  ADDON_LINK_REPLY,
  ADDON_NOTED_PREFIX,
  ADDON_QUOTED_PRICE_LABEL,
  ADDON_UNCHANGED_REPLY,
  EDITION_LINK_REPLY,
  OFFICIAL_WEBSITE_URLS,
} from '../constants';
import { addonPickQuestion, nextStep, STEP_QUESTIONS } from '../booking-progress';
import { explicitCatalogListRequest, type CatalogKind } from '../catalog-policy';
import { resolveCalendarDate } from '../extraction';
import { normalizeQuotes } from '../regex';
import { EARLY_SLOT_STEP, earlySlotsExpired } from '../slot-memory';
import { isFamilyPhotoCountQuestion } from '../verified-facts';
import {
  getDepositForPackage,
  getPackageForDeposit,
} from '../booking-tools';
import {
  getPackageCatalogReply,
} from '../package-replies';
import {
  shouldUseInvoiceRequestReply,
} from '../invoice-tools';
import {
  shouldUseUpcomingAppointmentDetailsReply,
} from '../appointment-replies';
import {
  messageContainsExplicitDateSignal,
  messageContainsExplicitTimeSignal,
} from './intent-datetime';

export function isUnverifiedBookingConfirmation(
  modelReply: string,
  userMessage: string,
  _history: { role: 'user' | 'assistant'; content: string }[],
  existingBooking?: { dateTime: Date; status: string }
): boolean {
  const reply = normalizeQuotes(modelReply);
  const claimsConfirmed = /\b(?:confirmed\s+(?:session|appointment|booking)|(?:booking|session|appointment)\s+(?:is|has been)\s+confirmed|session is all set|successfully booked|payment has gone through|payment is received and confirmed)\b/i.test(reply);
  if (!claimsConfirmed) return false;
  const asksExisting = /\b(?:existing|upcoming|already booked|confirmed)\b.*\b(?:session|appointment|booking)\b|\b(?:session|appointment|booking)\b.*\b(?:existing|upcoming|already booked)\b/i.test(userMessage);
  if (!asksExisting || existingBooking?.status !== 'confirmed' || /\b(?:payment|deposit)\b/i.test(reply)) return true;
  try {
    const date = resolveCalendarDate(reply);
    const timeMatch = reply.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{2}):(\d{2})\b/i);
    if (!date || !timeMatch) return true;
    const hour = timeMatch[4] ? Number(timeMatch[4]) : Number(timeMatch[1]) % 12 + (timeMatch[3].toLowerCase() === 'pm' ? 12 : 0);
    const minute = Number(timeMatch[5] || timeMatch[2] || 0);
    const stored = inBusinessTimezone(existingBooking.dateTime);
    return date !== stored.format('YYYY-MM-DD') || hour !== stored.hour() || minute !== stored.minute();
  } catch {
    return true;
  }
}

export function shouldClarifyMixedIntent(this: any, userMessage: string): boolean {
  const checkUpcoming = this?.shouldUseUpcomingAppointmentDetailsReply
    ? this.shouldUseUpcomingAppointmentDetailsReply(userMessage)
    : shouldUseUpcomingAppointmentDetailsReply(userMessage);
  if (checkUpcoming) return false;

  const text = userMessage.toLowerCase();
  const checkInvoice = this?.shouldUseInvoiceRequestReply
    ? this.shouldUseInvoiceRequestReply(userMessage)
    : shouldUseInvoiceRequestReply(userMessage);
  const invoiceForSession = checkInvoice
    && /\b(session|shoot|appointment|booking)\b/.test(text)
    && !/\b(book|schedule|reschedule|cancel)\b/.test(text);
  if (invoiceForSession) return false;

  const hasInvoice = /(invoice|receipt|payment summary)/.test(text);
  const hasPackage = /(package|session|shoot|service|edition|the bloom|the icon|the empress|the royal|gold|platinum|vip|vvip)/.test(text);
  const hasDate = /(next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\b\d{1,2}(?:st|nd|rd|th)?\b|tomorrow|today|weekend)/.test(text);
  const hasBookingAction = /\b(book|booking|schedule|rescheduling|reschedule|cancel|appointment)\b/.test(text);

  const matchedSignals = [hasInvoice, hasPackage, hasDate, hasBookingAction].filter(Boolean).length;
  return matchedSignals >= 3 && !(hasInvoice && !hasPackage && !hasDate && !hasBookingAction);
}

export function shouldClarifyNewAddon(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const text = userMessage.toLowerCase();
  if (!/\b(add|include|put)\b.*\b(new|another|one more)\b|\b(new|another|one more)\b.*\b(add|extra)\b/.test(text)) return false;
  return history.slice(-8).some((message) => /add-on|addon|extra outfit|styled wig|extra edited photo|extra makeup/i.test(message.content));
}

export function isDecliningOptionalAddons(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const lastAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
  return /^(?:no(?:\s*,?\s*i\s+(?:do(?:n't| not)\s+want|don't need))?.*|none|skip|no thanks|no thank you|i\s+(?:don't|dont|do not)\s+(?:want|need)\s+(?:them|(?:any\s+|the\s+)?(?:extras|add-ons|additions))(?:\s+(?:please|thanks|thank you))?)\s*[.!]*$/i.test(userMessage.trim())
    && /optional (?:add-ons|extras|additions)|(?:add-ons|extras|additions).*(?:optional|include|like)/i.test(lastAssistantMessage);
}

export function shouldExposeTools(
  this: any,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  platform: string
): boolean {
  if (platform !== 'whatsapp' && platform !== 'web') return false;

  const text = userMessage.toLowerCase();

  const asksBookingHowTo =
    /\bhow\s+(?:can|do|would)\s+(?:i|we)\s+(?:go\s+about\s+)?(?:book|booking|schedule|reserve)\s+(?:a|an|the|my|our|for|at|with)\b|\bhow\s+to\s+(?:book|schedule|reserve)\b|\b(?:booking|reservation)\s+(?:process|procedure|steps)\b|\b(?:process|procedure|steps)\s+(?:for|to)\s+(?:book|booking|reserve|schedule)\b/i.test(text);

  if (asksBookingHowTo) return false;
  const hasDate = this?.messageContainsExplicitDateSignal
    ? this.messageContainsExplicitDateSignal(userMessage)
    : messageContainsExplicitDateSignal(userMessage);
  const hasTime = this?.messageContainsExplicitTimeSignal
    ? this.messageContainsExplicitTimeSignal(userMessage)
    : messageContainsExplicitTimeSignal(userMessage);
  if (hasDate || hasTime) {
    return true;
  }

  const decliningAddons = this?.isDecliningOptionalAddons
    ? this.isDecliningOptionalAddons(userMessage, history)
    : isDecliningOptionalAddons(userMessage, history);
  if (decliningAddons) {
    return true;
  }

  const explicitAction = /\b(book|schedule|reschedule|change|move|postpone|cancel|confirm|check\s+(?:availability|available\s+(?:slots|times))|availability|available\s+slots|reserve|hold\s+(?:a\s+)?(?:date|slot)|resend|send\s+(?:the\s+)?(?:payment|m-?pesa)|pay\s+(?:the\s+)?(?:deposit|balance)|add\s+(?:an?\s+)?(?:add-on|extra)|bringing|coming\s+with)\b/.test(text);
  const deliveryPreferenceAction = /\b(?:prefer|save|set|use|send|receive|deliver)\b.{0,35}\b(?:email|whatsapp|download\s+link|delivery)\b/.test(text);
  if (explicitAction || deliveryPreferenceAction) {
    return true;
  }

  const givesExplicitTime = /\b\d{1,2}(?:[:.\u{FF0E}]\d{2})?\s*(?:am|pm)\b|\b\d{1,2}[:.\u{FF0E}]\d{2}\b/iu.test(text);
  const recentlyAskedForTime = history.slice(-2).some((message) =>
    message.role === 'assistant' && /\b(?:what time|which time|preferred time|time would work)\b/i.test(message.content)
  );
  if (givesExplicitTime && recentlyAskedForTime) return true;

  const isAffirmation = /\b(?:that\s+one|yes+|yep|yup|okay|ok|sure|go\s+ahead|confirm|proceed|want\s+that|that['']?s?\s+(?:it|the\s+one)|noo+[.\s]+i\s+want|i\s+want\s+that|that['']?s?\s+fine|perfect|sounds?\s+good|let['']?s?\s+do\s+it|already\s+(?:cho(?:se|sen|osen)|picked|selected|said|told)|i\s+had\s+already|you\s+remember|remember\??)\b/i.test(text);
  const lastAssistantAskedBookingConfirmation = history
    .some(
      (m) =>
        m.role === 'assistant' &&
        /\b(?:book(?:ing)?|edition|package|confirm|which.*(?:edition|package)|looking\s+to\s+book|would\s+you\s+(?:like|prefer|want)\s+to\s+book|shall\s+i\s+(?:go\s+ahead|book|confirm))\b/i.test(m.content)
    );
  if (isAffirmation && lastAssistantAskedBookingConfirmation) return true;

  return false;
}

export function shouldUsePreviousAddonReply(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): boolean {
  const text = userMessage.toLowerCase();
  const addonStatus = /\b(?:have|did)\s+you\s+(?:(?:already|actually)\s+)?(?:add(?:ed)?|sav(?:e|ed)|record(?:ed)?|include(?:d)?|note(?:d)?)\b/i.test(text);
  if (addonStatus && (/\b(?:add-?ons?|extras?)\b/i.test(text) || ADDON_CATALOG.some((item) => item.match.test(text)))) return true;
  if (/\b(package|edition|bloom|muse|icon|legend|queen|empress|goddess|price|cost)\b/.test(text)) return false;
  const explicitAddonHistoryQuestion = /\b(which|what)\b[\s\S]{0,50}\b(?:add-?ons?|extras?)\b[\s\S]{0,40}\b(?:did i|have i)\b[\s\S]{0,25}\b(?:choose|chose|chosen|pick|picked|select|selected|add|added|include|included)\b/.test(text)
    || /\b(which|what)\b[\s\S]{0,50}\b(?:did i|have i)\s+(?:choose|chose|chosen|pick|picked|select|selected|add|added|include|included)\b[\s\S]{0,40}\b(?:add-?ons?|extras?)\b/.test(text)
    || /\b(?:previously|before|earlier|already)\b[\s\S]{0,40}\b(?:add-?ons?|extras?)\b[\s\S]{0,30}\b(?:choose|chosen|picked|selected|add|added|include|included)\b/.test(text);
  if (explicitAddonHistoryQuestion) return true;

  const anaphoricHistoryQuestion = /\b(which|what)\s+ones?\b[\s\S]{0,40}\b(?:choose|chose|chosen|pick|picked|select|selected|add|added)\b[\s\S]{0,30}\b(?:previously|before|earlier|already)\b/.test(text);
  return anaphoricHistoryQuestion && history.slice(-8).some((message) =>
    /(add-on|addon|extra outfit|styled wig|extra edited photo|extra makeup)/i.test(message.content)
  );
}

export async function getPreviousAddonReply(customerId: string): Promise<string | null> {
  const bookings = await prisma.booking.findMany({
    where: { customerId, status: { not: 'cancelled' }, dateTime: { gte: new Date() } },
    orderBy: { dateTime: 'asc' },
    select: { id: true, service: true, dateTime: true, recipientName: true, customer: { select: { name: true } } },
  });

  if (bookings.length === 0) return 'I could not find add-ons linked to an upcoming session. The studio team can check any pending requests.';

  const bookingAddons = await prisma.bookingAddon.findMany({
    where: {
      bookingId: { in: bookings.map((booking) => booking.id) },
      status: { in: ['pending', 'confirmed', 'invoiced'] },
    },
    orderBy: { createdAt: 'asc' },
    select: { bookingId: true, name: true, quantity: true, totalPrice: true },
  });

  if (bookingAddons.length === 0) {
    return `I don't see any add-ons selected for your upcoming sessions yet.`;
  }

  const sessionSummaries = bookings
    .map((booking) => {
      const addons = bookingAddons.filter((addon) => addon.bookingId === booking.id);
      if (addons.length === 0) return null;
      const selected = addons
        .map((addon) => `${addon.name}${addon.quantity > 1 ? ` x${addon.quantity}` : ''}${addon.totalPrice > 0 ? ` (Ksh ${addon.totalPrice.toLocaleString()})` : ''}`)
        .join(', ');
      const bookerName = booking.customer?.name?.trim().toLowerCase() || '';
      const recipientName = booking.recipientName?.trim() || '';
      const recipient = recipientName && recipientName.toLowerCase() !== bookerName
        ? ` for ${recipientName}`
        : '';
      return `${booking.service} on ${inBusinessTimezone(booking.dateTime).format('D MMMM')} ${recipient}: ${selected}`;
    })
    .filter((summary): summary is string => !!summary);

  return `Your previously selected add-ons are: ${sessionSummaries.join('; ')}.`;
}

export function getAddonSelectionReply(addon: AddonCatalogItem, quantity = 1, unchangedRequested = false): string {
  const price = addon.unitPrice > 0
    ? quantity > 1
      ? `${quantity} x Ksh ${addon.unitPrice.toLocaleString()} = Ksh ${(addon.unitPrice * quantity).toLocaleString()}`
      : `Ksh ${addon.unitPrice.toLocaleString()}${addon.quantityFromNote ? ' each' : ''}`
    : ADDON_QUOTED_PRICE_LABEL;
  const label = quantity > 1 ? `${quantity} x ${addon.name}` : addon.name;
  return `${ADDON_NOTED_PREFIX} ${label} (${price}). It will be added to the session balance, not the deposit.${unchangedRequested ? ` ${ADDON_UNCHANGED_REPLY}` : ''}`;
}

export function getStudioPolicyReply(userMessage: string): string | null {
  const text = userMessage.toLowerCase();

  const asksEveningSession =
    /\b(?:evening|late\s*night|nighttime|night-time)\s+(?:sessions?|shoots?)\b|\b(?:sessions?|shoots?)\b.{0,40}\b(?:evening|late\s*night|nighttime|night-time)\b/i.test(text);

  if (asksEveningSession) {
    return 'We are open Tuesday to Sunday from 9 AM to 7 PM and closed on Mondays. Sessions are by appointment only. The team can confirm whether a particular evening time is available.';
  }

  if (isFamilyPhotoCountQuestion(userMessage)) return null;

  if (/\b(nude|semi[-\s]?nude)\b/.test(text) && /\b(session|shoot|maternity|portrait|photo)\b/.test(text)) {
    return 'Yes, nude and semi-nude maternity portraits are available. We handle them with professionalism and privacy so you can feel comfortable throughout the session.';
  }

  return null;
}

export function getOutOfScopeReply(userMessage: string): string | null {
  const text = userMessage.toLowerCase();
  const medicalOrExplicitQuestion = /\b(fertile|fertility|ovulat(?:e|ion|ing)|fertili[sz](?:e|ation)|conceiv(?:e|ing)|conception|sperm|semen|viable\s+egg|egg\s+viab|miscarriage|medication|diagnos(?:is|e)|treatment|contraception|pregnancy\s+(?:complication|symptom)|reproductive\s+health|sexual\s+health|have\s+(?:unprotected\s+)?sex|fuck|sex\s+to\s+(?:get\s+)?pregnant|good\s+seeds|are\s+you\s+into\s+sex|horny)\b/.test(text);
  const professionalAdviceRequest = /\b(?:legal|financial|investment|tax)\s+advice\b|\bshould\s+i\s+(?:invest|take\s+out\s+a\s+loan)\b|\b(?:lawsuit|lawyer|attorney)\b/.test(text);
  const explicitSexualRequest = /\b(talk\s+dirty|dirty\s+talk|sexual\s+roleplay)\b/.test(text);

  if (explicitSexualRequest) return 'I’ll keep things professional here, but I can definitely help you plan your Fiesta House shoot.';
  if (!medicalOrExplicitQuestion && !professionalAdviceRequest) return null;

  return 'That’s outside my studio brief; a qualified professional is the right person to ask. I’m here if you need help with a shoot or booking.';
}

export function isClearlyUnrelatedRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase().trim();
  return /\b(tell\s+(?:me\s+)?a\s+joke|capital\s+of|president\s+of|meaning\s+of\s+life|politics?|election|weather|sports?|football|recipe|cook(?:ing)?|program(?:ming)?|code|crypto|bitcoin|stock\s+market|girlfriend|boyfriend|dating|relationship\s+advice)\b/.test(text);
}

export function getScopeBoundaryReply(
  userMessage: string,
  _history: { role: 'user' | 'assistant'; content: string }[] = []
): string | null {
  const studioPolicyReply = getStudioPolicyReply(userMessage);
  if (studioPolicyReply) return studioPolicyReply;

  const outOfScopeReply = getOutOfScopeReply(userMessage);
  if (outOfScopeReply) return outOfScopeReply;

  const familySessionSignal =
    /\b(husband|wife|partner|spouse|baby|babies|child|children|family|mum|mom|mother|dad|father)\b/i.test(userMessage)
    && (
      /\b(come|bring|join|accompany|with|include|together)\b/i.test(userMessage)
      || /\b(session|shoot|booking|appointment|visit|studio)\b/i.test(userMessage)
      || /\b(that time|when the time comes|when i come|when we come)\b/i.test(userMessage)
    );

  if (familySessionSignal) {
    return null;
  }

  const sessionContext =
    /\b(session|shoot|booking|appointment|studio|photos|pictures|photo|maternity|pregnan|outfit|pose|poses|husband|wife|partner|baby|babies|children|family)\b/i.test(userMessage);

  if (sessionContext) {
    return null;
  }

  if (!isClearlyUnrelatedRequest(userMessage)) return null;

  return 'I’m your Fiesta House studio assistant, so I stick to shoots and bookings. If you need help with a session, I’m happy to help.';
}

export function shouldClarifyAmbiguousDeposit(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /\b(10|10000|10k)\s*(sh|k|ksh|kes)?\b.*\bdeposit\b|\bdeposit\b.*\b(10|10000|10k)\s*(sh|k|ksh|kes)?\b/.test(text);
}

export async function getAmbiguousDepositReply(this: any): Promise<string> {
  try {
    const pkg = this?.getPackageForDeposit
      ? await this.getPackageForDeposit('THE BLOOM')
      : await getPackageForDeposit('THE BLOOM');
    const deposit = this?.getDepositForPackage
      ? this.getDepositForPackage(pkg)
      : getDepositForPackage(pkg);
    return `Do you mean a Ksh 10,000 deposit, or an add-on or item costing Ksh 10,000? THE BLOOM's deposit is Ksh ${deposit.toLocaleString()}, so I want to make sure I understand before recommending anything.`;
  } catch {
    console.warn('Unable to resolve Bloom deposit for clarification.');
    return 'Do you mean a Ksh 10,000 deposit, or an add-on or item costing Ksh 10,000? The studio team can confirm the current package deposit before recommending anything.';
  }
}

export async function getCatalogBookingQuestion(customerId: string, kind: CatalogKind = 'editions'): Promise<string | null> {
  try {
    const draft = await prisma.bookingDraft.findUnique({
      where: { customerId },
      select: { step: true, service: true, date: true, time: true, name: true, createdAt: true, isForSomeoneElse: true },
    });
    if (!draft || draft.step !== EARLY_SLOT_STEP || earlySlotsExpired(draft) || draft.isForSomeoneElse) return null;
    const step = nextStep({ ...draft, addonsDecided: kind === 'editions' });
    if (kind === 'addons' && draft.service && (step === 'need_addon_decision' || step === 'ready_to_propose')) return addonPickQuestion(draft.service);
    if (step !== 'ready_to_propose' && step !== 'need_addon_decision') return STEP_QUESTIONS[step];
  } catch {
    console.warn('[AGENT_FLOW] catalog_booking_context=unavailable');
  }
  return null;
}

export async function getCatalogDisplayReply(
  this: any,
  customerId: string,
  _platform: string,
  kind: CatalogKind,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string> {
  const linkReply = kind === 'addons' ? ADDON_LINK_REPLY : EDITION_LINK_REPLY;
  if (kind === 'addons' && !explicitCatalogListRequest(userMessage)) {
    const named = ADDON_CATALOG.filter((item) => item.match.test(userMessage));
    if (named.length === 1) {
      const item = named[0];
      const price = item.unitPrice > 0
        ? 'Ksh ' + item.unitPrice.toLocaleString() + (item.quantityFromNote ? ' each' : '')
        : ADDON_QUOTED_PRICE_LABEL;
      return item.name + ' (' + price + '): ' + addonDetail(item) + '\n' + ADDON_BALANCE_REPLY + '\nYou can see all the extras here: ' + OFFICIAL_WEBSITE_URLS.packages;
    }
  }
  const mentionedEditions = PACKAGE_NAMES_FOR_EXTRACTION.filter((name) => new RegExp(`\\b${name.replace(/^THE /, '')}\\b`, 'i').test(userMessage));
  const specificEdition = kind === 'editions' && mentionedEditions.length === 1;
  if (specificEdition) {
    const detail = this?.getPackageCatalogReply
      ? await this.getPackageCatalogReply(true, userMessage)
      : await getPackageCatalogReply(true, userMessage);
    return detail ? `${detail}\n${OFFICIAL_WEBSITE_URLS.packages}` : linkReply;
  }
  if (!explicitCatalogListRequest(userMessage)) {
    const question = this?.getCatalogBookingQuestion
      ? await this.getCatalogBookingQuestion(customerId, kind)
      : await getCatalogBookingQuestion(customerId, kind);
    return question ? `${linkReply.split('\n')[0]}\n${question}` : linkReply;
  }
  if (kind === 'addons') {
    return this.getAdditionsReply(customerId);
  }
  const showInclusions = this?.conversationFlows?.isPackageInclusionFollowUp
    ? this.conversationFlows.isPackageInclusionFollowUp(userMessage, history)
    : false;
  const catalogReply = this?.getPackageCatalogReply
    ? await this.getPackageCatalogReply(showInclusions, userMessage)
    : await getPackageCatalogReply(showInclusions, userMessage);
  return catalogReply || linkReply;
}
