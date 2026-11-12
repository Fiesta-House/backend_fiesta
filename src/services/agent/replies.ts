import { ADDON_CATALOG, MINIMUM_BOOKING_DEPOSIT } from '../../config/constants';
import { OFFICIAL_WEBSITE_URLS, ADDON_NOTED_PREFIX, ADDON_UNCHANGED_REPLY, ADDON_ADDITIONS_HEADER, ADDON_QUOTED_PRICE_LABEL } from './constants';
import { businessDay } from '../../utils/time';
import { editionInText } from './reply-voice';
import { stripAssistantEmojis } from './emoji-policy';
import { RESCHEDULE_FORFEITURE_WINDOW_HOURS } from '../../utils/booking-policy';
export { isBookingProcessRequest } from './booking-process-reply';

export const FAMILY_STYLING_TEAM_REPLY = 'Your partner and children are welcome. The team will confirm what styling is available for them.';

export function buildBookingPolicyReply(): string {
  const hours = RESCHEDULE_FORFEITURE_WINDOW_HOURS;
  return `Rescheduling: Changes within ${hours} hours before your session forfeit the deposit. At exactly ${hours} hours, the current rule does not forfeit it.\n\nCancellation: Refund eligibility applies only when cancelling more than ${hours} hours before the session. At ${hours} hours or less, the deposit is not eligible for a refund. A new booking requires a new deposit.\n\nNo booking change or cancellation has been made.`;
}

export function familyStylingReply(message: string, history: { role: 'user' | 'assistant'; content: string }[] = []): string | null {
  history = stripAssistantEmojis(history);
  const family = /\b(?:family|partners?|husbands?|wives|wife|children|kids|sons?|daughters?|fathers?|dads?|brothers?|sisters?)\b/i;
  const styling = /\b(?:dress(?:ing|ed|es)?|groom(?:ing|ed)?|styl(?:ing|e|ed)|outfits?|clothes|clothing|attire|accessories|hair|make[ -]?up)\b/i;
  const extraMakeup = ADDON_CATALOG.find(item => item.sku === 'extra_makeup');
  const needsConfirmation = message.split(/[.!?;]|\band\b/i).some(clause => {
    const recipient = family.test(clause) || /\b(?:they|them|him|her|their|his|everyone|everybody)\b/i.test(clause)
      && history.slice(-4).some(entry => family.test(entry.content));
    const catalogSelection = extraMakeup && clause.match(extraMakeup.match)
      && !/\?/.test(message) && /\b(?:want|add|include|noted)\b/i.test(clause);
    return recipient && styling.test(clause) && !catalogSelection;
  });
  return needsConfirmation ? FAMILY_STYLING_TEAM_REPLY : null;
}

export function buildAdditionsReply(deposit: number | null): string {
  const displayDeposit = typeof deposit === 'number' && Number.isInteger(deposit) && deposit >= MINIMUM_BOOKING_DEPOSIT ? deposit : null;
  const pricedLines = ADDON_CATALOG
    .filter((item) => item.unitPrice > 0)
    .map((item) => `${item.name}: Ksh ${item.unitPrice.toLocaleString()}${item.quantityFromNote ? ' each' : ''}`);
  const quotedLines = ADDON_CATALOG.filter((item) => item.unitPrice === 0)
    .map((item) => `${item.name}: ${ADDON_QUOTED_PRICE_LABEL}`);

  return [
    ADDON_ADDITIONS_HEADER,
    '',
    ...pricedLines,
    '',
    'Quoted by package tier:',
    ...quotedLines,
    '',
    displayDeposit === null
      ? 'They are optional and are added to the balance, not the deposit. The studio team can confirm the deposit amount. Nothing has been added yet.'
      : `They are optional, are added to the balance, and are not included in the Ksh ${displayDeposit.toLocaleString()} deposit. Nothing has been added yet.`,
    '',
    'Which, if any, would you like me to note for the session?'
  ].join('\n');
}

function normalizeHyphens(value: string): string {
  return value.replace(/[\u2010-\u2015\u2212]/g, '-');
}

export function isAddonListFollowUp(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  history = stripAssistantEmojis(history);
  const text = normalizeHyphens(userMessage).trim().toLowerCase().replace(/[.!?]+$/, '');
  const affirmative = /^(show(\s+me)?(\s+the)?(\s+(full\s+)?(list|options|extras|add[\s-]?ons?))?|see\s+them|list\s+them|list\s+the\s+(extras|add[\s-]?ons?)|what\s+(are\s+they|else)|yes(\s+please)?|yeah|yep|sure|ok(ay)?|please)$/.test(text);
  if (!affirmative && !/^list\s+them\s+here$/.test(text)) return false;

  const lastAssistant = [...history].reverse().find((message) => message.role === 'assistant');
  if (!lastAssistant) return false;
  if (lastAssistant.content.includes(OFFICIAL_WEBSITE_URLS.packages)) {
    return /extras|add-ons/i.test(lastAssistant.content)
      && /^(?:list\s+(?:them|the\s+(?:extras|add-?ons))(?:\s+here)?|show\s+(?:me\s+)?(?:the\s+)?(?:full\s+)?(?:list|extras|add-?ons)(?:\s+here)?)$/.test(text);
  }
  if ([ADDON_NOTED_PREFIX, ADDON_UNCHANGED_REPLY, ADDON_ADDITIONS_HEADER]
    .some((phrase) => normalizeHyphens(lastAssistant.content).toLowerCase().includes(phrase.toLowerCase()))) return true;
  return /(available extras|add-?ons?\b|optional additions|extra services|extra outfit|styled wig)/i.test(
    normalizeHyphens(lastAssistant.content)
  );
}

export function formatCustomerTime(time: string): string {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return time;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
}

export function buildBookingProposalConfirmation(service: string, date: string, time: string, deposit: number): string {
  return `Your details for ${editionInText(service)} are ready for ${businessDay(date).format('dddd, D MMMM YYYY')} at ${formatCustomerTime(time)}. The deposit is Ksh ${deposit.toLocaleString()}. Reply yes to confirm your booking details and receive payment instructions. Your booking is confirmed once the deposit is received.`;
}

export function buildRescheduleProposalConfirmation(service: string, date: string, time: string): string {
  return `I can move your session for ${editionInText(service)} to ${businessDay(date).format('dddd, D MMMM YYYY')} at ${formatCustomerTime(time)}. If that works for you, reply yes and I'll confirm it.`;
}

export function buildTimeOnlyRescheduleProposal(service: string, date: string, time: string): string {
  return `I can move your ${service} session to ${date} at ${formatCustomerTime(time)}. Would you like me to confirm that change?`;
}

export function buildPackageDepositProposal(
  service: string,
  date: string,
  time: string,
  deposit: number
): string {
  return `${service} works for ${date} at ${formatCustomerTime(time)}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes to confirm and receive payment instructions.`;
}

export function buildCancellationProposal(service: string, session: string, refundPosition: string): string {
  return `You asked to cancel your ${session}. ${refundPosition} If you want me to cancel this booking, reply yes to confirm.`;
}

export function previousMessageRequestsConfirmation(
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  history = stripAssistantEmojis(history);
  const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content.toLowerCase() || '';
  return /(?:reply\s+["“”']?yes["“”']?|if\s+that\s+works\s+for\s+you.*reply\s+["“”']?yes["“”']?|would\s+you\s+like\s+me\s+to\s+confirm|confirm\s+that\s+change|confirm\s+the\s+change|shall\s+i\s+confirm|shall\s+i\s+(?:switch|set)\b|reply\W{0,3}yes\b|if\s+you\s+want\s+me\s+to\s+cancel\s+this\s+booking,?\s+reply\s+yes\s+to\s+confirm|(?:could\s+you\s+please\s+)?confirm\s+(?:that\s+)?you(?:['’]d|\s+would)\s+like\s+to\s+(?:reschedule|move|change)\b[\s\S]{0,160}\bto\b)/.test(previousAssistantMessage);
}

export function isPackageBudgetRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(cheapest|most affordable|lowest cost|budget friendly|budget-friendly|cheap|affordable|same as last time|like last time|same as before|same package as last time)/.test(text);
}

export function buildPackageBudgetReply(): string {
  return 'I can help with that. The most affordable option is usually THE BLOOM, while THE ICON is the most popular mid-range package. If you want to keep it simple, tell me which package you prefer: THE BLOOM, THE ICON, or a premium option like THE EMPRESS or THE GODDESS.';
}

const LEGACY_PACKAGE_PATTERN = /\b(standard|economy|executive|gold|platinum|vvip|vip)\s+(?:package|edition|session|plan|option|tier)s?\b/i;

/** Retired package names get a direct answer instead of a model call; "my standard session" refers to an old booking and is skipped. */
export function legacyPackageReply(message: string): string | null {
  const match = message.match(LEGACY_PACKAGE_PATTERN);
  if (!match || /\bmy\b/i.test(message)) return null;
  const word = match[1].toLowerCase();
  const name = word.length <= 4 ? word.toUpperCase() : `${word[0].toUpperCase()}${word.slice(1)}`;
  return `We don't have a ${name} package. Our editions run from THE BLOOM to THE GODDESS, and THE BLOOM is the entry option. Would you like its details, or the full rate card?`;
}

export const LASHES_FAQ_REPLY = 'Yes. Lashes are included in all our makeup services, including every package. The extra professional makeup add-on also includes lashes.';

export function isLashesQuestion(message: string): boolean {
  return /\b(?:eye)?lash(?:es)?\b/i.test(message);
}

export function isStandaloneLashesQuestion(message: string): boolean {
  if (!isLashesQuestion(message)) return false;
  const text = message.toLowerCase();
  const hasSecondIntent =
    (text.match(/\?/g) || []).length > 1
    || /\b(?:accessor(?:y|ies)|options?\s+(?:of|for)|what\s+else|what\s+about)\b/i.test(text)
    || /\b(?:and|also|plus|as\s+well\s+as)\b[\s\S]{0,70}\b(?:what|which|how|do|does|are|is|can|could|makeup|hair|wig|outfit|gown|package|price|cost|deposit|date|session)\b/i.test(text);
  return !hasSecondIntent;
}

export function isAdditionsRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(additions|add[\s-]?ons?\b|extras|extra\s+services|extra\s+photo|extra\s+outfit|extra\s+makeup|digital\s+art|power\s+suit|wig\s+hire|suspending\s+concept|sculpture\s+set|reel\s+pricing|what\s+extras)/.test(text);
}

export function isPersonalOutfitQuestion(userMessage: string): boolean {
  return /\b(?:bring|wear)\b.{0,60}\boutfit\b.{0,30}\b(?:of my own|that is mine|that's mine)\b|\b(?:bring|wear)\s+my\s+own\s+outfit\b/i.test(userMessage);
}

export function buildPersonalOutfitReply(): string {
  return 'You may bring one outfit of your own or substitute it for one from our studio wardrobe. Additional outfits beyond that are Ksh 4,000 each.';
}

export function isHairWigClarificationRequest(userMessage: string): boolean {
  return /\b(?:what does|what is|does)\b.{0,60}\b(?:professional hair|hair styling|wig styling|wig installation|styled wig)\b|\b(?:professional hair|hair styling)\b.{0,50}\b(?:wig|mean|included)\b/i.test(userMessage);
}

export function buildHairWigClarificationReply(): string {
  return 'Basic hair styling is included with sessions. Wig styling and installation is Ksh 3,000; styled wig hire is Ksh 4,000. Which one did you mean?';
}

export function buildMixedIntentClarificationReply(): string {
  return 'I can help with the package, the date, or the invoice. Which one would you like to sort out first?';
}

export function buildBusinessIntroductionReply(): string {
  return 'Welcome to Fiesta House Maternity. What kind of session are you planning?';
}

export function buildAboutBusinessReply(): string {
  return [
    'Fiesta House Maternity is a luxury maternity photography studio in Parklands, Nairobi.',
    'We photograph expecting mothers in our studio, and every edition includes professional makeup and styled outfits from our wardrobe.',
    'You can choose from seven editions, add optional extras, or ask us for a bespoke experience. We also help mothers travelling from outside Nairobi.',
    `You can see the editions here: ${OFFICIAL_WEBSITE_URLS.packages}`,
    'What kind of session are you planning?',
  ].join('\n');
}

export function isPostShootProcessRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(after\s+(?:(?:the|my|your)\s+)?(?:shoot|session)|post\s*(?:shoot|session)\s*process)/.test(text);
}

export function buildPostShootProcessReply(): string {
  return [
    'After your session:',
    '1) Any remaining balance is cleared as per your package terms (M-Pesa or cash).',
    '2) Edited photos are ready within 10 working days.',
    '3) Edited photos are delivered as a secure download link only.',
    '4) We can share that link via WhatsApp or email, based on your preference.',
    '5) Express delivery is available at an extra fee if you need them sooner.',
    '6) Raw files are available at an extra fee if requested.',
    '',
    "Tell me your preferred delivery method and I'll save it now."
  ].join('\n');
}

export function isRawFilesRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(raw\s+file|raw\s+files|unedited\s+photos|original\s+files|can\s+i\s+get\s+raw)/.test(text);
}

export function buildRawFilesReply(): string {
  return [
    'Raw files are quoted by edition.',
    'They are shared as a secure download link.',
    'The team can confirm the fee for your edition.'
  ].join('\n');
}

export function isBespokeRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(bespoke|custom\s+experience|custom\s+shoot|custom\s+package|tailored\s+session|tailored\s+experience|vision\s+does\s+not\s+fit)/.test(text);
}

export function buildBespokeReply(): string {
  return [
    'Bespoke Experiences',
    '',
    'For the mother whose vision does not fit inside a package, we design custom experiences by consultation.',
    '',
    'Reach out to our team to begin the conversation, and we will craft a session around your unique story.'
  ].join('\n');
}

export function isTravellingMothersRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(travelling\s+mother|traveling\s+mother|from\s+outside\s+nairobi|from\s+abroad|airport\s+transfer|hotel\s+booking|concierge|soft\s+landing|journeying\s+to\s+us)/.test(text);
}

export function buildTravellingMothersReply(): string {
  return [
    'For Our Travelling Mothers',
    '',
    'For mothers journeying to us from beyond Nairobi, we curate the full arrival.',
    '',
    'Airport transfers, hotel bookings, and a soft landing arranged by our concierge, so all you carry with you is your presence.',
    '',
    'Available on request! Let us know your travel dates and we will be delighted to coordinate for you.'
  ].join('\n');
}

export function isSocialMediaRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  return /(social\s+media|instagram|facebook|website|where\s+can\s+i\s+find\s+you\s+online)/.test(text);
}

export function buildSocialMediaReply(): string {
  return [
    'Instagram: @fiestahousematernity',
    'https://www.instagram.com/fiestahousematernity',
    '',
    'Facebook: Fiesta House Attire',
    'https://www.facebook.com/fiestahouseattire/',
    '',
    'Website: https://www.fiestahousematernity.com/',
    '',
    'We only share client photos with consent.'
  ].join('\n');
}

export function getSuspendingConceptGalleryReply(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): string | null {
  if (/\b(packages?|editions?|price list|pricing)\b/i.test(userMessage)) return null;

  const asksToSeeExample = /\b(where\s+(?:can|could|do)\s+i\s+(?:see|view)|can\s+i\s+see|see\s+this\s+(?:idea|concept))\b/i.test(userMessage)
    || /\bshow\s+me\b.{0,24}\b(gallery|photos?|pictures?|images?|examples?|concept)\b/i.test(userMessage);
  if (!asksToSeeExample) return null;

  const mentionsConcept = /suspending\s+concept/i.test(userMessage)
    || history.slice(-6).some((message) => /suspending\s+concept/i.test(message.content));
  if (!mentionsConcept) return null;

  return `You can see the Suspending Concept gallery here: ${OFFICIAL_WEBSITE_URLS.suspendingConcept}`;
}

export function getReviewPageReply(userMessage: string): string | null {
  const asksAboutReviews = /\b(reviews?|testimonials?|client feedback)\b/i.test(userMessage);
  const asksForPage = /\b(page|website|where|see|read|view|link)\b/i.test(userMessage);
  if (!asksAboutReviews || !asksForPage) return null;

  return `You can read Fiesta House Maternity client reviews here: ${OFFICIAL_WEBSITE_URLS.reviews}`;
}

export function buildWebsiteReply(): string {
  return `You can find us here: ${OFFICIAL_WEBSITE_URLS.home}. It has our portfolio, current packages and more about the studio.`;
}

export function buildContactDetailsReply(): string {
  return 'We are at Diamond Plaza Annex, 2nd Floor, on 4th Avenue in Parklands, Nairobi. Visits are by appointment only. You can reach us on 0720 111928 or at info@fiestahouseattire.com. Our website is https://www.fiestahousematernity.com/.';
}

export function buildOpeningHoursReply(): string {
  return 'We are open Tuesday to Sunday, 9:00 AM to 7:00 PM, and closed on Mondays. Sessions are by appointment only.';
}

export function buildWalkInReply(): string {
  return 'We work strictly by appointment, so we do not take walk-ins. A deposit is required to secure your slot.';
}

export const DEFERRAL_REPLY = "Of course, we're here when you're ready.";

export function buildPortfolioReply(): string {
  return `You can see our maternity, newborn and family sessions in the portfolio here: ${OFFICIAL_WEBSITE_URLS.home}. Have a look and tell me which style feels most like you.`;
}

export function isMultiPersonBookingRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  const mentionsAnotherPerson = /(my\s+sister|my\s+brother|my\s+friend|my\s+husband|my\s+wife|my\s+partner|my\s+family|also\s+coming|come\s+with\s+her|come\s+with\s+him|joining\s+the\s+shoot|join\s+the\s+shoot)/.test(text);
  const bookingContext = /(\bbook(?:s|ed|ing)?\b|photoshoot|shoot|session|appointment|ready\s+to\s+book)/.test(text);
  const jointSessionSignal = /(\bwith\b|alongside|together|\bjoin(?:s|ed|ing)?\b|coming\s+with\b|both\s+of\s+us|each\s+of\s+us)/.test(text);
  return mentionsAnotherPerson && bookingContext && jointSessionSignal;
}

export function buildMultiPersonBookingReply(): string {
  return [
    'Great question, and yes, we can plan that.',
    'Do you want:',
    '1) one joint session together, or',
    '2) separate bookings for each of you?',
    '',
    "I've noted that another person may join.",
    "Once you confirm option 1 or 2, share your package, date, and preferred time and I'll check availability."
  ].join('\n');
}

export function isBookingForSomeoneElseRequest(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  const bookingContext = /(\bbook(?:s|ed|ing)?\b|photoshoot|shoot|session|appointment|ready\s+to\s+book)/.test(text);
  const bookingForSomeoneElse = /\b(for|on behalf of)\s+my\s+(sister|brother|friend|husband|wife|partner|mother|father|daughter|son|family)\b/.test(text);
  return bookingContext && bookingForSomeoneElse && !isMultiPersonBookingRequest(userMessage);
}

export function buildBookingForSomeoneElseReply(relation = 'her'): string {
  return `Of course. Is the session just for ${relation}, or would you both like to be photographed together? Once I know that, I can help with the package, date, and preferred time.`;
}