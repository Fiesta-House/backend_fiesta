import { isMissingColumnError } from '../../config/schema-readiness';
import { emojiReplyType, stripAssistantEmojis, type EmojiReplyType } from './emoji-policy';
import { InvalidDateError, INVALID_DATE_REPLY, resolveCalendarDate } from './extraction';
import { normalizeQuotes } from './regex';
import { isCustomerNameQuestion } from './reply-voice';
import { circuitBreaker, FALLBACK_MESSAGE, shouldNotifyOutage } from './resilience.service';
import { completeTillBooking } from './till-booking-confirmation';
import { PAYMENT_MESSAGE_ROUTES } from './till-payment';
import { bookingStateService } from '../booking/booking-state.service';

export type ReplyContext = {
  customerId: string;
  userMessage: string;
  platform: string;
  startedAt: number;
  escalatedThisTurn?: boolean;
  /** First reply of a conversation: prefix the virtual-assistant introduction. */
  introduceAssistant?: boolean;
  /** Layer that produced the reply (route name or guard id); persisted as AiJobMetric.strategyUsed. */
  strategyUsed?: string;
};

export type ReplyOutcome = {
  success?: boolean;
  isFallback?: boolean;
  failureReason?: string;
  circuitBreakerTrip?: boolean;
  circuitBreakerReason?: string;
};

/**
 * Handles an incoming message from a customer, with conversation history.
 * Wraps runAgent with a circuit breaker, per-customer daily token budget,
 * best-effort frustration detection, and AI job metrics. Never throws -
 * always resolves to a string that's safe to send to the customer.
 */
export async function handleMessageFlow(
  this: any,
  customerId: string,
  rawMessage: string,
  rawHistory: { role: 'user' | 'assistant'; content: string }[] = [],
  platform: string = 'whatsapp'
): Promise<string> {
  const userMessage = normalizeQuotes(rawMessage);
  const history = stripAssistantEmojis(rawHistory).map((entry) => ({
    ...entry,
    content: normalizeQuotes(entry.content),
  }));
  const startedAt = Date.now();
  const ctx: ReplyContext = { customerId, userMessage, platform, startedAt };
  ctx.introduceAssistant = false;
  this.activeTurnContext = ctx;

  if (String(process.env.AI_AUTOMATION_ENABLED || 'true').trim().toLowerCase() === 'false') {
    ctx.strategyUsed = 'automationDisabled';
    await this.escalate(
      customerId,
      'automation_disabled',
      `Outbound AI automation is disabled (AI_AUTOMATION_ENABLED=false). Customer message: "${userMessage.slice(0, 300)}"`
    );
    return this.respond(ctx, 'The studio team will help you shortly on 0720 111928.', {
      success: false,
      isFallback: true,
      failureReason: 'automation_disabled',
    });
  }

  try {
    resolveCalendarDate(userMessage);
  } catch (error) {
    if (!(error instanceof InvalidDateError)) throw error;
    ctx.strategyUsed = 'invalidDate';
    return this.respond(ctx, INVALID_DATE_REPLY);
  }

  const naturalAssistantMode = this.isNaturalAssistantModeEnabled();
  let cancellationDraftReply: string | null;
  try {
    cancellationDraftReply = await this.clearStaleCancellationDraftBeforeRouting(customerId, userMessage, history);
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;
    const failure = await this.handleSchemaMismatch(customerId, userMessage, platform, error);
    ctx.strategyUsed = 'schemaMismatch';
    return this.respond(ctx, failure.reply, failure.outcome);
  }
  if (cancellationDraftReply) {
    ctx.strategyUsed = 'cancellationDraft';
    return this.respond(ctx, cancellationDraftReply);
  }

  const routes = this.createMessageRoutes(customerId, userMessage, history, platform, startedAt);
  const scopeBoundaryRoute = routes.find((candidate: any) => candidate.name === 'scopeBoundary');
  if (scopeBoundaryRoute?.when()) {
    console.log(`[AGENT_FLOW] route=${scopeBoundaryRoute.name}`);
    const scopeResult = (await scopeBoundaryRoute.handle()) as string;
    ctx.strategyUsed = scopeBoundaryRoute.name;
    return this.respond(ctx, scopeResult);
  }

  console.log(
    '[AGENT_FLOW] handleMessage start:',
    JSON.stringify({
      customerId,
      platform,
      messagePreview: userMessage.slice(0, 200),
      historyLength: history.length,
      naturalAssistantMode,
    })
  );

  if (this.isAskingIfHuman(userMessage)) {
    ctx.strategyUsed = 'identityQuestion';
    return this.respond(
      ctx,
      "I'm the virtual assistant for Fiesta House Maternity, so you're chatting with an AI rather than a person. I can help with our editions, add-ons and bookings, and the studio team is always there when you'd like a person, on 0720 111928."
    );
  }

  const paymentMessageState = await this.captureMpesaMessage(customerId, userMessage, platform);
  const paymentMessageMode = paymentMessageState !== 'not_waiting';
  if (paymentMessageState === 'received') {
    ctx.strategyUsed = 'mpesaPaymentMessage';
    try {
      const bookingReply = await completeTillBooking(customerId, userMessage);
      if (bookingReply) {
        return this.respond(ctx, bookingReply);
      }
      return this.respond(
        ctx,
        'Thank you for sharing your M-Pesa confirmation. The studio team has received it and will check the transaction against your booking.'
      );
    } catch (error) {
      console.error('[AGENT_FLOW] Till booking completion failed:', error);
      return this.respond(
        ctx,
        'Thank you. Your M-Pesa confirmation has been received. The studio team is checking the transaction and your booking details.'
      );
    }
  }

  if (circuitBreaker.isOpen()) {
    console.log('[AGENT_FLOW] Circuit breaker is open; returning fallback reply.');
    ctx.strategyUsed = 'circuitBreaker';
    if (shouldNotifyOutage()) {
      await this.escalate(
        customerId,
        'error',
        'AI circuit breaker is open due to repeated failures - customers are getting the canned fallback message.'
      );
    }
    return this.respond(ctx, FALLBACK_MESSAGE, {
      success: false,
      isFallback: true,
      failureReason: 'circuit_open',
      circuitBreakerTrip: true,
      circuitBreakerReason: 'Reply pipeline failing repeatedly, cooling down',
    });
  }

  if (this.isTimeOfDayGreeting(userMessage) || this.isCasualGreeting(userMessage)) {
    try {
      const greetingReply = await this.getGreetingReply(customerId, history);
      if (greetingReply) {
        ctx.strategyUsed = this.isTimeOfDayGreeting(userMessage) ? 'timeOfDayGreeting' : 'casualGreeting';
        const decorated = await this.decorateTemplateEmoji(
          customerId,
          platform,
          greetingReply,
          'welcome',
          userMessage,
          rawHistory
        );
        return this.respond(ctx, decorated);
      }
    } catch {
      console.warn('[AGENT_FLOW] greeting lookup failed; continuing normal routing.');
    }
  }

  this.trackSentiment(customerId, userMessage).catch((err: unknown) =>
    console.error('Sentiment tracking failed:', err)
  );

  for (const route of routes.filter((candidate: any) => candidate.beforeSlotCapture)) {
    if (paymentMessageMode && !PAYMENT_MESSAGE_ROUTES.has(route.name)) continue;
    if (!route.when()) continue;
    console.log(`[AGENT_FLOW] route=${route.name}`);
    try {
      const result = await route.handle();
      if (typeof result === 'string') {
        ctx.strategyUsed = route.name;
        return this.respond(ctx, result);
      }
      if (result) {
        ctx.strategyUsed = route.name;
        return this.respond(ctx, result.reply, result.outcome);
      }
    } catch (error) {
      if (isMissingColumnError(error)) {
        const failure = await this.handleSchemaMismatch(customerId, userMessage, platform, error);
        ctx.strategyUsed = 'schemaMismatch';
        return this.respond(ctx, failure.reply, failure.outcome);
      }
      ctx.strategyUsed = route.name;
      return this.respond(
        ctx,
        'I could not prepare that change, so your session is unchanged. The studio team can help on 0720 111928.',
        { success: false, isFallback: true, failureReason: 'reschedule_entry_failed' }
      );
    }
  }

  if (
    (platform === 'whatsapp' || platform === 'web') &&
    !this.conversationFlows.isRescheduleQuestion(history) &&
    !this.shouldUseInvoiceRequestReply(userMessage, history) &&
    !isCustomerNameQuestion(userMessage) &&
    !this.shouldUseBookingProcessReply(userMessage) &&
    !this.shouldUsePreviousAddonReply(userMessage, history)
  ) {
    try {
      const slotReply = await this.rememberBookingSlots(customerId, userMessage, history);
      if (slotReply) {
        ctx.strategyUsed = 'slotCapture';
        return this.respond(ctx, slotReply);
      }
    } catch (error) {
      if (isMissingColumnError(error)) {
        const failure = await this.handleSchemaMismatch(customerId, userMessage, platform, error);
        ctx.strategyUsed = 'schemaMismatch';
        return this.respond(ctx, failure.reply, failure.outcome);
      }
      console.warn('[AGENT_FLOW] Early booking slot persistence failed; requesting team assistance.');
      await this.escalate(
        customerId,
        'booking',
        'Early booking details could not be saved. Review the customer message before continuing.'
      );
      ctx.strategyUsed = 'slotCaptureError';
      return this.respond(ctx, 'The studio team will help save those details and continue your booking.', {
        success: false,
        isFallback: true,
        failureReason: 'slot_persistence_failed',
      });
    }
  }

  if (this.isDecliningOptionalAddons(userMessage, history)) {
    await bookingStateService.markAddonsDecided(customerId).catch(() => {});
  }

  for (const route of routes) {
    if (route.name === 'scopeBoundary') continue;
    if (paymentMessageMode && !PAYMENT_MESSAGE_ROUTES.has(route.name)) continue;
    if (route.beforeSlotCapture) continue;
    if (!route.when()) continue;
    if (route.mutateState) {
      try {
        await route.mutateState();
      } catch (error) {
        console.warn(`[AGENT_FLOW] route=${route.name} state mutation failed:`, error);
      }
    }
    if (route.replyMode === 'natural' && naturalAssistantMode) continue;
    console.log(`[AGENT_FLOW] route=${route.name}`);
    let result;
    try {
      result = await route.handle();
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      result = await this.handleSchemaMismatch(customerId, userMessage, platform, error);
      ctx.strategyUsed = 'schemaMismatch';
    }
    if (result === null) continue;
    if (ctx.strategyUsed !== 'schemaMismatch') ctx.strategyUsed = route.name;
    if (typeof result === 'string') {
      const types: Record<string, EmojiReplyType> = {
        greeting: 'welcome',
        packageSelection: 'packageChosen',
        postActionAcknowledgement: 'closing',
      };
      const type = types[route.name] || (route.name !== 'runAgent' ? emojiReplyType(result) : 'other');
      if (type !== 'other') {
        result = await this.decorateTemplateEmoji(customerId, platform, result, type, userMessage, rawHistory);
      }
      return this.respond(ctx, result);
    }
    return this.respond(ctx, result.reply, result.outcome);
  }

  ctx.strategyUsed = 'noMatchingRoute';
  return this.respond(ctx, FALLBACK_MESSAGE, {
    success: false,
    isFallback: true,
    failureReason: 'no_matching_route',
  });
}
