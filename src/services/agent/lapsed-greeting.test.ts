import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import { AgentService } from './agent.service';
import { applyEmojiPolicy, EMOJI_REPEAT_WINDOW_MS } from './emoji-policy';

test('emoji repeat rule applies within 2 hours but does not span a full day (22 hours)', () => {
  const heart = '\u{1F90D}';
  const now = Date.now();

  // 1. Previous message was 10 minutes ago (within 2h window) -> emoji is stripped as consecutive repeat
  const recentResult = applyEmojiPolicy(`Welcome back. ${heart}`, {
    replyType: 'welcome',
    previousAssistant: `Hello. ${heart}`,
    previousAssistantCreatedAt: new Date(now - 10 * 60 * 1000),
  });
  assert.equal(recentResult, 'Welcome back.');

  // 2. Previous message was 22 hours ago (yesterday) -> emoji is kept because it's a new conversation
  const yesterdayResult = applyEmojiPolicy(`Welcome back. ${heart}`, {
    replyType: 'welcome',
    previousAssistant: `Hello. ${heart}`,
    previousAssistantCreatedAt: new Date(now - 22 * 60 * 60 * 1000),
  });
  assert.equal(yesterdayResult, `Welcome back. ${heart}`);
});

test('lapsed draft greeting: varies on 2nd turn and offers clean reset on 3rd turn', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T09:00:00Z').getTime() });
  const originals = {
    draftFindUnique: prisma.bookingDraft.findUnique,
    draftDeleteMany: prisma.bookingDraft.deleteMany,
    bookingFindFirst: prisma.booking.findFirst,
    bookingCount: prisma.booking.count,
    paymentFindFirst: prisma.payment.findFirst,
    paymentUpdateMany: prisma.payment.updateMany,
    memoryFindUnique: prisma.customerMemory.findUnique,
    memoryUpsert: prisma.customerMemory.upsert,
    memoryUpdateMany: prisma.customerMemory.updateMany,
    convFindFirst: prisma.unifiedConversation.findFirst,
    messageFindFirst: prisma.message.findFirst,
  };

  const agent = new AgentService() as any;
  agent.trackSentiment = async () => {};
  agent.logConversationLearning = async () => {};
  agent.touchCustomerMemory = async () => {};

  try {
    let currentDraft: any = {
      id: 'draft-bloom-14',
      customerId: 'cust-lapsed',
      service: 'THE BLOOM',
      date: '2026-10-14',
      time: '10:00',
      step: 'payment_pending',
      version: 2,
      updatedAt: new Date(Date.now() - 4 * 60 * 60 * 1000), // lapsed > 1h
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };

    (prisma.bookingDraft.findUnique as any) = async () => currentDraft;
    (prisma.bookingDraft.deleteMany as any) = async () => {
      currentDraft = null;
      return { count: 1 };
    };
    (prisma.booking.findFirst as any) = async () => null;
    (prisma.booking.count as any) = async () => 0;
    (prisma.payment.findFirst as any) = async () => null;
    (prisma.payment.updateMany as any) = async () => ({ count: 0 });
    (prisma.customerMemory.findUnique as any) = async () => null;
    (prisma.customerMemory.upsert as any) = async () => ({});
    (prisma.customerMemory.updateMany as any) = async () => ({ count: 1 });
    (prisma.unifiedConversation.findFirst as any) = async () => null;
    (prisma.message.findFirst as any) = async () => null;

    const history: Array<{ role: 'user' | 'assistant'; content: string; createdAt?: Date }> = [];

    // Turn 1: First greeting on lapsed draft
    const reply1 = await agent.handleMessage('cust-lapsed', 'Hey', history, 'whatsapp');
    assert.match(reply1, /Welcome back\./);
    assert.match(reply1, /Your earlier request for the Bloom edition on Wednesday, 14 October at 10:00 AM was not paid, so nothing is booked yet\./);
    assert.match(reply1, /Reply yes and I'll check the slot is still free/);
    history.push({ role: 'user', content: 'Hey', createdAt: new Date(Date.now() - 22 * 60 * 60 * 1000) });
    history.push({ role: 'assistant', content: reply1, createdAt: new Date(Date.now() - 22 * 60 * 60 * 1000) });

    // Turn 2: Second greeting next day (1 reminder already in history) -> varied reminder, not a copy-paste nag
    const reply2 = await agent.handleMessage('cust-lapsed', 'Hey', history, 'whatsapp');
    assert.match(reply2, /Good to hear from you\./);
    assert.match(reply2, /Your Bloom request for Wednesday, 14 October is still waiting\./);
    assert.match(reply2, /Shall I check the slot\?/);
    assert.doesNotMatch(reply2, /was not paid, so nothing is booked yet/);
    history.push({ role: 'user', content: 'Hey', createdAt: new Date() });
    history.push({ role: 'assistant', content: reply2, createdAt: new Date() });

    // Turn 3: Third greeting (2 reminders in history) -> clean reset offer
    const reply3 = await agent.handleMessage('cust-lapsed', 'Hey', history, 'whatsapp');
    assert.match(reply3, /Good to hear from you\./);
    assert.match(reply3, /Would you like me to clear it and start fresh, or check that slot for you\?/);
    history.push({ role: 'user', content: 'Hey', createdAt: new Date() });
    history.push({ role: 'assistant', content: reply3, createdAt: new Date() });

    // Turn 4: Customer says "clear it" -> deletes draft cleanly
    const reply4 = await agent.handleMessage('cust-lapsed', 'clear it', history, 'whatsapp');
    assert.match(reply4, /Done, I've cancelled that booking request\. Nothing was booked and no payment was taken\./);
    assert.equal(currentDraft, null);
  } finally {
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
    prisma.bookingDraft.deleteMany = originals.draftDeleteMany;
    prisma.booking.findFirst = originals.bookingFindFirst;
    prisma.booking.count = originals.bookingCount;
    prisma.payment.findFirst = originals.paymentFindFirst;
    prisma.payment.updateMany = originals.paymentUpdateMany;
    prisma.customerMemory.findUnique = originals.memoryFindUnique;
    prisma.customerMemory.upsert = originals.memoryUpsert;
    prisma.customerMemory.updateMany = originals.memoryUpdateMany;
    prisma.unifiedConversation.findFirst = originals.convFindFirst;
    prisma.message.findFirst = originals.messageFindFirst;
  }
});

test('stale past-date rule: drops past-dated lapsed draft when 14 October passes and greets normally', async (context) => {
  // Freeze clock to Thursday 15 October 2026 8:00 AM
  const frozenNow = new Date('2026-10-15T08:00:00Z').getTime();
  context.mock.timers.enable({ apis: ['Date'], now: frozenNow });

  const originals = {
    draftFindUnique: prisma.bookingDraft.findUnique,
    draftDeleteMany: prisma.bookingDraft.deleteMany,
    bookingFindFirst: prisma.booking.findFirst,
    customerMemoryFindUnique: prisma.customerMemory.findUnique,
    unifiedConvFindFirst: prisma.unifiedConversation.findFirst,
    messageFindFirst: prisma.message.findFirst,
  };

  let deleted = false;
  let draft: any = {
    id: 'past-bloom-draft',
    customerId: 'cust-past-date',
    service: 'THE BLOOM',
    date: '2026-10-14', // yesterday relative to 15 October
    time: '10:00',
    step: 'payment_pending',
    version: 1,
    updatedAt: new Date('2026-10-14T10:30:00Z'),
    createdAt: new Date('2026-10-14T09:00:00Z'),
  };

  (prisma.bookingDraft.findUnique as any) = async () => draft;
  (prisma.bookingDraft.deleteMany as any) = async () => {
    deleted = true;
    draft = null;
    return { count: 1 };
  };
  (prisma.booking.findFirst as any) = async () => null;
  (prisma.customerMemory.findUnique as any) = async () => null;
  (prisma.unifiedConversation.findFirst as any) = async () => null;
  (prisma.message.findFirst as any) = async () => null;

  const agent = new AgentService() as any;
  agent.trackSentiment = async () => {};
  agent.logConversationLearning = async () => {};
  agent.touchCustomerMemory = async () => {};

  try {
    const reply = await agent.handleMessage('cust-past-date', 'Hey', [], 'whatsapp');
    assert.equal(deleted, true, 'Draft from 14 October must be deleted once date is past');
    assert.match(reply, /Welcome to Fiesta House Maternity/);
    assert.doesNotMatch(reply, /Bloom|October|14/);
  } finally {
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
    prisma.bookingDraft.deleteMany = originals.draftDeleteMany;
    prisma.booking.findFirst = originals.bookingFindFirst;
    prisma.customerMemory.findUnique = originals.customerMemoryFindUnique;
    prisma.unifiedConversation.findFirst = originals.unifiedConvFindFirst;
    prisma.message.findFirst = originals.messageFindFirst;
  }
});
