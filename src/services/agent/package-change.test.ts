import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import {
  parsePackageOrPriceTarget,
  isPackageChangeRequest,
  getPackageChangeReply,
  isPackageSwitchAnswer,
  getPackageSwitchAnswerReply,
} from './package-replies';
import { AgentService } from './agent.service';

test('parsePackageOrPriceTarget parses various price shorthands and editions', () => {
  // 55k
  const res55k = parsePackageOrPriceTarget('Can I change my package to 55k');
  assert.ok(res55k && 'package' in res55k);
  assert.equal(res55k.package.name, 'THE QUEEN');
  assert.equal(res55k.priceText, '55k');

  // 55,000
  const resComma = parsePackageOrPriceTarget('change my package to 55,000');
  assert.ok(resComma && 'package' in resComma);
  assert.equal(resComma.package.name, 'THE QUEEN');
  assert.equal(resComma.priceText, '55,000');

  // 55000
  const resRaw = parsePackageOrPriceTarget('switch to 55000');
  assert.ok(resRaw && 'package' in resRaw);
  assert.equal(resRaw.package.name, 'THE QUEEN');

  // the 55 thousand one
  const resThousand = parsePackageOrPriceTarget('can I switch to the 55 thousand one');
  assert.ok(resThousand && 'package' in resThousand);
  assert.equal(resThousand.package.name, 'THE QUEEN');
  assert.equal(resThousand.priceText, '55 thousand');

  // Edition name: Queen
  const resQueen = parsePackageOrPriceTarget('Can I change my package to the Queen edition');
  assert.ok(resQueen && 'package' in resQueen);
  assert.equal(resQueen.package.name, 'THE QUEEN');

  // Unknown price
  const resUnknown = parsePackageOrPriceTarget('Can I change my package to 40k');
  assert.ok(resUnknown && 'unknownPrice' in resUnknown);
  assert.equal(resUnknown.unknownPrice, 40000);
});

test('isPackageChangeRequest recognizes change/switch package intents', () => {
  assert.equal(isPackageChangeRequest('Can I change my package to 55k'), true);
  assert.equal(isPackageChangeRequest('can i switch to Queen'), true);
  assert.equal(isPackageChangeRequest('change my edition to 55,000'), true);
  assert.equal(isPackageChangeRequest('upgrade my package to Queen'), true);
  assert.equal(isPackageChangeRequest('can I switch my booking to 55k'), true);

  // Answering after carry-over question
  const carryOverHistory = [{ role: 'assistant' as const, content: 'Last time you were looking at the Legend edition. Would you like to continue with that, or choose a different one?' }];
  assert.equal(isPackageChangeRequest('How about 55k', carryOverHistory), true);
  assert.equal(isPackageChangeRequest('55k please', carryOverHistory), true);

  // Unrelated messages
  assert.equal(isPackageChangeRequest('Where are you located?'), false);
  assert.equal(isPackageChangeRequest('What is included in the Queen?'), false);
});

test('getPackageChangeReply proposes switch for draft and hands off for confirmed booking', async () => {
  const originals = {
    packageFindMany: prisma.package.findMany,
    draftFindUnique: prisma.bookingDraft.findUnique,
    bookingFindFirst: prisma.booking.findFirst,
  };

  try {
    (prisma.package.findMany as any) = async () => [
      { name: 'THE LEGEND', price: 45000, deposit: 2000 },
      { name: 'THE QUEEN', price: 55000, deposit: 2000 },
    ];

    // 1. Client with Legend draft asks to change to 55k
    (prisma.booking.findFirst as any) = async () => null;
    (prisma.bookingDraft.findUnique as any) = async () => ({
      customerId: 'cust-1',
      service: 'THE LEGEND',
      step: 'collecting_slots',
    });

    const replyDraft = await getPackageChangeReply('cust-1', 'Can I change my package to 55k');
    assert.ok(replyDraft);
    assert.equal(replyDraft.reply, '55k is the Queen edition. Shall I switch your booking from the Legend to the Queen?');
    assert.equal(replyDraft.escalateToTeam, undefined);

    // 2. Client with confirmed booking asks to change to 55k -> hands off to team
    (prisma.booking.findFirst as any) = async () => ({
      id: 'booking-1',
      customerId: 'cust-2',
      service: 'THE LEGEND',
      status: 'confirmed',
      dateTime: new Date(Date.now() + 86400000),
    });

    const replyConfirmed = await getPackageChangeReply('cust-2', 'Can I change my package to 55k');
    assert.ok(replyConfirmed);
    assert.match(replyConfirmed.reply, /Since your booking is already confirmed, changing your package involves adjusting the deposit and price difference/);
    assert.match(replyConfirmed.reply, /0720 111928/);
    assert.equal(replyConfirmed.escalateToTeam, true);

    // 3. Unknown price -> explains available editions with link
    const replyUnknown = await getPackageChangeReply('cust-1', 'Can I change my package to 40k');
    assert.ok(replyUnknown);
    assert.match(replyUnknown.reply, /We don't have an edition at Ksh 40,000/);
    assert.match(replyUnknown.reply, /session-packages/);
  } finally {
    prisma.package.findMany = originals.packageFindMany;
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
    prisma.booking.findFirst = originals.bookingFindFirst;
  }
});

test('getPackageSwitchAnswerReply saves the new edition on yes and confirms it in the reply', async () => {
  const originals = {
    draftFindUnique: prisma.bookingDraft.findUnique,
    draftUpdateMany: prisma.bookingDraft.updateMany,
    draftCreate: prisma.bookingDraft.create,
  };

  try {
    let updatedData: any = null;
    (prisma.bookingDraft.findUnique as any) = async () => ({
      id: 'draft-1',
      customerId: 'cust-1',
      service: 'THE LEGEND',
      step: 'collecting_slots',
      date: null,
      time: null,
    });
    (prisma.bookingDraft.updateMany as any) = async ({ data }: any) => {
      updatedData = data;
      return { count: 1 };
    };

    const history = [
      { role: 'user' as const, content: 'Can I change my package to 55k' },
      { role: 'assistant' as const, content: '55k is the Queen edition. Shall I switch your booking from the Legend to the Queen?' },
    ];

    assert.equal(isPackageSwitchAnswer('yes', history), true);
    assert.equal(isPackageSwitchAnswer('sure', history), true);
    assert.equal(isPackageSwitchAnswer('no', history), true);

    // Affirmative answer
    const replyYes = await getPackageSwitchAnswerReply('cust-1', 'yes', history);
    assert.ok(replyYes);
    assert.match(replyYes, /I’ve switched your booking to the Queen edition\./);
    assert.match(replyYes, /What date would suit you\?/);
    assert.match(replyYes, /session-packages/);
    assert.equal(updatedData.service, 'THE QUEEN');

    // Decline answer
    const replyNo = await getPackageSwitchAnswerReply('cust-1', 'no', history);
    assert.ok(replyNo);
    assert.match(replyNo, /We'll keep the Legend edition\./);
  } finally {
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
    prisma.bookingDraft.updateMany = originals.draftUpdateMany;
    prisma.bookingDraft.create = originals.draftCreate;
  }
});

test('full conversation flow: package change from 55k, acknowledgement, discount and handoff escalation', async () => {
  const originals = {
    packageFindMany: prisma.package.findMany,
    draftFindUnique: prisma.bookingDraft.findUnique,
    draftUpdateMany: prisma.bookingDraft.updateMany,
    bookingFindFirst: prisma.booking.findFirst,
    customerFindUnique: prisma.customer.findUnique,
    customerMemoryFindUnique: prisma.customerMemory.findUnique,
  };

  const escalations: Array<{ customerId: string; type: string; description: string }> = [];

  const agent = new AgentService() as any;
  agent.escalate = async (customerId: string, type: string, description: string) => {
    escalations.push({ customerId, type, description });
  };
  agent.trackSentiment = async () => {};
  agent.logConversationLearning = async () => {};
  agent.touchCustomerMemory = async () => {};
  agent.runAgent = async () => {
    throw new Error('LLM must not be called for these turns!');
  };

  try {
    (prisma.package.findMany as any) = async () => [
      { name: 'THE LEGEND', price: 45000, deposit: 2000 },
      { name: 'THE QUEEN', price: 55000, deposit: 2000 },
    ];
    (prisma.booking.findFirst as any) = async () => null;
    (prisma.customer.findUnique as any) = async () => ({ name: 'Maryanne' });
    (prisma.customerMemory.findUnique as any) = async () => null;

    let currentDraft: any = {
      id: 'draft-legend',
      customerId: 'cust-maryanne',
      service: 'THE LEGEND',
      step: 'collecting_slots',
      date: null,
      time: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.bookingDraft.findUnique as any) = async () => currentDraft;
    (prisma.bookingDraft.updateMany as any) = async ({ data }: any) => {
      currentDraft = { ...currentDraft, ...data, updatedAt: new Date() };
      return { count: 1 };
    };

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Turn 1: Bot had asked stale draft carry-over question
    const carryOverMsg = 'Last time you were looking at the Legend edition. Would you like to continue with that, or choose a different one?';
    history.push({ role: 'assistant', content: carryOverMsg });

    // Turn 2: Customer says "Can I change my package to 55k"
    const reply2 = await agent.handleMessage('cust-maryanne', 'Can I change my package to 55k', history, 'whatsapp');
    assert.equal(reply2, '55k is the Queen edition. Shall I switch your booking from the Legend to the Queen?');
    history.push({ role: 'user', content: 'Can I change my package to 55k' });
    history.push({ role: 'assistant', content: reply2 });

    // Turn 3: Customer says "yes"
    const reply3 = await agent.handleMessage('cust-maryanne', 'yes', history, 'whatsapp');
    assert.match(reply3, /I’ve switched your booking to the Queen edition\./);
    assert.match(reply3, /What date would suit you\?/);
    assert.equal(currentDraft.service, 'THE QUEEN');
    history.push({ role: 'user', content: 'yes' });
    history.push({ role: 'assistant', content: reply3 });

    // Turn 4: Customer says "Thank you 😊"
    const reply4 = await agent.handleMessage('cust-maryanne', 'Thank you 😊', history, 'whatsapp');
    assert.match(reply4, /You are welcome/);
    history.push({ role: 'user', content: 'Thank you 😊' });
    history.push({ role: 'assistant', content: reply4 });

    // Turn 5: Customer says "I will appreciate"
    const reply5 = await agent.handleMessage('cust-maryanne', 'I will appreciate', history, 'whatsapp');
    assert.match(reply5, /You are welcome/);
    assert.doesNotMatch(reply5, /\?/); // No question! Short, warm line
    history.push({ role: 'user', content: 'I will appreciate' });
    history.push({ role: 'assistant', content: reply5 });

    // Turn 6: Customer asks about discount
    const reply6 = await agent.handleMessage('cust-maryanne', 'Since I am a returning client, do I get a discount?', history, 'whatsapp');
    assert.equal(reply6, 'The team will confirm that for you.');
    history.push({ role: 'user', content: 'Since I am a returning client, do I get a discount?' });
    history.push({ role: 'assistant', content: reply6 });

    // Turn 7: Customer follows up: "Kindly confirm that for me"
    const reply7 = await agent.handleMessage('cust-maryanne', 'Kindly confirm that for me', history, 'whatsapp');
    assert.equal(reply7, "I've passed that on, and the studio team will reply here shortly.");
    history.push({ role: 'user', content: 'Kindly confirm that for me' });
    history.push({ role: 'assistant', content: reply7 });

    // Verify escalation was created for the handoff
    assert.ok(escalations.length >= 1, 'At least one escalation should be created');
    const discountEscalation = escalations.find(e => e.type === 'team_handoff' || e.description.includes('discount') || e.description.includes('returning'));
    assert.ok(discountEscalation, 'Discount handoff should have created an escalation');
    assert.equal(discountEscalation.customerId, 'cust-maryanne');
  } finally {
    prisma.package.findMany = originals.packageFindMany;
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
    prisma.bookingDraft.updateMany = originals.draftUpdateMany;
    prisma.booking.findFirst = originals.bookingFindFirst;
    prisma.customer.findUnique = originals.customerFindUnique;
    prisma.customerMemory.findUnique = originals.customerMemoryFindUnique;
  }
});

test('kill switch: AI_AUTOMATION_ENABLED=false immediately routes to handoff and logs escalation without invoking AI', async () => {
  const previousEnv = process.env.AI_AUTOMATION_ENABLED;
  process.env.AI_AUTOMATION_ENABLED = 'false';

  const escalations: Array<{ customerId: string; type: string; description: string }> = [];
  const agent = new AgentService() as any;
  agent.escalate = async (customerId: string, type: string, description: string) => {
    escalations.push({ customerId, type, description });
  };
  agent.runAgent = async () => {
    assert.fail('runAgent must never be called when kill switch is active');
  };

  try {
    const reply = await agent.handleMessage('cust-kill-switch', 'Hello, I want to book a session', [], 'whatsapp');
    assert.equal(reply, 'The studio team will help you shortly on 0720 111928.');
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].customerId, 'cust-kill-switch');
    assert.equal(escalations[0].type, 'automation_disabled');
    assert.match(escalations[0].description, /AI_AUTOMATION_ENABLED=false/);
  } finally {
    process.env.AI_AUTOMATION_ENABLED = previousEnv;
  }
});
