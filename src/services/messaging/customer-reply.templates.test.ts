import assert from 'node:assert/strict';
import test from 'node:test';
import { customerReplyTemplates, formatCustomerReply } from './customer-reply.templates';

const bannedPatterns = [
  /\*[^*]+\*/,
  /fiesta ai/i,
  /[\p{Extended_Pictographic}\uFE0F]/u,
  /^(sure thing|absolutely|no worries|great question|perfect)[!,.:\s-]*/i,
];

function assertNaturalCustomerReply(reply: string) {
  for (const pattern of bannedPatterns) {
    assert.equal(pattern.test(reply), false, `reply should not match ${pattern}: ${reply}`);
  }
}

test('formats model output as plain conversational text', () => {
  const reply = formatCustomerReply('Sure thing! **Fiesta AI** is here ✨\n\n- Visit https://fiestahouseattire.com/');

  assert.equal(reply, 'Fiesta House is here\nVisit https://www.fiestahousematernity.com/');
  assertNaturalCustomerReply(reply);
});

test('customer reply templates avoid bot-like formatting and canned openers', () => {
  const replies = [
    customerReplyTemplates.bookingAwaitingConfirmation(),
    customerReplyTemplates.rescheduleAwaitingConfirmation(),
    customerReplyTemplates.paymentPending(),
    customerReplyTemplates.paymentFailed('Payment was declined'),
    customerReplyTemplates.appointmentReminder('Sarah', 'Standard Package', '3:00 PM'),
    customerReplyTemplates.feedbackFollowUp('Sarah'),
    customerReplyTemplates.rescheduleConfirmed('Standard Package', 'Friday, September 4 at 3:00 PM'),
  ];

  replies.forEach(assertNaturalCustomerReply);
});
