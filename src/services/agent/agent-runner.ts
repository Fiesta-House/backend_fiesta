import OpenAI from 'openai';
import type { AgentService } from './agent.service';
import { CHAT_MODEL, type ChatProvider } from './llm/provider';
import {
  addUsage,
  BookingExtractor,
  findExplicitDate,
  findExplicitDayOfMonth,
  InvalidDateError,
  INVALID_DATE_REPLY,
  resolveCalendarDate,
  usageFromCompletion,
  type TokenUsage,
} from './extraction';
import {
  CANCELLATION_PROPOSAL_TTL_MS,
  MAX_AGENT_COMPLETION_TOKENS,
  MAX_HISTORY_MESSAGES,
  MAX_RAG_CONTEXT_CHUNKS,
  OFFICIAL_WEBSITE_URLS,
  PACKAGE_PRICING_FALLBACK,
  PAYMENT_CONFIRMATION_REQUIRED_REPLY,
  PAYMENT_ALREADY_PENDING,
  BOOKING_SLOT_UNAVAILABLE,
  PAYMENT_ATTEMPTS_EXHAUSTED,
  RESCHEDULE_COLLECTING_STEP,
  RESCHEDULE_CONTEXT_TTL_MS,
  PAYMENT_PROMPT_UNRECORDED,
  PAYMENT_PROMPT_UNRECORDED_REPLY,
  ADDON_NOTED_PREFIX,
  ADDON_UNCHANGED_REPLY,
  ADDON_QUOTED_PRICE_LABEL,
  ADDON_BALANCE_REPLY,
  BUDGET_HANDOFF_REPLY,
  BRAND_RULES,
  VOICE_RULES,
  UNKNOWN_ANSWER_REPLY,
  ADDON_LINK_REPLY,
  EDITION_LINK_REPLY,
} from './constants';
import { RESCHEDULE_KEYWORD_PATTERN, normalizeQuotes } from './regex';
import {
  rememberBookingSlots as storeEarlySlots,
  carriedOverStale,
  closedDateReply,
  earlySlotsExpired,
  extractStatedSlots,
  isUsableName,
  knownSlotsLine,
  lapsedCarryOver,
  paymentLapsed,
  sanitizeSlotValue,
  sameDayClosedReply,
  EARLY_SLOT_STEP,
} from './slot-memory';
import { addonDetail, addonQuantity, selectedAddons } from './addon-capture';
import {
  editionInText,
  isCustomerNameQuestion,
  repeatedCollectionQuestion,
  savedCustomerNameReply,
} from './reply-voice';
import { enforceSlogan } from './slogan-guard';
import {
  applyEmojiPolicy,
  emojiReplyType,
  emojisIn,
  enforceEmojiPolicy,
  isOnlyEmojis,
  stripAssistantEmojis,
  templateEmojiReply,
  EMOJI_PROMPT_RULE,
  type EmojiReplyType,
} from './emoji-policy';
import {
  claimCatalogLink,
  explicitCatalogListRequest,
  type CatalogKind,
} from './catalog-policy';
import {
  bookingProgressReply,
  addonPickQuestion,
  carryOverQuestion,
  nextStep,
  openTimesReply,
  sampleSlots,
  STEP_QUESTIONS,
  welcomePrefix,
} from './booking-progress';
import {
  createSchemaAlertLimiter,
  isMissingColumnError,
  safeSchemaDetails,
  SCHEMA_MAINTENANCE_REPLY,
} from '../../config/schema-readiness';
import {
  createVerifierEscalationLimiter,
  currencyAmounts,
  depositAmounts,
  verifierCorrectionMessage,
  verifyWithOneRetry,
  type VerifierFacts,
} from './output-verifier';
import { SEED_EDITION_INCLUSIONS } from '../../config/edition-inclusions';
import { EDITIONS_PENDING_OWNER_CONFIRMATION } from '../../config/constants';
import { isFamilyPhotoCountQuestion } from './verified-facts';
import {
  buildBespokeReply,
  buildBookingForSomeoneElseReply,
  buildBusinessIntroductionReply,
  buildAboutBusinessReply,
  buildContactDetailsReply,
  buildMixedIntentClarificationReply,
  buildPackageBudgetReply,
  legacyPackageReply,
  isLashesQuestion,
  LASHES_FAQ_REPLY,
  buildPortfolioReply,
  buildPostShootProcessReply,
  buildRawFilesReply,
  buildSocialMediaReply,
  buildTravellingMothersReply,
  buildWebsiteReply,
  buildAdditionsReply,
  formatCustomerTime,
  buildBookingProposalConfirmation,
  buildCancellationProposal,
  buildPackageDepositProposal,
  buildRescheduleProposalConfirmation,
  isAddonListFollowUp as matchesAddonListFollowUp,
  isAdditionsRequest,
  isBespokeRequest,
  isBookingForSomeoneElseRequest,
  isBookingProcessRequest,
  isPackageBudgetRequest,
  isPostShootProcessRequest,
  isRawFilesRequest,
  isSocialMediaRequest,
  isTravellingMothersRequest,
  getReviewPageReply as buildReviewPageReply,
  getSuspendingConceptGalleryReply as buildSuspendingConceptGalleryReply,
  previousMessageRequestsConfirmation as matchesConfirmationRequest,
} from './replies';
import { knowledgeRetrieval } from '../knowledge/retrieval.service';
import prisma from '../../config/prisma';
import dayjs from 'dayjs';
import { bookingService } from '../booking/booking.service';
import { bookingStateService } from '../booking/booking-state.service';
import { bookingDraftService } from '../booking/booking-draft.service';
import { googleCalendarService } from '../calendar/calendar.service';
import {
  SERVICE_DURATIONS,
  DEFAULT_DURATION,
  MINIMUM_BOOKING_DEPOSIT,
  PACKAGE_NAME_PATTERN,
  PACKAGE_NAMES_FOR_EXTRACTION,
  ADDON_CATALOG,
  type AddonCatalogItem,
} from '../../config/constants';
import { mpesaService } from '../payment/mpesa.service';
import {
  circuitBreaker,
  scoreSentiment,
  DAILY_TOKEN_CAP,
  FALLBACK_MESSAGE,
  PROVIDER_OUTAGE_MESSAGE,
  shouldNotifyOutage,
  classifyProviderRateLimit,
  isProviderRateLimitError,
} from './resilience.service';
import { notifyAdmin } from '../notifications/notification.service';
import {
  TILL_NAME,
  TILL_NUMBER,
  PAYMENT_MESSAGE_ROUTES,
  parseMpesaMessage,
  isValidTillPayment,
} from './till-payment';
import {
  businessDay,
  bookingDateFacts,
  formatCustomerDate,
  nextWeekRange,
  inBusinessTimezone,
  nowInBusinessTimezone,
} from '../../utils/time';
import { getBookingPolicyWindow } from '../../utils/booking-policy';
import {
  ConversationFlowMatcher,
  isBusinessIdentityQuestion,
  isDeferral,
  isPlainGreeting,
  rescheduleTargetText,
} from './conversation-flow.matcher';
import { customerReplyTemplates, formatCustomerReply } from '../messaging/customer-reply.templates';
import { bookingAddonService } from '../booking/booking-addon.service';
import { explicitlySelectedDeliveryMethod } from './photo-delivery-replies';
import {
  buildPackageCard as formatPackageCard,
  getSameBookingSlotReply as buildSameBookingSlotReply,
} from './package-replies';
import { formatBookingDuration as formatAppointmentDuration } from './appointment-replies';

export async function runAgent(this: AgentService, customerId: string, userMessage: string, history: { role: 'user'|'assistant', content: string }[] = [], platform: string = 'whatsapp'): Promise<{ content: string; tokensUsed: number; failureType?: string }> {
    const modelRunStartedAt = Date.now();
    // 1. Fetch Customer and Booking History for Memory
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        bookings: {
          orderBy: { dateTime: 'desc' },
          take: 5,
          include: {
            bookingAddons: {
              where: { status: { in: ['pending', 'confirmed', 'invoiced'] } },
              orderBy: { createdAt: 'asc' },
              select: { name: true, quantity: true, totalPrice: true },
            },
            sessionNotes: {
              where: { status: { in: ['pending', 'approved'] } },
              orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
              select: { description: true, category: true, priority: true, structuredData: true },
            },
          },
        },
      }
    });

    const customerName = customer?.name && customer.name !== 'WhatsApp User' ? customer.name : 'Unknown';
    const now2 = dayjs();
    const upcomingBookings = (customer?.bookings || [])
      .filter(b => dayjs(b.dateTime).isAfter(now2) && b.status !== 'cancelled')
      .sort((a, b) => a.dateTime.getTime() - b.dateTime.getTime());
    const upcomingBooking = upcomingBookings[0];
    const otherUpcomingBookings = upcomingBookings.slice(1)
      .map(b => `${b.service} on ${inBusinessTimezone(b.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')} (status: ${b.status})`)
      .join('; ') || 'None';
    const upcomingAddons = upcomingBooking?.bookingAddons || [];
    const upcomingNotes = upcomingBooking?.sessionNotes || [];
    const recipientSummary = upcomingBooking?.recipientName
      ? ` Recipient: ${upcomingBooking.recipientName}.`
      : '';
    const addonSummary = upcomingAddons.length > 0
      ? ` Add-ons: ${upcomingAddons.map((addon) => `${addon.name}${addon.quantity > 1 ? ` x${addon.quantity}` : ''}${addon.totalPrice > 0 ? ` (Ksh ${addon.totalPrice.toLocaleString()})` : ''}`).join(', ')}.`
      : '';
    const noteSummary = upcomingNotes.length > 0
      ? ` Special session details: ${upcomingNotes.map((note) => `${note.description} [${note.category}, ${note.priority} priority]`).join('; ')}.`
      : '';
    const upcomingBookingSummary = upcomingBooking
      ? `${upcomingBooking.service} on ${inBusinessTimezone(upcomingBooking.dateTime).format('dddd, MMMM D, YYYY [at] h:mm A')} (status: ${upcomingBooking.status}; duration: ${upcomingBooking.durationMinutes || DEFAULT_DURATION} minutes).${recipientSummary}${addonSummary}${noteSummary}`
      : 'None';
    const pastBookings = customer?.bookings
      .filter((booking) => dayjs(booking.dateTime).isBefore(now2) && booking.status !== 'cancelled')
      .map(b =>
      `${b.service} on ${inBusinessTimezone(b.dateTime).format('YYYY-MM-DD')} (${b.status})`
    ).join(', ') || 'No past bookings';

    // Snapshot the booking draft's step as it stood BEFORE this turn's tool calls
    // run. confirm_booking checks against this snapshot, not the live value, so
    // a propose_booking call made earlier in this same turn can never satisfy it -
    // confirmation is only valid if it was already pending from a PRIOR message.
    const draftBeforeThisTurn = await prisma.bookingDraft.findUnique({ where: { customerId } });
    const initialDraftStep = draftBeforeThisTurn?.step;
    const currentSlots = draftBeforeThisTurn && !earlySlotsExpired(draftBeforeThisTurn) ? draftBeforeThisTurn : null;
    const statedSlots = extractStatedSlots(userMessage, history);
    const knownService = statedSlots.service || currentSlots?.service;
    const requestedCalendarDate = resolveCalendarDate(userMessage);
    const nextWeekAvailability = /\bnext\s+week\b/i.test(userMessage)
      && /\b(dates?|availability|available|slots?|book|session)\b/i.test(userMessage)
      && (platform === 'whatsapp' || platform === 'web');
    const lastAssistantMessageForCalendar =
      [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
    const customerAskedForBookingOrAvailability =
      /\b(?:book(?:ing)?|schedule|reserve|make\s+(?:an\s+)?appointment|availability|available\s+slots?|check\s+(?:availability|dates?|times?))\b/i.test(userMessage);
    const assistantIsCollectingBookingDateOrTime =
      /\b(?:what\s+date|which\s+date|preferred\s+date|what\s+time|which\s+time|preferred\s+time|what\s+date\s+and\s+time|when\s+would\s+you\s+like)\b/i.test(lastAssistantMessageForCalendar);
    const calendarRequested = Boolean(
      nextWeekAvailability ||
      /\b(?:available|availability|slots?|open\s+dates?|check\s+(?:the\s+)?calendar|what\s+dates?)\b/i.test(userMessage) ||
      (customerAskedForBookingOrAvailability && (requestedCalendarDate || statedSlots.time)) ||
      (assistantIsCollectingBookingDateOrTime && (requestedCalendarDate || statedSlots.time))
    );
    if (nextWeekAvailability && !knownService) {
      return { content: 'Which package would you like for your session?', tokensUsed: 0 };
    }
    let calendarReply: string | null = null;
    const dateRangeResults = new Map<string, Awaited<ReturnType<typeof bookingService.getAvailableDates>>>();
    const checkDateRange = async (fromDate: string, toDate: string, service: string) => {
      const key = JSON.stringify([fromDate, toDate, service]);
      let result = dateRangeResults.get(key);
      if (!result) {
        result = await bookingService.getAvailableDates(fromDate, toDate, service);
        dateRangeResults.set(key, result);
      }
      calendarReply = result.dates.length
        ? `Available dates for ${editionInText(service)}:\n${result.dates.map((entry) => `${formatCustomerDate(entry.date)}: ${sampleSlots(entry.slots).map(formatCustomerTime).join(', ')}`).join('\n')}\nWhich date and time would work for you?`
        : `${result.message} Which other date range would work for you?`;
      return result;
    };
    const checkCalendarSlots = async (date: string, service: string) => {
      const facts = bookingDateFacts(date);
      const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => service.toLowerCase().includes(key));
      if (!serviceKey) throw new Error('Choose a recognised package before checking availability.');
      const result = await bookingService.getAvailableSlots(date, SERVICE_DURATIONS[serviceKey]);
      const day = formatCustomerDate(date);
      if (facts.isPast || facts.isMonday || !Array.isArray(result)) {
        const reason = facts.isPast ? 'That date is in the past' : facts.isMonday ? 'Closed on Mondays'
          : Array.isArray(result) ? 'No slots are available' : result.reason;
        calendarReply = facts.isPast || facts.isMonday ? closedDateReply(facts) : `${day}: ${reason}. Which other date would work for you?`;
        return { ...facts, status: 'closed', reason };
      }
      const requestedTime = statedSlots.time || currentSlots?.time;
      calendarReply = requestedTime && result.includes(requestedTime)
        ? `${formatCustomerTime(requestedTime)} on ${day} is available for ${editionInText(service)}. Would you like to go ahead with that time?`
        : result.length
          ? openTimesReply(date, service, result)
          : (date === nowInBusinessTimezone().format('YYYY-MM-DD'))
          ? `There are no more sessions available today for ${editionInText(service)}. Which other date would work for you?`
          : `${day} is fully booked for ${editionInText(service)}. Which other date would work for you?`;
      return { ...facts, slots: result };
    };

    // Fetch payment and deposit facts separately for every upcoming appointment.
    const upcomingBookingPaymentSummaries = await Promise.all(
      upcomingBookings.map(async (booking) => {
        const [paidPayment, packageInfo] = await Promise.all([
          prisma.payment.findFirst({
            where: { bookingId: booking.id, status: 'success' },
            orderBy: { updatedAt: 'desc' },
          }),
          this.getPackageForDeposit(booking.service).catch(() => null),
        ]);

        let depositText = 'not available from package records';
        try {
          if (packageInfo) {
            depositText = `KSh ${this.getDepositForPackage(packageInfo).toLocaleString()}`;
          }
        } catch {
          // Do not invent a deposit if package data is missing or invalid.
        }

        const appointmentDate = inBusinessTimezone(booking.dateTime)
          .format('dddd, MMMM D, YYYY [at] h:mm A');

        const paymentFact = paidPayment
          ? `SUCCESSFUL PAYMENT RECORDED via M-Pesa${paidPayment.mpesaReceipt ? ` (Receipt: ${paidPayment.mpesaReceipt})` : ''}. Do not ask the customer to pay this deposit again.`
          : 'No successful payment is recorded in this database lookup. This does NOT prove the customer has not paid. If she says she already paid, offer verification with the studio team; do not automatically tell her to pay again.';

        return `${booking.service} â€” ${appointmentDate} (booking status: ${booking.status}). Package deposit: ${depositText}. Payment record: ${paymentFact}`;
      })
    );

    // Keep active proposal payment context separate from existing appointments.
    let paymentSummary = 'No active proposal payment is awaiting a customer message.';
    if (draftBeforeThisTurn?.step === 'awaiting_payment_message') {
      let depositText = 'the deposit amount in her proposal';
      try {
        const deposit = this.getDepositForPackage(
          await this.getPackageForDeposit(draftBeforeThisTurn.service || '')
        );
        depositText = 'KSh ' + deposit.toLocaleString();
      } catch {
        // Keep the generic wording if verified package data is unavailable.
      }

      paymentSummary =
        'The customer has accepted the active booking proposal. Its deposit is ' +
        depositText +
        ' and is payable via Lipa na M-Pesa Buy Goods, Till Number ' +
        TILL_NUMBER +
        ' (' +
        TILL_NAME +
        '). No STK push or payment link is sent. If payment instructions are needed, explain them naturally. The customer shares the M-Pesa confirmation message or transaction code here. The studio team verifies the transaction. A message or code is not proof of payment; never claim payment received before verification.';
    }
    const [memory, pendingAddonSummary] = await Promise.all([
      prisma.customerMemory.findUnique({ where: { customerId } }),
      bookingStateService.getPendingAddonSummary(customerId, draftBeforeThisTurn),
    ]);
    const memorySummary = memory
      ? `Relationship Stage: ${memory.relationshipStage}. Total Past Bookings: ${memory.totalBookings}.`
        + (memory.preferredPackages.length ? ` Preferred Packages: ${memory.preferredPackages.join(', ')}.` : '')
        + (memory.lastInteractionSummary ? ` Last Interaction Summary: "${memory.lastInteractionSummary}"` : '')
      : 'No prior interaction history - this looks like a new customer.';

    const isLightweightTurn = /^(?:hi+|hello+|hey+|good\s+(?:morning|afternoon|evening)|thanks?|thank\s+you|ok(?:ay)?|sawa|asante)[!.\s]*$/i.test(userMessage.trim());

    // 2. Retrieve RAG Context (skip for pure greetings/acknowledgements)
    const relevantKnowledge = isLightweightTurn
      ? []
      : await knowledgeRetrieval.search(userMessage, MAX_RAG_CONTEXT_CHUNKS);
    const contextString = relevantKnowledge.map(k => k.content).join('\n---\n');

    const contextSlots = currentSlots || (upcomingBooking?.status === 'confirmed' ? {
      step: 'confirmed', service: upcomingBooking.service,
      date: inBusinessTimezone(upcomingBooking.dateTime).format('YYYY-MM-DD'),
      time: inBusinessTimezone(upcomingBooking.dateTime).format('HH:mm'),
      name: upcomingBooking.recipientName || customer?.name,
    } : null);
    const fullContext = `Customer Name: ${JSON.stringify(sanitizeSlotValue(customerName))}
  ${knownSlotsLine(contextSlots, customer?.name)}
  Pending Add-ons (Current Draft): ${pendingAddonSummary}
  Computed calendar facts (authoritative, never infer weekdays): today=${nowInBusinessTimezone().format('YYYY-MM-DD dddd')}; requested=${requestedCalendarDate ? JSON.stringify(bookingDateFacts(requestedCalendarDate)) : 'none'}; next week=${JSON.stringify(nextWeekRange())}.
  Booking Draft: ${draftBeforeThisTurn?.recipientName ? `This booking is for ${draftBeforeThisTurn.recipientName}, on behalf of the WhatsApp customer. Do not ask for the recipient's name again.` : 'None'}
Upcoming Booking (their next appointment, if any): ${currentSlots?.step === 'collecting_slots' ? `SEPARATE EXISTING BOOKING, NOT the current unbooked request: ${upcomingBookingSummary}. The collecting_slots request is NOT confirmed or paid; do not substitute this older appointment.` : upcomingBookingSummary}
Other Upcoming Bookings: ${otherUpcomingBookings}
Payment Status: Existing appointment payment details: ${upcomingBookingPaymentSummaries.join('\n') || 'No upcoming appointments with payment details.'} Active proposal payment status: ${currentSlots?.step === 'collecting_slots' ? 'The current collecting_slots request is not confirmed and has no verified payment. Existing appointment payment details above belong to separate bookings.' : paymentSummary}
Past Bookings: ${pastBookings}
Customer Memory: ${memorySummary}

Business Context:
${contextString}`;

    // 3. Build conversation history
    const recentConversation = [...history.slice(-MAX_HISTORY_MESSAGES).map((message) => message.content), userMessage]
      .join('\n')
      .toLowerCase();
    const currentMessageRequestsPricing =
      /\b(?:how\s+much|price(?:s|d|ing)?|pricing|cost(?:s|ing)?|rate\s*card|cheapest|affordable)\b/i.test(userMessage);

    const currentMessageMentionsAddon =
      /\b(?:add-?ons?|extras?|extra\s+(?:outfit|photo|makeup)|styled\s+wig|wig\s+hire|power\s+suit|sculpture\s+set|balloon\s+backdrop|reel\s+pricing)\b/i.test(userMessage);

    const currentMessageMentionsPackage =
      /\b(?:package|edition|bloom|muse|icon|legend|queen|empress|goddess)\b/i.test(userMessage);

    const previousUserAskedPricing = history.slice(-4).some(
      (message) =>
        message.role === 'user' &&
        /\b(?:how\s+much|price(?:s|d|ing)?|pricing|cost(?:s|ing)?|rate\s*card|cheapest|affordable)\b/i.test(message.content)
    );

    const currentMessageContainsDateOrTime =
      this.messageContainsExplicitDateSignal(userMessage) ||
      this.messageContainsExplicitTimeSignal(userMessage);

    const includePackagePricing =
      (currentMessageRequestsPricing &&
        (!currentMessageMentionsAddon || currentMessageMentionsPackage)) ||
      (!currentMessageContainsDateOrTime &&
        !currentMessageRequestsPricing &&
        previousUserAskedPricing &&
        currentMessageMentionsPackage &&
        !currentMessageMentionsAddon);

    const includeAddonPricing = true;

    const packagePricingLine = includePackagePricing
      ? await this.getPackagePricingLine()
      : undefined;
    const paymentIntentForExistingBooking =
      /\b(?:pay(?:ment)?|deposit|balance|m-?pesa|till)\b/i.test(userMessage);

    const explicitBookingActionIntent =
      /\b(?:book|schedule|reserve|reschedule|postpone|move|change|cancel|availability|available\s+slots?)\b/i.test(userMessage) ||
      /\b(?:new|another|different)\s+(?:booking|appointment|session)\b/i.test(userMessage);

    const hasExistingPaymentContext =
      upcomingBookings.length > 0 ||
      draftBeforeThisTurn?.step === 'awaiting_payment_message';

    const paymentQuestionForExistingContext =
      paymentIntentForExistingBooking &&
      hasExistingPaymentContext &&
      !explicitBookingActionIntent;

    const toolsEnabledForTurn =
      this.shouldExposeTools(userMessage, history, platform) &&
      !paymentQuestionForExistingContext;
    const mentionsWorkflowTopic =
      /\b(?:book(?:ing)?|reserve|reservation|schedule|reschedule|cancel|cancellation|availability|available|slots?|appointment|deposit|payment|delivery)\b/i.test(userMessage);

    const includeEditions = Boolean(
      currentMessageMentionsPackage ||
      currentMessageRequestsPricing ||
      /\b(?:inclusions?|included|include|comes?\s+with|compare|difference|duration|hours?|photos?|images?|outfits?|makeup|wig|photobook|mount|backdrop)\b/i.test(recentConversation)
    );
    const includeWorkflow = toolsEnabledForTurn || mentionsWorkflowTopic;

    const fullSystemPrompt = this.getSystemPrompt(
      fullContext,
      platform,
      includePackagePricing,
      includeAddonPricing,
      packagePricingLine,
      recentConversation,
      { includeEditions, includeWorkflow }
    );

    const systemPrompt = toolsEnabledForTurn
      ? fullSystemPrompt
      : fullSystemPrompt.replace(
          /\[B\] TOOL-USE WORKFLOW[\s\S]*?(?=\[C\] BUSINESS KNOWLEDGE)/,
          mentionsWorkflowTopic
            ? `[B] INFORMATION-ONLY WORKFLOW GUIDANCE: No booking or action tools are available on this turn. Answer booking, payment and appointment questions naturally using verified context. Use the Existing appointment payment details in Payment Status to identify the correct package, date, time, deposit and recorded payment status. Match references such as a weekday, date, package or "the one on Tuesday" against those appointments. If more than one appointment could match, ask which one rather than guessing. If a successful payment is recorded for that appointment, do not ask her to pay that deposit again. If no successful payment is recorded, do not assume she has not paid; if she says she already paid, offer verification with the studio team. Only explain the Till payment instructions when payment is actually due, and use the exact deposit shown for the relevant appointment or active proposal. Do not call or imply that a booking, reschedule, cancellation, payment or delivery action occurred. The current payment method for new bookings is manual Lipa na M-Pesa Buy Goods Till Number ${TILL_NUMBER} (${TILL_NAME}); no STK push, automated phone prompt or payment link is sent. Explain the process in your own words according to what the customer is asking. The exact deposit comes from the booking proposal or verified package information. After the customer has accepted the proposal, explain how to pay the deposit and ask her to share the M-Pesa confirmation message or transaction code here. The studio team verifies payment before confirming the session. A submitted message is not proof of payment. Never invent a deposit amount or say a slot is secured before payment verification. For appointment details, answer from existing booking information rather than treating the question as a reschedule request. Follow the platform capability rules above.\n\n`
            : '[B] Detailed tool-use workflows omitted for this informational turn.\n\n',
        );

    if (!toolsEnabledForTurn && systemPrompt === fullSystemPrompt) {
      throw new Error('Could not omit the workflow section from the informational prompt.');
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: 'user', content: userMessage }
    ];

    // 3. Hybrid Extraction (for logging/debug, we'll let LLM handle the tool calls)
    const extractor = new BookingExtractor();
    const { details: extracted, usage: extractorUsage } = await extractor.extract(userMessage);
    console.log('Extracted details:', extracted);

    // 4. Define the tools the AI can use
    const availableTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'add_session_note',
          description: 'Saves a note about a specific request or detail for a booking (e.g. "bringing husband", "special backdrop request").',
          parameters: {
            type: 'object',
            properties: {
              bookingDate: { type: 'string', description: 'The date of the booking this note applies to (YYYY-MM-DD)' },
              note: { type: 'string', description: 'The specific detail to save' },
              type: { type: 'string', enum: ['external_people', 'external_items', 'special_request', 'other'], description: 'Legacy storage type for the note' },
              category: { type: 'string', enum: ['client_wish', 'operational', 'addon', 'accessibility', 'companion', 'styling', 'delivery', 'other'], description: 'What kind of operational detail this is' },
              priority: { type: 'string', enum: ['normal', 'high', 'urgent'], description: 'How important this detail is for preparing the session' }
            },
            required: ['bookingDate', 'note', 'type']
          }
        }
      }
    ];

    if (platform === 'whatsapp' || platform === 'web') {
      availableTools.push(
        {
          type: 'function',
          function: {
            name: 'propose_booking',
            description: 'Prepare a booking proposal only when the customer has genuinely decided to proceed with booking and the conversation has reached the proposal stage. Having a package, date, time and name is NOT by itself permission to propose. Do NOT call this for package interest, comparisons, pricing or inclusion questions, general studio questions, tentative plans, or an availability-only enquiry. A customer saying they like or are interested in an edition is not booking intent. For a short reply such as a date, time, or â€œthat oneâ€, use the conversation to establish whether she is answering a question in an already active booking progression; do not treat an old draft or an earlier package discussion as permission. The required name, service, date and confirmed-free time must all be known. This only prepares a proposal and states the exact deposit; it does NOT charge anything or send payment instructions. The customer must explicitly confirm on a LATER message before confirm_booking can be called.',
            parameters: {
              type: 'object',
              properties: {
                customerName: { type: 'string', description: "The customer's name; a single usable first name is sufficient. Never pass 'Unknown' or a placeholder; ask only if no usable name is available." },
                service: { type: 'string', description: 'The photography or attire service requested' },
                date: { type: 'string', description: 'The date for the booking (YYYY-MM-DD)' },
                time: { type: 'string', description: 'The time for the booking (HH:mm)' }
              },
              required: ['customerName', 'service', 'date', 'time']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'confirm_booking',
            description: "Confirms the booking details and issues the M-Pesa Till number payment instructions to the customer. Only call this after propose_booking has already told them the deposit amount AND the customer has explicitly replied yes/confirm/go ahead in their OWN message - never call this in the same turn as propose_booking.",
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_reschedule',
            description: "Proposes moving the customer's upcoming booking to a new date/time they just told you. Only call this if the customer EXPLICITLY asked to reschedule/change/move/postpone their booking - merely asking about their appointment or its details (e.g. 'tell me about my appointment') is NOT a reschedule request, do not call this tool for that. NEVER invent or guess a date/time yourself - only call this with a date/time the customer actually stated in their own message. If they asked to reschedule without giving a new date/time, do not call this at all - ask them what date/time they want instead. Does NOT change anything yet - you must get an explicit yes/confirm from the customer on a LATER message before calling confirm_reschedule.",
            parameters: {
              type: 'object',
              properties: {
                newDate: { type: 'string', description: 'The new date, exactly as the customer stated it (YYYY-MM-DD)' },
                newTime: { type: 'string', description: 'The new time, exactly as the customer stated it (HH:mm)' }
              },
              required: ['newDate', 'newTime']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'confirm_reschedule',
            description: 'Actually applies the reschedule. Only call this after propose_reschedule already told the customer the new date/time AND they explicitly replied yes/confirm on their OWN later message - never call this in the same turn as propose_reschedule.',
            parameters: { type: 'object', properties: {} }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_available_slots',
            description: 'Check available time slots for a specific date and service duration',
            parameters: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'The date to check (YYYY-MM-DD)' },
                service: { type: 'string', description: 'The service name (to determine duration)' }
              },
              required: ['date', 'service']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'get_available_dates',
            description: 'Check open dates and a few available times per date for a recognised package, over at most fourteen days. Skip Mondays and fully booked dates. Use the stored package when known; next week means the computed Monday-Sunday range.',
            parameters: {
              type: 'object',
              properties: {
                fromDate: { type: 'string', description: 'First date, YYYY-MM-DD' },
                toDate: { type: 'string', description: 'Last date inclusive, YYYY-MM-DD' },
                service: { type: 'string', description: 'Selected package name' },
              },
              required: ['fromDate', 'toDate', 'service'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'cancel_booking',
            description: 'Two-step cancellation tool. On the first turn, identify the exact upcoming session, state its date/time and whether it is eligible for a refund (never promise an amount or that money was returned), save a cancel_confirm proposal, and STOP. If there are multiple upcoming sessions, ask which one and save no cancellation proposal until the customer identifies one. On a later turn, call this tool to cancel only when initialDraftStep was already cancel_confirm, the customer message clearly says yes/yeah/yep/ndio/confirm, and the immediately preceding assistant message asked them to confirm this cancellation. ok/okay/sawa are not consent. A no/keep response or unrelated message must clear the pending proposal. The actual cancellation updates the booking and removes its Google Calendar event through the existing cancellation action.',
            parameters: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'Date (YYYY-MM-DD) of the appointment to cancel. Required when the customer has more than one upcoming appointment.' }
              }
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'save_delivery_preference',
            description: 'Saves how the customer wants to receive the secure download link for edited photos (especially email delivery). If email delivery is requested, include the exact email address when known.',
            parameters: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['email', 'download_link', 'whatsapp'], description: 'Preferred channel for receiving the secure download link for edited photos' },
                email: { type: 'string', description: 'Customer email address if method is email (optional only when already known and previously confirmed)' },
                whatsappNumber: { type: 'string', description: 'WhatsApp number to receive the download link when method is whatsapp (optional if same as customer number on file)' },
                note: { type: 'string', description: 'Any extra delivery preference details (e.g. express requested)' }
              },
              required: ['method']
            }
          }
        }
      );
    }

    const exposesToolsForTurn = toolsEnabledForTurn;

    const lastAssistantForToolSelection =
      [...history].reverse().find((message) => message.role === 'assistant')?.content || '';

    // Only customer-authored context participates in this narrow tool-selection
    // hint. Assistant wording must not turn an ordinary follow-up into a booking turn.
    const recentCustomerContextForToolSelection = history
      .filter((message) => message.role === 'user')
      .slice(-4)
      .map((message) => message.content)
      .join('\n');

    const dateOrTimeForToolSelection =
      this.messageContainsExplicitDateSignal(userMessage) ||
      this.messageContainsExplicitTimeSignal(userMessage);

    const bookingContextForToolSelection =
      /\b(?:book(?:ing)?|schedule|appointment|availability|available\s+slots?|reschedul(?:e|ing)|postpone|move)\b/i.test(
        `${userMessage}\n${recentCustomerContextForToolSelection}`
      );

    const rescheduleContextForToolSelection =
      /\b(?:reschedul(?:e|ing)|postpone|move\s+(?:it|my|the|this)|change\s+(?:my|the|this)\s+(?:booking|appointment|session))\b/i.test(
        `${userMessage}\n${lastAssistantForToolSelection}`
      );

    const hasExplicitDateForToolSelection =
      this.messageContainsExplicitDateSignal(userMessage);

    const hasExplicitTimeForToolSelection =
      this.messageContainsExplicitTimeSignal(userMessage);

    const dateRangeRequestForToolSelection =
      /\b(?:next week|this week|what dates|which dates|open dates|available dates|date range)\b/i.test(userMessage);

    let selectedToolNamesForTurn: string[] | null = null;

    if (
      exposesToolsForTurn &&
      dateOrTimeForToolSelection &&
      bookingContextForToolSelection
    ) {
      if (dateRangeRequestForToolSelection) {
        selectedToolNamesForTurn = ['get_available_dates'];
      } else if (
        rescheduleContextForToolSelection &&
        hasExplicitDateForToolSelection &&
        hasExplicitTimeForToolSelection
      ) {
        selectedToolNamesForTurn = [
          'get_available_slots',
          'propose_reschedule',
        ];
      } else {
        // Do not narrow this turn to a pre-decided booking action. The model
        // still receives the full tool set and must interpret the customer's
        // intent from the conversation; a date/time plus stored package is not
        // sufficient reason to propose a booking. Availability is checked only
        // when requested or when she is answering the assistant's active
        // booking-detail question (enforced by calendarRequested above).
      }
    }

    const allTools = !exposesToolsForTurn
      ? []
      : selectedToolNamesForTurn
        ? availableTools.filter(
            (tool) =>
              tool.type === 'function' &&
              selectedToolNamesForTurn!.includes(tool.function.name)
          )
        : availableTools;

    if (selectedToolNamesForTurn) {
      console.info('[AGENT_TOOLS] Narrowed tools for date/time turn:', {
        toolCount: allTools.length,
        toolNames: allTools.map((tool) =>
          tool.type === 'function' ? tool.function.name : ''
        ),
      });
    }
    const allowedToolNames = allTools
      .map((tool) => tool.type === 'function' ? tool.function.name : '')
      .filter((name): name is string => !!name);
    const contentCharLength = (content: unknown): number =>
      typeof content === 'string'
        ? content.length
        : (JSON.stringify(content ?? '') || '').length;

    const recentHistoryForSize = history.slice(-MAX_HISTORY_MESSAGES);
    const promptMessageChars = messages.reduce(
      (total, message) => total + contentCharLength(message.content),
      0,
    );
    const historyChars = recentHistoryForSize.reduce(
      (total, message) => total + contentCharLength(message.content),
      0,
    );
    const toolSchemaChars = JSON.stringify(allTools).length;

    console.info('[AGENT_PROMPT_SIZE]', JSON.stringify({
      systemChars: systemPrompt.length,
      businessContextChars: fullContext.length,
      ragChars: contextString.length,
      historyMessages: recentHistoryForSize.length,
      historyChars,
      toolCount: allTools.length,
      toolSchemaChars,
      totalMessageChars: promptMessageChars,
      estimatedInputTokens: Math.ceil((promptMessageChars + toolSchemaChars) / 4),
    }));

    // 5. Call LLM. Booking a slot is naturally multi-step (check availability,
    // then book), so the model can legitimately want to chain more than one
    // tool call in a single turn - loop until it returns plain text instead of
    // assuming a single round. A hard cap prevents a runaway loop.
    const usage: TokenUsage = { ...extractorUsage };
    const verifiedToolAmounts = new Set<number>();
    const verifiedToolDeposits = new Set<number>();
    let toolCalls = 0;
    const MAX_TOOL_ROUNDS = 3;
    const completionParams = {
      model: CHAT_MODEL,
      messages,
      temperature: 0.5,
      max_completion_tokens: MAX_AGENT_COMPLETION_TOKENS,
      ...(allTools.length > 0 ? { tools: allTools, tool_choice: nextWeekAvailability
        ? { type: 'function' as const, function: { name: 'get_available_dates' } }
        : 'auto' as const } : {}),
    };
    let completion = await this.createCompletionWithToolNameGuard(completionParams, allowedToolNames, allTools);
    let currentResponse = completion.response;
    addUsage(usage, usageFromCompletion(currentResponse, completion.completionCalls));
    completionParams.tool_choice = 'auto';

    let rounds = 0;
    let proposedThisTurn = false; // blocks confirm_booking if propose_booking (even a re-propose with changed details) ran earlier in this same turn
    let confirmedActionThisTurn = false; // once a booking/reschedule is confirmed, blocks ALL further booking tool calls this turn - the model has looped and re-proposed unasked-for changes after a successful confirm before
    let rescheduleAppliedThisTurn = false;
    let cancelledThisTurn = false;
    let noteSavedThisTurn = false;
    let cancellationReply: string | null = null;
    let exactProposalReply: string | null = null;
    while (currentResponse.choices[0].message.tool_calls && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const responseMessage = currentResponse.choices[0].message;
      messages.push(responseMessage); // Add assistant message to history once

      for (const toolCall of responseMessage.tool_calls!) {
        if (toolCall.type === 'function') {
          toolCalls++;
          const functionName = toolCall.function.name;
          let args: any = {};
          let toolResponse: string;

          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            toolResponse = `ERROR: Invalid arguments for tool ${functionName}. Ask the customer for the missing details again and then retry the correct tool.`;
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResponse
            });
            continue;
          }

          console.log(`Tool Called: ${functionName} with args:`, args);

          try {
            if (['propose_booking', 'confirm_booking', 'propose_reschedule', 'confirm_reschedule', 'cancel_booking'].includes(functionName) && confirmedActionThisTurn) {
              toolResponse = `ERROR: A booking/reschedule was already confirmed earlier in this same turn. The task is done - stop calling booking tools and just tell the customer it's confirmed.`;
            }
            else if (functionName === 'propose_booking') {
              const requestedDate = this.getAuthoritativeRequestedDate(userMessage, args.date, extracted.date, history);
              const result = await this.executeProposeBookingTool(customerId, args.customerName, args.service, `${requestedDate}T${args.time}`);
              if (Number.isInteger(result.depositAmount) && result.depositAmount > 0) verifiedToolDeposits.add(result.depositAmount);
              proposedThisTurn = true;
              exactProposalReply = buildBookingProposalConfirmation(args.service, requestedDate, args.time, result.depositAmount);
              toolResponse = `PROPOSED (not yet charged): ${args.service} on ${requestedDate} at ${args.time}, deposit KSH ${result.depositAmount}. Use this exact customer-facing confirmation: "${buildBookingProposalConfirmation(args.service, requestedDate, args.time, result.depositAmount)}" Do NOT call confirm_booking in this same turn.`;
            }
            else if (functionName === 'confirm_booking') {
              if (proposedThisTurn) {
                toolResponse = `ERROR: You already called propose_booking earlier in this same turn - possibly with different details than what the customer last saw and agreed to. You must stop here and wait for the customer's own separate message explicitly confirming before calling confirm_booking.`;
              } else if (!this.isPaymentConfirmation(userMessage)) {
                toolResponse = `ERROR: The customer has not explicitly replied yes, confirm, go ahead, or proceed in this message, so payment instructions were NOT sent. Ask them to reply yes to confirm the booking.`;
              } else {
                const expectedDeposit = this.getDepositAmountFromProposalHistory(history);
                const result = await this.executeConfirmBookingTool(customerId, initialDraftStep, expectedDeposit);
                if (Number.isInteger(result.depositAmount) && result.depositAmount > 0) verifiedToolDeposits.add(result.depositAmount);
                confirmedActionThisTurn = true;
                exactProposalReply = `To complete booking ${result.service} on ${result.date} at ${result.time}, please pay the deposit of Ksh ${result.depositAmount.toLocaleString()} via Lipa na M-Pesa: Buy Goods Till Number ${result.till} (${result.tillName}). Once paid, please paste or forward the M-Pesa confirmation message here and a team member will confirm your booking.`;
                toolResponse = `${exactProposalReply} This is DONE - do not call any more booking tools this turn.`;
              }
            }
            else if (functionName === 'propose_reschedule') {
              if (!args.newDate || !args.newTime || !this.hasRescheduleDateTimeSignal(userMessage, history)) {
                toolResponse = `ERROR: The customer has not actually stated a specific new date and time in their OWN message this turn. Do NOT invent one, and do NOT reuse the date/time from their existing upcoming booking as if it were a new request - ask them what date and time they'd like to reschedule to.`;
              } else {
                const result = await this.executeProposeRescheduleTool(customerId, args.newDate, args.newTime);
                await this.notifyRescheduleAdmin({
                  customerId,
                  event: 'proposed',
                  service: result.service,
                  oldDateTime: result.oldDateTime,
                  newDate: args.newDate,
                  newTime: args.newTime,
                });
                proposedThisTurn = true;
                const policyNotice = this.isRescheduleWithin72Hours(result.oldDateTime)
                  ? `${this.getReschedulePolicyMessage()} `
                  : '';
                exactProposalReply = `${policyNotice}${buildRescheduleProposalConfirmation(args.service, args.newDate, args.newTime)}`;
                toolResponse = `${policyNotice}PROPOSED (not yet applied): reschedule ${result.service} to ${args.newDate} at ${args.newTime}. Use this exact customer-facing confirmation: "${buildRescheduleProposalConfirmation(result.service, args.newDate, args.newTime)}" Do NOT call confirm_reschedule in this same turn.`;
              }
            }
            else if (functionName === 'confirm_reschedule') {
              if (proposedThisTurn) {
                toolResponse = `ERROR: You already called propose_reschedule earlier in this same turn - possibly with different details than what the customer last saw and agreed to. You must stop here and wait for the customer's own separate message explicitly confirming before calling confirm_reschedule.`;
              } else {
                const result = await this.executeConfirmRescheduleTool(customerId, initialDraftStep);
                rescheduleAppliedThisTurn = true;
                exactProposalReply = customerReplyTemplates.rescheduleConfirmed(result.service, inBusinessTimezone(result.newDateTime).format('dddd, MMMM D, YYYY [at] h:mm A'), result.depositForfeited);
                await this.notifyRescheduleAdmin({
                  customerId,
                  event: 'confirmed',
                  service: result.service,
                  oldDateTime: result.oldDateTime,
                  newDateTime: result.newDateTime,
                });
                confirmedActionThisTurn = true;
                const policyNotice = result.depositForfeited
                  ? ' The customer was rescheduled within 72 hours, so the deposit was forfeited according to policy.'
                  : '';
                toolResponse = `SUCCESS: Booking for ${result.service} rescheduled to ${inBusinessTimezone(result.newDateTime).format('YYYY-MM-DD HH:mm')} Nairobi time.${policyNotice} This is DONE - do not call any more booking tools this turn.`;
              }
            }
            else if (functionName === 'cancel_booking') {
              if (proposedThisTurn) {
                toolResponse = 'ERROR: A cancellation proposal or booking selection was already made this turn. Stop and wait for the customer to respond on a later message.';
              } else if (initialDraftStep === 'cancel_confirm') {
                if (!this.isCancellationConfirmation(userMessage) || !this.previousMessageRequestsConfirmation(history)) {
                  toolResponse = 'ERROR: The customer has not clearly confirmed this pending cancellation in their own message immediately after the cancellation proposal. Do not cancel; ask them to reply yes, yeah, yep, ndio, or confirm.';
                } else {
                  const result = await this.executeConfirmCancellationTool(customerId, initialDraftStep);
                  confirmedActionThisTurn = true;
                  cancelledThisTurn = true;
                  cancellationReply = this.getCancellationCompletionReply(result);
                  toolResponse = `SUCCESS: ${cancellationReply} This is DONE - do not call any more booking tools this turn.`;
                }
              } else {
                const proposal = await this.proposeCancellation(customerId, userMessage, history);
                proposedThisTurn = true;
                cancellationReply = proposal.reply;
                toolResponse = `${proposal.reply} Do not call cancel_booking again this turn; wait for the customer's own next message.`;
              }
            }
            else if (functionName === 'save_delivery_preference') {
              const deliveryContext = [...history.filter((message) => message.role === 'user').map((message) => message.content), userMessage].join('\n');
              if (!explicitlySelectedDeliveryMethod(deliveryContext, args.method)) {
                toolResponse = 'No delivery preference was saved. The customer has not explicitly chosen this channel. Ask whether they prefer WhatsApp, email, or the secure download link.';
              } else {
                const result = await this.executeSaveDeliveryPreferenceTool(customerId, args.method, args.email, args.whatsappNumber, args.note, platform);
                if (result.method === 'email' && result.email) {
                  toolResponse = `SUCCESS: Delivery preference saved. Use this exact customer-facing confirmation: "Perfect, I've saved ${result.email} as your delivery email. We'll share your secure download link within 10 working days after the shoot."`;
                } else if (result.method === 'whatsapp' && result.whatsappNumber) {
                  toolResponse = `SUCCESS: Delivery preference saved. Use this exact customer-facing confirmation: "Perfect, I've saved WhatsApp delivery to ${result.whatsappNumber}. We'll share your secure download link within 10 working days after the shoot."`;
                } else {
                  toolResponse = `SUCCESS: Delivery preference saved as ${result.method}. Use this exact customer-facing confirmation: "Perfect, I've saved your delivery preference. We'll share your secure download link within 10 working days after the shoot."`;
                }
              }
            }
            else if (functionName === 'add_session_note') {
              const noteResult = await this.executeAddNoteTool(customerId, args.bookingDate, args.note, args.type, args.category, args.priority, userMessage, platform,
                this.getSelectedAddons(userMessage, history).map((item) => item.sku));
              if (noteResult.created) {
                noteSavedThisTurn = true;
                toolResponse = `SUCCESS: Note added to session as ${noteResult.type}.`;
              } else {
                toolResponse = `INFO: Note not queued (${noteResult.reason || 'non-actionable'}).`;
              }
            }
            else if (['get_available_dates', 'get_available_slots'].includes(functionName) && !calendarRequested) {
              toolResponse = 'ERROR: The customer has not requested availability on this turn. Do not replay an older draft date as an answer to an unrelated question.';
            }
            else if (functionName === 'get_available_dates') {
              const range = nextWeekAvailability ? nextWeekRange() : args;
              // edition-guard-dates
const editionKey = (value: unknown) => String(value || '').toLowerCase().replace(/^the\s+/, '').replace(/\s+(?:edition|package)$/, '').trim();
              if (knownService && args.service && !statedSlots.service && editionKey(knownService) !== editionKey(args.service)) {
                toolResponse = 'ERROR: The stored package for this booking is ' + knownService + ', but you asked about ' + args.service + '. Do not check availability yet; ask her warmly which edition she would like, then continue.';
              } else {
                toolResponse = JSON.stringify(await checkDateRange(range.fromDate, range.toDate, knownService || args.service));
              }
            }
            else if (functionName === 'get_available_slots') {
              const requestedDate = this.getAuthoritativeRequestedDate(userMessage, args.date, extracted.date, history);
              // edition-guard-slots
const editionKey = (value: unknown) => String(value || '').toLowerCase().replace(/^the\s+/, '').replace(/\s+(?:edition|package)$/, '').trim();
              if (knownService && args.service && !statedSlots.service && editionKey(knownService) !== editionKey(args.service)) {
                toolResponse = 'ERROR: The stored package for this booking is ' + knownService + ', but you asked about ' + args.service + '. Do not check availability yet; ask her warmly which edition she would like, then continue.';
              } else {
                toolResponse = JSON.stringify(await checkCalendarSlots(requestedDate, knownService || args.service));
              }
            } else {
              toolResponse = `ERROR: Tool ${functionName} not found.`;
            }
          } catch (e: any) {
            console.error(`Tool execution error (${functionName}):`, e);
            if (functionName === 'propose_reschedule' || functionName === 'confirm_reschedule') {
              await this.notifyRescheduleAdmin({
                customerId,
                event: 'failed',
                newDate: args?.newDate,
                newTime: args?.newTime,
                reason: e?.message,
              });
            }
            if (functionName === 'cancel_booking') {
              await notifyAdmin(
                'booking',
                `Cancellation failed for ${customerId}`,
                `Cancellation tool failed: ${e?.message || 'Unknown error'}`,
                { customerId, event: 'cancel_failed', reason: e?.message }
              );
            }
            toolResponse = `ERROR: ${e.message}`;
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResponse
          });
          if (!/^(?:ERROR|INFO):/.test(toolResponse) && ['propose_booking', 'confirm_booking', 'propose_reschedule', 'confirm_reschedule', 'cancel_booking'].includes(functionName)) {
            for (const amount of currencyAmounts(toolResponse)) verifiedToolAmounts.add(amount);
          }
        }
      }

      // Do not re-expose the full tool list when this turn intentionally has
      // no tools. The tool-name guard must keep that boundary in force.

      completion = await this.createCompletionWithToolNameGuard({
        ...completionParams,
        messages,
      }, allowedToolNames, allTools, completion.provider);
      currentResponse = completion.response;
      addUsage(usage, usageFromCompletion(currentResponse, completion.completionCalls));
    }

    if (!proposedThisTurn && !confirmedActionThisTurn && !calendarReply) {
      if (nextWeekAvailability && knownService) {
        const range = nextWeekRange();
        await checkDateRange(range.fromDate, range.toDate, knownService);
      } else if (requestedCalendarDate && knownService
        && (platform === 'whatsapp' || platform === 'web')
        && !/\b(cancel|reschedule|move|postpone|note|bringing)\b/i.test(userMessage)
        && (/\b(available|availability|slots?|open|closed|weekday|schedule)\b/i.test(userMessage)
          || /^\s*(?:\d{1,2}(?:st|nd|rd|th)?\s+|\d{4}-\d{2}-\d{2})/.test(userMessage))) {
        await checkCalendarSlots(requestedCalendarDate, knownService);
      }
    }
    const modelContent = currentResponse.choices[0].message.content?.trim() || '';
    const emptyResponse = modelContent.length === 0 && !calendarReply && !exactProposalReply && !cancellationReply;

    // Guard against the LLM narrating a booking lock-in / confirmation prompt in plain text
    // without actually invoking propose_booking (which leaves BookingDraft stuck in collecting_slots).
    let narratedProposalGuardReply: string | null = null;
    const narratedProposalPrompt =
      !proposedThisTurn &&
      !confirmedActionThisTurn &&
      (platform === 'whatsapp' || platform === 'web') &&
      (/\b(?:shall i|should i|would you like me to|want me to)\s+(?:lock (?:that|it) in|book (?:that|it|this)|confirm (?:that|it|this)|propose)\b/i.test(modelContent) ||
        /\bjust to confirm:\s+you['’]?d like\b[\s\S]{0,160}\b(?:shall i|should i|ready to)\b/i.test(modelContent));

    if (narratedProposalPrompt) {
      const candidateName = currentSlots?.name || customer?.name || '';
      const hasAllSlots = Boolean(
        currentSlots?.service &&
        currentSlots?.date &&
        currentSlots?.time &&
        isUsableName(candidateName)
      );
      const addonsAlreadyDecided = currentSlots
        ? await bookingStateService
            .hasAddonsDecided(customerId, currentSlots, history, (m, h) => this.isDecliningOptionalAddons(m, h))
            .catch(() => false)
        : false;

      if (hasAllSlots && addonsAlreadyDecided) {
        try {
          const proposal = await this.executeProposeBookingTool(
            customerId,
            candidateName,
            currentSlots!.service!,
            `${currentSlots!.date}T${currentSlots!.time}`
          );
          if (Number.isInteger(proposal.depositAmount) && proposal.depositAmount > 0) {
            verifiedToolDeposits.add(proposal.depositAmount);
          }
          proposedThisTurn = true;
          exactProposalReply = buildBookingProposalConfirmation(
            currentSlots!.service!,
            currentSlots!.date!,
            currentSlots!.time!,
            proposal.depositAmount
          );
        } catch (err) {
          console.warn('[AGENT_FLOW] Auto-propose fallback failed:', err);
          narratedProposalGuardReply = await this.getBookingProgressReply(customerId, userMessage, history, false, true);
        }
      } else {
        narratedProposalGuardReply = await this.getBookingProgressReply(customerId, userMessage, history, false, true);
      }
    }

    const unverifiedActionReply = this.getUnverifiedActionReply(modelContent, {
      rescheduled: rescheduleAppliedThisTurn,
      cancelled: cancelledThisTurn,
      noteSaved: noteSavedThisTurn,
    });
    if (unverifiedActionReply) {
      console.warn('[AGENT_FLOW] Blocked unverified action claim:', JSON.stringify({ customerRef: this.customerReference(customerId), reply: modelContent.slice(0, 200) }));
    }

    const repeatedQuestionReply = !proposedThisTurn && !confirmedActionThisTurn
      ? repeatedCollectionQuestion(modelContent, currentSlots, customer?.name, userMessage, upcomingBooking) : null;
    const codeOwnedReply = cancellationReply || exactProposalReply || narratedProposalGuardReply || (!proposedThisTurn && !confirmedActionThisTurn ? calendarReply : null) || (unverifiedActionReply
      ? unverifiedActionReply
      : this.isUnverifiedBookingConfirmation(modelContent, userMessage, history, upcomingBooking)
      && !rescheduleAppliedThisTurn
      ? 'I canÃ¢â‚¬â„¢t confirm a new booking from that message alone. No new appointment has been confirmed or paid for. I can check whether the requested date and time are available.'
      : null) || repeatedQuestionReply;
    let safeModelContent = codeOwnedReply || this.formatCustomerReply(modelContent, userMessage, history);
    let verifierBlocked = false;
    let verifierRetries = 0;
    let correctionChars = 0;
    if (!codeOwnedReply && !emptyResponse) {
      const facts: VerifierFacts = {
        amounts: [...new Set([...ADDON_CATALOG.filter((addon) => addon.unitPrice > 0).map((addon) => addon.unitPrice), ...verifiedToolAmounts])],
        deposits: [...verifiedToolDeposits], editions: [], customerMessage: userMessage, packagePrices: [],
        emojiContext: { userMessage, replyType: emojiReplyType(safeModelContent), sentimentScore: scoreSentiment(userMessage).score },
        catalogListAllowed: explicitCatalogListRequest(userMessage)
          && (/\b(?:packages?|editions?|add-ons?|extras)\b/i.test(userMessage) || history.some(entry => entry.role === 'assistant' && entry.content.includes(OFFICIAL_WEBSITE_URLS.packages))),
      };
      if (currencyAmounts(safeModelContent).length
        || depositAmounts(safeModelContent).length
        || /\bdeposit\b/i.test(safeModelContent) && /%|\bpercent(?:age)?\b|\bper\s+cent\b/i.test(safeModelContent)
        || /\b(?:bloom|muse|icon|legend|queen|empress|goddess)\b/i.test(safeModelContent) && /\b(?:hours?|hrs?)\b/i.test(safeModelContent)) {
        try {
          const rows = await prisma.package.findMany({ select: { name: true, price: true, deposit: true, duration: true } });
          facts.editions = rows.filter((row) => !EDITIONS_PENDING_OWNER_CONFIRMATION.includes(row.name)
            && (!SEED_EDITION_INCLUSIONS[row.name] || SEED_EDITION_INCLUSIONS[row.name].duration === row.duration))
            .map((row) => ({ name: row.name, duration: row.duration }));
          const amounts = [...facts.amounts];
          facts.packagePrices = rows.filter((row) => Number.isInteger(row.price) && row.price > 0).map((row) => ({ name: row.name, price: row.price }));
          const deposits: number[] = [...verifiedToolDeposits];
          for (const row of rows) {
            if (Number.isInteger(row.price) && row.price > 0) amounts.push(row.price);
            // The stored deposit is the business fact even when a local override changes the charged amount.
            if (typeof row.deposit === 'number' && Number.isInteger(row.deposit) && row.deposit >= MINIMUM_BOOKING_DEPOSIT) { deposits.push(row.deposit); amounts.push(row.deposit); }
            try { const deposit = this.getDepositForPackage(row); deposits.push(deposit); amounts.push(deposit); } catch {}
          }
          facts.amounts = [...new Set(amounts)];
          facts.deposits = [...new Set(deposits)];
        } catch {
          console.warn('[AGENT_FLOW] Verifier catalog facts unavailable; unverified financial claims will be withheld.');
        }
      }
      const verified = await verifyWithOneRetry(safeModelContent, facts, async (reasons) => {
        verifierRetries++;
        const correctionText = verifierCorrectionMessage(reasons, facts, modelContent);
        correctionChars = correctionText.length;
        console.info(`[AGENT_FLOW] verifier=retry correction_chars=${correctionChars}`);
        const correction = await this.createCompletionWithToolNameGuard({
          model: CHAT_MODEL, temperature: 0.3, max_completion_tokens: MAX_AGENT_COMPLETION_TOKENS,
          groqReasoningEffort: 'low',
          messages: [...messages, { role: 'assistant', content: modelContent }, {
            role: 'system', content: correctionText,
          }],
        }, [], [], completion.provider);
        addUsage(usage, usageFromCompletion(correction.response, correction.completionCalls));
        const message = correction.response.choices[0].message;
        if (message.tool_calls?.length) throw new Error('Verifier correction must not call tools.');
        const reply = message.content?.trim() || '';
        if (!reply) {
          throw new Error('Verifier correction returned empty text.');
        }
        if (this.getUnverifiedActionReply(reply, { rescheduled: rescheduleAppliedThisTurn, cancelled: cancelledThisTurn, noteSaved: noteSavedThisTurn })
          || this.isUnverifiedBookingConfirmation(reply, userMessage, history, upcomingBooking) && !rescheduleAppliedThisTurn) {
          throw new Error('Verifier correction claimed an unverified action.');
        }
        return this.formatCustomerReply(reply, userMessage, history);
      }, async (text, reasons) => {
        if (!this.shouldEscalateVerifier(customerId, userMessage)) {
          console.info('[AGENT_FLOW] verifier=escalation_suppressed');
          return;
        }
        await this.escalate(customerId, 'booking', JSON.stringify({
          event: 'output_verifier_blocked', reasons, customerMessage: userMessage.slice(0, 2000), offendingText: JSON.parse(text),
        }));
      }, () => this.getVerifierTemplateReply(customerId, userMessage, history));
      safeModelContent = verified.reply;
      if (safeModelContent === EDITION_LINK_REPLY || safeModelContent === ADDON_LINK_REPLY) {
        await claimCatalogLink(customerId, platform, safeModelContent === ADDON_LINK_REPLY ? 'addons' : 'editions', history);
      }
      if (!verified.blocked && this.conversationFlows.isPackageAdviceRequest(userMessage)
        && !safeModelContent.includes(OFFICIAL_WEBSITE_URLS.packages)) {
        safeModelContent = `${safeModelContent}\n${OFFICIAL_WEBSITE_URLS.packages}`;
      }
      verifierBlocked = verified.blocked;
    }
    safeModelContent = await enforceSlogan(customerId, platform, safeModelContent, history);
    if (codeOwnedReply && calendarReply && !exactProposalReply && !cancellationReply) {
      safeModelContent = await this.decorateTemplateEmoji(customerId, platform, safeModelContent, 'slotAvailable', userMessage, history);
    }
    const lastAssistant = [...history].reverse().find(message => message.role === 'assistant');
    if (!codeOwnedReply) safeModelContent = await enforceEmojiPolicy(customerId, platform, safeModelContent, {
      userMessage, replyType: emojiReplyType(safeModelContent), sentimentScore: scoreSentiment(userMessage).score,
      forbidden: verifierBlocked,
      previousAssistant: lastAssistant?.content,
      previousAssistantCreatedAt: (lastAssistant as any)?.createdAt,
    });
    console.info('[AGENT_USAGE]', JSON.stringify({
      customerRef: this.customerReference(customerId), model: CHAT_MODEL,
      completionCalls: usage.completionCalls, toolCalls,
      verifierChecked: !codeOwnedReply && !emptyResponse,
      verifierBypassReason: !codeOwnedReply ? emptyResponse ? 'empty_model_reply' : null
        : cancellationReply ? 'exact_cancellation_reply'
        : exactProposalReply ? 'exact_tool_reply'
        : calendarReply && !proposedThisTurn && !confirmedActionThisTurn ? 'backend_calendar_reply'
        : codeOwnedReply === repeatedQuestionReply ? 'known_slot_question_guard'
        : unverifiedActionReply ? 'unverified_action_guard' : 'backend_action_guard',
      verifierRetries, correctionChars,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
      latencyMs: Date.now() - modelRunStartedAt, rateLimited: false,
      failureType: verifierBlocked ? 'output_verifier_failed' : emptyResponse ? 'empty_model_response' : null,
    }));

    return {
      content: emptyResponse
        ? 'Sorry, I lost the thread there. Could you tell me a little more about what you need?'
        : safeModelContent,
      tokensUsed: usage.totalTokens,
      ...(verifierBlocked ? { failureType: 'output_verifier_failed' } : emptyResponse ? { failureType: 'empty_model_response' } : {}),
    };
  }


