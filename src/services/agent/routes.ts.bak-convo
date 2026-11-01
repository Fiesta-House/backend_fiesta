import prisma from '../../config/prisma';
import { CHAT_MODEL } from './llm/provider';
import {
  circuitBreaker,
  DAILY_TOKEN_CAP,
  FALLBACK_MESSAGE,
  PROVIDER_OUTAGE_MESSAGE,
  isProviderRateLimitError,
  classifyProviderRateLimit,
  shouldNotifyOutage,
} from './resilience.service';
import { PAYMENT_PROMPT_UNRECORDED, PAYMENT_PROMPT_UNRECORDED_REPLY, BUDGET_HANDOFF_REPLY } from './constants';
import { resolveVerifiedFact } from './verified-facts';
import { InvalidDateError, INVALID_DATE_REPLY } from './extraction';
import { addonInquiryReply, addonRecipient, addonSelectionClarification, isAddonListRequest } from './addon-capture';
import { ADDON_NOTED_PREFIX, ADDON_BALANCE_REPLY, ADDON_UNCHANGED_REPLY } from './constants';
import { isCustomerNameQuestion, needsUnchangedReassurance, editionInText } from './reply-voice';
import { isMissingColumnError } from '../../config/schema-readiness';
import { DEFERRAL_REPLY, buildBookingPolicyReply, buildHairWigClarificationReply, buildOpeningHoursReply, buildPersonalOutfitReply, buildWalkInReply, familyStylingReply, isHairWigClarificationRequest, isStandaloneLashesQuestion, isPersonalOutfitQuestion, legacyPackageReply, buildAboutBusinessReply } from './replies';
import { alternativeDates, extractStatedSlots, EARLY_SLOT_STEP } from './slot-memory';
import { CARRY_OVER_PREFIX, STEP_QUESTIONS, alternativeDatesReply } from './booking-progress';

const CARRY_OVER_CONTINUE = /^(?:yes+|yeah|yep|sure|ok(?:ay)?|continue|same|that one|yes,? (?:please|continue|let'?s continue)|let'?s continue|please continue|continue with (?:that|it))[.! ]*$/i;
const CARRY_OVER_CHANGE = /^(?:no|nope|no,? (?:a |something )?different(?: one)?|(?:a |something )?different(?: one)?|another one|change it|choose (?:a )?different(?: one)?)[.! ]*$/i;
import { buildExpressDeliveryFeeReply, isExpressDeliveryFeeRequest } from './photo-delivery-replies';
import { classifyPaymentMessage } from './payment-recovery';
import { catalogLinkFollowUp } from './catalog-policy';
import { OFFICIAL_WEBSITE_URLS } from './constants';
import { isBookingPolicyQuestion, isDeferral, isOpeningHoursQuestion, isPlainGreeting, isWalkInQuestion } from './conversation-flow.matcher';
import { isConfirmedSessionFollowUp } from './appointment-replies';
import { emojiReplyType, stripAssistantEmojis } from './emoji-policy';
import { getPackageChangeReply, getPackageSwitchAnswerReply, isPackageChangeRequest, isPackageSwitchAnswer } from './package-replies';

export type RouteOutcome = {
  success?: boolean;
  isFallback?: boolean;
  failureReason?: string;
  circuitBreakerTrip?: boolean;
  circuitBreakerReason?: string;
};

export type MessageRouteResult = string | { reply: string; outcome?: RouteOutcome } | null;

export type MessageRoute = {
  name: string;
  when: () => boolean;
  handle: () => MessageRouteResult | Promise<MessageRouteResult>;
  replyMode?: 'deterministic' | 'natural';
  beforeSlotCapture?: boolean;
};




function isAddonAdviceRequest(
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


function buildAddonAdviceReply(): string {
  return [
    'Add-ons are completely optional 😊 Your Bloom package already includes its own features, so there is no pressure to add anything extra.',
    '',
    'If you would like to personalise your photoshoot, here are a few options:',
    '• Extra outfit — KSh 4,000 if you would like another look.',
    '• Extra edited photo — KSh 1,000 each for more finished images beyond those included in your package.',
    '• Styled wig hire — KSh 4,000 if you would like a different look; this must be booked in advance.',
    '',
    'These are just suggestions, not requirements. You can enjoy your session with your existing package exactly as it is.',
    `You can explore all the optional extras here: ${OFFICIAL_WEBSITE_URLS.packages}`,
  ].join('\n');
}









export function createMessageRoutes(
  this: any,
  customerId: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  platform: string,
  startedAt: number
): MessageRoute[] {
  history = stripAssistantEmojis(history);
  let scopeBoundaryReply: string | null = null;
  let informationalFlowResolved = false;
  let informationalFlow: any;
  const getInformationalFlow = () => {
    if (!informationalFlowResolved) {
      informationalFlow = this.conversationFlowHandler.resolveInformationalFlow(userMessage, history);
      informationalFlowResolved = true;
    }
    return informationalFlow;
  };

  return [
    {
      name: 'familyStyling',
      replyMode: 'deterministic',
      when: () => Boolean(familyStylingReply(userMessage, history)),
      handle: () => familyStylingReply(userMessage, history),
    },
    {
      name: 'scopeBoundary',
      when: () => Boolean(scopeBoundaryReply = this.getScopeBoundaryReply(userMessage, history)),
      handle: () => scopeBoundaryReply,
    },
    {
      name: 'customerName',
      replyMode: 'deterministic',
      when: () => isCustomerNameQuestion(userMessage),
      handle: async () => {
        try {
          return await this.getCustomerNameReply(customerId);
        } catch (error) {
          if (isMissingColumnError(error)) throw error;
          return { reply: 'I could not check your saved name just now. The studio team can help.',
            outcome: { success: false, isFallback: true, failureReason: 'customer_name_lookup_failed' } };
        }
      },
    },
    {
      name: 'bookingPolicyInformation',
      replyMode: 'deterministic',
      beforeSlotCapture: true,
      when: () => isBookingPolicyQuestion(userMessage),
      handle: () => buildBookingPolicyReply(),
    },
    {
      name: 'walkIn',
      replyMode: 'deterministic',
      beforeSlotCapture: true,
      when: () => isWalkInQuestion(userMessage),
      handle: async () => {
        let withinBudget: boolean;

        try {
          withinBudget = await this.checkTokenBudget(customerId);
        } catch (error) {
          if (isMissingColumnError(error)) throw error;

          console.error('[AGENT_FLOW] Walk-in budget check failed; handing off to the studio team.');
          try {
            await this.escalate(customerId, 'quota', JSON.stringify({
              event: 'quota_handoff_requested',
              platform,
              customerMessage: userMessage.slice(0, 2000),
              requiresHumanReply: true,
              assignedOwner: null,
              note: 'The automated conversation limit could not be verified. A studio team member must review this message.',
            }));
          } catch {
            console.error('[AGENT_FLOW] Failed to create the walk-in budget handoff.');
          }

          return {
            reply: BUDGET_HANDOFF_REPLY,
            outcome: { success: false, isFallback: true, failureReason: 'token_budget_check_failed' },
          };
        }

        if (!withinBudget) {
          try {
            await this.escalateQuotaHandoff(customerId, userMessage, platform);
          } catch {
            console.error('[AGENT_FLOW] Failed to create the walk-in quota handoff.');
          }

          return {
            reply: BUDGET_HANDOFF_REPLY,
            outcome: { success: false, isFallback: true, failureReason: 'daily_token_limit_exceeded' },
          };
        }

        return buildWalkInReply();
      },
    },
    {
      name: 'openingHours',
      replyMode: 'deterministic',
      beforeSlotCapture: true,
      when: () => isOpeningHoursQuestion(userMessage),
      handle: () => buildOpeningHoursReply(),
    },
    {
      name: 'packageSwitchAnswer',
      replyMode: 'deterministic',
      beforeSlotCapture: true,
      when: () => (platform === 'whatsapp' || platform === 'web') && isPackageSwitchAnswer(userMessage, history),
      handle: async () => getPackageSwitchAnswerReply(customerId, userMessage, history),
    },
    {
      name: 'packageChangeRequest',
      replyMode: 'deterministic',
      beforeSlotCapture: true,
      when: () => (platform === 'whatsapp' || platform === 'web') && isPackageChangeRequest(userMessage, history),
      handle: async () => {
        const result = await getPackageChangeReply(customerId, userMessage, history);
        if (!result) return null;
        if (result.escalateToTeam) {
          await this.escalate(customerId, 'booking', result.escalationReason || 'Customer requested package change on confirmed booking.');
        }
        return result.reply;
      },
    },
    {
      name: 'dateAlternatives',
      replyMode: 'deterministic',
      beforeSlotCapture: true,
      when: () => (platform === 'whatsapp' || platform === 'web') && alternativeDates(userMessage, history).length > 1,
      handle: () => alternativeDatesReply.call(this, customerId, userMessage, history),
    },
    {
      name: 'rescheduleEntry',
      replyMode: 'deterministic',
      beforeSlotCapture: true,
      when: () => (platform === 'whatsapp' || platform === 'web') && this.conversationFlows.isInitialRescheduleRequest(userMessage),
      handle: async () => {
        const reply = await this.getInitialRescheduleReply(customerId, userMessage, history);
        return /^I have not changed your current request or your session\./.test(reply)
          ? { reply, outcome: { success: false, isFallback: false, failureReason: 'reschedule_conflicting_draft' } }
          : reply;
      },
    },
    {
      name: 'identityCorrection',
      when: () => this.isBookingIdentityCorrection(userMessage),
      handle: async () => this.getBookingIdentityCorrectionReply(customerId, history),
    },
    {
      name: 'recipientName',
      when: () => this.shouldCaptureRecipientName(userMessage, history),
      handle: async () => {
        const recipientName = await this.captureRecipientName(customerId, userMessage);
        return recipientName
          ? `Thanks, I’ll set the session up for ${recipientName}. Which package would you like, and what date and time would work best?`
          : null;
      },
    },
    {
      name: 'ambiguousDeposit',
      replyMode: 'deterministic',
      when: () => this.shouldClarifyAmbiguousDeposit(userMessage),
      handle: () => this.getAmbiguousDepositReply(),
    },
    {
      name: 'paymentRecovery',
      replyMode: 'deterministic',
      // Explicit yes/confirm replies go through immediateConfirmation, which delegates payment_pending drafts here.
      when: () => (platform === 'whatsapp' || platform === 'web')
        && classifyPaymentMessage(userMessage) !== null
        && !(classifyPaymentMessage(userMessage) === 'consent' && this.isExplicitConfirmation(userMessage)),
      handle: async () => {
        try {
          return await this.getPaymentRecoveryReply(customerId, userMessage);
        } catch (error: any) {
          if (isMissingColumnError(error)) throw error;
          console.error('[AGENT_FLOW] Payment recovery failed:', error);
          return {
            reply: 'I could not check your payment just now. The studio team can help on 0720 111928.',
            outcome: { success: false, isFallback: true, failureReason: String(error?.message || error).slice(0, 200) },
          };
        }
      },
    },
    {
      name: 'rescheduleWithdrawalConfirmation',
      when: () => this.shouldConfirmRescheduleWithdrawal(userMessage, history),
      handle: () => 'Yes. Your original session date and time are still booked, and your deposit remains held for it.',
    },
    {
      name: 'carryOverAnswer',
      replyMode: 'deterministic',
      when: () => (platform === 'whatsapp' || platform === 'web')
        && ([...history].reverse().find(entry => entry.role === 'assistant')?.content || '').includes(CARRY_OVER_PREFIX)
        && (CARRY_OVER_CONTINUE.test(userMessage.trim()) || CARRY_OVER_CHANGE.test(userMessage.trim())),
      handle: async () => {
        if (CARRY_OVER_CONTINUE.test(userMessage.trim())) {
          return await this.getBookingProgressReply(customerId, userMessage, history, false, true) || STEP_QUESTIONS.need_package;
        }
        await prisma.bookingDraft.updateMany({ where: { customerId, step: EARLY_SLOT_STEP },
          data: { service: null, date: null, time: null, dateTimeIso: null } });
        return `No problem. ${STEP_QUESTIONS.need_package}`;
      },
    },
    {
      name: 'postActionAcknowledgement',
      replyMode: 'natural',
      when: () => this.isPostActionAcknowledgement(userMessage, history),
      handle: () => {
        const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
        if (lastAssistant.includes(BUDGET_HANDOFF_REPLY) || /passed your question to the studio team|team will pick this up|team will confirm/i.test(lastAssistant)) {
          return 'You are welcome. 🤍 A member of our team will be in touch with you shortly.';
        }
        return this.previousMessageRequestsConfirmation(history)
          ? 'No rush. Let me know when you are ready to go ahead.'
          : 'You are welcome. I am here if you need anything else.';
      },
    },
    {
      name: 'deferral',
      replyMode: 'natural',
      when: () => isDeferral(userMessage) && !Object.keys(extractStatedSlots(userMessage, history)).length,
      handle: () => DEFERRAL_REPLY,
    },
    {
      name: 'cancellationDeclined',
      when: () => this.hasPendingCancellationProposal(history) && this.isCancellationDecline(userMessage),
      handle: async () => {
        await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
        return 'Understood. Your booking is unchanged, and I have not cancelled it.';
      },
    },
    {
      name: 'staleCancellationProposal',
      when: () => this.hasPendingCancellationProposal(history)
        && !this.isCancellationConfirmation(userMessage)
        && !this.isCancellationDecline(userMessage)
        && !this.shouldUseCancellationRequest(userMessage, history),
      handle: async () => {
        await prisma.bookingDraft.deleteMany({ where: { customerId, step: 'cancel_confirm' } });
        return null;
      },
    },
    {
      name: 'cancellationProposal',
      when: () => (platform === 'whatsapp' || platform === 'web')
        && this.shouldUseCancellationRequest(userMessage, history),
      handle: async () => (await this.proposeCancellation(customerId, userMessage, history)).reply,
    },
    {
      name: 'bookingStatus',
      when: () => this.shouldUseBookingStatusReply(userMessage),
      handle: async () => this.getBookingStatusReply(customerId),
    },
    {
      name: 'upcomingAppointmentTime',
      when: () => this.shouldUseUpcomingAppointmentTimeReply(userMessage),
      handle: async () => this.getUpcomingAppointmentTimeReply(customerId),
    },
    {
      name: 'pastAppointmentsList',
      when: () => this.shouldUsePastAppointmentsListReply(userMessage),
      handle: async () => this.getPastAppointmentsListReply(customerId),
    },
    {
      name: 'lastAppointmentDetails',
      when: () => this.shouldUseLastAppointmentDetailsReply(userMessage),
      handle: async () => this.getLastAppointmentDetailsReply(customerId),
    },
    {
      name: 'upcomingAppointmentDetails',
      when: () => this.shouldUseUpcomingAppointmentDetailsReply(userMessage),
      handle: async () => this.getUpcomingAppointmentDetailsReply(customerId, history),
    },
    {
      name: 'mixedIntent',
      when: () => this.shouldClarifyMixedIntent(userMessage),
      handle: () => this.getMixedIntentClarificationReply(),
    },
    {
      name: 'invoice',
      when: () => this.shouldUseInvoiceRequestReply(userMessage, history),
      handle: async () => {
        const requestedInvoiceNumber = this.extractInvoiceNumber(userMessage);
        return this.sendStoredInvoiceToCustomer(customerId, requestedInvoiceNumber ?? undefined, history, userMessage);
      },
    },
    {
      name: 'confirmedSessionFollowUp',
      replyMode: 'deterministic',
      when: () => (platform === 'whatsapp' || platform === 'web') && isConfirmedSessionFollowUp(userMessage),
      handle: () => this.getConfirmedSessionFollowUpReply(customerId),
    },
    {
      name: 'pastAppointment',
      when: () => this.shouldUsePastAppointmentReply(userMessage) || this.isPastAppointmentFollowUp(userMessage, history),
      handle: async () => this.getPastAppointmentReply(customerId),
    },
    {
      name: 'bookingForSomeoneElseFollowUp',
      when: () => {
        const lastAssistantMessage = [...history].reverse()
          .find((entry) => entry.role === 'assistant')?.content || '';

        const clarificationWasAsked =
          /session just for your sister[\s\S]{0,100}would you both like to be photographed together/i
            .test(lastAssistantMessage);

        const answer = userMessage.trim();

        const answersForSister =
          /^(?:(?:it's|it is|the session is)\s+)?(?:just|only)\s+(?:for\s+)?(?:her|my sister)(?:\s+only)?[.! ]*$/i
            .test(answer);

        return clarificationWasAsked && answersForSister;
      },
      handle: () =>
        "Got it. The session will be just for your sister. What is her full name?",
    },
    {
      name: 'bookingForSomeoneElse',
      when: () => this.shouldClarifyBookingForSomeoneElse(userMessage),
      handle: () => this.getBookingForSomeoneElseReply(),
    },
    {
      name: 'multiPersonBooking',
      when: () => this.shouldUseMultiPersonBookingReply(userMessage),
      handle: async () => {
        await this.captureMultiPersonBookingNote(customerId, userMessage).catch((err: unknown) => {
          console.error('Failed to capture multi-person booking note:', err);
        });
        return this.getMultiPersonBookingReply();
      },
    },
    {
      name: 'lashes',
      replyMode: 'deterministic',
      when: () => isStandaloneLashesQuestion(userMessage),
      handle: () => this.getLashesReply(),
    },
    {
      name: 'legacyPackageName',
      replyMode: 'deterministic',
      when: () => Boolean(legacyPackageReply(userMessage)),
      handle: () => this.getLegacyPackageReply(userMessage),
    },
    {
      name: 'packageBudget',
      replyMode: 'deterministic',
      when: () => this.shouldUsePackageBudgetReply(userMessage),
      handle: () => this.getPackageBudgetReply(),
    },
    {
      name: 'suspendingConceptGallery',
      when: () => {
        getInformationalFlow();
        return Boolean(this.getSuspendingConceptGalleryReply(userMessage, history));
      },
      handle: () => this.getSuspendingConceptGalleryReply(userMessage, history),
    },
    {
      name: 'reviewPage',
      when: () => Boolean(this.getReviewPageReply(userMessage)),
      handle: () => this.getReviewPageReply(userMessage),
    },
    {
      name: 'greeting',
      replyMode: 'natural',
      when: () => isPlainGreeting(userMessage),
      handle: async () => this.getGreetingReply(customerId, history),
    },
    {
      name: 'businessIntroduction',
      replyMode: 'natural',
      when: () => getInformationalFlow() === 'business_introduction',
      handle: () => this.getBusinessIntroductionReply(userMessage),
    },
    {
      name: 'weekday',
      when: () => getInformationalFlow() === 'weekday',
      handle: () => this.getWeekdayReply(userMessage, history),
    },
    {
      name: 'website',
      replyMode: 'natural',
      when: () => getInformationalFlow() === 'website',
      handle: () => this.getWebsiteReply(),
    },
    {
      name: 'contactDetails',
      replyMode: 'deterministic',
      when: () => getInformationalFlow() === 'contact_details',
      handle: () => this.getContactDetailsReply(),
    },
    {
      name: 'portfolio',
      replyMode: 'natural',
      when: () => getInformationalFlow() === 'portfolio',
      handle: () => this.getPortfolioReply(),
    },
    {
      name: 'socialMedia',
      replyMode: 'natural',
      when: () => this.shouldUseSocialMediaReply(userMessage),
      handle: () => this.getSocialMediaReply(),
    },
    {
      name: 'rawFiles',
      replyMode: 'deterministic',
      when: () => this.shouldUseRawFilesReply(userMessage),
      handle: () => `${this.getRawFilesReply()}\n${OFFICIAL_WEBSITE_URLS.packages}`,
    },
    {
      name: 'expressDeliveryFee',
      replyMode: 'deterministic',
      when: () => isExpressDeliveryFeeRequest(userMessage),
      handle: () => buildExpressDeliveryFeeReply(),
    },
    {
      name: 'previousAddon',
      replyMode: 'deterministic',
      when: () => this.shouldUsePreviousAddonReply(userMessage, history),
      handle: async () => {
        try {
          return await this.getPreviousAddonReply(customerId);
        } catch (error) {
          if (isMissingColumnError(error)) throw error;
          return { reply: 'I could not check your saved add-ons just now. The studio team can help verify them.',
            outcome: { success: false, isFallback: true, failureReason: 'addon_status_lookup_failed' } };
        }
      },
    },
    
{
  name: 'addonAdvice',
  replyMode: 'natural',
  when: () => isAddonAdviceRequest(userMessage, history),
  handle: () => buildAddonAdviceReply(),
},



    {
      name: 'clarifyNewAddon',
      when: () => this.shouldClarifyNewAddon(userMessage, history),
      handle: () => 'Which add-on would you like to add to your session? I can show you the available extras if you are not sure yet.',
    },

    {
      name: 'addonRequest',
      replyMode: 'natural',
      when: () => isAddonListRequest(userMessage),
      handle: () => this.getCatalogDisplayReply(customerId, platform, 'addons', userMessage, history),
    },
    {
      name: 'addonListFollowUp',
      replyMode: 'natural',
      when: () => this.isAddonListFollowUp(userMessage, history) && !this.getSelectedAddon(userMessage, history) && !addonSelectionClarification(userMessage, history),
      handle: () => this.getCatalogDisplayReply(customerId, platform, 'addons', userMessage, history),
    },
    {
      name: 'verifiedFacts',
      replyMode: 'deterministic',
      when: () => !this.getSelectedAddon(userMessage, history) && !addonSelectionClarification(userMessage, history) && Boolean(resolveVerifiedFact(userMessage, history)),
      handle: async () => {
        if (isPersonalOutfitQuestion(userMessage)) return buildPersonalOutfitReply();
        const draft = await prisma.bookingDraft.findUnique({ where: { customerId } }).catch(() => null);
        return resolveVerifiedFact(userMessage, history, { draftService: draft?.service });
      },
    },
    {
      name: 'personalOutfit',
      replyMode: 'deterministic',
      when: () => isPersonalOutfitQuestion(userMessage),
      handle: () => buildPersonalOutfitReply(),
    },
    {
      name: 'hairWigClarification',
      replyMode: 'deterministic',
      when: () => isHairWigClarificationRequest(userMessage),
      handle: () => buildHairWigClarificationReply(),
    },
    {
      name: 'addonInquiry',
      replyMode: 'deterministic',
      when: () => Boolean(addonInquiryReply(userMessage)),
      handle: async () => {
        const inquiry = addonInquiryReply(userMessage);
        if (inquiry) return `${inquiry}\n${OFFICIAL_WEBSITE_URLS.packages}`;
        return null;
      },
    },
    {
      name: 'selectedAddon',
      when: () => Boolean(addonSelectionClarification(userMessage, history) || this.getSelectedAddon(userMessage, history)),
      handle: async () => {
        const clarification = addonSelectionClarification(userMessage, history);
        if (clarification) return clarification;
        const choices = this.getSelectedAddons(userMessage, history);
        if (!choices.length) return null;
        const saved: string[] = [];
        const existing: string[] = [];
        const failed: string[] = [];
        const included: string[] = [];
        let edition = '';
        for (const addon of choices) {
          try {
            const quantity = this.getRequestedAddonQuantity(userMessage, addon);
            const label = quantity > 1 ? `${quantity} x ${addon.name}` : addon.name;
            const recipient = addonRecipient(userMessage, addon.sku);
            const noteResult = await this.executeAddNoteTool(customerId, '', `${label}${recipient ? ` ${recipient}` : ''}`,
              'special_request', 'addon', 'normal', userMessage, platform, choices.map((choice: { sku: string }) => choice.sku));
            if (noteResult.created) saved.push(label);
            else if (noteResult.reason === 'duplicate_pending_note') existing.push(label);
            else if (noteResult.reason === 'addon_included_in_edition') { included.push(addon.name); edition = noteResult.edition || edition; }
            else failed.push(label);
          } catch {
            failed.push(addon.name);
          }
        }
        const includedLine = included.length
          ? `${included.join(' and ')} ${included.length > 1 ? 'are' : 'is'} already included with ${editionInText(edition)}, so there is no extra charge.` : '';
        if (included.length && !saved.length && !existing.length && !failed.length) return includedLine;
        if (choices.length === 1 && saved.length === 1) {
          const acknowledgement = this.getAddonSelectionReply(choices[0], this.getRequestedAddonQuantity(userMessage, choices[0]), needsUnchangedReassurance(userMessage));
          const next = await this.getBookingProgressReply(customerId, userMessage, history, true);
          return next ? `${acknowledgement}\n${next}` : acknowledgement;
        }
        const acknowledgement = [saved.length ? `${ADDON_NOTED_PREFIX} ${saved.join('; ')}.` : '',
          existing.length ? `Already recorded: ${existing.join('; ')}. I have not added these twice.` : '',
          failed.length ? `Not saved: ${failed.join('; ')}. The team can help confirm these.` : '',
          includedLine,
          `${ADDON_BALANCE_REPLY}${needsUnchangedReassurance(userMessage) ? ` ${ADDON_UNCHANGED_REPLY}` : ''}`].filter(Boolean).join('\n');
        const next = !failed.length && (saved.length || existing.length) ? await this.getBookingProgressReply(customerId, userMessage, history, true) : null;
        return next ? `${acknowledgement}\n${next}` : acknowledgement;
      },
    },
    {
      name: 'additions',
      replyMode: 'natural',
      when: () => this.shouldUseAdditionsReply(userMessage) && !this.isDecliningOptionalAddons(userMessage, history),
      handle: () => this.getCatalogDisplayReply(customerId, platform, 'addons', userMessage, history),
    },
    {
      name: 'bespoke',
      replyMode: 'natural',
      when: () => this.shouldUseBespokeReply(userMessage),
      handle: () => this.getBespokeReply(),
    },
    {
      name: 'travellingMothers',
      replyMode: 'natural',
      when: () => this.shouldUseTravellingMothersReply(userMessage),
      handle: () => this.getTravellingMothersReply(),
    },
    {
      name: 'earliestImageDelivery',
      replyMode: 'deterministic',
      when: () => this.shouldUseEarliestImageDeliveryReply(userMessage),
      handle: async () => this.getEarliestImageDeliveryReply(customerId),
    },
    {
      name: 'postShootProcess',
      replyMode: 'deterministic',
      when: () => this.shouldUsePostShootProcessReply(userMessage) && !this.shouldUseBookingProcessReply(userMessage),
      handle: () => this.getPostShootProcessReply(),
    },
    {
      name: 'bookingProcess',
      replyMode: 'deterministic',
      when: () => this.shouldUseBookingProcessReply(userMessage),
      handle: async () => this.getBookingProcessReply(customerId, platform, history),
    },
    {
      name: 'rescheduleSelection',
      replyMode: 'deterministic',
      when: () => this.conversationFlows.hasRescheduleSlotSignal(userMessage),
      handle: async () => this.getRescheduleSelectionReply(customerId, userMessage, history),
    },
    {
      name: 'rescheduleWithdrawal',
      when: () => this.shouldUseRescheduleWithdrawalReply(userMessage, history),
      handle: async () => {
        await this.withdrawPendingReschedule(customerId);
        return 'Understood! We will keep your original session date and time, and your booking remains unchanged. Your deposit is still held for that session. Let us know if you need anything else preparing for your shoot!';
      },
    },
    {
      name: 'timeOnlyRescheduleRequest',
      when: () => this.conversationFlows.isTimeOnlyRescheduleRequest(userMessage),
      handle: async () => this.getRescheduleTimeReply(customerId),
    },
    {
      name: 'rescheduleRequest',
      when: () => this.shouldUseRescheduleRequestReply(userMessage),
      handle: async () => this.getRescheduleTimeReply(customerId),
    },
    {
      name: 'sameBookingSlot',
      when: () => this.conversationFlows.isSameBookingSlotRequest(userMessage),
      handle: async () => this.getSameBookingSlotReply(customerId, history),
    },
    {
      name: 'packageSelection',
      replyMode: 'deterministic',
      when: () => this.shouldResolvePackageSelectionImmediately(userMessage),
      handle: async () => this.getPackageSelectionReply(customerId, userMessage),
    },
    {
      name: 'packageAdvice',
      replyMode: 'natural',
      when: () => this.conversationFlows.isPackageAdviceRequest(userMessage),
      handle: async () => this.getPackageAdviceReply(userMessage),
    },
    {
  name: 'packageCatalog',
  replyMode: 'deterministic',
 when: () => this.conversationFlows.isPackageCatalogRequest(userMessage, history) || catalogLinkFollowUp(userMessage, history),
  handle: async () => {
    const previous = [...history].reverse().find(entry => entry.role === 'assistant')?.content || '';
    const kind = catalogLinkFollowUp(userMessage, history) && /extras|add-ons/i.test(previous) ? 'addons' : 'editions';
    return this.getCatalogDisplayReply(customerId, platform, kind, userMessage, history);
  },
},
{
  name: 'aboutBusiness',
  replyMode: 'natural',
  when: () =>
    /\b(?:about your services|what services do you offer|what does fiesta house do|tell me about fiesta house)\b/i
      .test(userMessage),
  handle: () => buildAboutBusinessReply(),
},
    {
      name: 'immediateConfirmation',
      when: () => (platform === 'whatsapp' || platform === 'web')
        && this.isExplicitConfirmation(userMessage)
        && (this.previousMessageRequestsConfirmation(history) || this.isPaymentConfirmation(userMessage)),
      handle: async () => {
        try {
          const immediate = await this.tryImmediateConfirmation(customerId, userMessage, history);
          return immediate;
        } catch (error: any) {
          if (isMissingColumnError(error)) return this.handleSchemaMismatch(customerId, userMessage, platform, error);
          console.error('[AGENT_FLOW] Immediate confirmation failed:', error);
          const recovery = error?.code === PAYMENT_PROMPT_UNRECORDED ? null
            : await this.getBookingStatusReply(customerId).catch(() => null);
          return {
            reply: error?.code === PAYMENT_PROMPT_UNRECORDED
              ? PAYMENT_PROMPT_UNRECORDED_REPLY
              : recovery || 'Your booking has not been confirmed. The studio team will help you with the deposit.',
            outcome: {
              success: false,
              isFallback: true,
              failureReason: String(error?.message || error).slice(0, 200),
            },
          };
        }
      },
    },
    {
      name: 'runAgent',
      when: () => true,
      handle: async () => {
        try {
          const progress = platform === 'whatsapp' || platform === 'web' ? await this.getBookingProgressReply(customerId, userMessage, history) : null;
          if (progress) {
            const type = emojiReplyType(progress);
            return type !== 'other' ? this.decorateTemplateEmoji(customerId, platform, progress, type, userMessage, history) : progress;
          }
          console.log('[AGENT_FLOW] No deterministic early exit matched; checking token budget before model call');
          const withinBudget = await this.checkTokenBudget(customerId);
          if (!withinBudget) {
            console.log('[AGENT_FLOW] Daily token budget exceeded; returning fallback reply.', {
              customerId,
              dailyTokenCap: DAILY_TOKEN_CAP,
              platform,
            });
            await this.escalateQuotaHandoff(customerId, userMessage, platform);
            return {
              reply: BUDGET_HANDOFF_REPLY,
              outcome: { success: false, isFallback: true, failureReason: 'daily_token_limit_exceeded' },
            };
          }
          console.log('[AGENT_FLOW] Invoking runAgent()');
          const { content, tokensUsed, failureType } = await this.runAgent(customerId, userMessage, history, platform);
          console.log('[AGENT_FLOW] runAgent() completed successfully:', JSON.stringify({
            customerId,
            tokensUsed,
            replyPreview: content.slice(0, 200)
          }));
          circuitBreaker.recordSuccess();
          await this.recordTokenUsage(customerId, tokensUsed);
          if (failureType) {
            return { reply: content, outcome: { success: false, isFallback: true, failureReason: failureType } };
          }
          this.touchCustomerMemory(customerId, userMessage, platform).catch((err: unknown) => console.error('Customer memory update failed:', err));
          return content;
        } catch (error: any) {
          if (isMissingColumnError(error)) return this.handleSchemaMismatch(customerId, userMessage, platform, error);
          if (error instanceof InvalidDateError || error?.name === 'InvalidDateError') {
            // Defensive: the handleMessage entry guard already answered this
            // message, so an invalid date can only leak in via a derived
            // substring. Never count it as a pipeline failure or trip the breaker.
            console.log('[AGENT_FLOW] Invalid calendar date reached the pipeline; replying with a clarification.');
            return { reply: INVALID_DATE_REPLY, outcome: { success: true } };
          }
          console.error('[AGENT_FLOW] Agent reply pipeline failed:', error);
          const rateLimitType = classifyProviderRateLimit(error);
          console.log('[AGENT_FLOW] Failure classification:', JSON.stringify({
            customerRef: this.customerReference(customerId),
            errorName: error?.name,
            status: error?.status,
            code: error?.code,
            rateLimitType,
          }));
          console.info('[AGENT_USAGE]', JSON.stringify({
            customerRef: this.customerReference(customerId),
            model: CHAT_MODEL,
            completionCalls: null,
            toolCalls: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            latencyMs: Date.now() - startedAt,
            rateLimited: rateLimitType !== null,
            failureType: rateLimitType || 'agent_pipeline_failure',
          }));
          const justTripped = circuitBreaker.recordFailure();
          const isOutage = isProviderRateLimitError(error);
          const pendingExtrasDecline = isOutage && (platform === 'whatsapp' || platform === 'web')
            && this.isDecliningOptionalAddons(userMessage, history);
          const fallbackReply = pendingExtrasDecline
            ? 'Noted, no optional extras. Our booking assistant is temporarily unavailable, so I have not sent a deposit proposal. A team member will follow up to finish your booking.'
            : isOutage
            ? PROVIDER_OUTAGE_MESSAGE
            : 'Sorry, I could not process that request right now. Please try again, or a team member will follow up with you.';
          if (rateLimitType === 'daily_tpd_exhausted' && shouldNotifyOutage()) {
            await this.escalate(customerId, 'error', `AI PROVIDER OUTAGE: Groq's daily token limit has been reached - ALL customers are currently getting the fallback message, not just this one. It resets on its own; check console.groq.com/settings/billing if this keeps recurring. Original error: ${error.message}`);
          } else if (rateLimitType === 'transient_rate_limit' && shouldNotifyOutage()) {
            await this.escalate(customerId, 'error', `AI PROVIDER RATE LIMIT: requests are being limited. No automatic retry was attempted. Original error: ${error.message}`);
          } else if (justTripped && !isOutage) {
            await this.escalate(customerId, 'error', `Circuit breaker just tripped: ${error.message}`);
          }
          if (pendingExtrasDecline) {
            await this.escalate(customerId, 'booking', 'Customer declined optional extras, but the AI provider is unavailable before the deposit proposal. Review the recent conversation, recheck slot availability, and send the booking proposal manually. No payment prompt was sent.');
          }
          return {
            reply: fallbackReply,
            outcome: {
              success: false,
              isFallback: true,
              failureReason: rateLimitType || String(error.message || error).slice(0, 200),
              circuitBreakerTrip: justTripped,
              circuitBreakerReason: justTripped ? 'Repeated failures in the reply pipeline' : undefined,
            },
          };
        }
      },
    },
  ];
}