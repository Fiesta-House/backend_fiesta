import { PACKAGE_NAMES_FOR_EXTRACTION } from '../../config/constants';
import { EDITION_CATALOG_HEADER, EDITION_TERM_PATTERN } from './constants';
import { stripAssistantEmojis } from './emoji-policy';
import { RESCHEDULE_KEYWORD_PATTERN, normalizeQuotes } from './regex';

export function rescheduleTargetText(message: string): string {
  const clauses = message.split(/\.{2,}|[;\n,]|\b(?:because|but)\b/i)
    .filter(clause => !/\b(?:busy|unavailable|can't|cannot|won't|will not|not free|not available)\b/i.test(clause));
  return clauses.map(clause => clause.match(/\bfrom\b[\s\S]*?\bto\s+([\s\S]+)/i)?.[1] || clause).join(' ');
}

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const EDITION_WORDS = 'bloom|muse|icon|legend|queen|empress|goddess';
const SELECTION_VERB = /\b(?:give\s+me|i\s+want|i\s+would\s+(?:like|want)|i['’]?d\s+like|i\s+(?:choose|pick|select)|i(?:['’]ll|\s+will)\s+(?:take|have|go\s+with|choose|pick)|let['’]?s\s+(?:go\s+with|do|book)|go\s+with|take|choose|pick|select|book|interested\s+in)\b/i;
const BARE_EDITION = new RegExp(`^(?:(?:ok(?:ay)?|so|then|yes|please)[, ]+)?(?:the\\s+)?(?:${EDITION_WORDS})(?:\\s+(?:package|edition))?(?:[, ]+(?:please|pls|then))?[.! ]*$`, 'i');

/** True when she is reminding us of an edition she already picked ("I already said the Muse… remember?"). */
export function isEditionRestatement(message: string): boolean {
  return /\b(?:already\s+(?:said|told|chose|chosen|choosen|picked|selected|booked)|i\s+(?:said|told|chose|chosen|picked|selected)|(?:you\s+)?remember)\b/i.test(
    message
  );
}

/** Returns the edition when the message chooses exactly one edition; questions, detail requests and negations return null. */
export function selectedEdition(message: string): string | null {
  const text = message.trim();
  const named = PACKAGE_NAMES_FOR_EXTRACTION.filter((name) => new RegExp(`\\b${name.replace(/^THE /, '')}\\b`, 'i').test(text));
  if (named.length !== 1) return null;
  const restatement = isEditionRestatement(text);
  // Restatements often end with "?" ("…remember?") but still name the chosen edition.
  if (!restatement && /\?|^\s*(?:what|which|how|why|can|could|do|does|is|are)\b/i.test(text)) return null;
  if (/\b(?:include[sd]?|inclusions?|details?|tell\s+me\s+about|compare|difference|vs|versus|recommend|price|cost|how\s+much|not|don['’]?t|dont|never|instead)\b/i.test(text)) return null;
  return restatement || SELECTION_VERB.test(text) || BARE_EDITION.test(text) ? named[0] : null;
}

export function isPlainGreeting(message: string): boolean {
  return /^\s*(?:hi+|hello+|hey+|hiya|helo|good\s+(?:morning|afternoon|evening|day)|habari(?:\s+yako)?|niaje|mambo|greetings)(?:\s+(?:there|team|fiesta(?:\s+house)?))?[\s!.,]*$/i.test(message);
}

const SPECIFIC_DAY = /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|\d{1,2}(?:st|nd|rd|th)?)\b/i;

/** General hours questions only; "are you open today/Saturday" stays with the calendar availability flow. */
export function isOpeningHoursQuestion(message: string): boolean {
  if (SPECIFIC_DAY.test(message)) return false;
  return /\b(?:opening|business|working|operating|studio)\s+(?:hours|days|times)\b|\bwhat\s+are\s+your\s+(?:hours|days)\b|\bwhat\s+(?:time|days?)\s+(?:do|are)\s+you\s+(?:open|close|operate|work)\b|\bwhen\s+(?:are|do)\s+you\s+(?:open|close)\b|\bwhat\s+time\s+does\s+the\s+studio\s+(?:open|close)\b/i.test(message);
}

export function isWalkInQuestion(message: string): boolean {
  return (
    /\bwalk[\s-]?ins?\b|\b(?:drop|pop|stop)\s+(?:by|in)\b|\bwithout\s+(?:an?\s+)?(?:appointment|booking)\b|\bdo\s+i\s+need\s+(?:an?\s+)?(?:appointment|booking)\b/i.test(message) ||
    /\b(?:can|could|may)\s+(?:i|we)\s+(?:come|visit)\b.{0,30}\b(?:now|today)\b/i.test(message) ||
    /\b(?:is it okay|is it alright|would it be okay)\s+if\s+(?:i|we)\s+(?:come|visit)\b.{0,30}\b(?:now|today)\b/i.test(message)
  );
}

/** "I'll call later", "let me ask my partner": the customer is pausing, so the reply must not ask a booking question. */
export function isDeferral(message: string): boolean {
  const text = normalizeQuotes(message).toLowerCase();
  if (/\?/.test(text)) return false;
  if (/\b(?:pay|paid|payment|m-?pesa|deposit|prompt|stk|pin|cancel\w*|reschedul\w*|refund\w*|invoice|receipt)\b/.test(text)) return false;
  return /\b(?:i(?:'ll|\s+will|\s+shall)|let\s+me|i(?:'m|\s+am)\s+going\s+to|i\s+(?:need|have)\s+to)\s+(?:first\s+)?(?:call|ring|get\s+back|come\s+back|check|confirm|ask|talk|speak|consult|discuss|think|reach\s+out|text|update\s+you|revert|decide)\b/.test(text)
    || /\b(?:get\s+back\s+to\s+you|let\s+you\s+know|call\s+(?:you\s+)?later|talk\s+later)\b/.test(text);
}

export function isBusinessIdentityQuestion(message: string): boolean {
  return /\b(?:is\s+this|am\s+i\s+(?:talking|chatting|speaking)\s+(?:to|with)|are\s+you)\s+(?:the\s+)?fiesta\b/i.test(message);
}

export function isBookingPolicyQuestion(message: string): boolean {
  return /\b(?:reschedul\w*|cancell?\w*|refund\w*)\b/i.test(message)
    && /\b(?:polic(?:y|ies)|rules?|terms|conditions|notice|what happens if|how (?:far|long) (?:in advance|before))\b/i.test(message);
}

export class ConversationFlowMatcher {
  isInitialRescheduleRequest(message: string): boolean {
    if (isBookingPolicyQuestion(message)) return false;
    if (/\b(?:package|edition)\b/i.test(message) && !/\b(?:date|day|time)\b/i.test(message)) return false;
    if (!RESCHEDULE_KEYWORD_PATTERN.test(message)) return false;
    if (/\b(?:not|don't|do not|never)\b[\s\S]{0,35}\b(?:reschedul\w*|change|move|postpone|push)\b/i.test(message)) return false;
    return /\breschedul\w*|\bpostpon\w*|\bpush\b/i.test(message)
      || /\b(?:change|move|shift)\b[\s\S]{0,60}\b(?:session|booking|appointment|shoot|date|day|time|it|this|that)\b/i.test(message);
  }

  isPackageCatalogRequest(message: string, history: ConversationMessage[] = []): boolean {
    history = stripAssistantEmojis(history);
    const text = message.toLowerCase().trim();
    const namesEdition = PACKAGE_NAMES_FOR_EXTRACTION.some((name) => new RegExp(`\\b${name.replace(/^THE /, '')}\\b`, 'i').test(text));
    const editionQuestion = new RegExp(`\\b(?:what|which|share|show|list|tell)\\b.*\\b${EDITION_TERM_PATTERN}\\b|\\byour\\s+${EDITION_TERM_PATTERN}\\b`, 'i');
    const requestedDetail = namesEdition && /\b(?:include|includes|inclusions|come with|tell me about|details|how much|price|cost)\b/i.test(text);
    const editionNameOnly = PACKAGE_NAMES_FOR_EXTRACTION.some((name) => [name.toLowerCase(), name.replace(/^THE /, '').toLowerCase()].includes(text.replace(/[.!?]+$/, '')));
    const choosesFromOverview = editionNameOnly
      && history.some((entry) => entry.role === 'assistant' && entry.content.includes(EDITION_CATALOG_HEADER));
    if ((editionQuestion.test(text) && !this.isPackageAdviceRequest(message)) || requestedDetail || choosesFromOverview) return true;
    const explicitCatalogRequest = /(what\s+packages|which\s+packages|package\s+list|list\s+of\s+services|services\s+do\s+you\s+offer|what\s+services\s+do\s+you\s+offer|show\s+me\s+packages|tell\s+me\s+about\s+(the\s+)?(packages|services)|packages?\s+(or|and)\s+services|what\s+does\s+each\s+(package|edition)\s+(include|come\s+with))/i.test(text);
    const shareCatalogRequest = /\bshare\s+(?:the\s+)?packages\b|\bwhat\s+do\s+you\s+offer\b|\byour\s+editions\b/i.test(text);
    const rateCardRequest = /\b(?:rate\s*cards?|price\s*list|pricing\s*list)\b/i.test(text);
    if (explicitCatalogRequest || shareCatalogRequest || rateCardRequest || this.isPackageInclusionFollowUp(message, history)) return true;

    const contextualFollowUp = /^(?:tell\s+me\s+about\s+(?:them|those)|what\s+about\s+(?:them|those)|can\s+you\s+tell\s+me\s+about\s+(?:them|those))\s*[?.!]*$/.test(text);
    if (!contextualFollowUp) return false;

    const recentAssistantMessages = history
      .filter((entry) => entry.role === 'assistant')
      .slice(-3);
    return recentAssistantMessages.some((entry) => /\bpackages?\b|\bservices?\b|\beditions\b/i.test(entry.content));
  }

  isPackageInclusionFollowUp(message: string, history: ConversationMessage[] = []): boolean {
    history = stripAssistantEmojis(history);
    const text = message.toLowerCase().trim();
    const asksWhatEachIncludes = /^(?:so\s+)?what\s+(?:does|do)\s+each(?:\s+one)?\s+(?:come\s+with|include|includes)\s*[?.!]*$|^what\s+comes\s+with\s+each\s*[?.!]*$|^what(?:'s|\s+is)\s+included\s+(?:in|with)\s+each\s*[?.!]*$/.test(text);
    if (!asksWhatEachIncludes) return false;

    const recentAssistantMessages = history
      .filter((entry) => entry.role === 'assistant')
      .slice(-3)
      .map((entry) => entry.content.toLowerCase());
    const packageNamesMentioned = PACKAGE_NAMES_FOR_EXTRACTION
      .filter((name) => recentAssistantMessages.some((content) => content.includes(name.toLowerCase())));

    return packageNamesMentioned.length >= 2
      || recentAssistantMessages.some((content) => content.includes(EDITION_CATALOG_HEADER.toLowerCase()))
      || recentAssistantMessages.some((content) => /all (?:the )?(?:current )?(?:packages|editions)/.test(content));
  }

  isPackageAdviceRequest(message: string): boolean {
    const text = message.toLowerCase();
    const namesPackage = /(bloom|muse|icon|legend|queen|empress|goddess|standard|economy|executive|gold|platinum|vvip|vip)\s+(package|edition)?/.test(text);
    const asksForAdvice = /(recommend|which\s+(one|package|edition)|best\s+(package|edition)|should\s+i\s+(get|choose)|why.*over|compare|difference\s+between)/.test(text);
    return namesPackage && asksForAdvice || /(recommend|which\s+one|best\s+(package|edition)|should\s+i\s+(get|choose))/.test(text);
  }

  isPackageSelection(message: string): boolean {
    if (selectedEdition(message)) return true;
    return /(i\s+(like|want|choose|will take|would like|would want)|i(?:'ll|\s+will)\s+(go with|take)|let'?s\s+(go with|do))\s+(the\s+)?(bloom|muse|icon|legend|queen|empress|goddess|standard|economy|executive|gold|platinum|vip|vvip)(\s+(package|edition))?\b/.test(message.toLowerCase());
  }

  isSameBookingSlotRequest(message: string): boolean {
    return /\b(same|that)\s+(date\s+and\s+time|day\s+and\s+time|date|day|time)\b/.test(message.toLowerCase());
  }

  isTimeOnlyRescheduleRequest(message: string): boolean {
    const text = message.toLowerCase();
    return /(reschedule|change|move|shift)\s+(the\s+)?(time|appointment time|session time)|\bchange\s+my\s+time\b/.test(text)
      && !/(date|day|tomorrow|next\s+week|\d{4}-\d{2}-\d{2})/.test(text);
  }

  parseTimeOnly(message: string): string | null {
    const match = message.trim().toLowerCase().match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = Number(match[2] || '0');
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (match[3] === 'pm' && hour !== 12) hour += 12;
    if (match[3] === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  isTimeOnlyRescheduleSelection(message: string, history: ConversationMessage[]): boolean {
    history = stripAssistantEmojis(history);
    if (!this.parseTimeOnly(message)) return false;
    const previousAssistantMessage = [...history].reverse().find((entry) => entry.role === 'assistant')?.content.toLowerCase() || '';
    return /what time.*work better|what new time|time would you like/.test(previousAssistantMessage);
  }

  /** The last assistant turn asked for a new date/time for an existing booking. */
  isRescheduleQuestion(history: ConversationMessage[]): boolean {
    history = stripAssistantEmojis(history);
    const previousAssistantMessage = [...history].reverse().find((entry) => entry.role === 'assistant')?.content.toLowerCase() || '';
    return /what time.*work better|what new time|share your preferred date and time|which new date and time would suit you|what (?:new )?(?:date and time|date or time|day and time) would you like|(?:move|reschedule|push) your (?:session|booking|appointment|shoot) to|when would you like to (?:move|reschedule)/.test(previousAssistantMessage);
  }

  /** Accepts "5pm", "from 5:30 pm", "17:00" anywhere in the message. */
  parseCustomerTime(message: string): string | null {
    const text = message.toLowerCase();
    const meridiem = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (meridiem) return this.parseTimeOnly(`${meridiem[1]}${meridiem[2] ? `:${meridiem[2]}` : ''}${meridiem[3]}`);
    const clock = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    return clock ? `${clock[1].padStart(2, '0')}:${clock[2]}` : null;
  }

  isRescheduleSelection(message: string, history: ConversationMessage[]): boolean {
    return this.isRescheduleQuestion(history) && this.hasRescheduleSlotSignal(message);
  }

  hasRescheduleSlotSignal(message: string): boolean {
    if (this.parseCustomerTime(message)) return true;
    return /\b(?:same|that)\s+(?:day|date)\b|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(message);
  }

  isWeekdayRequest(message: string): boolean {
    return /(what|which)\s+day\s+of\s+(the\s+)?week.*\b\d{1,2}(st|nd|rd|th)?\b|what\s+day.*\b\d{1,2}(st|nd|rd|th)?\b/.test(message.toLowerCase());
  }

  isBusinessIntroductionRequest(message: string): boolean {
    return /(tell\s+me\s+about\s+(the\s+)?business|what\s+(is|does)\s+fiesta|about\s+fiesta\s+(house|attire)|who\s+are\s+you|what\s+(exactly\s+)?do\s+(you|you\s+people)\s+do|what\s+do\s+you\s+people\s+do|(is\s+this|am\s+i\s+(talking|chatting|speaking)\s+(to|with)|are\s+you)\s+(the\s+)?fiesta)/.test(message.toLowerCase());
  }

  isWebsiteRequest(message: string): boolean {
    return /(what(?:'s|\s+is)\s+your\s+website|website.*(?:reach|find|visit|see)|(?:reach|find|visit|see).*website|your\s+site|web\s*site)/.test(message.toLowerCase());
  }

  isContactDetailsRequest(message: string): boolean {
    return /(contact\s+details|how\s+can\s+i\s+(contact|reach)\s+you|where\s+(are|is)\s+your\s+(studio|location|office)|your\s+(location|address)|address.*contact|contact.*(?:location|address)|where\s+(are\s+you|is\s+(the|fiesta)\s*(studio|house)?)\s*(located|based|situated|found)?\s*[?.!]*$|where\s+are\s+you\s+(located|based|situated)|how\s+do\s+i\s+(get|find)\s+(to\s+)?(you|the\s+studio)|directions\s+to)/.test(message.toLowerCase().trim());
  }

  isPortfolioRequest(message: string): boolean {
    return /(portfolio|gallery|recent\s+shoots|sample\s+photos|see\s+your\s+work)/.test(message.toLowerCase());
  }
}
