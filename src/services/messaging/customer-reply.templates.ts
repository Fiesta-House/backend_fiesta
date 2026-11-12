import { applyEmojiPolicy, type EmojiContext } from '../agent/emoji-policy';

const LEGACY_WEBSITE = /https?:\/\/(?:www\.)?fiestahouseattire\.com(?:\/[^\s)\]}>,]*)?/gi;
const CANNED_OPENERS = /^(?:sure thing|absolutely|no worries|great question|perfect|i see(?:,|—|-)?\s*thanks for letting me know|thanks for letting me know)[!,.:\s-]*/i;

export function formatCustomerReply(reply: string, emojiContext?: EmojiContext): string {
  const source = emojiContext ? reply : reply.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '');
  const formatted = source
    .replace(LEGACY_WEBSITE, 'https://www.fiestahousematernity.com/')
    .replace(/\bFiesta AI\b/gi, 'Fiesta House')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(CANNED_OPENERS, '')
    .replace(/\bhow (?:can|may) i assist you\b/gi, 'how can I help you')
    .replace(/\bassist you today\b/gi, 'help you today')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return emojiContext ? applyEmojiPolicy(formatted, emojiContext) : formatted;
}

export const customerReplyTemplates = {
  bookingAwaitingConfirmation: () =>
    'I have the details ready. When you are happy with the date, time and deposit, reply yes and I will share the Till payment instructions.',

  rescheduleAwaitingConfirmation: () =>
    'I have the new time ready. Reply yes when you would like me to confirm the change.',

  paymentPending: () =>
    'The M-Pesa prompt is still waiting for payment. Once it goes through, I will confirm your session.',

  paymentFailed: (reason: string) =>
    formatCustomerReply(`Your deposit payment did not go through: ${reason.trim().replace(/[.\s]+$/, '')}. Your booking request is still held for 15 minutes. You can try again, or message us if you need help.`),

  appointmentReminder: (name: string, service: string, time: string) =>
    `Hi ${name}, your ${service} session is tomorrow at ${time}. Please arrive about 30 minutes early so there is time to get settled and ready. We look forward to seeing you.`,

  feedbackFollowUp: (name: string) =>
    `Hi ${name}, we wanted to check in after your session. How was the experience for you? We would really value your feedback.`,

  rescheduleConfirmed: (service: string, dateTime: string, depositForfeited = false) =>
    `Your ${service} session has been moved to ${dateTime}.${depositForfeited ? ' Because this change was made within 72 hours, your deposit has been forfeited according to our policy.' : ''}`,
};
