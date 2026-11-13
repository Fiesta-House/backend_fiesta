
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { mpesaService } from '../payment/mpesa.service';
import { DEFAULT_DURATION, SERVICE_DURATIONS } from '../../config/constants';
import { bookingDateFacts, businessDay, formatCustomerDate, inBusinessTimezone } from '../../utils/time';
import { buildBookingProposalConfirmation, formatCustomerTime } from './replies';
import { editionInText } from './reply-voice';
import { PAYMENT_PROMPT_UNRECORDED_REPLY } from './constants';
import { completeTillBooking } from './till-booking-confirmation';
import { paymentLapsed } from './slot-memory';

export const MAX_PAYMENT_ATTEMPTS = 3;
export const PAYMENT_PROMPT_TIMEOUT_MS = 2 * 60_000;
export const PAYMENT_HOLD_MS = 15 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;
export const STUDIO_CONTACT = '0720 111928';

export type PaymentSituationKind =
  | 'none'
  | 'prompt_sent'
  | 'prompt_stale'
  | 'cancelled'
  | 'failed'
  | 'hold_expired'
  | 'unrecorded'
  | 'paid';

export type PaymentMessageKind =
  | 'payment_details'
  | 'not_arrived'
  | 'paid_claim'
  | 'receipt'
  | 'status_check'
  | 'restart'
  | 'resend'
  | 'consent';

type DraftLike = {
  id: string;
  step: string;
  version?: number | null;
  updatedAt?: Date | string | null;
  service?: string | null;
  date?: string | null;
  time?: string | null;
};

type PaymentLike = {
  id: string;
  amount: number;
  phone: string;
  status: string;
  checkoutRequestId?: string | null;
  updatedAt?: Date | string | null;
};

export type PaymentSituation = {
  kind: PaymentSituationKind;
  draft: DraftLike | null;
  payment: PaymentLike | null;
  attempts: number;
  lapsed?: boolean;
  holdEndsAt: Date | null;
  promptAgeMs: number | null;
  paidBooking: { service: string; dateTime: Date } | null;
};

const timeOf = (value: Date | string | null | undefined): number | null => {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

// BookingDraft.version is bumped once per STK push, so attempts = version - 1.
export function draftVersion(
  draft: { version?: number | null } | null | undefined,
): number {
  return Number.isInteger(draft?.version) ? Number(draft?.version) : 1;
}

export function paymentAttempts(
  draft: DraftLike | null,
  payment: PaymentLike | null,
): number {
  return Math.max(draftVersion(draft) - 1, payment ? 1 : 0);
}

export function holdEndsAt(draft: DraftLike | null): Date | null {
  const updated = timeOf(draft?.updatedAt);
  return updated === null ? null : new Date(updated + PAYMENT_HOLD_MS);
}

export async function getPaymentSituation(
  customerId: string,
  now = Date.now(),
  includePaidBooking = true,
): Promise<PaymentSituation> {
  const draft = await prisma.bookingDraft.findUnique({
    where: { customerId },
  }) as DraftLike | null;

  const base = {
    draft,
    payment: null,
    attempts: 0,
    holdEndsAt: null,
    promptAgeMs: null,
    paidBooking: null,
  };

  if (draft?.step !== 'payment_pending') {
    if (draft || !includePaidBooking) {
      return { ...base, kind: 'none' };
    }

    const paid = await prisma.payment.findFirst({
      where: {
        status: 'success',
        booking: {
          customerId,
          status: 'confirmed',
          dateTime: { gte: new Date(now) },
        },
      },
      include: { booking: true },
      orderBy: { updatedAt: 'desc' },
    }) as (PaymentLike & {
      booking?: { service: string; dateTime: Date } | null;
    }) | null;

    return paid?.booking
      ? {
          ...base,
          kind: 'paid',
          payment: paid,
          paidBooking: {
            service: paid.booking.service,
            dateTime: paid.booking.dateTime,
          },
        }
      : { ...base, kind: 'none' };
  }

  const payment = await prisma.payment.findFirst({
    where: { bookingDraftId: draft.id },
  }) as PaymentLike | null;

  const hold = holdEndsAt(draft);
  const lapsed =
    paymentLapsed(draft, now) && payment?.status !== 'success';

  const situation = {
    ...base,
    payment,
    attempts: lapsed ? 0 : paymentAttempts(draft, payment),
    lapsed,
    holdEndsAt: hold,
  };

  if (payment?.status === 'success') {
    return { ...situation, kind: 'paid' };
  }

  if (hold && now > hold.getTime()) {
    return { ...situation, kind: 'hold_expired' };
  }

  const promptAt =
    timeOf(payment?.updatedAt) ?? timeOf(draft.updatedAt);

  const promptAgeMs =
    promptAt === null ? null : now - promptAt;

  if (!payment) {
    return promptAgeMs !== null &&
      promptAgeMs < PAYMENT_PROMPT_TIMEOUT_MS
      ? { ...situation, kind: 'prompt_sent', promptAgeMs }
      : { ...situation, kind: 'unrecorded', promptAgeMs };
  }

  if (payment.status === 'cancelled') {
    return { ...situation, kind: 'cancelled', promptAgeMs };
  }

  if (payment.status === 'failed') {
    return { ...situation, kind: 'failed', promptAgeMs };
  }

  return promptAgeMs !== null &&
    promptAgeMs < PAYMENT_PROMPT_TIMEOUT_MS
    ? { ...situation, kind: 'prompt_sent', promptAgeMs }
    : { ...situation, kind: 'prompt_stale', promptAgeMs };
}

export function describeDarajaResult(
  code: unknown,
): {
  status: 'cancelled' | 'failed';
  reason: string;
  waitFirst: boolean;
} {
  switch (Number(code)) {
    case 1032:
      return {
        status: 'cancelled',
        reason:
          'The M-Pesa prompt was cancelled on your phone, so no payment was taken.',
        waitFirst: false,
      };

    case 1:
      return {
        status: 'failed',
        reason:
          'M-Pesa reported insufficient funds, so no payment was taken.',
        waitFirst: false,
      };

    case 2001:
      return {
        status: 'failed',
        reason:
          'The M-Pesa PIN entered was not accepted, so no payment was taken.',
        waitFirst: false,
      };

    case 1019:
    case 1037:
      return {
        status: 'failed',
        reason:
          'The M-Pesa prompt timed out before it was completed, so no payment was taken.',
        waitFirst: false,
      };

    case 1001:
      return {
        status: 'failed',
        reason:
          'M-Pesa says another transaction is already in progress on your line, so no payment was taken.',
        waitFirst: true,
      };

    default:
      return {
        status: 'failed',
        reason:
          'M-Pesa could not complete the payment, so no payment was taken.',
        waitFirst: false,
      };
  }
}

const holdLine = (hold: Date | null) =>
  hold
    ? ` Your slot is held until ${inBusinessTimezone(hold).format('h:mm A')}.`
    : '';

const lastDigits = (phone: string) =>
  phone.replace(/\D/g, '').slice(-3);

export const paymentAttemptsExhaustedReply = () =>
  `I've sent the M-Pesa prompt a few times now, so I won't send another. Please check your M-Pesa line, or contact the studio team on ${STUDIO_CONTACT} to finish your booking.`;

const exhaustedText = paymentAttemptsExhaustedReply;

const resendOffer = (attempts: number) =>
  attempts >= MAX_PAYMENT_ATTEMPTS
    ? exhaustedText()
    : "Reply yes and I'll send a new one.";

const slotText = (draft: DraftLike) =>
  draft.date && draft.time
    ? `${businessDay(draft.date).format('dddd, D MMMM')} at ${formatCustomerTime(draft.time)}`
    : 'your requested time';

export function paymentFailureMessage(
  code: unknown,
  draft: DraftLike | null,
): string {
  const { reason, waitFirst } = describeDarajaResult(code);

  if (!draft) {
    return `${reason} The studio team will help you complete the payment.`;
  }

  const attempts = draftVersion(draft) - 1;

  const next =
    attempts >= MAX_PAYMENT_ATTEMPTS
      ? exhaustedText()
      : waitFirst
        ? "Please wait a minute, then reply yes and I'll send a new prompt."
        : "Reply yes and I'll send a new prompt.";

  return `${reason}${holdLine(holdEndsAt(draft))} ${next}`;
}

export function extractReceiptCode(message: string): string | null {
  const match = message.match(
    /\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{10}\b/i,
  );

  return match ? match[0].toUpperCase() : null;
}

export function isMpesaConfirmationText(message: string): boolean {
  const text = message.toLowerCase().replace(/[’`]/g, "'");

  return (
    /\b(?:confirmed|mpesa|m-pesa)\b/i.test(text) &&
    /\b(?:ksh|sent to|paid to|received|buy goods|till|670241|fiesta)\b/i.test(
      text,
    )
  );
}

export function classifyPaymentMessage(
  message: string,
): PaymentMessageKind | null {
  const text = message
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  if (/\b(?:cancel\w*|stop|reschedul\w*|postpone)\b/.test(text)) {
    return null;
  }

  // Receipt code or forwarded M-Pesa SMS.
  if (extractReceiptCode(message) || isMpesaConfirmationText(message)) {
    return 'receipt';
  }

  if (text.length > 160) return null;

  if (
    /\b(?:has ?n'?t|have ?n'?t|did ?n'?t|not|never|no|nothing)\b[^.?!]{0,30}\b(?:arriv\w*|c[ao]me|receiv\w*|got|gotten|get|pop\w*|show\w*|reach\w*|seen?)\b/.test(
      text,
    )
  ) {
    return 'not_arrived';
  }

  if (
    /\b(?:i|we)(?:'ve| have)? (?:already |just )?(?:paid|completed (?:the )?payment|entered (?:my |the )?pin|sent (?:you )?(?:the )?(?:money|payment|deposit|cash))\b|\balready paid\b|\bdone paying\b|\bpayment (?:is )?(?:done|made|complete[d]?)\b/.test(
      text,
    )
  ) {
    return 'paid_claim';
  }

  if (
    /\b(?:did|has|have|was|is)\b[^?]{0,25}\b(?:go(?:ne)? through|went through|successful|received|reflect\w*)\b|\bpayment status\b|\bdid you (?:get|receive)\b/.test(
      text,
    )
  ) {
    return 'status_check';
  }

  if (/\b(?:start (?:again|over|afresh)|begin again|from scratch)\b/.test(text)) {
    return 'restart';
  }

  if (/\b(?:no|not|don'?t|do not|wait|hold on|later)\b/.test(text)) {
    return null;
  }

  if (
    /\b(?:payment details?|payment options?|till number|paybill number)\b/.test(
      text,
    ) ||
    /\b(?:what\s+(?:is|are)\s+(?:the\s+)?(?:payment\s+details?|till\s+number|paybill\s+number|m-?pesa\s+number)|where\s+(?:do|should|can)\s+i\s+pay|how\s+(?:do|can)\s+i\s+pay|which\s+(?:till|paybill|number)\s+(?:should|do)\s+i\s+use)\b/.test(
      text,
    )
  ) {
    return 'payment_details';
  }

  if (
    /\bwhere\s+(?:(?:am|are|will)\s+i\s+)?(?:(?:supposed|meant)\s+to\s+)?(?:send|sending|pay|paying)\b[^?!.]{0,60}\b(?:money|deposit|payment|it|that)\b|\bwhere\s+(?:do|should|can)\s+i\s+send\b/.test(
      text,
    )
  ) {
    return 'payment_details';
  }

  if (
    /\bre-?send\b|\bre-?try\b|\btry (?:it |that |this )?again\b|\b(?:send|do|push) (?:it |that |this |the prompt |the payment |the request )?again\b|\b(?:one more|last|another) time\b|\bnew (?:prompt|one|request)\b/.test(
      text,
    )
  ) {
    return 'resend';
  }

  if (
    /^(?:yes+|yeah|yep|yea|ndio|confirm(?:ed)?|go[\s-]?ahead|proceed|please do|sure)\b/.test(
      text,
    ) ||
    /\b(?:finish|complete|make|do) (?:the |my |this )?payment\b|\bsend (?:it|the prompt)\b|\bpay (?:now|it|the deposit)\b|^(?:let'?s|let us) do it(?: then)?$/.test(
      text,
    )
  ) {
    return 'consent';
  }

  return null;
}

function promptSentReply(
  s: PaymentSituation,
  phoneFallback: string,
  alreadySent: boolean,
): string {
  const amount = s.payment
    ? `Ksh ${s.payment.amount.toLocaleString()}`
    : 'the Ksh 2,000 deposit';

  return `To complete your booking, please pay ${amount} via Lipa na M-Pesa: Buy Goods Till Number 670241 (Fiesta House Maternity). Once paid, please paste or forward the M-Pesa confirmation message here and a team member will confirm your booking.`;
}

function situationReply(
  s: PaymentSituation,
  customerId: string,
): string {
  switch (s.kind) {
    case 'prompt_sent':
      return promptSentReply(s, customerId, false);

    case 'prompt_stale':
      return promptSentReply(s, customerId, false);

    case 'cancelled':
      return `That booking request was not completed.${holdLine(s.holdEndsAt)} ${resendOffer(s.attempts)}`;

    case 'failed':
      return `Payment was not completed.${holdLine(s.holdEndsAt)} ${resendOffer(s.attempts)}`;

    case 'hold_expired':
      return s.attempts >= MAX_PAYMENT_ATTEMPTS
        ? exhaustedText()
        : s.lapsed && s.draft?.service
          ? `Your earlier request for ${editionInText(s.draft.service)} on ${slotText(s.draft)} was not paid, so nothing is booked yet. Reply yes and I'll check the slot is still free, or tell me what you'd like instead.`
          : "Your 15-minute hold on this slot has ended and I can't see a payment. Reply yes and I'll check the slot is still free.";

    case 'unrecorded':
      return PAYMENT_PROMPT_UNRECORDED_REPLY;

    default:
      return paidReply(s);
  }
}

function paidReply(s: PaymentSituation): string {
  if (!s.paidBooking) {
    return "Your payment has been received. I'm confirming your booking now and will send the details shortly.";
  }

  const when = inBusinessTimezone(s.paidBooking.dateTime);

  return `Your payment is confirmed and your session for ${editionInText(s.paidBooking.service)} on ${when.format('dddd, D MMMM YYYY')} at ${when.format('h:mm A')} is booked.`;
}

function notArrivedReply(
  s: PaymentSituation,
  customerId: string,
): string {
  if (s.kind !== 'prompt_sent' && s.kind !== 'prompt_stale') {
    return situationReply(s, customerId);
  }

  const digits = lastDigits(s.payment?.phone || customerId);

  return `I can't verify that a prompt reached your phone. Make sure your phone is on with good signal for the number ending ${digits}. Reply resend to try again, pay via Lipa na M-Pesa: Buy Goods Till Number 670241, or call the studio team on ${STUDIO_CONTACT}.${holdLine(s.holdEndsAt)}`;
}

async function escalateAttemptsExhausted(
  this: any,
  customerId: string,
  s: PaymentSituation,
): Promise<string> {
  const context = s.draft
    ? `${s.draft.service || 'the booking'} on ${s.draft.date || 'unknown date'} ${s.draft.time || ''}`
    : 'the booking';

  await this.escalate(
    customerId,
    'booking',
    `Payment prompt limit reached (${MAX_PAYMENT_ATTEMPTS} M-Pesa prompts) for ${context}. Contact the customer to finish the booking.`,
  );

  return paymentAttemptsExhaustedReply();
}

async function recheckExpiredHold(
  this: any,
  customerId: string,
  s: PaymentSituation,
): Promise<string> {
  const draft = s.draft;

  if (!draft || !draft.date || !draft.service) {
    return 'Your hold has ended. What date would you like for your session?';
  }

  if (bookingDateFacts(draft.date).isPast) {
    await prisma.bookingDraft.update({
      where: { id: draft.id },
      data: {
        step: 'collecting_slots',
        date: null,
        time: null,
        dateTimeIso: null,
        version: 1,
      },
    }).catch(() => null);

    return 'Your earlier request has lapsed, and no payment was taken. Which date would you like now?';
  }

  const duration = SERVICE_DURATIONS[draft.service] || DEFAULT_DURATION;

  const availableSlotsResult = await bookingService.getAvailableSlots(
    draft.date,
    duration,
    undefined,
    draft.id,
  ).catch(() => [] as string[]);

  if (!Array.isArray(availableSlotsResult)) {
    const availabilityFailure = availableSlotsResult as {
      status?: string;
      reason?: string;
    };

    console.warn(
      '[PAYMENT_RECOVERY] Availability lookup returned a failure result:',
      {
        status: availabilityFailure.status,
        reason: availabilityFailure.reason,
      },
    );

    throw new Error(
      availabilityFailure.reason ||
        'Could not retrieve available slots for payment recovery.',
    );
  }

  const availableSlots: string[] = availableSlotsResult;

  if (draft.time && availableSlots.includes(draft.time)) {
    await prisma.bookingDraft.update({
      where: { id: draft.id },
      data: {
        step: 'awaiting_confirmation',
        version: 1,
      },
    }).catch(() => null);

    const pkg = await prisma.package.findUnique({
      where: { name: draft.service },
    }).catch(() => null);

    const deposit = pkg?.deposit || 2000;

    return `Your 15-minute hold ended, but ${formatCustomerTime(draft.time)} on ${businessDay(draft.date).format('dddd, D MMMM YYYY')} is still free. The deposit is Ksh ${deposit.toLocaleString()}. Reply yes to confirm your booking details and receive payment instructions.`;
  }

  await prisma.bookingDraft.update({
    where: { id: draft.id },
    data: {
      step: 'collecting_slots',
      time: null,
      dateTimeIso: null,
    },
  }).catch(() => null);

  const slotList = availableSlots.length > 0
    ? `available times on ${formatCustomerDate(draft.date)} are ${availableSlots.map(formatCustomerTime).join(', ')}`
    : `there are no available slots left on ${formatCustomerDate(draft.date)}`;

  return `That slot is no longer available. For the ${editionInText(draft.service)}, ${slotList}. Which time would suit you?`;
}

async function resendPrompt(
  this: any,
  customerId: string,
  s: PaymentSituation,
): Promise<string> {
  if (s.attempts >= MAX_PAYMENT_ATTEMPTS) {
    return escalateAttemptsExhausted.call(this, customerId, s);
  }

  const amount = s.payment
    ? `Ksh ${s.payment.amount.toLocaleString()}`
    : 'the deposit';

  return `We do not send automated phone prompts. Please pay ${amount} via Lipa na M-Pesa: Buy Goods Till Number 670241 (Fiesta House Maternity). Once paid, please paste or forward the M-Pesa confirmation message here and a team member will confirm your booking.`;
}

async function handlePaidClaim(
  this: any,
  customerId: string,
  message: string,
  s: PaymentSituation,
): Promise<string> {
  const code = extractReceiptCode(message);
  const isMessage = isMpesaConfirmationText(message);
  const draft = s.draft;

  const context = draft
    ? `${draft.service || 'booking'} on ${draft.date || 'unknown date'} ${draft.time || ''}`
    : 'no open booking draft';

  if (!code && !isMessage) {
    await this.escalate(
      customerId,
      'booking',
      `Customer says they paid for ${context}, but no receipt or confirmation message was provided. Receipt code requested; do not confirm until verified.`,
    );

    return "I can't see the payment yet. If you have the M-Pesa confirmation message, please share the receipt code and the team will verify it.";
  }

  if (s.payment && code) {
    await prisma.payment.update({
      where: { id: s.payment.id },
      data: {
        mpesaReceipt: code,
        updatedAt: new Date(),
      },
    }).catch((err) =>
      console.error('Failed to save receipt on payment:', err),
    );
  }

  await this.escalate(
    customerId,
    'booking',
    code
      ? `Customer shared M-Pesa receipt ${code} for ${context}. Verify the payment and confirm the booking. Message: "${message.slice(0, 300)}"`
      : `Customer shared M-Pesa confirmation message for ${context}. Verify the payment and confirm the booking. Message: "${message.slice(0, 300)}"`,
  );

  return code
    ? `Thank you! I've passed receipt ${code} to the studio team to verify. A team member will verify your payment and confirm your booking shortly.`
    : "Thank you! I've received your M-Pesa confirmation message. A team member will verify your payment and confirm your booking shortly.";
}

export async function handlePaymentRecovery(
  this: any,
  customerId: string,
  message: string,
  forcedKind?: PaymentMessageKind,
): Promise<string | null> {
  const kind = forcedKind || classifyPaymentMessage(message);

  if (!kind) return null;

  // Till payment flow: customer has received payment instructions
  // and is now submitting their M-Pesa receipt.
  if (kind === 'receipt' && extractReceiptCode(message)) {
    const tillReply = await completeTillBooking(customerId, message);

    if (tillReply) {
      return tillReply;
    }
  }

  const aboutPayment =
    kind === 'status_check' ||
    kind === 'paid_claim' ||
    kind === 'payment_details' ||
    /\b(?:pa(?:y|id|yment)\w*|m-?pesa|prompt|stk|deposit)\b/i.test(message);

  const s = await getPaymentSituation(
    customerId,
    Date.now(),
    aboutPayment,
  );

  if (s.draft?.step !== 'payment_pending') {
    if (s.kind === 'paid') {
      return paidReply(s);
    }

    if (kind === 'payment_details') {
      return 'The official payment method for Fiesta House Maternity is Lipa na M-Pesa Buy Goods Till Number 670241. Please use only the deposit amount confirmed for your selected edition; if you have not received the exact amount, confirm it with the studio team before paying. Your booking is confirmed only after the deposit is received and verified.';
    }

    return kind === 'paid_claim' && !s.draft
      ? handlePaidClaim.call(this, customerId, message, s)
      : null;
  }

  if (s.kind === 'paid') {
    return paidReply(s);
  }

  switch (kind) {
    case 'paid_claim':
    case 'receipt':
      return handlePaidClaim.call(this, customerId, message, s);

    case 'payment_details': {
      if (s.kind === 'hold_expired') {
        return situationReply(s, customerId);
      }

      const amount =
        s.payment && Number.isFinite(s.payment.amount)
          ? `Ksh ${s.payment.amount.toLocaleString()}`
          : 'the deposit amount confirmed in your booking proposal';

      return `To complete your booking, please pay ${amount} via Lipa na M-Pesa: Buy Goods Till Number 670241 (Fiesta House Maternity). Once paid, please paste or forward the M-Pesa confirmation message here and a team member will confirm your booking.`;
    }

    case 'status_check':
      return situationReply(s, customerId);

    case 'not_arrived':
      return notArrivedReply(s, customerId);

    case 'restart':
      if (s.kind === 'prompt_sent' || s.kind === 'unrecorded') {
        return situationReply(s, customerId);
      }

      return s.attempts >= MAX_PAYMENT_ATTEMPTS
        ? exhaustedText()
        : `Your booking for ${editionInText(s.draft?.service || '')} on ${slotText(s.draft!)} is still open. Reply yes and I'll send a new M-Pesa prompt. If you'd like to change the booking instead, the studio team can help on ${STUDIO_CONTACT}.`;

    default:
      if (s.kind === 'unrecorded') {
        return PAYMENT_PROMPT_UNRECORDED_REPLY;
      }

      if (s.kind === 'hold_expired') {
        return recheckExpiredHold.call(this, customerId, s);
      }

      if (
        s.kind === 'prompt_sent' &&
        (kind === 'consent' ||
          (s.promptAgeMs ?? 0) < RESEND_COOLDOWN_MS)
      ) {
        return promptSentReply(s, customerId, true);
      }

      return resendPrompt.call(this, customerId, s);
  }
}
