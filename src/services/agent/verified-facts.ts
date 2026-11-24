import { ADDON_CATALOG } from '../../config/constants';
import { stripAssistantEmojis } from './emoji-policy';

export interface VerifiedFactResult {
  reply: string;
  category: string;
}

export const POWER_SUIT_DESCRIPTION = 'A bold, sophisticated maternity look designed for the mother who wants to make a statement. The Power Suit combines tailored elegance with maternity glamour \u2014 think structured blazer, stylish trousers or coordinated pieces, statement accessories, and confident poses. It creates a strong, modern, editorial feel while celebrating the beauty of pregnancy. The vibe: Powerful \u2022 Elegant \u2022 Modern \u2022 Confident \u2022 Editorial. Perfect for mums who want something different from the traditional flowing maternity gown.';

const POWER_SUIT_REPLY = `The Fiesta House Power Suit: ${POWER_SUIT_DESCRIPTION}\nIt is available as an add-on for Ksh 10,000, and is included with The Empress and The Goddess editions.`;

export function isFamilyPhotoCountQuestion(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase();
  return /\b(?:family|partner|husband|wife|children|kids|sons?|daughters?)\b/i.test(text)
    && /\bphotos?|images?\b/i.test(text)
    && /\b(?:include|included|count|part\s+of|within|taken\s+with|in\s+the)\b/i.test(text);
}

/**
 * Verified Facts Table
 * Provides deterministic, approved answers for common questions about:
 * - Makeup (coverage, lashes, extra makeup)
 * - Hair & Wigs (styling included, wig hire, wig styling only, bringing own hair)
 * - Outfits & Gowns (studio wardrobe selection, extra outfit fee, bringing own outfit, sharing gowns in chat)
 * - Power Suit details and pricing
 * - Follow-up acknowledgements after a team handoff (avoids repeating canned fallbacks)
 */
export function resolveVerifiedFact(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
  context?: { draftService?: string | null }
): string | null {
  const text = userMessage.trim().toLowerCase();
  const cleanHistory = stripAssistantEmojis(history);
  const lastAssistant = cleanHistory.slice().reverse().find((m) => m.role === 'assistant')?.content || '';

  // 1. Acknowledging previous handoff / "waiting for response" (avoids repeating "I'd rather not guess")
  const isWaitingStatement = /^(?:(?:i\s+will|i'll)\s+(?:be\s+)?wait(?:ing)?(?:\s+for\s+(?:your\s+)?(?:response|reply))?|wait(?:ing)?(?:\s+for\s+(?:your\s+)?(?:response|reply))?|okay\s+i\s+(?:will|'ll)\s+wait|i\s+will\s+wait|i'll\s+wait)[.!]?$/i.test(text);
  const recentTeamHandoff = /passed your question to the studio team|member of our team will pick this up|team will confirm/i.test(lastAssistant);
  const isConfirmFollowUp = /^(?:(?:kindly|please)\s+)?confirm(?:\s+that)?(?:\s+for\s+me)?[.!]?$/i.test(text);
  if (isWaitingStatement || (recentTeamHandoff && (/^(?:okay|ok|alright|noted|waiting)[.!]?$/i.test(text) || isConfirmFollowUp))) {
    return "I've passed that on, and the studio team will reply here shortly.";
  }

  if (isFamilyPhotoCountQuestion(userMessage)) {
    return 'I understand you are asking whether family portraits count toward the edited photos. The package details do not specify that; the studio team can confirm for you.';
  }

  // 2. Makeup questions: "is makeup for one person", "is makeup included for partner"
  const makeupTerms = /\b(?:make[-\s]?up|makeup)\b/i;
  const singlePersonQuery = /\b(?:one\s+person|single\s+person|only\s+me|just\s+me|for\s+me\s+alone|how\s+many\s+people|who\s+is\s+it\s+for|for\s+both|for\s+(?:my\s+)?(?:partner|husband|sister))\b/i;
  if (makeupTerms.test(text) && singlePersonQuery.test(text)) {
    return 'Professional makeup is included for the expecting mother with every session. If you would like extra professional makeup for a partner, sister, or someone joining you, it is available for Ksh 3,500. Lashes are included with all our makeup services.';
  }

  // 3. Hair & Wigs: "do I have to come with my own hair", "bring my own hair", "can I bring my own wig"
  const hairTerms = /\b(?:hair|hairstyling|hair\s*styling|wig|wigs)\b/i;
  const ownHairQuery = /\b(?:come\s+with\s+(?:my\s+)?own\s+hair|bring\s+(?:my\s+)?own\s+hair|with\s+my\s+own\s+hair|my\s+own\s+hair|bring\s+(?:my\s+)?own\s+wig|come\s+with\s+(?:my\s+)?own|bring\s+(?:my\s+)?own)\b/i;
  if (hairTerms.test(text) && ownHairQuery.test(text)) {
    return 'Sessions include styling of your own hair. You are welcome to come with your hair ready for styling. If you would like a styled wig, styled wig hire is Ksh 4,000 and wig styling only is Ksh 3,000 (booked in advance). For specific hair preparation details, the studio team will confirm with you.';
  }

  // 4. Outfits - How to choose gowns / outfits
  const chooseTerms = /\b(?:(?:how|where)\s+(?:can|do)\s+i\s+(?:choose|chose|pick|select)|how\s+are\s+(?:the\s+)?(?:outfits?|gowns?)\s+(?:chosen|selected|picked)|(?:can|could|do|may)\s+i\s+(?:get\s+to\s+)?(?:choose|chose|pick|select))\b/i;
  const outfitTerms = /\b(?:outfits?|gowns?|dresses?|wardrobe)\b/i;
  if (chooseTerms.test(text) && outfitTerms.test(text)) {
    return 'You select your gowns and outfits from our studio wardrobe during your session, where our team assists with styling and fit. You may also bring personal sentimental outfits if you wish.';
  }

  // 5. Outfits - Customer offering to share gowns in chat
  const sharingGowns = /\b(?:i\s+will|i'll|let\s+me)\s+(?:share|send)\b.{0,40}\b(?:my\s+)?(?:gowns?|outfits?|dresses?|photos?)\b/i.test(text)
    || /\b(?:share|send)\b.{0,30}\b(?:my\s+gowns|my\s+outfits|my\s+dresses)\b/i.test(text);
  if (sharingGowns) {
    const nextGuide = context?.draftService ? ' What date would suit you for your session?' : '';
    return `Sounds wonderful! The studio team will review your gown choices with you, or you can bring them along to your session.${nextGuide}`;
  }

  // 6. Outfits - Adding extra outfit of own / swapping outfits
  const extraOwnOutfit = /\b(?:add|bring|wear|include)\b.{0,60}\boutfit\b.{0,40}\b(?:of\s+my\s+own|my\s+own|extra|one\s+more)\b/i.test(text)
    || /\b(?:add|bring)\s+(?:an?\s+)?(?:extra|one\s+more)\s+outfit\b/i.test(text)
    || /\b(?:can\s+i\s+bring|can\s+i\s+add)\b.{0,40}\b(?:my\s+own\s+outfit|extra\s+outfit)\b/i.test(text);
  if (extraOwnOutfit) {
    const nextGuide = context?.draftService ? ' What date would suit you for your session?' : '';
    return `Extra outfits beyond your package are Ksh 4,000 each. For bringing your own outfit or swapping one with the studio wardrobe, the studio team will confirm details with you.${nextGuide}`;
  }

  // 8. Power Suit: "what is the power suit", "what does the power suit look like", "how much is the power suit"
  if (/\bpower\s*suit\b/i.test(text)
    && /\b(?:what|tell\s+me|about|describe|explain|details?|looks?\s+like|vibe|style|feel|how\s+much|price|cost)\b/i.test(text)
    && !/\b(?:add|added|save|saved|want|book)\b/i.test(text)) {
    return POWER_SUIT_REPLY;
  }

  // 9. Preparation: wording from the studio FAQ rows "What should I bring to the session?" and "What do I need to bring?"
  if (/\b(?:what|anything)\b[^?]{0,40}\b(?:should|do|must|need\s+to|have\s+to)\s+(?:i\s+)?(?:bring|carry|wear)\b|\bwhat\s+to\s+(?:bring|carry|wear)\b/i.test(text)) {
    return 'Just bring yourself and any personal items you would like to include, such as baby ultrasound photos, baby shoes and accessories like earrings. Please wear a black bra and panties. We will handle the rest, including outfits, props and styling.';
  }

  // 10. Discount and returning-client inquiries (pending studio owner confirmation)
  const discountTerms = /\b(?:discounts?|special\s+rates?|loyalty\s+discounts?|returning\s+client\s+discounts?|repeat\s+client\s+discounts?)\b/i;
  const returningDiscountQuery = /\b(?:returning|repeat)\s+(?:client|customer)\b.*\b(?:discount|offer|rate|deal)\b/i.test(text)
    || /\b(?:do\s+i\s+get|is\s+there)\s+(?:a\s+)?discount\b/i.test(text)
    || /\bdo\s+you\s+(?:offer|have|give)\s+(?:any\s+)?discounts?\b/i.test(text);
  if (discountTerms.test(text) || returningDiscountQuery) {
    return 'The team will confirm that for you.';
  }

  return null;
}
