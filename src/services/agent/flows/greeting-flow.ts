import prisma from '../../../config/prisma';
import {
  bookingDateFacts,
  formatCustomerDate,
  nowInBusinessTimezone,
} from '../../../utils/time';
import {
  buildBusinessIntroductionReply,
  buildAboutBusinessReply,
} from '../replies';
import { isBusinessIdentityQuestion } from '../conversation-flow.matcher';
import { editionInText } from '../reply-voice';
import { earlySlotsExpired } from '../slot-memory';
import { handlePaymentRecovery } from '../payment-recovery';

export function isAskingIfHuman(message: string): boolean {
  const text = message.toLowerCase().replace(/[’`]/g, "'");
  return /\b(?:are|r)\s+(?:you|u)\s+(?:a\s+|an\s+)?(?:real\s+|actual\s+|live\s+)?(?:human|person|bot|robot|ai|machine|chatbot|computer)\b/.test(text)
    || /\b(?:am i|is this)\s+(?:talking\s+(?:to|with)\s+|speaking\s+(?:to|with)\s+|chatting\s+(?:to|with)\s+)?(?:a\s+|an\s+)?(?:real\s+|actual\s+)?(?:human|person|bot|robot|ai|chatbot)\b/.test(text)
    || /\bwho\s+am\s+i\s+(?:talking|speaking|chatting)\s+(?:to|with)\b/.test(text)
    || /\bwewe\s+ni\s+(?:mtu|roboti|bot)\b/.test(text);
}

export function isTimeOfDayGreeting(message: string): boolean {
  return /^\s*(?:good\s+(?:morning|afternoon|evening)|habari(?:\s+ya\s+(?:asubuhi|mchana|jioni))?|hujambo|mambo|niaje|sasa)(?:\s+(?:there|team|fiesta(?:\s+house)?|everyone|all))?[\s!.,?]*$/i.test(message);
}

export function isCasualGreeting(message: string): boolean {
  const lines = message
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return false;

  return lines.every(line =>
    /^(?:hi+|hello+|hey+|hallo)(?:\s+(?:there|you|team|fiesta(?:\s+house)?|everyone|all))?[\s!.,?]*$/i.test(line)
  );
}

export function openingGreeting(message: string): string | null {
  const text = message.toLowerCase();
  const timed = text.match(/\bgood\s+(morning|afternoon|evening)\b/);
  if (timed) {
    const hour = nowInBusinessTimezone().hour();
    const currentPeriod = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : 'evening';
    return `Good ${currentPeriod}`;
  }
  if (/^\s*(?:habari|hujambo|mambo|niaje|sasa)\b/.test(text)) return 'Habari';
  if (/^\s*(?:hi+|hello+|hey+|hallo)\b/.test(text)) return 'Hello';
  return null;
}

export function getBusinessIntroductionReply(userMessage = ''): string {
  return isBusinessIdentityQuestion(userMessage) ? buildBusinessIntroductionReply() : buildAboutBusinessReply();
}

/**
 * True when the drafted slot has already started.
 * Date-only drafts are treated as past only on earlier days.
 */
export function isDraftSlotPast(draft: { date?: string | null; time?: string | null }): boolean {
  if (!draft.date) return false;
  if (bookingDateFacts(draft.date).isPast) return true;
  if (!draft.time) return false;
  const now = nowInBusinessTimezone();
  return draft.date === now.format('YYYY-MM-DD') && draft.time <= now.format('HH:mm');
}

export async function getGreetingReply(
  customerId: string,
  history: Array<{ role: string; content: string }> = [],
  naturalAssistantMode = false
): Promise<string | null> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (draft?.step === 'payment_pending') {
    if (isDraftSlotPast(draft)) {
      await prisma.bookingDraft.deleteMany({ where: { id: draft.id, step: 'payment_pending' } });
    } else {
      const reminderCount = history.filter(
        m => m.role === 'assistant' && (
          /was not paid, so nothing is booked yet/i.test(m.content) ||
          /is still waiting/i.test(m.content)
        )
      ).length;

      if (reminderCount === 1) {
        const editionTitle = draft.service
          ? editionInText(draft.service).replace(/^the\s+/i, '').replace(/\s+edition$/i, '').trim()
          : 'session';
        const dayText = draft.date ? formatCustomerDate(draft.date) : 'your requested date';
        return `Good to hear from you. Your ${editionTitle} request for ${dayText} is still waiting. Shall I check the slot?`;
      }

      if (reminderCount >= 2) {
        const editionLabel = draft.service ? editionInText(draft.service) : 'your session';
        const dayText = draft.date ? formatCustomerDate(draft.date) : 'your requested date';
        return `Good to hear from you. Your earlier request for ${editionLabel} on ${dayText} is still waiting, but nothing was booked or paid. Would you like me to clear it and start fresh, or check that slot for you?`;
      }

      const status = await handlePaymentRecovery(customerId, 'hello', 'status_check');
      if (status) return `Welcome back. ${status}`;
    }
  }
  // A profile name alone is not booking progress.
  if (draft && !earlySlotsExpired(draft) && (draft.service || draft.date || draft.time)) {
    if (isDraftSlotPast(draft)) {
      await prisma.bookingDraft.updateMany({
        where: { id: draft.id, step: draft.step },
        data: { date: null, time: null, dateTimeIso: null },
      });
    } else {
      return null;
    }
  }
  try {
    const upcoming = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
      select: { id: true },
    });
    if (upcoming) return 'Welcome back. How can I help with your session?';
  } catch {
    console.warn('[AGENT_FLOW] Greeting booking lookup failed; using the general welcome.');
  }
  if (history.length > 0) {
    if (naturalAssistantMode) {
      return null;
    }
    return 'Welcome back! How can I help you today?';
  }

  if (naturalAssistantMode) {
    return null;
  }

  return buildBusinessIntroductionReply();
}
