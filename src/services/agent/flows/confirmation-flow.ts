import dayjs from 'dayjs';
import prisma from '../../../config/prisma';
import {
  TILL_NAME,
  TILL_NUMBER,
} from '../till-payment';
import {
  PAYMENT_CONFIRMATION_REQUIRED_REPLY,
  BOOKING_SLOT_UNAVAILABLE,
  PAYMENT_ALREADY_PENDING,
} from '../constants';
import { EARLY_SLOT_STEP } from '../slot-memory';
import { editionInText } from '../reply-voice';
import { businessDay } from '../../../utils/time';
import { customerReplyTemplates } from '../../messaging/customer-reply.templates';
import {
  executeConfirmBookingTool,
  executeConfirmRescheduleTool,
  executeConfirmCancellationTool,
  getCancellationCompletionReply,
  getPackageForDeposit,
  getDepositForPackage,
} from '../booking-tools';
import { getBookingStatusReply as buildBookingStatusReply } from '../appointment-replies';
import { handlePaymentRecovery, type PaymentMessageKind } from '../payment-recovery';
import {
  hasPendingCancellationProposal,
  isCancellationProposalExpired,
  isCancellationConfirmation,
} from './cancellation-flow';
import { notifyRescheduleAdmin } from '../helpers/resilience-handlers';
import { isOnlyEmojis } from '../emoji-policy';
import { previousMessageRequestsConfirmation as matchesConfirmationRequest } from '../replies';

export function isExplicitConfirmation(userMessage: string): boolean {
  const normalized = userMessage
    .trim()
    .toLowerCase()
    .replace(/[!?.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized || normalized.length > 40) return false;

  // Guard against ambiguous/negative replies that should not auto-confirm.
  if (/\b(no|not|don't|dont|cancel|wait|hold)\b/.test(normalized)) return false;

  const confirmations = new Set([
    'yes', 'y', 'yep', 'yeah', 'yess', 'yesss',
    'ok', 'okay', 'confirm', 'confirmed',
    'go ahead', 'go-ahead', 'proceed', 'continue',
    'lets do it', "let's do it", 'lets do it then', "let's do it then", 'let us do it then',
    'that works', 'works for me', 'that one', 'same one', 'lets do that', "let's do that", 'let us do that',
    'sawa', 'ndio'
  ]);

  if (confirmations.has(normalized)) return true;

  // Accept short natural affirmations like "yes that works for me" or
  // "yess that one" for pending booking/reschedule drafts.
  return [
    /^yes+s?\b/,
    /^yep\b/,
    /^yeah\b/,
    /^ok(ay)?\b/,
    /^confirm(ed)?\b/,
    /^go[\s-]?ahead\b/,
    /^that works\b/,
    /^works for me\b/,
    /^that one\b/,
    /^same one\b/,
    /^let'?s do that\b/,
    /^let us do that\b/
  ].some((pattern) => pattern.test(normalized));
}

export function previousMessageRequestsConfirmation(
  history: { role: 'user' | 'assistant', content: string }[]
): boolean {
  return matchesConfirmationRequest(history);
}

export function isPostActionAcknowledgement(
  userMessage: string,
  history: { role: 'user' | 'assistant', content: string }[]
): boolean {
  if (isOnlyEmojis(userMessage) && history.length > 0) {
    return true;
  }
  const normalized = userMessage.trim().toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  const isAcknowledgement = /^(?:ok|okay|thanks|thank you(?: so much)?|got it|sawa|alright|perfect|great|all good|noted|noted\s+thanks|noted\s+thank\s+you|asante|asante\s+sana|(?:i\s+(?:will|would|'ll)\s+)?appreciate(?:\s+(?:it|that))?|much\s+appreciated|appreciated)(?:\s+(?:thanks|thank you))?$/.test(normalized);
  if (!isAcknowledgement) return false;

  const awaitingConfirmation = previousMessageRequestsConfirmation(history);
  const includesThanks = /\b(thanks|thank you|appreciate|appreciated)\b/.test(normalized);
  if (awaitingConfirmation && !includesThanks && /^(?:ok|okay|alright|sawa)$/.test(normalized)) return false;
  const lastAssistantText = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
  if (/\bpayment link\b|\bi['’]ll send you\b|\breserved the\b|\bi['’]ve reserved\b/i.test(lastAssistantText)) return false;

  return true;
}

/** Sending an M-Pesa prompt needs an explicit yes/yeah/yep/ndio/confirm/go ahead/proceed; "ok" or "sawa" is not enough. */
export function isPaymentConfirmation(userMessage: string): boolean {
  const normalized = userMessage.trim().toLowerCase().replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ');
  if (/\b(no|not|don't|dont|cancel|wait|hold)\b/.test(normalized)) return false;
  return /\b(?:yes+|yeah|yep|ndio|confirm(?:ed)?|go[\s-]?ahead|proceed)\b/.test(normalized)
    || /^(?:let['’]?s|let us) do it(?: then)?$/.test(normalized.trim());
}

export function getDepositAmountFromProposalHistory(
  history: { role: 'user' | 'assistant'; content: string }[]
): number | null {
  const previousAssistantMessage = [...history].reverse().find((message) => message.role === 'assistant')?.content || '';
  const match = previousAssistantMessage.match(/\bdeposit\s+is\s+KSH\s+([\d,]+)/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isInteger(amount) && amount > 0 ? amount : null;
}

export async function tryImmediateConfirmation(
  this: any,
  customerId: string,
  userMessage = '',
  history: { role: 'user' | 'assistant'; content: string }[] = []
): Promise<string | null> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (!draft?.step) return null;

  const prevRequestsConfirmation = (
    this?.previousMessageRequestsConfirmation
      ? this.previousMessageRequestsConfirmation(history)
      : previousMessageRequestsConfirmation(history)
  );

  if (
    ['reschedule_confirm', 'cancel_confirm'].includes(draft.step) &&
    !prevRequestsConfirmation
  ) {
    return null;
  }

  const checkIsPaymentConfirmation = (msg: string) => (
    this?.isPaymentConfirmation
      ? this.isPaymentConfirmation(msg)
      : isPaymentConfirmation(msg)
  );

  if (draft.step === 'payment_pending') {
    const consent = !userMessage || checkIsPaymentConfirmation(userMessage);
    if (this?.getPaymentRecoveryReply) {
      return this.getPaymentRecoveryReply(
        customerId,
        userMessage,
        consent ? 'consent' : 'status_check'
      );
    }
    return handlePaymentRecovery.call(
      this,
      customerId,
      userMessage,
      consent ? 'consent' : 'status_check'
    );
  }

  const getPackage = (pkgName?: string) => (
    this?.getPackageForDeposit
      ? this.getPackageForDeposit(pkgName)
      : getPackageForDeposit(pkgName)
  );

  const getDeposit = (pkg: any) => (
    this?.getDepositForPackage
      ? this.getDepositForPackage(pkg)
      : getDepositForPackage(pkg)
  );

  const getStatusReply = (cId: string) => (
    this?.getBookingStatusReply
      ? this.getBookingStatusReply(cId)
      : buildBookingStatusReply(cId)
  );

  // The customer has already accepted the proposal.
  // Repeat the payment instructions without attempting confirmation again.
  if (draft.step === 'awaiting_payment_message') {
    const pkg = await getPackage(draft.service || undefined);
    const deposit = getDeposit(pkg);

    return `To complete your booking for ${draft.service} on ${draft.date} at ${draft.time}, please pay the deposit of Ksh ${deposit.toLocaleString()} via Lipa na M-Pesa: Buy Goods Till Number ${TILL_NUMBER} (${TILL_NAME}). Once paid, please paste or forward the M-Pesa confirmation message or transaction code here. The team will verify your payment and confirm your session.`;
  }

  if (draft.step === 'awaiting_confirmation') {
    if (!checkIsPaymentConfirmation(userMessage)) {
      return PAYMENT_CONFIRMATION_REQUIRED_REPLY;
    }

    const expectedDeposit = (
      this?.getDepositAmountFromProposalHistory
        ? this.getDepositAmountFromProposalHistory(history)
        : getDepositAmountFromProposalHistory(history)
    );

    if (
      expectedDeposit === null ||
      !prevRequestsConfirmation
    ) {
      return getStatusReply(customerId);
    }

    try {
      const result = await (
        this?.executeConfirmBookingTool
          ? this.executeConfirmBookingTool(customerId, 'awaiting_confirmation', expectedDeposit)
          : executeConfirmBookingTool.call(this, customerId, 'awaiting_confirmation', expectedDeposit)
      );

      // Confirmation of the proposal is recorded, but payment is still outstanding.
      return `To complete your booking for ${result.service} on ${result.date} at ${result.time}, please pay the deposit of Ksh ${result.depositAmount.toLocaleString()} via Lipa na M-Pesa: Buy Goods Till Number ${result.till} (${result.tillName}). Once paid, please paste or forward the M-Pesa confirmation message or transaction code here. The team will verify your payment and confirm your session.`;
    } catch (error: any) {
      if (error?.code === BOOKING_SLOT_UNAVAILABLE) {
        const sameProposal = (candidate: any) =>
          candidate?.id === draft.id &&
          candidate?.step === 'awaiting_confirmation' &&
          candidate?.service === draft.service &&
          candidate?.date === draft.date &&
          candidate?.time === draft.time;

        let currentDraft = await prisma.bookingDraft.findUnique({
          where: { customerId },
        });

        // Retry once if a concurrent update changed only the draft version.
        for (let attempt = 0; attempt < 2; attempt++) {
          if (
            !currentDraft ||
            !sameProposal(currentDraft) ||
            !Number.isInteger(currentDraft.version)
          ) {
            break;
          }

          const released = await prisma.bookingDraft.updateMany({
            where: {
              id: currentDraft.id,
              step: 'awaiting_confirmation',
              version: currentDraft.version,
              service: draft.service,
              date: draft.date,
              time: draft.time,
            },
            data: {
              step: EARLY_SLOT_STEP,
              time: null,
              dateTimeIso: null,
              version: currentDraft.version + 1,
            },
          });

          if (released.count === 1) {
            const edition = editionInText(draft.service || 'session');
            const dateLabel = businessDay(draft.date).format('dddd, D MMMM');
            return `That time is no longer available for your ${edition} on ${dateLabel}. What time would work for you instead?`;
          }

          currentDraft = await prisma.bookingDraft.findUnique({
            where: { customerId },
          });
        }

        // A concurrent request may already have advanced the booking.
        if (currentDraft?.step === 'awaiting_payment_message') {
          const pkg = await getPackage(
            currentDraft.service || undefined
          );
          const deposit = getDeposit(pkg);

          return `To complete your booking for ${currentDraft.service} on ${currentDraft.date} at ${currentDraft.time}, please pay the deposit of Ksh ${deposit.toLocaleString()} via Lipa na M-Pesa: Buy Goods Till Number ${TILL_NUMBER} (${TILL_NAME}). Once paid, please paste or forward the M-Pesa confirmation message or transaction code here. The team will verify your payment and confirm your session.`;
        }

        if (currentDraft?.step === 'payment_pending') {
          if (this?.getPaymentRecoveryReply) {
            return this.getPaymentRecoveryReply(
              customerId,
              userMessage,
              'status_check'
            );
          }
          return handlePaymentRecovery.call(
            this,
            customerId,
            userMessage,
            'status_check'
          );
        }

        // Never repeat the stale proposal if its guarded release did not succeed.
        if (sameProposal(currentDraft)) {
          return 'That time is no longer available. What time would work for you instead?';
        }

        return (await getStatusReply(customerId)) ||
          'That time is no longer available. What time would work for you instead?';
      }

      if (error?.code !== PAYMENT_ALREADY_PENDING) {
        throw error;
      }

      // Another request may already have moved the draft forward.
      // Re-read the state and return payment instructions without confirming again.
      const currentDraft = await prisma.bookingDraft.findUnique({
        where: { customerId },
      });

      if (currentDraft?.step === 'awaiting_payment_message') {
        const pkg = await getPackage(
          currentDraft.service || undefined
        );
        const deposit = getDeposit(pkg);

        return `To complete your booking for ${currentDraft.service} on ${currentDraft.date} at ${currentDraft.time}, please pay the deposit of Ksh ${deposit.toLocaleString()} via Lipa na M-Pesa: Buy Goods Till Number ${TILL_NUMBER} (${TILL_NAME}). Once paid, please paste or forward the M-Pesa confirmation message or transaction code here. The team will verify your payment and confirm your session.`;
      }

      throw error;
    }
  }

  if (
    draft.step === 'reschedule_confirm' &&
    prevRequestsConfirmation
  ) {
    const result = await (
      this?.executeConfirmRescheduleTool
        ? this.executeConfirmRescheduleTool(customerId, 'reschedule_confirm')
        : executeConfirmRescheduleTool.call(this, customerId, 'reschedule_confirm')
    );

    const notifyAdmin = (params: any) => (
      this?.notifyRescheduleAdmin
        ? this.notifyRescheduleAdmin(params)
        : notifyRescheduleAdmin(params)
    );

    void notifyAdmin({
      customerId,
      event: 'confirmed',
      service: result.service,
      oldDateTime: result.oldDateTime,
      newDateTime: result.newDateTime,
    });

    return customerReplyTemplates.rescheduleConfirmed(
      result.service,
      dayjs(result.newDateTime).format('dddd, MMMM D, YYYY [at] h:mm A'),
      result.depositForfeited
    );
  }

  if (draft.step === 'cancel_confirm') {
    if (!hasPendingCancellationProposal(history)) {
      await prisma.bookingDraft.deleteMany({
        where: { customerId, step: 'cancel_confirm' },
      });
      return null;
    }

    if (isCancellationProposalExpired(draft)) {
      await prisma.bookingDraft.deleteMany({
        where: { customerId, step: 'cancel_confirm' },
      });

      return 'That cancellation proposal expired, so your booking was not changed. If you still want to cancel it, please ask again.';
    }

    if (!isCancellationConfirmation(userMessage)) {
      return 'Please reply yes, yeah, yep, ndio, or confirm if you want me to cancel this booking. Ok, okay, and sawa do not confirm a cancellation.';
    }

    const result = await (
      this?.executeConfirmCancellationTool
        ? this.executeConfirmCancellationTool(customerId, draft.step)
        : executeConfirmCancellationTool.call(this, customerId, draft.step)
    );

    return (
      this?.getCancellationCompletionReply
        ? this.getCancellationCompletionReply(result)
        : getCancellationCompletionReply(result)
    );
  }

  return null;
}
