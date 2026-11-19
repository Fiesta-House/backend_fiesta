import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVerifiedFact } from './verified-facts';
import { isEarliestImageDeliveryRequest } from './photo-delivery-replies';
import { extractStatedSlots } from './slot-memory';
import { AgentService } from './agent.service';
import { BUDGET_HANDOFF_REPLY } from './constants';
import prisma from '../../config/prisma';

test('verified-facts table answers makeup scope deterministically', () => {
  const q1 = 'Is the makeup for one person?';
  const reply1 = resolveVerifiedFact(q1);
  assert.ok(reply1);
  assert.match(reply1, /Professional makeup is included for the expecting mother/i);
  assert.match(reply1, /Ksh 3,500/);
  assert.match(reply1, /Lashes are included/i);
});

test('verified-facts table answers hair and wig questions deterministically without inventing Ksh 3000 wig arrangement', () => {
  for (const q of [
    'Do I have to come with my own hair?',
    'The package contains hairstyling,so I\'m asking if I can come with my own',
    'Can I bring my own hair?',
    'Can I bring my own wig?',
  ]) {
    const reply = resolveVerifiedFact(q);
    assert.ok(reply, `Failed for query: ${q}`);
    assert.match(reply, /styling of your own hair/i);
    assert.match(reply, /styled wig hire is Ksh 4,000/i);
    assert.match(reply, /wig styling only is Ksh 3,000/i);
    assert.match(reply, /studio team will confirm/i);
  }
});

test('verified-facts table answers outfit and gown selection without inventing Instagram gallery browsing', () => {
  const variations = [
    'How can I chose the outfits?',
    'Can i choose an outfit for myself',
    'Can I pick my own outfits?',
    'Do I get to choose the gowns?',
    'Where do I choose the outfits?'
  ];

  for (const q of variations) {
    const reply = resolveVerifiedFact(q);
    assert.ok(reply, `Expected verified fact reply for: "${q}"`);
    assert.match(reply, /select your gowns and outfits from our studio wardrobe/i);
    assert.doesNotMatch(reply, /instagram|gallery posts|scroll/i);
  }
});

test('verified-facts table safely handles customer offering to share gowns in chat', () => {
  const q = 'Perfect I will share with you my gowns as soon as I go through them';
  const replyWithDraft = resolveVerifiedFact(q, [], { draftService: 'THE LEGEND' });
  assert.ok(replyWithDraft);
  assert.match(replyWithDraft, /team will review your gown choices/i);
  assert.match(replyWithDraft, /What date would suit you/i);

  const replyWithoutDraft = resolveVerifiedFact(q);
  assert.ok(replyWithoutDraft);
  assert.match(replyWithoutDraft, /team will review your gown choices/i);
});

test('verified-facts table answers extra outfit / bringing own outfit beyond package', () => {
  const q = 'I see it contains 15 images and 4 outfits, how about if I want to add one more outfit of my own?';
  const reply = resolveVerifiedFact(q, [], { draftService: 'THE LEGEND' });
  assert.ok(reply);
  assert.match(reply, /Extra outfits beyond your package are Ksh 4,000 each/i);
  assert.match(reply, /team will confirm/i);
  assert.match(reply, /What date would suit you/i);
});

test('verified-facts table answers partner styling follow-up', () => {
  const q = 'Do you mean you have outfits for both me and my partner';
  const reply = resolveVerifiedFact(q);
  assert.ok(reply);
  assert.match(reply, /wardrobe is primarily tailored for the expecting mother/i);
  assert.match(reply, /partner and children are very welcome/i);
});

test('verified-facts table distinguishes family participation from the edited-photo package count', () => {
  for (const question of [
    'Do the 15 edited photos include my family photos?',
    'I am asking about the 15 edited photos, do they include the photos taken with family?',
  ]) {
    assert.equal(resolveVerifiedFact(question), 'I understand you are asking whether family portraits count toward the edited photos. The package details do not specify that; the studio team can confirm for you.');
  }
  assert.equal(resolveVerifiedFact('Can my family join the session?'), null);
});

test('verified-facts table answers Power Suit queries', () => {
  const q = 'What is the Power Suit?';
  const reply = resolveVerifiedFact(q);
  assert.ok(reply);
  assert.match(reply, /Ksh 10,000/);
  assert.match(reply, /The Empress and The Goddess/i);
  for (const question of ['What does the power suit look like?', 'Tell me about the Power Suit', 'whats the vibe of the power suit']) {
    assert.match(resolveVerifiedFact(question) || '', /structured blazer[\s\S]*Powerful \u2022 Elegant \u2022 Modern \u2022 Confident \u2022 Editorial/, question);
  }
  assert.equal(resolveVerifiedFact('Did you add the power suit?'), null);
  assert.equal(resolveVerifiedFact('I want the power suit'), null);
});

test('verified-facts table acknowledges studio team handoff without repeating canned text', () => {
  for (const q of [
    'I will be waiting for your response',
    "I'll wait for your reply",
    'Waiting',
  ]) {
    const reply = resolveVerifiedFact(q);
    assert.ok(reply, `Failed for: ${q}`);
    assert.equal(reply, "I've passed that on, and the studio team will reply here shortly.");
  }
});

test('verified-facts table answers returning-client discount inquiry and confirm follow-up', () => {
  for (const q of [
    'Since I am a returning client, do I get a discount?',
    'Do you offer discounts?',
    'Do returning clients get a discount?',
    'Is there a special rate for returning clients?',
  ]) {
    const reply = resolveVerifiedFact(q);
    assert.equal(reply, 'The team will confirm that for you.', `Failed for: ${q}`);
  }

  const history = [{ role: 'assistant' as const, content: 'The team will confirm that for you.' }];
  for (const followUp of [
    'Kindly confirm that for me',
    'Please confirm that for me',
    'confirm that for me',
  ]) {
    const reply = resolveVerifiedFact(followUp, history);
    assert.equal(reply, "I've passed that on, and the studio team will reply here shortly.", `Failed for follow-up: ${followUp}`);
  }
});

test('isEarliestImageDeliveryRequest matches "how long does it take to get the photos"', () => {
  assert.equal(isEarliestImageDeliveryRequest('how long does it take to get the photos'), true);
  assert.equal(isEarliestImageDeliveryRequest('how long to get the photos'), true);
});

test('extractStatedSlots extracts date and time from schedule queries with @time syntax', () => {
  const query = 'How is your schedule on 30th October @2pm';
  const slots = extractStatedSlots(query);
  assert.ok(slots.date, 'Date should be extracted');
  assert.match(slots.date, /-10-30$/);
  assert.equal(slots.time, '14:00');
});

test('deterministic routes succeed with zero tokens even when daily token cap is exhausted', async () => {
  const agent = new AgentService() as any;
  agent.checkTokenBudget = async () => false; // Simulating exhausted token budget
  agent.runAgent = async () => { throw new Error('Model must not be called for deterministic routes!'); };
  agent.escalate = async () => {};
  agent.trackSentiment = async () => {};
  agent.logConversationLearning = async () => {};
  agent.touchCustomerMemory = async () => {};

  // 1. Post action acknowledgement ("Thank you")
  const replyThanks = await agent.handleMessage('budget-customer-1', 'Thank you', [], 'whatsapp');
  assert.match(replyThanks, /welcome/i);
  assert.notEqual(replyThanks, BUDGET_HANDOFF_REPLY);

  // 2. Earliest image delivery ("how long does it take to get the photos")
  const replyPhotos = await agent.handleMessage('budget-customer-1', 'how long does it take to get the photos', [], 'whatsapp');
  assert.match(replyPhotos, /10 working days/i);
  assert.notEqual(replyPhotos, BUDGET_HANDOFF_REPLY);

  // 3. Verified fact ("Is the makeup for one person?")
  const replyMakeup = await agent.handleMessage('budget-customer-1', 'Is the makeup for one person?', [], 'whatsapp');
  assert.match(replyMakeup, /Professional makeup is included/i);
  assert.notEqual(replyMakeup, BUDGET_HANDOFF_REPLY);

  // 4. Rate card request ("Can you share your rate cards with me")
  const replyCatalog = await agent.handleMessage('budget-customer-1', 'Can you share your rate cards with me', [], 'whatsapp');
  assert.match(replyCatalog, /session-packages/i);
  assert.notEqual(replyCatalog, BUDGET_HANDOFF_REPLY);

  // 5. General open-ended query that requires LLM triggers the handoff cleanly
  const replyHandoff = await agent.handleMessage('budget-customer-1', 'Do you have parking at the studio?', [], 'whatsapp');
  assert.equal(replyHandoff, BUDGET_HANDOFF_REPLY);
});
