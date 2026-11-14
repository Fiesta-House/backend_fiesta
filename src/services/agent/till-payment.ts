
/**
 * Till (Buy Goods) payment settings and helpers.
 * The customer pays outside the chat, then sends her M-Pesa confirmation.
 * Nothing is ever pushed to her phone.
 */
export const TILL_NUMBER =
  process.env.MPESA_TILL_NUMBER?.trim() || '670241';

export const TILL_NAME =
  process.env.MPESA_TILL_NAME?.trim() || 'Fiesta House Maternity';

/**
 * While her draft waits for the M-Pesa message, only these routes may answer;
 * everything else is left to the model so a pasted message is never hijacked
 * by an invoice, date or fact route.
 */
export const PAYMENT_MESSAGE_ROUTES = new Set([
  'runAgent',
  'cancellationProposal',
  'cancellationDeclined',
  'staleCancellationProposal',
  'bookingStatus',
  'customerName',
]);

export type ParsedMpesaMessage = {
  code: string | null;
  amount: number | null;
  recipient: string | null;
  paidOn: string | null;
  paidAt: string | null;
};

// M-Pesa transaction codes are 10 characters mixing letters and digits.
const CODE_PATTERN =
  /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10}\b/i;

/**
 * Reads what it can from a pasted M-Pesa confirmation.
 */
export function parseMpesaMessage(text: string): ParsedMpesaMessage {
  const message = String(text || '');

  const code =
    message.match(CODE_PATTERN)?.[0]?.toUpperCase() ?? null;

  const amountMatch = message.match(
    /\bKsh\.?\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const amount = amountMatch
    ? Number(amountMatch[1].replace(/,/g, ''))
    : null;

  const recipient =
    message.match(
      /\b(?:paid|sent) to\s+([A-Za-z0-9&' -]+?)(?:\.|\s+on\s|\s+\d{9,}|\s+for account|$)/i
    )?.[1]?.trim() ?? null;

  const when = message.match(
    /\bon\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i
  );

  return {
    code,
    amount: amount !== null && Number.isFinite(amount) ? amount : null,
    recipient,
    paidOn: when?.[1] ?? null,
    paidAt: when?.[2]?.toUpperCase() ?? null,
  };
}

/**
 * Confirms that a message looks like an outgoing Buy Goods payment
 * to the configured Fiesta House Till.
 *
 * A transaction code alone is not proof of payment.
 * Incoming transfers ("received from") are never accepted.
 */
export function isValidTillPayment(text: string): boolean {
  const message = String(text || '').trim();

  if (!message) return false;

  const parsed = parseMpesaMessage(message);

  // A transaction code is needed to record and identify the receipt.
  if (!parsed.code) return false;

  const normalisedMessage = message
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const containsFiesta = normalisedMessage.includes('fiesta');
  const containsTill = normalisedMessage.includes(
    TILL_NUMBER.replace(/\D/g, '')
  );

  return containsFiesta && containsTill;
}
