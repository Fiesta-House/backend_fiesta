import { runAgent as executeAgentRun } from './agent-runner';
import { handleMessageFlow, type ReplyContext, type ReplyOutcome } from './handle-message';
import {
  isUnverifiedBookingConfirmation as checkUnverifiedBookingConfirmation,
  shouldClarifyMixedIntent as checkMixedIntentClarification,
  shouldClarifyNewAddon as checkClarifyNewAddon,
  isDecliningOptionalAddons as checkDecliningOptionalAddons,
  shouldExposeTools as checkShouldExposeTools,
  shouldUsePreviousAddonReply as checkPreviousAddonReply,
  getPreviousAddonReply as buildPreviousAddonReply,
  getAddonSelectionReply as buildAddonSelectionReply,
  getStudioPolicyReply as resolveStudioPolicyReply,
  getOutOfScopeReply as resolveOutOfScopeReply,
  isClearlyUnrelatedRequest as checkClearlyUnrelatedRequest,
  getScopeBoundaryReply as resolveScopeBoundaryReply,
  shouldClarifyAmbiguousDeposit as checkClarifyAmbiguousDeposit,
  getAmbiguousDepositReply as buildAmbiguousDepositReply,
  getCatalogDisplayReply as buildCatalogDisplayReply,
  getCatalogBookingQuestion as buildCatalogBookingQuestion,
} from './helpers/scope-and-catalog';
import { getSystemPrompt, getPackagePricingLine, getAddonPricingLine, type SystemPromptOptions } from './prompt/system-prompt';
import {
  isAskingIfHuman,
  isTimeOfDayGreeting,
  isCasualGreeting,
  openingGreeting,
  getGreetingReply,
  getBusinessIntroductionReply,
  isDraftSlotPast,
} from './flows/greeting-flow';
import {
  isBookingIdentityCorrection,
  getRequestedBookingFromHistory,
  getBookingIdentityCorrectionReply,
  shouldClarifyBookingForSomeoneElse,
  extractStandaloneFullName,
  shouldCaptureRecipientName,
  captureRecipientName,
} from './flows/booking-identity-flow';
import {
  isCancellationConfirmation,
  isCancellationDecline,
  hasPendingCancellationProposal,
  isCancellationProposalExpired,
  clearStaleCancellationDraftBeforeRouting,
  hasPendingCancellationSelection,
  hasCancellationBookingSelector,
  shouldUseCancellationRequest,
  withdrawUnpaidBookingRequest,
  proposeCancellation,
} from './flows/cancellation-flow';
import {
  shouldUseRescheduleRequestReply,
  shouldUseRescheduleWithdrawalReply,
  withdrawPendingReschedule,
  isRescheduleWithin72Hours,
  getReschedulePolicyMessage,
  shouldConfirmRescheduleWithdrawal,
  rememberRescheduleContext,
  isActiveRescheduleDraft,
  getRescheduleTimeReply,
  getRescheduleSelectionReply,
  getInitialRescheduleReply,
} from './flows/reschedule-flow';
import {
  isExplicitConfirmation,
  previousMessageRequestsConfirmation,
  isPostActionAcknowledgement,
  isPaymentConfirmation,
  getDepositAmountFromProposalHistory,
  tryImmediateConfirmation,
} from './flows/confirmation-flow';
import {
  messageContainsExplicitDateTimeSignal,
  messageContainsExplicitDateSignal,
  messageContainsExplicitTimeSignal,
  hasRescheduleDateTimeSignal,
  getContextualBookingWeekdayDate,
  getAuthoritativeRequestedDate,
  getWeekdayReply,
  inferIntent,
  inferOutcome,
  getUnverifiedActionReply,
} from './helpers/intent-datetime';
import {
  handleSchemaMismatch,
  captureMpesaMessage,
  escalateQuotaHandoff,
  notifyRescheduleAdmin,
  isLapsedCarryOver,
  getCarryOverConfirmation,
  rememberBookingSlots,
} from './helpers/resilience-handlers';

import OpenAI from 'openai';
import { CHAT_MODEL, createChatCompletion, type ChatProvider } from './llm/provider';
export { createChatCompletion, getGroqCooldownUntil,getGroqRateLimitSnapshots } from './llm/provider';
import {
  createCompletionWithToolNameGuard as guardToolCompletion,
  isToolCallWithoutToolsError as isNoToolsCallError,
  isToolNameValidationError as isMalformedToolNameError,
  normalizeToolName as normalizeGuardedToolName,
} from './llm/tool-guard';
import { addUsage, BookingExtractor, findExplicitDate, findExplicitDayOfMonth, InvalidDateError, INVALID_DATE_REPLY, resolveCalendarDate, usageFromCompletion, type TokenUsage } from './extraction';
export { BookingExtractor } from './extraction';
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
} from './constants';
import { RESCHEDULE_KEYWORD_PATTERN, normalizeQuotes } from './regex';
import { rememberBookingSlots as storeEarlySlots, carriedOverStale, closedDateReply, earlySlotsExpired, extractStatedSlots, knownSlotsLine, lapsedCarryOver, paymentLapsed, sanitizeSlotValue, sameDayClosedReply, EARLY_SLOT_STEP } from './slot-memory';
import { addonDetail, addonQuantity, selectedAddons } from './addon-capture';
import { ADDON_NOTED_PREFIX, ADDON_UNCHANGED_REPLY, ADDON_QUOTED_PRICE_LABEL, ADDON_BALANCE_REPLY } from './constants';
import { BUDGET_HANDOFF_REPLY } from './constants';
import { BRAND_RULES, VOICE_RULES, UNKNOWN_ANSWER_REPLY } from './constants';
import { editionInText, isCustomerNameQuestion, repeatedCollectionQuestion, savedCustomerNameReply } from './reply-voice';
import { enforceSlogan } from './slogan-guard';
import { applyEmojiPolicy, emojiReplyType, emojisIn, enforceEmojiPolicy, isOnlyEmojis, stripAssistantEmojis, templateEmojiReply, EMOJI_PROMPT_RULE, type EmojiReplyType } from './emoji-policy';
import { claimCatalogLink, explicitCatalogListRequest, type CatalogKind } from './catalog-policy';
import { ADDON_LINK_REPLY, EDITION_LINK_REPLY } from './constants';
import { bookingProgressReply, addonPickQuestion, carryOverQuestion, nextStep, openTimesReply, sampleSlots, STEP_QUESTIONS, welcomePrefix } from './booking-progress';
import { createSchemaAlertLimiter, isMissingColumnError, safeSchemaDetails, SCHEMA_MAINTENANCE_REPLY } from '../../config/schema-readiness';
import { createVerifierEscalationLimiter, currencyAmounts, depositAmounts, verifierCorrectionMessage, verifyWithOneRetry, type VerifierFacts } from './output-verifier';
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
import { bookingDraftService } from '../booking/booking-draft.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION, MINIMUM_BOOKING_DEPOSIT, PACKAGE_NAME_PATTERN, PACKAGE_NAMES_FOR_EXTRACTION, ADDON_CATALOG, type AddonCatalogItem } from '../../config/constants';
import { mpesaService } from '../payment/mpesa.service';
import { circuitBreaker, scoreSentiment, DAILY_TOKEN_CAP, FALLBACK_MESSAGE, PROVIDER_OUTAGE_MESSAGE, shouldNotifyOutage, classifyProviderRateLimit, isProviderRateLimitError } from './resilience.service';
import { notifyAdmin } from '../notifications/notification.service';
import { TILL_NAME, TILL_NUMBER, PAYMENT_MESSAGE_ROUTES, parseMpesaMessage,isValidTillPayment } from './till-payment';
import { businessDay, bookingDateFacts, formatCustomerDate, nextWeekRange, inBusinessTimezone, nowInBusinessTimezone } from '../../utils/time';
import { getBookingPolicyWindow } from '../../utils/booking-policy';
import { ConversationFlowMatcher, isBusinessIdentityQuestion, isDeferral, isPlainGreeting, rescheduleTargetText } from './conversation-flow.matcher';
import { ConversationFlowHandler } from './conversation-flow.handler';
import { customerReplyTemplates, formatCustomerReply } from '../messaging/customer-reply.templates';
import { bookingAddonService } from '../booking/booking-addon.service';
import { invoiceService } from '../invoice/invoice.service';
import { whatsappService } from '../messaging/whatsapp.service';
import { createMessageRoutes as buildMessageRoutes, type MessageRoute } from './routes';
import { explicitlySelectedDeliveryMethod } from './photo-delivery-replies';
import {
  executeConfirmBookingTool as confirmBookingTool,
  executeConfirmCancellationTool as confirmCancellationTool,
  executeConfirmRescheduleTool as confirmRescheduleTool,
  executeCancelBookingTool as cancelBookingTool,
  executeProposeBookingTool as proposeBookingTool,
  executeProposeRescheduleTool as proposeRescheduleTool,
  getCancellationCompletionReply as formatCancellationCompletionReply,
  getDepositForPackage as validateDeposit,
  getPackageForDeposit as findPackageForDeposit,
} from './booking-tools';
import {
  executeAddNoteTool as saveSessionNote,
  extractSessionNoteMetadata as buildSessionNoteMetadata,
  executeSaveDeliveryPreferenceTool as saveDeliveryPreference,
} from './session-tools';
import {
  checkTokenBudget as getTokenBudgetStatus,
  escalate as createEscalation,
  logAiJobMetric as recordAiJobMetric,
  recordTokenUsage as saveTokenUsage,
  touchCustomerMemory as updateCustomerMemory,
} from './usage-and-memory';
import { buildBookingProcessReply } from './booking-process-reply';
import { handlePaymentRecovery, paymentAttemptsExhaustedReply, type PaymentMessageKind } from './payment-recovery';
import {
  extractInvoiceNumber as parseInvoiceNumber,
  extractInvoiceSessionDateRange as parseInvoiceSessionDateRange,
  getInvoiceSessionDateFromHistory as resolveInvoiceSessionDateFromHistory,
  sendStoredInvoiceToCustomer as deliverStoredInvoice,
  shouldDeclineConsolidatedInvoiceRequest as shouldDeclineCombinedInvoice,
  shouldUseInvoiceRequestReply as matchesInvoiceRequest,
} from './invoice-tools';
import {
  getPastAppointmentsListReply as buildPastAppointmentsListReply,
  shouldUsePastAppointmentsListReply as matchesPastAppointmentsListRequest,
} from './booking-history-replies';
import {
  getConfirmedSessionFollowUpReply as buildConfirmedSessionFollowUpReply,
  formatBookingDuration as formatAppointmentDuration,
  getBookingStatusReply as buildBookingStatusReply,
  getLastAppointmentDetailsReply as buildLastAppointmentDetailsReply,
  getPastAppointmentReply as buildPastAppointmentReply,
  getUpcomingAppointmentDetailsReply as buildUpcomingAppointmentDetailsReply,
  getUpcomingAppointmentTimeReply as buildUpcomingAppointmentTimeReply,
  isPastAppointmentFollowUp as matchesPastAppointmentFollowUp,
  shouldUseBookingStatusReply as matchesBookingStatusRequest,
  shouldUseLastAppointmentDetailsReply as matchesLastAppointmentDetailsRequest,
  shouldUsePastAppointmentReply as matchesPastAppointmentRequest,
  shouldUseUpcomingAppointmentDetailsReply as matchesUpcomingAppointmentDetailsRequest,
  shouldUseUpcomingAppointmentTimeReply as matchesUpcomingAppointmentTimeRequest,
  wasUpcomingAppointmentDetailsJustProvided as wasAppointmentDetailsJustProvided,
} from './appointment-replies';
import {
  buildPackageCard as formatPackageCard,
  getPackageAdviceReply as buildPackageAdviceReply,
  getPackageCatalogReply as buildPackageCatalogReply,
  getPackageSelectionReply as buildPackageSelectionReply,
  getSameBookingSlotReply as buildSameBookingSlotReply,
} from './package-replies';
import {
  getEarliestImageDeliveryReply as buildEarliestImageDeliveryReply,
  isEarliestImageDeliveryRequest as matchesEarliestImageDeliveryRequest,
} from './photo-delivery-replies';
import { completeTillBooking } from './till-booking-confirmation';

function isAvailableSlotList(result: string[] | { status: string; reason: string }): result is string[] {
  return Array.isArray(result);
}

export class AgentService {
  private readonly naturalAssistantMode = String(process.env.AI_ASSISTANT_NATURAL_MODE || 'true').toLowerCase() === 'true';
  public readonly conversationFlows = new ConversationFlowMatcher();
  private readonly conversationFlowHandler = new ConversationFlowHandler(this.conversationFlows);
  public readonly shouldEscalateVerifier = createVerifierEscalationLimiter();
  private readonly shouldEscalateHandoff = createVerifierEscalationLimiter();
  private readonly shouldAlertSchemaMismatch = createSchemaAlertLimiter();
  /** Rate-limits frustration escalations to at most one per 5 minutes, matching the outage-alert pattern. */
  private readonly shouldEscalateFrustration = createSchemaAlertLimiter(5 * 60_000);
  private activeTurnContext?: ReplyContext;

  private isNaturalAssistantModeEnabled(): boolean {
    return this.naturalAssistantMode;
  }

  private isTeamHandoffReply(reply: string): boolean {
    return /passed your question to the studio team|passed that on, and the studio team will reply|forward(?:ed|ing)? (?:your|this) (?:request|question) to the team|member of our team will (?:pick this up|be in touch)|team will confirm|studio team will confirm/i.test(reply);
  }

  private static readonly ASSISTANT_INTRO = "I'm the virtual assistant for Fiesta House Maternity.";

  public isAskingIfHuman(message: string): boolean {
    return isAskingIfHuman(message);
  }

  public isTimeOfDayGreeting(message: string): boolean {
    return isTimeOfDayGreeting(message);
  }

  public openingGreeting(message: string): string | null {
    return openingGreeting(message);
  }

  /** Records the turn's metric and learning rows in the background and returns the reply unchanged. */
  private respond(ctx: ReplyContext, reply: string, outcome: ReplyOutcome = {}): string {
    const { success = true, isFallback = false, ...failureDetails } = outcome;

    if (ctx.introduceAssistant && success && !isFallback && !/virtual assistant/i.test(reply)) {
      const greeting = this.openingGreeting(ctx.userMessage);
      const alreadyGreeted = /^\s*(?:hello|hi|hey|good\s)/i.test(reply);
      reply = `${greeting && !alreadyGreeted ? `${greeting}! ` : ''}${AgentService.ASSISTANT_INTRO} ${reply}`;
    }

    const latencyMs = Date.now() - ctx.startedAt;
    if (!ctx.escalatedThisTurn && this.isTeamHandoffReply(reply) && this.shouldEscalateHandoff(ctx.customerId, ctx.userMessage)) {
      ctx.escalatedThisTurn = true;
      this.logInBackground('team handoff escalation', () => this.escalate(
        ctx.customerId,
        'team_handoff',
        `Customer question handed off to team: "${ctx.userMessage.slice(0, 300)}" (Reply: "${reply.slice(0, 200)}")`
      ));
    }
    this.activeTurnContext = undefined;
    this.logInBackground('AI job metric', () => this.logAiJobMetric({
      customerId: ctx.customerId,
      platform: ctx.platform,
      success,
      latencyMs,
      ...(ctx.strategyUsed ? { strategyUsed: ctx.strategyUsed } : {}),
      ...(isFallback ? { isFallback } : {}),
      ...failureDetails,
    }));
    this.logInBackground('conversation learning', () => this.logConversationLearning({
      customerId: ctx.customerId,
      userMessage: ctx.userMessage,
      aiResponse: reply,
      platform: ctx.platform,
      latencyMs,
      wasSuccessful: success,
      isFallback,
    }));
    return reply;
  }

  /** Never lets a logging failure (sync throw or rejection) reach the caller or become an unhandled rejection. */
  private logInBackground(label: string, task: () => Promise<unknown>): void {
    Promise.resolve()
      .then(task)
      .catch((err) => console.error(`Failed to log ${label}:`, err));
  }

  public formatCustomerReply(
    reply: string,
    userMessage = '',
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): string {
    const formattedReply = formatCustomerReply(reply, {
      userMessage, replyType: emojiReplyType(reply), sentimentScore: scoreSentiment(userMessage).score,
      previousAssistant: [...history].reverse().find(message => message.role === 'assistant')?.content,
    });
    const aboutSuspendingConcept = /suspending\s+concept/i.test(userMessage)
      || history.slice(-6).some((message) => /suspending\s+concept/i.test(message.content));

    return formattedReply.replace(
      /https?:\/\/(?:www\.)?fiestahousematernity\.com(?:\/[^\s<>"'()[\]{}]*)?/gi,
      (matchedUrl) => {
        const trailingPunctuation = matchedUrl.match(/[.,!?;:]+$/)?.[0] || '';
        const urlWithoutPunctuation = trailingPunctuation
          ? matchedUrl.slice(0, -trailingPunctuation.length)
          : matchedUrl;
        const path = new URL(urlWithoutPunctuation).pathname.replace(/\/+$/, '') || '/';

        if (path === '/session-packages') return OFFICIAL_WEBSITE_URLS.packages + trailingPunctuation;
        if (path === '/reviews' || path === '/gallery/suspending-concept' || path === '/') {
          return path === '/reviews'
            ? OFFICIAL_WEBSITE_URLS.reviews + trailingPunctuation
            : path === '/gallery/suspending-concept'
              ? OFFICIAL_WEBSITE_URLS.suspendingConcept + trailingPunctuation
              : OFFICIAL_WEBSITE_URLS.home + trailingPunctuation;
        }
        if (path === '/testimonials') return OFFICIAL_WEBSITE_URLS.reviews + trailingPunctuation;
        if (path === '/gallery' && aboutSuspendingConcept) {
          return OFFICIAL_WEBSITE_URLS.suspendingConcept + trailingPunctuation;
        }
        return OFFICIAL_WEBSITE_URLS.home + trailingPunctuation;
      }
    );
  }

  private normalizeToolName(rawName: string): string {
    return normalizeGuardedToolName(rawName);
  }

  private isToolNameValidationError(error: any): boolean {
    return isMalformedToolNameError(error);
  }

  /** Provider rejects the turn when the model emits a tool call while no tools were exposed. */
  private isToolCallWithoutToolsError(error: any): boolean {
    return isNoToolsCallError(error);
  }

  public async createCompletionWithToolNameGuard(
    params: any,
    allowedToolNames: string[],
    fallbackTools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    preferredProvider?: ChatProvider
  ): Promise<{ response: any; completionCalls: number; provider: ChatProvider }> {
    return guardToolCompletion(params, allowedToolNames, fallbackTools, preferredProvider);
  }

  // Hard, non-LLM gate for propose_reschedule: the customer's OWN message text
  // must actually contain a date or time signal. Neither the tool-calling
  // model's own arguments nor the separate BookingExtractor's AI pass can be
  // trusted alone here - both can echo back or hallucinate a date (e.g. the
  // customer's existing upcoming-booking date from context) even when the
  // customer only asked an info question and stated no new date/time at all.
  public messageContainsExplicitDateTimeSignal(message: string): boolean {
    return messageContainsExplicitDateTimeSignal(message);
  }

  public hasRescheduleDateTimeSignal(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    return hasRescheduleDateTimeSignal(userMessage, history);
  }

  public getUnverifiedActionReply(
    modelReply: string,
    done: { rescheduled: boolean; cancelled: boolean; noteSaved: boolean }
  ): string | null {
    return getUnverifiedActionReply(modelReply, done);
  }

  public messageContainsExplicitDateSignal(message: string): boolean {
    return messageContainsExplicitDateSignal(message);
  }

  public messageContainsExplicitTimeSignal(message: string): boolean {
    return messageContainsExplicitTimeSignal(message);
  }

  private shouldResolvePackageSelectionImmediately(userMessage: string): boolean {
    return this.conversationFlows.isPackageSelection(userMessage)
      && !this.messageContainsExplicitDateSignal(userMessage);
  }

  public getAuthoritativeRequestedDate(
    userMessage: string,
    proposedDate: string,
    extractedDate?: string | null,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): string {
    return getAuthoritativeRequestedDate(userMessage, proposedDate, extractedDate, history);
  }

  public getContextualBookingWeekdayDate(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): string | null {
    return getContextualBookingWeekdayDate(userMessage, history);
  }

  private shouldUseRescheduleRequestReply(userMessage: string): boolean {
    const text = userMessage.toLowerCase();
    return RESCHEDULE_KEYWORD_PATTERN.test(text)
      && !this.messageContainsExplicitDateTimeSignal(userMessage)
      && !this.conversationFlows.isTimeOnlyRescheduleRequest(userMessage);
  }

  private shouldUseRescheduleWithdrawalReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const text = userMessage.toLowerCase().trim();
    const withdrawal = /\b(let'?s|we should)\s+(not|don't|do not)\s+(reschedule|change|move|postpone)\b|\b(no|never mind|nevermind|forget it)\b.*\b(reschedule|change|move|postpone)\b|\bkeep\s+(the|my|this)\s+(original|current)\s+(date|time|booking|session)\b/.test(text);
    if (!withdrawal) return false;

    return history.slice(-6).some((message) =>
      message.role === 'assistant' && /reschedul|move|forfeit.*deposit|within 72 hours/i.test(message.content)
    );
  }

  private async withdrawPendingReschedule(customerId: string): Promise<void> {
    await prisma.bookingDraft.deleteMany({
      where: { customerId, step: { in: ['reschedule_confirm', RESCHEDULE_COLLECTING_STEP] } },
    });
  }

  public inferIntent(userMessage: string): { intent: string; confidence: number; rule: string } {
    return inferIntent(userMessage);
  }

  public inferOutcome(aiResponse: string, isFallback: boolean): string {
    return inferOutcome(aiResponse, isFallback);
  }

  public getWeekdayReply(
    userMessage: string,
    history: { role: 'user' | 'assistant', content: string }[] = []
  ): string | null {
    return getWeekdayReply(userMessage, history);
  }

  private getBusinessIntroductionReply(userMessage = ''): string {
    return isBusinessIdentityQuestion(userMessage) ? buildBusinessIntroductionReply() : buildAboutBusinessReply();
  }


  /**
   * True when the drafted slot has already started.
   * Date-only drafts are treated as past only on earlier days.
   */
  public isDraftSlotPast(draft: { date?: string | null; time?: string | null }): boolean {
    return isDraftSlotPast(draft);
  }

  public async getGreetingReply(customerId: string, history: Array<{ role: string; content: string }> = []): Promise<string | null> {
    return getGreetingReply(customerId, history, this.isNaturalAssistantModeEnabled());
  }

  /** Deterministic reply for the detected intent when the verifier cannot use the model's reply. */

/** Deterministic reply for the detected intent when the verifier cannot use the model's reply. */
public async getVerifierTemplateReply(
  customerId: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string | null> {
  if (this.shouldResolvePackageSelectionImmediately(userMessage)) {
    return this.getPackageSelectionReply(customerId, userMessage);
  }

  if (this.isAddonAdviceRequest(userMessage, history)) {

    return null;

  }

  if (this.conversationFlows.isPackageCatalogRequest(userMessage, history)) {
    return EDITION_LINK_REPLY;
  }

  if (isPlainGreeting(userMessage)) {
    if (history.length > 0) {
      if (this.isNaturalAssistantModeEnabled()) {
        return null;
      }
      return 'Welcome back! How can I help you today?';
    }

    return buildBusinessIntroductionReply();
  }

  return null;
}



private isAddonAdviceRequest(
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): boolean {
  const asksForAdvice =
    /\b(recommend|recommendation|suggest|suggestion|which would you|which one|what would you|most clients like|popular|best option|specific ones?|any specific|what do you recommend)\b/i
      .test(userMessage);

  if (!asksForAdvice) return false;

  const recentContext = [
    ...history.slice(-8).map((message) => message.content),
    userMessage,
  ].join('\n');

  return /\b(add-?ons?|optional extras?|extras?|power suit|extra outfit|extra edited photos?|digital art edits?|styled wig|wig hire|wig styling|sculpture set|suspending concept)\b/i
    .test(recentContext);
}

private getAddonAdviceReply(): string {
  return [
    'A few lovely options to consider are:',
    'Ã¢â‚¬Â¢ Extra outfit - KSh 4,000 if youÃ¢â‚¬â„¢d like another look.',
    'Ã¢â‚¬Â¢ Extra edited photos - KSh 1,000 each for more finished images.',
    'Ã¢â‚¬Â¢ Power Suit - KSh 10,000 if it isnÃ¢â‚¬â„¢t already included in your edition, for a bold, structured look.',
    'Ã¢â‚¬Â¢ Styled wig hire - KSh 4,000; this needs to be booked in advance.',
    `You can see the full list here: ${OFFICIAL_WEBSITE_URLS.packages}`,
  ].join('\n');
}

  private shouldUseBookingProcessReply(userMessage: string): boolean {
    return isBookingProcessRequest(userMessage);
  }

  private shouldUsePostShootProcessReply(userMessage: string): boolean {
    return isPostShootProcessRequest(userMessage);
  }

  private shouldUseEarliestImageDeliveryReply(userMessage: string): boolean {
    return matchesEarliestImageDeliveryRequest(userMessage);
  }

  private shouldUseRawFilesReply(userMessage: string): boolean {
    return isRawFilesRequest(userMessage);
  }

  private extractInvoiceNumber(userMessage: string): string | null {
    return parseInvoiceNumber(userMessage);
  }

  private extractInvoiceSessionDateRange(userMessage: string): { start: Date; end: Date } | null {
    return parseInvoiceSessionDateRange(userMessage);
  }

  private shouldUseInvoiceRequestReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): boolean {
    return matchesInvoiceRequest(userMessage, history);
  }

  private getInvoiceSessionDateFromHistory(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): { start: Date; end: Date } | null {
    return resolveInvoiceSessionDateFromHistory(history);
  }

  private shouldDeclineConsolidatedInvoiceRequest(userMessage: string): boolean {
    return shouldDeclineCombinedInvoice(userMessage);
  }

  private shouldUsePastAppointmentsListReply(userMessage: string): boolean {
    return matchesPastAppointmentsListRequest(userMessage);
  }

  public isUnverifiedBookingConfirmation(
    modelReply: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    existingBooking?: { dateTime: Date; status: string }
  ): boolean {
    return checkUnverifiedBookingConfirmation(modelReply, userMessage, history, existingBooking);
  }

  public isBookingIdentityCorrection(userMessage: string): boolean {
    return isBookingIdentityCorrection(userMessage);
  }

  public getRequestedBookingFromHistory(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): { recipient: string | null; service: string | null; date: string; time: string } | null {
    return getRequestedBookingFromHistory(history);
  }

  public async getBookingIdentityCorrectionReply(
    customerId: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<string> {
    return getBookingIdentityCorrectionReply(customerId, history);
  }

  private async getPastAppointmentsListReply(customerId: string): Promise<string> {
    return buildPastAppointmentsListReply(customerId);
  }

  private async sendStoredInvoiceToCustomer(
    customerId: string,
    requestedInvoiceNumber?: string,
    history: { role: 'user' | 'assistant'; content: string }[] = [],
    userMessage = ''
  ): Promise<string> {
    return deliverStoredInvoice.call(this, customerId, requestedInvoiceNumber, history, userMessage);
  }

  private shouldUsePackageBudgetReply(userMessage: string): boolean {
    return isPackageBudgetRequest(userMessage);
  }

  private getPackageBudgetReply(): string {
    return buildPackageBudgetReply();
  }

  private getLegacyPackageReply(userMessage: string): string | null {
    return legacyPackageReply(userMessage);
  }

  private getLashesReply(): string {
    return LASHES_FAQ_REPLY;
  }

  private shouldClarifyMixedIntent(userMessage: string): boolean {
    return checkMixedIntentClarification.call(this, userMessage);
  }

  private getMixedIntentClarificationReply(): string {
    return buildMixedIntentClarificationReply();
  }

  private shouldUseAdditionsReply(userMessage: string): boolean {
    return isAdditionsRequest(userMessage);
  }

  private shouldClarifyNewAddon(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    return checkClarifyNewAddon(userMessage, history);
  }

  /** "Show me" / "yes" right after we offered or listed the extras. */
  private isAddonListFollowUp(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    return matchesAddonListFollowUp(userMessage, history);
  }

  /** Collapse unicode dashes so regexes written with "-" still match model output. */
  private normalizeHyphens(value: string): string {
    return value.replace(/[\u2010-\u2015\u2212]/g, '-');
  }

  private isDecliningOptionalAddons(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    return checkDecliningOptionalAddons(userMessage, history);
  }

  public shouldExposeTools(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    platform: string
  ): boolean {
    return checkShouldExposeTools.call(this, userMessage, history, platform);
  }

  public customerReference(customerId: string): string {
    const digits = customerId.replace(/\D/g, '');
    return digits ? `***${digits.slice(-4)}` : 'unknown';
  }

  /** Exact add-on pricing injected into the system prompt so the model cannot invent it. */
  private getAddonPricingLine(conversation = ''): string {
    const priced = ADDON_CATALOG.filter((item) => item.unitPrice > 0)
      .map((item) => `${item.name}: Ksh ${item.unitPrice.toLocaleString()}${item.quantityFromNote ? ' each' : ''}`)
      .join('; ');
    const quoted = ADDON_CATALOG.filter((item) => item.unitPrice === 0)
      .map((item) => item.name)
      .join(', ');
    // Descriptions only for add-ons named in the conversation; the free Groq tier caps a request at 8,000 tokens.
    const details = ADDON_CATALOG.filter((item) => item.match.test(conversation))
      .map((item) => `${item.name}: ${addonDetail(item)}`).join(' | ');
    return `${priced}. Quoted by package tier (no fixed price): ${quoted}.${details ? ` ADD-ON DETAILS: ${details}` : ''} ADD-ON RULES: never charge an add-on the customer's edition already includes; never invent prices for quoted items, availability or production details; answer one add-on only about that add-on; list add-ons briefly grouped as Image & delivery, Styling & wardrobe, Creative production.`;
  }

  private shouldUsePreviousAddonReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): boolean {
    return checkPreviousAddonReply(userMessage, history);
  }

  private async getPreviousAddonReply(customerId: string): Promise<string | null> {
    return buildPreviousAddonReply(customerId);
  }

  private getSelectedAddon(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): AddonCatalogItem | null {
    return selectedAddons(userMessage, history)[0] || null;
  }

  public getSelectedAddons(userMessage: string, history: { role: 'user' | 'assistant'; content: string }[] = []): AddonCatalogItem[] {
    return selectedAddons(userMessage, history);
  }

  private getRequestedAddonQuantity(userMessage: string, addon: AddonCatalogItem): number {
    return addonQuantity(userMessage, addon);
  }

  private getAddonSelectionReply(addon: AddonCatalogItem, quantity = 1, unchangedRequested = false): string {
    return buildAddonSelectionReply(addon, quantity, unchangedRequested);
  }

  private shouldUseBespokeReply(userMessage: string): boolean {
    return isBespokeRequest(userMessage);
  }

  private shouldUseTravellingMothersReply(userMessage: string): boolean {
    return isTravellingMothersRequest(userMessage);
  }

  private shouldUseSocialMediaReply(userMessage: string): boolean {
    return isSocialMediaRequest(userMessage);
  }

private getStudioPolicyReply(userMessage: string): string | null {
    return resolveStudioPolicyReply(userMessage);
  }

  private getOutOfScopeReply(userMessage: string): string | null {
    return resolveOutOfScopeReply(userMessage);
  }

  private isClearlyUnrelatedRequest(userMessage: string): boolean {
    return checkClearlyUnrelatedRequest(userMessage);
  }

  private getScopeBoundaryReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): string | null {
    return resolveScopeBoundaryReply(userMessage, history);
  }

  public shouldClarifyBookingForSomeoneElse(userMessage: string): boolean {
    return shouldClarifyBookingForSomeoneElse(userMessage);
  }

  public extractStandaloneFullName(userMessage: string): string | null {
    return extractStandaloneFullName(userMessage);
  }

  public shouldCaptureRecipientName(
    userMessage: string,
    history: { role: 'user' | 'assistant', content: string }[]
  ): boolean {
    return shouldCaptureRecipientName(userMessage, history);
  }

  public shouldClarifyAmbiguousDeposit(userMessage: string): boolean {
    return checkClarifyAmbiguousDeposit(userMessage);
  }

  public async getAmbiguousDepositReply(): Promise<string> {
    return buildAmbiguousDepositReply.call(this);
  }

  public async captureRecipientName(customerId: string, userMessage: string): Promise<string | null> {
    return captureRecipientName(customerId, userMessage);
  }

  private shouldUseBookingStatusReply(userMessage: string): boolean {
    return matchesBookingStatusRequest(userMessage);
  }

  private shouldUseUpcomingAppointmentTimeReply(userMessage: string): boolean {
    return matchesUpcomingAppointmentTimeRequest(userMessage);
  }

  private shouldUseUpcomingAppointmentDetailsReply(userMessage: string): boolean {
    return matchesUpcomingAppointmentDetailsRequest(userMessage);
  }

  private shouldUseLastAppointmentDetailsReply(userMessage: string): boolean {
    return matchesLastAppointmentDetailsRequest(userMessage);
  }

  private formatBookingDuration(durationMinutes?: number | null): string {
    return formatAppointmentDuration(durationMinutes);
  }

  private wasUpcomingAppointmentDetailsJustProvided(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    return wasAppointmentDetailsJustProvided(history);
  }

  private async getUpcomingAppointmentDetailsReply(
    customerId: string,
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): Promise<string | null> {
    return buildUpcomingAppointmentDetailsReply(customerId, history);
  }

  private async getLastAppointmentDetailsReply(customerId: string): Promise<string> {
    return buildLastAppointmentDetailsReply(customerId);
  }

  private async getUpcomingAppointmentTimeReply(customerId: string): Promise<string | null> {
    return buildUpcomingAppointmentTimeReply(customerId);
  }

    private shouldUsePastAppointmentReply(userMessage: string): boolean {
      return matchesPastAppointmentRequest(userMessage);
    }

      private isPastAppointmentFollowUp(
        userMessage: string,
        history: { role: 'user' | 'assistant', content: string }[]
      ): boolean {
        return matchesPastAppointmentFollowUp(userMessage, history);
      }

  private buildPackageCard(pkg: {
    name: string;
    price: number;
    duration: string;
    images: number;
    makeup: boolean;
    outfits: number;
    photobook: boolean;
    photobookSize: string | null;
    mount: boolean;
    balloonBackdrop: boolean;
    wig: boolean;
    notes: string | null;
  }): string {
    return formatPackageCard(pkg);
  }

  private async getPackageCatalogReply(showInclusions = false, userMessage = ''): Promise<string | null> {
    return buildPackageCatalogReply(showInclusions, userMessage);
  }

  private async getCatalogDisplayReply(customerId: string, platform: string, kind: CatalogKind, userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]): Promise<string> {
    return buildCatalogDisplayReply.call(this, customerId, platform, kind, userMessage, history);
  }

  private async getCatalogBookingQuestion(customerId: string, kind: CatalogKind = 'editions'): Promise<string | null> {
    return buildCatalogBookingQuestion(customerId, kind);
  }

  private async getPackageAdviceReply(userMessage: string): Promise<string | null> {
    const reply = await buildPackageAdviceReply(userMessage);
    return reply ? `${reply}\n${OFFICIAL_WEBSITE_URLS.packages}` : null;
  }

  private async getPackageSelectionReply(customerId: string, userMessage: string): Promise<string | null> {
    return buildPackageSelectionReply(customerId, userMessage);
  }

  private async getSameBookingSlotReply(
    customerId: string,
    history: { role: 'user' | 'assistant', content: string }[]
  ): Promise<string | null> {
    return buildSameBookingSlotReply(customerId, history);
  }

  public async getInitialRescheduleReply(customerId: string, message: string,
    history: { role: 'user' | 'assistant'; content: string }[]): Promise<string> {
    return getInitialRescheduleReply(customerId, message, history, (params) => this.notifyRescheduleAdmin(params));
  }

  public async getRescheduleTimeReply(customerId: string): Promise<string | null> {
    return getRescheduleTimeReply(customerId);
  }

  public async rememberRescheduleContext(customerId: string, booking: { id: string; service: string }): Promise<void> {
    return rememberRescheduleContext(customerId, booking);
  }

  public isActiveRescheduleDraft(draft: { step: string; updatedAt?: Date | null } | null): boolean {
    return isActiveRescheduleDraft(draft);
  }

  public async getRescheduleSelectionReply(customerId: string, userMessage: string, history: { role: 'user' | 'assistant'; content: string }[] = []): Promise<string | null> {
    return getRescheduleSelectionReply(customerId, userMessage, history, (params) => this.notifyRescheduleAdmin(params));
  }

  public isRescheduleWithin72Hours(bookingDateTime: Date, now = new Date()): boolean {
    return isRescheduleWithin72Hours(bookingDateTime, now);
  }

  public getReschedulePolicyMessage(): string {
    return getReschedulePolicyMessage();
  }

  private async getBookingProcessReply(customerId?: string, platform = 'whatsapp', history: { role: 'user' | 'assistant'; content: string }[] = []): Promise<string> {
    if (customerId) await Promise.all(['editions', 'addons'].map(kind => claimCatalogLink(customerId, platform, kind as CatalogKind, history)));
    return buildBookingProcessReply.call(this);
  }

  private getPostShootProcessReply(): string {
    return buildPostShootProcessReply();
  }

  private async getEarliestImageDeliveryReply(customerId: string): Promise<string> {
    return buildEarliestImageDeliveryReply(customerId);
  }

  private getRawFilesReply(): string {
    return buildRawFilesReply();
  }

  private async getAdditionsReply(customerId?: string): Promise<string> {
    let deposit: number | null = null;
    try {
      const draft = customerId ? await prisma.bookingDraft.findUnique({ where: { customerId }, select: { service: true } }) : null;
      deposit = this.getDepositForPackage(await this.getPackageForDeposit(draft?.service || undefined));
    } catch {
      console.warn('Unable to resolve starting deposit for add-ons reply.');
    }
    return buildAdditionsReply(deposit);
  }

  private getBespokeReply(): string {
    return buildBespokeReply();
  }

  private getTravellingMothersReply(): string {
    return buildTravellingMothersReply();
  }

  private getSocialMediaReply(): string {
    return buildSocialMediaReply();
  }

  private getPortfolioReply(): string {
    return buildPortfolioReply();
  }

  private getSuspendingConceptGalleryReply(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): string | null {
    return buildSuspendingConceptGalleryReply(userMessage, history);
  }

  private getReviewPageReply(userMessage: string): string | null {
    return buildReviewPageReply(userMessage);
  }

  private getWebsiteReply(): string {
    return buildWebsiteReply();
  }

  private getContactDetailsReply(): string {
    return buildContactDetailsReply();
  }

private getBookingForSomeoneElseReply(userMessage = ''): string {
    const lower = userMessage.toLowerCase();
    const relation =
      lower.includes('wife') ? 'your wife' :
      lower.includes('sister') ? 'your sister' :
      lower.includes('husband') ? 'your husband' :
      lower.includes('brother') ? 'your brother' :
      lower.includes('friend') ? 'your friend' :
      lower.includes('partner') ? 'your partner' :
      lower.includes('daughter') ? 'your daughter' :
      lower.includes('mother') ? 'your mother' :
      'her';
    return buildBookingForSomeoneElseReply(relation);
  }

  private async getBookingStatusReply(customerId: string): Promise<string | null> {
    return buildBookingStatusReply.call(this, customerId);
  }

  private async getCustomerNameReply(customerId: string): Promise<string> {
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
    return savedCustomerNameReply(customer?.name);
  }

  private async getConfirmedSessionFollowUpReply(customerId: string): Promise<string | null> {
    return buildConfirmedSessionFollowUpReply(customerId);
  }

  private async getPastAppointmentReply(customerId: string): Promise<string | null> {
    return buildPastAppointmentReply(customerId);
  }

  private async logConversationLearning(params: {
    customerId: string;
    userMessage: string;
    aiResponse: string;
    platform: string;
    latencyMs: number;
    wasSuccessful: boolean;
    isFallback: boolean;
  }): Promise<void> {
    try {
      const { score, sentiment, confidence: toneConfidence } = scoreSentiment(params.userMessage);
      const inferred = this.inferIntent(params.userMessage);
      const conversationLength = Math.max(1, params.userMessage.split('\n').filter(Boolean).length);

      await prisma.conversationLearning.create({
        data: {
          customerId: params.customerId,
          userMessage: params.userMessage,
          aiResponse: params.aiResponse,
          extractedIntent: inferred.intent,
          detectedEmotionalTone: sentiment,
          wasSuccessful: params.wasSuccessful,
          conversationOutcome: this.inferOutcome(params.aiResponse, params.isFallback),
          conversationLength,
          timeToResolution: Math.max(1, Math.round(params.latencyMs / 1000)),
          metadata: {
            platform: params.platform,
            isFallback: params.isFallback,
            sentimentScore: score,
            toneConfidence,
            intentConfidence: inferred.confidence,
            intentRule: inferred.rule,
            classifierVersion: 'v2',
          },
        },
      });
    } catch (err) {
      console.error('Failed to log conversation learning:', err);
    }
  }

  async getInstructionGuide(): Promise<string> {
    const packagePricing = await this.getPackagePricingLine();
    return this.getSystemPrompt('', 'whatsapp', true, true, packagePricing);
  }

  public async getPackagePricingLine(): Promise<string> {
    return getPackagePricingLine();
  }

  public getSystemPrompt(
    businessContext: string,
    platform: string,
    includePackagePricing = true,
    includeAddonPricing = true,
    packagePricingLine = PACKAGE_PRICING_FALLBACK,
    conversation = '',
    options: SystemPromptOptions = {}
  ): string {
    return getSystemPrompt(businessContext, platform, includePackagePricing, includeAddonPricing, packagePricingLine, conversation, options);
  }

  private async runAgent(customerId: string, userMessage: string, history: { role: 'user'|'assistant', content: string }[] = [], platform: string = 'whatsapp'): Promise<{ content: string; tokensUsed: number; failureType?: string }> {
    return executeAgentRun.call(this, customerId, userMessage, history, platform);
  }

  private createMessageRoutes(
    customerId: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    platform: string,
    startedAt: number
  ): MessageRoute[] {
    return buildMessageRoutes.call(this, customerId, userMessage, history, platform, startedAt);
  }

  async handleMessage(customerId: string, rawMessage: string, rawHistory: { role: 'user'|'assistant', content: string }[] = [], platform: string = 'whatsapp'): Promise<string> {
    return handleMessageFlow.call(this, customerId, rawMessage, rawHistory, platform);
  }

  private isCasualGreeting(message: string): boolean {
  const lines = message
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return false;

  return lines.every(line =>
    /^(?:hi+|hello+|hey+|hallo)(?:\s+(?:there|you|team|fiesta(?:\s+house)?|everyone|all))?[\s!.,?]*$/i.test(line)
  );
}
  public async decorateTemplateEmoji(customerId: string, platform: string, reply: string, replyType: EmojiReplyType,
    userMessage: string, history: { role: 'user' | 'assistant'; content: string; createdAt?: Date | string }[]): Promise<string> {
    const lastAssistant = [...history].reverse().find(message => message.role === 'assistant');
    const context = {
      userMessage,
      replyType,
      sentimentScore: scoreSentiment(userMessage).score,
      previousAssistant: lastAssistant?.content,
      previousAssistantCreatedAt: lastAssistant?.createdAt,
    };
    const decorated = templateEmojiReply(reply, replyType, context);
    if (decorated === reply) return reply;
    const result = await enforceEmojiPolicy(customerId, platform, decorated, context);
    return emojisIn(result).length ? result : reply;
  }

  public async handleSchemaMismatch(customerId: string, userMessage: string, platform: string, error: unknown) {
    return handleSchemaMismatch(customerId, userMessage, platform, error, this.shouldAlertSchemaMismatch);
  }

  public async captureMpesaMessage(
    customerId: string,
    userMessage: string,
    platform: string
  ): Promise<'not_waiting' | 'waiting' | 'received'> {
    return captureMpesaMessage(customerId, userMessage, platform);
  }

  public async escalateQuotaHandoff(customerId: string, userMessage: string, platform: string): Promise<void> {
    return escalateQuotaHandoff(customerId, userMessage, platform);
  }

  public async getBookingProgressReply(customerId: string, message: string, history: { role: 'user' | 'assistant'; content: string }[], decisionJustSaved = false, force = false): Promise<string | null> {
    return bookingProgressReply.call(this, customerId, message, history, decisionJustSaved, force);
  }

  public async rememberBookingSlots(
    customerId: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<string | null> {
    return rememberBookingSlots(customerId, userMessage, history);
  }

  public isLapsedCarryOver(draft: { date?: string | null; time?: string | null }): boolean {
    return isLapsedCarryOver(draft);
  }

  public async getCarryOverConfirmation(customerId: string, userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]): Promise<string | null> {
    return getCarryOverConfirmation(customerId, userMessage, history);
  }

  private isExplicitConfirmation(userMessage: string): boolean {
    return isExplicitConfirmation(userMessage);
  }

  private isPostActionAcknowledgement(userMessage: string, history: { role: 'user' | 'assistant'; content: string }[]): boolean {
    return isPostActionAcknowledgement(userMessage, history);
  }

  public isPaymentConfirmation(userMessage: string): boolean {
    return isPaymentConfirmation(userMessage);
  }

  public isCancellationConfirmation(userMessage: string): boolean {
    return isCancellationConfirmation(userMessage);
  }

  public isCancellationDecline(userMessage: string): boolean {
    return isCancellationDecline(userMessage);
  }

  public hasPendingCancellationProposal(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    return hasPendingCancellationProposal(history);
  }

  public isCancellationProposalExpired(draft: { cancelProposedAt?: Date | string | null }, now = Date.now()): boolean {
    return isCancellationProposalExpired(draft, now);
  }

  public async clearStaleCancellationDraftBeforeRouting(
    customerId: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<string | null> {
    return clearStaleCancellationDraftBeforeRouting(customerId, userMessage, history);
  }

  public hasPendingCancellationSelection(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    return hasPendingCancellationSelection(history);
  }

  public hasCancellationBookingSelector(userMessage: string): boolean {
    return hasCancellationBookingSelector(userMessage);
  }

  public shouldUseCancellationRequest(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    return shouldUseCancellationRequest(userMessage, history);
  }

  public async withdrawUnpaidBookingRequest(customerId: string, draft: any, userMessage: string): Promise<string | null> {
    return withdrawUnpaidBookingRequest(customerId, draft, userMessage);
  }

  public async proposeCancellation(
    customerId: string,
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<{ reply: string; proposed: boolean }> {
    return proposeCancellation(customerId, userMessage, history);
  }

  private shouldConfirmRescheduleWithdrawal(
    userMessage: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): boolean {
    const normalized = userMessage.trim().toLowerCase().replace(/[!?.,]/g, '').replace(/\s+/g, ' ');
    if (!/^(sure|yes|yeah|yep|okay|ok)$/.test(normalized)) return false;
    const lastAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
    return /^(?:understood[.!]?\s*)?we(?:'ll| will) keep your original session date and time\b|^yes\.\s*your original session date and time are still booked\b/i.test(lastAssistantMessage.trim());
  }

  public previousMessageRequestsConfirmation(history: { role: 'user' | 'assistant', content: string }[]): boolean {
    return matchesConfirmationRequest(history);
  }

  public getDepositAmountFromProposalHistory(
    history: { role: 'user' | 'assistant'; content: string }[]
  ): number | null {
    return getDepositAmountFromProposalHistory(history);
  }

 
   public async tryImmediateConfirmation(
    customerId: string,
    userMessage = '',
    history: { role: 'user' | 'assistant'; content: string }[] = []
  ): Promise<string | null> {
    return tryImmediateConfirmation.call(this, customerId, userMessage, history);
  }

  private async getPaymentRecoveryReply(customerId: string, userMessage: string, forcedKind?: PaymentMessageKind): Promise<string | null> {
    return handlePaymentRecovery.call(this, customerId, userMessage, forcedKind);
  }

  /**
   * Keyword-based frustration check, run on every inbound message. Cheap
   * enough to never skip - no LLM call involved. Best-effort: failures here
   * must never break the actual reply.
   *
   * The DB sentimentScore row is always written so analytics stay complete.
   * The escalation is rate-limited to one per 5 minutes so an angry burst
   * during an outage (when many messages arrive before the circuit breaker
   * trips) doesn't flood the dashboard with duplicate escalations.
   */
  private async trackSentiment(customerId: string, userMessage: string): Promise<void> {
    const { score, sentiment, confidence } = scoreSentiment(userMessage);

    await prisma.sentimentScore.create({
      data: { customerId, score, sentiment, confidence, triggeredAlert: score <= -0.6 }
    });

    if (score <= -0.6 && this.shouldEscalateFrustration()) {
      await this.escalate(customerId, 'frustration', `Customer message scored ${score.toFixed(2)} (${sentiment}) on the frustration heuristic.`, score);
    }
  }

  /**
   * Keeps CustomerMemory current with cheap, directly-derivable facts (no
   * extra LLM call - deeper summarization is a separate feature to build
   * later if wanted). Best-effort: failures here must never break the reply.
   */
  private async touchCustomerMemory(customerId: string, userMessage: string, platform: string): Promise<void> {
    return updateCustomerMemory(customerId, userMessage, platform);
  }

  /**
   * Creates an escalation row so a human knows to follow up. Best-effort -
   * a failure here must never break the actual customer-facing reply.
   */
  public async escalate(customerId: string, escalationType: string, description: string, sentimentScore?: number): Promise<boolean> {
    const recorded = await createEscalation(customerId, escalationType, description, sentimentScore);

    if (recorded && this.activeTurnContext && this.activeTurnContext.customerId === customerId) {
      this.activeTurnContext.escalatedThisTurn = true;
    }

    return recorded;
  }

  /**
   * Emits operational notifications for reschedule milestones/failures
   * without automatically creating escalations.
   */
  public async notifyRescheduleAdmin(params: {
    customerId: string;
    event: 'proposed' | 'confirmed' | 'failed';
    service?: string;
    oldDateTime?: Date;
    newDate?: string;
    newTime?: string;
    newDateTime?: Date;
    reason?: string;
  }): Promise<void> {
    return notifyRescheduleAdmin(params);
  }

  private async logAiJobMetric(data: {
    customerId: string; platform: string; success: boolean; latencyMs: number;
    failureReason?: string; isFallback?: boolean; circuitBreakerTrip?: boolean; circuitBreakerReason?: string;
    strategyUsed?: string;
  }): Promise<void> {
    return recordAiJobMetric(data);
  }

  /**
   * Resets and checks a customer's rolling daily token budget. Missing customer
   * = allow (nothing to enforce yet). Only enforced in production - during
   * development a single person's own testing traffic blows past a budget
   * meant to catch runaway/abusive customers long before real usage would.
   */
  private async checkTokenBudget(customerId: string): Promise<boolean> {
    return getTokenBudgetStatus(customerId);
  }

  /** Records token usage after a successful reply, resetting the daily counter if a new day has started. */
  private async recordTokenUsage(customerId: string, tokensUsed: number): Promise<void> {
    return saveTokenUsage(customerId, tokensUsed);
  }

  /**
   * Step 1 of 2: validates the package/date and saves a BookingDraft in
   * 'awaiting_confirmation' - tells the customer the deposit amount, but never
   * touches M-Pesa. No payment prompt gets sent until confirm_booking runs,
   * which can only happen on a later turn (see initialDraftStep in runAgent).
   */
  public async executeProposeBookingTool(customerId: string, name: string, service: string, date: string) {
    return proposeBookingTool.call(this, customerId, name, service, date);
  }

  /**
   * Step 2 of 2: issues the manual M-Pesa Buy Goods payment instructions.
   * Only proceeds if initialDraftStep (captured at the START of this turn,
   * before any tool calls ran) was already 'awaiting_confirmation' - meaning
   * propose_booking happened on a PRIOR message, not earlier in this same turn.
   * This guarantees the customer explicitly agreed before payment instructions
   * are issued.
   */
  public async executeConfirmBookingTool(
    customerId: string,
    initialDraftStep: string | undefined,
    expectedDeposit: number | null
  ) {
    return confirmBookingTool.call(this, customerId, initialDraftStep, expectedDeposit);
  }

  public async getPackageForDeposit(packageName?: string): Promise<{ name: string; deposit: number | null } | null> {
    return findPackageForDeposit(packageName);
  }

  public getDepositForPackage(pkg: { name: string; deposit: number | null } | null | undefined): number {
    return validateDeposit(pkg);
  }

  /**
   * Step 1 of 2 for rescheduling: validates there's an upcoming confirmed
   * booking and saves the proposed new date/time on the customer's
   * BookingDraft. Does NOT touch the real booking yet.
   */
  public async executeProposeRescheduleTool(customerId: string, newDate: string, newTime: string) {
    return proposeRescheduleTool.call(this, customerId, newDate, newTime);
  }

  /**
   * Step 2 of 2: applies the reschedule for real. Only proceeds if
   * initialDraftStep (captured at the START of this turn) was already
   * 'reschedule_confirm' - meaning propose_reschedule happened on a PRIOR
   * message, not earlier in this same turn.
   */
  public async executeConfirmRescheduleTool(customerId: string, initialDraftStep: string | undefined) {
    return confirmRescheduleTool.call(this, customerId, initialDraftStep);
  }

  /**
   * Cancels the next upcoming confirmed booking and removes its Google
   * Calendar event if linked.
   */
  public async executeConfirmCancellationTool(customerId: string, initialDraftStep: string | undefined) {
    return confirmCancellationTool.call(this, customerId, initialDraftStep);
  }

  public getCancellationCompletionReply(result: {
    service: string;
    dateTime: Date;
    refundEligible: boolean;
    depositPaid?: boolean;
  }): string {
    return formatCancellationCompletionReply(result);
  }

  private async executeCancelBookingTool(customerId: string, date?: string, bookingId?: string) {
    return cancelBookingTool.call(this, customerId, date, bookingId);
  }

  /**
   * Saves customer's preferred edited-photo delivery method (especially email)
   * and emits an admin notification so the team can follow through.
   */
  public async executeSaveDeliveryPreferenceTool(
    customerId: string,
    method: 'email' | 'download_link' | 'whatsapp',
    email?: string,
    whatsappNumber?: string,
    note?: string,
    platform?: string,
  ) {
    return saveDeliveryPreference(customerId, method, email, whatsappNumber, note, platform);
  }

  /**
   * Logic to save a note for a customer session
   */
  extractSessionNoteMetadata(note: string, type?: string, category?: string, priority?: string): {
    normalizedType: string;
    category: string;
    priority: string;
    tags: string[];
    details: {
      addOns: string[];
      companions: string[];
      accessibilityNeeds: string[];
      stylingRequests: string[];
      deliveryPreferences: string[];
    };
  } {
    return buildSessionNoteMetadata(note, type, category, priority);
  }

  public async executeAddNoteTool(
    customerId: string,
    bookingDate: string,
    note: string,
    type: string,
    category?: string,
    priority?: string,
    sourceMessage?: string,
    platform?: string,
    approvedAddonSkus?: readonly string[]
  ): Promise<{ created: boolean; reason?: string; type?: string }> {
    return saveSessionNote.call(this, customerId, bookingDate, note, type, category, priority, sourceMessage, platform, approvedAddonSkus);
  }
}

export const agentService = new AgentService();