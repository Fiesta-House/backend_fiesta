
export const MAX_AGENT_COMPLETION_TOKENS = Math.min(2_500, Math.max(200, Number(process.env.AI_MAX_COMPLETION_TOKENS) || 1500));
export const MAX_RAG_CONTEXT_CHUNKS = 2;
// Booking flows routinely span add-on talk + date/time + affirmations; 6 was
// truncating the established edition out of the prompt after a couple of recovery turns.
export const MAX_HISTORY_MESSAGES = 12;
export const CANCELLATION_PROPOSAL_TTL_MS = 60 * 60 * 1000;
export const OFFICIAL_WEBSITE_URLS = {
  home: 'https://www.fiestahousematernity.com/',
  packages: 'https://www.fiestahousematernity.com/session-packages',
  reviews: 'https://www.fiestahousematernity.com/reviews',
  suspendingConcept: 'https://www.fiestahousematernity.com/gallery/suspending-concept',
} as const;
export const EDITION_LINK_REPLY = `You can see all our editions, inclusions and prices here: ${OFFICIAL_WEBSITE_URLS.packages}\nTell me which edition catches your eye.`;
export const ADDON_LINK_REPLY = `All the optional extras and their prices are here: ${OFFICIAL_WEBSITE_URLS.packages}\nTell me which you would like for your session.`;
export const PACKAGE_PRICING_FALLBACK = 'The Editions are THE BLOOM: Ksh 15,000, THE MUSE: Ksh 25,000, THE ICON: Ksh 35,000, THE LEGEND: Ksh 45,000, THE QUEEN: Ksh 55,000, THE EMPRESS: Ksh 70,000 (Most Loved / Signature), and THE GODDESS: Ksh 120,000 (Flagship).';
export const PAYMENT_CONFIRMATION_REQUIRED_REPLY = 'Before I share the payment details, please reply yes to confirm the booking.';
export const PAYMENT_PROMPT_UNRECORDED = 'PAYMENT_PROMPT_UNRECORDED';
export const PAYMENT_ALREADY_PENDING = 'PAYMENT_ALREADY_PENDING';
export const PAYMENT_ATTEMPTS_EXHAUSTED = 'PAYMENT_ATTEMPTS_EXHAUSTED';
export const RESCHEDULE_COLLECTING_STEP = 'reschedule_collecting';
export const RESCHEDULE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
export const PAYMENT_PROMPT_UNRECORDED_REPLY = 'Please use Lipa na M-Pesa Buy Goods Till Number 670241 and share the M-Pesa confirmation message here so the team can verify your payment.';
export const EDITION_TERM_PATTERN = '(?:packages?|editions?)';
export const EDITION_CATALOG_HEADER = 'Fiesta House Maternity - Rate Card 2026';
export const EDITION_CATALOG_INTRO = 'Here are our maternity editions:';
export const EDITION_CATALOG_FOLLOW_UP = "Tell me which edition you're considering and I'll share its inclusions and anything the team still needs to confirm.";
export const ADDON_NOTED_PREFIX = 'Noted for your session:';
export const ADDON_UNCHANGED_REPLY = 'I have not changed your edition or date.';
export const ADDON_BALANCE_REPLY = 'Extras go to the session balance, not the deposit.';
export const ADDON_QUOTED_PRICE_LABEL = 'quoted by package tier';
export const ADDON_MAKEUP_CLARIFICATION = 'Who should the extra professional makeup be for: you or someone joining your session?';
export const ADDON_MULTI_CLARIFICATION = 'Which add-on would you like to add to your session?';
export const ADDON_ADDITIONS_HEADER = 'Yes, these optional additions are available:';
// Must keep matching isTeamHandoffReply ("member of our team will pick this up") so handoff escalations still fire.
export const BUDGET_HANDOFF_REPLY = "I'm sorry for the wait, and thank you for your patience. A member of our team will pick this up with you shortly.";
export const BRAND_SLOGAN = 'Where Every Mother Becomes Iconic.';
// Must keep matching isTeamHandoffReply ("team will confirm"). Check tests/verifier for exact-string comparisons.
export const UNKNOWN_ANSWER_REPLY = 'I want to get that exactly right for you, so the team will confirm it and get back to you.';
export const BOOKING_WELCOME_CLOSING = "We're looking forward to welcoming you to Fiesta House Maternity.";
export const BRAND_RULES = `BRAND: Fiesta House Maternity's pillars are Luxury, Safety, Convenience and Comfort. Mention the all-women, professionally trained team only when relevant AND verified in Business Context. The only slogan is "${BRAND_SLOGAN}" Use it at most once per conversation, only in a greeting or closing, never in a price, policy or booking answer.`;
export const VOICE_RULES = `VOICE: In your own wording, use "session" or "reveal", never "photoshoot". Avoid clichés such as "glow" and "cherish every moment"; do not use hashtags in customer replies. Follow BRAND_RULES for slogan use.`;
