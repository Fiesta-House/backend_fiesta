import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import axios from 'axios';
import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { SEED_EDITION_INCLUSIONS } from '../../config/edition-inclusions';
import { SERVICE_DURATIONS as SEED_COMPARISON_DURATIONS } from '../../config/constants';
import { bookingAddonService } from '../booking/booking-addon.service';
import { bookingDraftService } from '../booking/booking-draft.service';
import { bookingService } from '../booking/booking.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { AgentService, BookingExtractor, createChatCompletion, getGroqCooldownUntil } from './agent.service';
import { primaryProvider } from './llm/provider';
import { ConversationFlowMatcher } from './conversation-flow.matcher';
import {
  buildBespokeReply,
  buildBookingForSomeoneElseReply,
  buildBusinessIntroductionReply,
  buildContactDetailsReply,
  buildMultiPersonBookingReply,
  buildPackageBudgetReply,
  buildPortfolioReply,
  buildPostShootProcessReply,
  buildRawFilesReply,
  buildSocialMediaReply,
  buildTravellingMothersReply,
  buildWebsiteReply,
  getReviewPageReply,
  getSuspendingConceptGalleryReply,
  buildAdditionsReply,
  buildBookingProposalConfirmation,
  buildCancellationProposal,
  buildPackageDepositProposal,
  buildRescheduleProposalConfirmation,
  buildTimeOnlyRescheduleProposal,
  isAddonListFollowUp,
  isAdditionsRequest,
  isBespokeRequest,
  isBookingForSomeoneElseRequest,
  isMultiPersonBookingRequest,
  isPackageBudgetRequest,
  isPostShootProcessRequest,
  isRawFilesRequest,
  isSocialMediaRequest,
  isTravellingMothersRequest,
  isBookingProcessRequest,
  previousMessageRequestsConfirmation,
} from './replies';
import { whatsappService, normalizeWhatsappText } from '../messaging/whatsapp.service';
import { inBusinessTimezone } from '../../utils/time';
const agent = new AgentService() as any;
const conversationFlows = new ConversationFlowMatcher();

test('falls back to Gemini on a Groq quota error and keeps later tool rounds on Gemini', async () => {
  const calls: string[] = [];
  const saved: any[] = [];
  const originalCreate = prisma.aiModelUsage.create;
  (prisma.aiModelUsage.create as any) = async ({ data }: any) => { saved.push(data); };
  const clients = {
    groq: { chat: { completions: { create: async () => {
      calls.push('groq');
      throw Object.assign(new Error('tokens per day'), { status: 429 });
    } } } },
    gemini: { chat: { completions: { create: async (params: any) => {
      calls.push(params.model);
      return { choices: [{ message: { content: 'Ready' } }], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } };
    } } } },
  } as any;
  const params = { model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'Book my session' }] };
  try {
    const first = await createChatCompletion(params, 'groq', clients);
    assert.equal(first.provider, 'gemini');
    assert.equal(first.completionCalls, 2);
    const next = await createChatCompletion(params, first.provider, clients);
    assert.equal(next.provider, 'gemini');
    const geminiModel = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
    assert.deepEqual(calls, ['groq', geminiModel, geminiModel]);
    assert.deepEqual(saved.map(({ provider, status, totalTokens, failover }) => ({ provider, status, totalTokens, failover })), [
      { provider: 'groq', status: 'failed', totalTokens: 0, failover: false },
      { provider: 'gemini', status: 'success', totalTokens: 42, failover: true },
      { provider: 'gemini', status: 'success', totalTokens: 42, failover: true },
    ]);
  } finally {
    prisma.aiModelUsage.create = originalCreate;
  }
});

test('uses the secondary Groq key before Gemini and keeps later rounds on that provider', async () => {
  const calls: string[] = [];
  const saved: any[] = [];
  const originalCreate = prisma.aiModelUsage.create;
  (prisma.aiModelUsage.create as any) = async ({ data }: any) => { saved.push(data); };
  const response = { choices: [{ message: { content: 'Ready' } }], usage: { total_tokens: 7 } };
  const clients = {
    groq: { chat: { completions: { create: async () => {
      calls.push('groq');
      throw Object.assign(new Error('primary key rate limited'), { status: 429 });
    } } } },
    groq2: { chat: { completions: { create: async (params: any) => {
      calls.push(`groq2:${params.model}`);
      return response;
    } } } },
    gemini: { chat: { completions: { create: async () => { calls.push('gemini'); return response; } } } },
  } as any;
  try {
    const first = await createChatCompletion({ model: 'primary-model', messages: [] }, 'groq', clients);
    assert.equal(first.provider, 'groq2');
    const next = await createChatCompletion({ model: 'primary-model', messages: [] }, first.provider, clients);
    assert.equal(next.provider, 'groq2');
    assert.deepEqual(calls, ['groq', `groq2:${process.env.GROQ_2_CHAT_MODEL || process.env.GROQ_CHAT_MODEL || process.env.OPENAI_CHAT_MODEL || 'llama-3.1-8b-instant'}`, `groq2:${process.env.GROQ_2_CHAT_MODEL || process.env.GROQ_CHAT_MODEL || process.env.OPENAI_CHAT_MODEL || 'llama-3.1-8b-instant'}`]);
    assert.deepEqual(saved.map(({ provider, status, failover }) => ({ provider, status, failover })), [
      { provider: 'groq', status: 'failed', failover: false },
      { provider: 'groq2', status: 'success', failover: true },
      { provider: 'groq2', status: 'success', failover: true },
    ]);
  } finally {
    prisma.aiModelUsage.create = originalCreate;
  }
});

test('skips Groq during its Retry-After cooldown and retries it after expiry', async () => {
  const originalCreate = prisma.aiModelUsage.create;
  const originalNow = Date.now;
  let now = 1_000_000;
  let groqCalls = 0;
  let geminiCalls = 0;
  Date.now = () => now;
  (prisma.aiModelUsage.create as any) = async () => ({});
  const response = { choices: [{ message: { content: 'Ready' } }] };
  const clients = {
    groq: { chat: { completions: { create: async () => {
      groqCalls++;
      if (groqCalls === 1) {
        throw Object.assign(new Error('tokens per day'), { status: 429, headers: new Headers({ 'retry-after': '120' }) });
      }
      return response;
    } } } },
    gemini: { chat: { completions: { create: async () => { geminiCalls++; return response; } } } },
  } as any;
  const params = { model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'Hello' }] };

  try {
    assert.equal((await createChatCompletion(params, 'groq', clients)).provider, 'gemini');
    assert.equal(getGroqCooldownUntil(clients.groq), new Date(now + 120_000).toISOString());
    assert.equal((await createChatCompletion(params, 'groq', clients)).completionCalls, 1);
    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 2);
    now += 120_001;
    assert.equal(getGroqCooldownUntil(clients.groq), null);
    assert.equal((await createChatCompletion(params, 'groq', clients)).provider, 'groq');
    assert.equal(groqCalls, 2);
  } finally {
    Date.now = originalNow;
    prisma.aiModelUsage.create = originalCreate;
  }
});

test('routes around invalid primary Groq credentials to Gemini', async () => {
  let fallbackCalled = false;
  const originalCreate = prisma.aiModelUsage.create;
  (prisma.aiModelUsage.create as any) = async () => ({});
  const clients = {
    groq: { chat: { completions: { create: async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    } } } },
    gemini: { chat: { completions: { create: async () => {
      fallbackCalled = true;
      return { choices: [{ message: { content: 'Ready' } }] };
    } } } },
  } as any;
  try {
    const result = await createChatCompletion({ model: 'primary', messages: [] }, 'groq', clients);
    assert.equal(result.provider, 'gemini');
    assert.equal(fallbackCalled, true);
  } finally {
    prisma.aiModelUsage.create = originalCreate;
  }
});

test('falls through all providers when each account exhausts its quota', async () => {
  const calls: string[] = [];
  const originalCreate = prisma.aiModelUsage.create;
  (prisma.aiModelUsage.create as any) = async () => ({});
  const clients = Object.fromEntries(['groq', 'groq2', 'gemini'].map((provider) => [provider, {
    chat: { completions: { create: async () => {
      calls.push(provider);
      throw Object.assign(new Error('quota exhausted'), { status: 429 });
    } } },
  }])) as any;
  clients.gemini2 = { chat: { completions: { create: async () => {
    calls.push('gemini2');
    return { choices: [{ message: { content: 'Ready' } }] };
  } } } };
  try {
    const result = await createChatCompletion({ model: 'primary', messages: [] }, 'groq', clients);
    assert.equal(result.provider, 'gemini2');
    assert.equal(result.completionCalls, 4);
    assert.deepEqual(calls, ['groq', 'groq2', 'gemini', 'gemini2']);
  } finally {
    prisma.aiModelUsage.create = originalCreate;
  }
});

test('a request too large for one account (413) falls over to the next provider', async () => {
  const originalCreate = prisma.aiModelUsage.create;
  (prisma.aiModelUsage.create as any) = async () => ({});
  const clients = {
    groq: { chat: { completions: { create: async () => { throw Object.assign(new Error('Request too large'), { status: 413 }); } } } },
    gemini: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Ready' } }] }) } } },
  } as any;
  try {
    const result = await createChatCompletion({ model: 'primary', messages: [] }, 'groq', clients);
    assert.equal(result.provider, 'gemini');
  } finally {
    prisma.aiModelUsage.create = originalCreate;
  }
});

test('with Gemini primary, Gemini answers first and Groq is only the fallback', async () => {
  const originalCreate = prisma.aiModelUsage.create;
  const saved: any[] = [];
  (prisma.aiModelUsage.create as any) = async ({ data }: any) => { saved.push(data); };
  const calls: string[] = [];
  const ok = (name: string) => ({ chat: { completions: { create: async () => { calls.push(name); return { choices: [{ message: { content: 'Ready' } }] }; } } } });
  const failing = (name: string) => ({ chat: { completions: { create: async () => { calls.push(name); throw Object.assign(new Error('busy'), { status: 503 }); } } } });
  try {
    assert.equal(primaryProvider({ AI_PRIMARY_PROVIDER: 'gemini' } as any), 'gemini');
    assert.equal(primaryProvider({} as any), 'groq');
    const first = await createChatCompletion({ model: 'primary', messages: [] }, undefined, { groq: ok('groq'), gemini: ok('gemini') } as any, 'gemini');
    assert.equal(first.provider, 'gemini');
    const fallback = await createChatCompletion({ model: 'primary', messages: [] }, undefined,
      { groq: ok('groq'), gemini: failing('gemini'), gemini2: failing('gemini2') } as any, 'gemini');
    assert.equal(fallback.provider, 'groq');
    assert.deepEqual(calls, ['gemini', 'gemini', 'gemini2', 'groq']);
    assert.deepEqual(saved.map(({ provider, failover }) => ({ provider, failover })), [
      { provider: 'gemini', failover: false }, { provider: 'gemini', failover: false },
      { provider: 'gemini2', failover: true }, { provider: 'groq', failover: true },
    ]);
  } finally {
    prisma.aiModelUsage.create = originalCreate;
  }
});

test('keeps hard policy identifiers while replacing redundant voice rules and omitting unrelated price tables', async () => {
  const originalPackageFindMany = prisma.package.findMany;
  (prisma.package.findMany as any) = async () => [
    { name: 'THE BLOOM', price: 15555 },
    { name: 'THE MUSE', price: 25000 },
    { name: 'THE ICON', price: 35000 },
    { name: 'THE LEGEND', price: 45000 },
    { name: 'THE QUEEN', price: 55000 },
    { name: 'THE EMPRESS', price: 70000 },
    { name: 'THE GODDESS', price: 120000 },
  ];
  try {
    const fullPrompt = await agent.getInstructionGuide();
    const compactPrompt = agent.getSystemPrompt('', 'whatsapp', false, false);
    const fallbackPricingPrompt = agent.getSystemPrompt('', 'whatsapp', true, false);

    assert.equal((fullPrompt.match(/(?:^|\n)[A-C]\d+[a-z]?\./g) || []).length, 24);
    assert.equal((fullPrompt.match(/(?:^|\n)[A-D]\d+[a-z]?\./g) || []).length, 33);
    assert.match(fullPrompt, /BRAND:.*Luxury, Safety, Convenience and Comfort/);
    assert.ok(fullPrompt.includes('VOICE: Warm, personable') && fullPrompt.includes('Say session or reveal, never photoshoot'));
    assert.match(fullPrompt, /THE BLOOM: Ksh 15,555/);
    assert.doesNotMatch(fullPrompt, /THE BLOOM: Ksh 15,000/);
    assert.equal(fullPrompt.includes(agent.getAddonPricingLine()), true);
    assert.match(fullPrompt, /Sus[p]?ending Concept|Sculpture Set|Concierge Services for Travelling Mothers/);
    assert.equal(compactPrompt.includes('THE BLOOM: Ksh 15,000'), false);
    assert.equal(compactPrompt.includes(agent.getAddonPricingLine()), false);
    assert.match(fallbackPricingPrompt, /THE BLOOM: Ksh 15,000/);
    assert.equal(fallbackPricingPrompt.includes(agent.getAddonPricingLine()), false);
    assert.ok(compactPrompt.length < fullPrompt.length);
  } finally {
    prisma.package.findMany = originalPackageFindMany;
  }
});

test('accepts natural confirmation wording for a pending booking', () => {
  assert.equal(agent.isExplicitConfirmation("Let's do that"), true);
  assert.equal(agent.isExplicitConfirmation('Let us do that'), true);
  assert.equal(agent.isExplicitConfirmation('Yes, that works'), true);
  assert.equal(agent.isExplicitConfirmation('Wait, let me check'), false);
});

test('only applies confirmation after the assistant presented a proposal', () => {
  assert.equal(agent.previousMessageRequestsConfirmation([{
    role: 'assistant',
    content: 'I can move your session to Friday at 3:00 PM. Would you like me to confirm that change?'
  }]), true);
  assert.equal(agent.previousMessageRequestsConfirmation([{
    role: 'assistant',
    content: 'If that works for you, just reply “yes” and I’ll send the M-Pesa prompt.'
  }]), true);
  assert.equal(agent.previousMessageRequestsConfirmation([{
    role: 'assistant',
    content: 'What time on Sunday, September 11 would you like to schedule the session?'
  }]), false);
  assert.equal(agent.previousMessageRequestsConfirmation([{
    role: 'assistant',
    content: "To make sure I have this exactly right for you, could you please confirm that you'd like to reschedule your Goddess session to Sunday, October 11th at 2:00 PM?"
  }]), true);
});

test('ignores duplicate yes replies after a payment prompt has already been sent', async () => {
  const originalFindUnique = prisma.bookingDraft.findUnique;
  const originalPaymentFindFirst = prisma.payment.findFirst;
  (prisma.bookingDraft.findUnique as any) = async () => ({
    id: 'draft-123',
    customerId: 'customer-123',
    service: 'THE ICON',
    step: 'payment_pending',
    date: '2026-09-19',
    time: '15:00',
    version: 2,
    updatedAt: new Date(),
  });
  (prisma.payment.findFirst as any) = async () => ({ id: 'payment-123', amount: 2000, phone: 'customer-123', status: 'pending', updatedAt: new Date() });

  try {
    const result = await agent.tryImmediateConfirmation('customer-123');
    assert.match(result || '', /already accepted the deposit request|deposit request.*still being processed/i);
  } finally {
    prisma.bookingDraft.findUnique = originalFindUnique;
    prisma.payment.findFirst = originalPaymentFindFirst;
  }
});

test('recognizes conversational package selections', () => {
  assert.equal(conversationFlows.isPackageSelection("Let's go with the standard package"), true);
  assert.equal(conversationFlows.isPackageSelection('I like the Executive then'), true);
  assert.equal(conversationFlows.isPackageSelection('What is included in Gold?'), false);
});

test('resolves package follow-ups from the previous assistant turn', () => {
  const history = [
    { role: 'assistant' as const, content: 'Would you like to book a session or chat about a package?' },
    { role: 'user' as const, content: 'tell me about them' },
    { role: 'assistant' as const, content: "I'm sorry, I couldn't process that." },
  ];

  assert.equal(conversationFlows.isPackageCatalogRequest('tell me about them', history), true);
  assert.equal(conversationFlows.isPackageCatalogRequest('tell me about them', []), false);

  const packageListHistory = [{
    role: 'assistant' as const,
    content: 'Here are all the current Fiesta House packages: THE BLOOM, THE MUSE, THE ICON, THE LEGEND, THE QUEEN, THE EMPRESS, and THE GODDESS.'
  }];
  assert.equal(conversationFlows.isPackageInclusionFollowUp('so what does each come with', packageListHistory), true);
  assert.equal(conversationFlows.isPackageCatalogRequest('so what does each come with', packageListHistory), true);
  assert.equal(conversationFlows.isPackageInclusionFollowUp('what does each come with', []), false);
});

test('how-to-book questions do not expose action tools', () => {
  const intentAgent = new AgentService() as any;

  assert.equal(
    intentAgent.shouldExposeTools('how can i book for a meet-up', [], 'whatsapp'),
    false,
  );
  assert.equal(
    intentAgent.shouldExposeTools('How do I book a session?', [], 'whatsapp'),
    false,
  );
  assert.equal(
    intentAgent.shouldExposeTools('What is the booking process?', [], 'whatsapp'),
    false,
  );

  // Explicit booking requests remain eligible for the booking workflow.
  assert.equal(
    intentAgent.shouldExposeTools('I want to book a session', [], 'whatsapp'),
    true,
  );
});
test('omits tool schemas for ordinary informational turns', () => {
  assert.equal(agent.shouldExposeTools('What time do you open?', [], 'whatsapp'), false);
  assert.equal(agent.shouldExposeTools('How much is THE ICON?', [], 'whatsapp'), false);
  assert.equal(agent.shouldExposeTools('Please reschedule my booking to Saturday at 2pm', [], 'whatsapp'), true);
  assert.equal(agent.shouldResolvePackageSelectionImmediately('I want THE ICON'), true);
  assert.equal(agent.shouldResolvePackageSelectionImmediately('I want THE ICON next Saturday around 10'), false);
  assert.equal(agent.messageContainsExplicitDateSignal('I want THE ICON next Saturday around 10'), true);
  assert.equal(agent.messageContainsExplicitDateTimeSignal('I want THE ICON next Saturday around 10'), false);
  assert.equal(agent.shouldExposeTools('I want THE ICON next Saturday at 10 AM', [], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('I want THE ICON next Saturday at 10 AM', [], 'instagram'), false);
  assert.equal(agent.shouldExposeTools('How much is the deposit?', [], 'whatsapp'), false);
  const extrasQuestion = [{ role: 'assistant' as const, content: 'Would you like to add any optional extras to the ICON package? It is completely optional.' }];
  assert.equal(agent.shouldExposeTools("No I don't want those", extrasQuestion, 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools("No I don't want those", extrasQuestion, 'instagram'), false);
  assert.equal(agent.shouldExposeTools("No I don't want those", [], 'whatsapp'), false);
  assert.equal(agent.shouldExposeTools('Does my husband have to pay extra?', [{
    role: 'assistant', content: 'What time would work for you?'
  }], 'whatsapp'), false);
  assert.equal(agent.shouldExposeTools('10 AM', [{
    role: 'assistant', content: 'What time would work for you?'
  }], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('3rd at 2pm?', [], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('3rd?', [], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('Saturday?', [], 'whatsapp'), true);
  assert.equal(agent.shouldExposeTools('2pm?', [], 'whatsapp'), true);
});

test('hands off a declined-extras booking when the provider daily limit is exhausted', async () => {
  const originals = {
    checkTokenBudget: agent.checkTokenBudget,
    trackSentiment: agent.trackSentiment,
    getBookingProgressReply: agent.getBookingProgressReply,
    runAgent: agent.runAgent,
    logAiJobMetric: agent.logAiJobMetric,
    logConversationLearning: agent.logConversationLearning,
    escalate: agent.escalate,
  };
  const escalations: string[] = [];
  agent.checkTokenBudget = async () => true;
  agent.trackSentiment = async () => {};
  agent.getBookingProgressReply = async () => null;
  agent.runAgent = async () => {
    throw Object.assign(new Error('tokens per day (TPD) limit reached'), { status: 429, code: 'rate_limit_exceeded' });
  };
  agent.logAiJobMetric = async () => {};
  agent.logConversationLearning = async () => {};
  agent.escalate = async (_customerId: string, _type: string, description: string) => { escalations.push(description); };

  try {
    const reply = await agent.handleMessage('customer-123', "No I don't want those", [{
      role: 'assistant', content: 'Would you like to add any optional extras to the ICON package? It is completely optional.'
    }], 'whatsapp');
    assert.match(reply, /no optional extras/i);
    assert.match(reply, /have not sent a deposit proposal or M-Pesa prompt/i);
    assert.ok(escalations.some((description) => /declined optional extras.*recheck slot availability/i.test(description)));
  } finally {
    Object.assign(agent, originals);
  }
});

test('skips the extractor completion for normal package selections', async () => {
  const extractor = new BookingExtractor() as any;
  extractor.aiExtract = async () => {
    throw new Error('The extractor model call should not run');
  };

  const result = await extractor.extract('I want THE ICON package');
  assert.equal(result.usage.completionCalls, 0);
});

test('recognizes a time-only reschedule request and time response', () => {
  assert.equal(conversationFlows.isTimeOnlyRescheduleRequest('Can we reschedule the time kindly'), true);
  assert.equal(conversationFlows.parseTimeOnly('10am'), '10:00');
  assert.equal(conversationFlows.parseTimeOnly('12:30 pm'), '12:30');
  assert.equal(conversationFlows.parseTimeOnly('25pm'), null);
});

test('stores a reschedule proposal as an explicit Nairobi-time instant', async () => {
  const originals = {
    bookingDraftFindUnique: prisma.bookingDraft.findUnique,
    bookingFindFirst: prisma.booking.findFirst,
    bookingDraftUpsert: prisma.bookingDraft.upsert,
    getAvailableSlots: bookingService.getAvailableSlots,
  };
  let savedDraft: any;
  (prisma.bookingDraft.findUnique as any) = async () => null;
  (prisma.booking.findFirst as any) = async () => ({
    id: 'booking-123',
    service: 'THE ICON',
    dateTime: new Date('2026-10-04T12:00:00.000Z'),
  });
  (bookingService.getAvailableSlots as any) = async () => ['13:00'];
  (prisma.bookingDraft.upsert as any) = async ({ update }: any) => {
    savedDraft = update;
    return update;
  };

  try {
    await agent.executeProposeRescheduleTool('customer-123', '2026-10-06', '13:00');

    assert.equal(savedDraft.dateTimeIso, '2026-10-06T10:00:00.000Z');
    assert.equal(inBusinessTimezone(savedDraft.dateTimeIso).format('YYYY-MM-DD HH:mm'), '2026-10-06 13:00');
  } finally {
    prisma.bookingDraft.findUnique = originals.bookingDraftFindUnique;
    prisma.booking.findFirst = originals.bookingFindFirst;
    prisma.bookingDraft.upsert = originals.bookingDraftUpsert;
    bookingService.getAvailableSlots = originals.getAvailableSlots;
  }
});

test('rejects a booking proposal when the requested slot is occupied', async () => {
  const originals = {
    customerFindUnique: prisma.customer.findUnique,
    bookingDraftFindUnique: prisma.bookingDraft.findUnique,
    getAvailableSlots: bookingService.getAvailableSlots,
    saveBookingProposal: bookingDraftService.saveBookingProposal,
  };
  let draftSaved = false;
  (prisma.customer.findUnique as any) = async () => ({ id: 'customer-123', name: 'Joan' });
  (prisma.bookingDraft.findUnique as any) = async () => ({ id: 'miriam-draft', isForSomeoneElse: true });
  (bookingService.getAvailableSlots as any) = async () => ['15:00', '17:00'];
  (bookingDraftService.saveBookingProposal as any) = async () => { draftSaved = true; };

  try {
    await assert.rejects(
      agent.executeProposeBookingTool('customer-123', 'Joan', 'THE ICON', '2026-11-06T16:00'),
      /unavailable on 2026-11-06/i
    );
    assert.equal(draftSaved, false);
  } finally {
    prisma.customer.findUnique = originals.customerFindUnique;
    prisma.bookingDraft.findUnique = originals.bookingDraftFindUnique;
    bookingService.getAvailableSlots = originals.getAvailableSlots;
    bookingDraftService.saveBookingProposal = originals.saveBookingProposal;
  }
});

test('uses the customer-stated day over a conflicting model-proposed date', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T09:00:00Z').getTime() });
  assert.equal(
    agent.getAuthoritativeRequestedDate(
      'she would want on 6th at 4pm',
      '2026-10-07',
      '2026-10-06'
    ),
    '2026-10-06'
  );
});

test('validates configured package deposits without substituting zero or null', async () => {
  const originalEnvironment = process.env.MPESA_ENVIRONMENT;
  let configuredDeposit: number | null = 10;
  try {
    process.env.MPESA_ENVIRONMENT = 'sandbox';
    assert.equal(agent.getDepositForPackage({ name: 'THE ICON', deposit: configuredDeposit }), 10);
    configuredDeposit = 0;
    assert.throws(() => agent.getDepositForPackage({ name: 'THE ICON', deposit: configuredDeposit }), /missing or invalid/);
    configuredDeposit = null;
    assert.throws(() => agent.getDepositForPackage({ name: 'THE ICON', deposit: configuredDeposit }), /missing or invalid/);

    process.env.MPESA_ENVIRONMENT = 'production';
    configuredDeposit = 2000;
    assert.equal(agent.getDepositForPackage({ name: 'THE ICON', deposit: configuredDeposit }), 2000);
    configuredDeposit = 10;
    assert.throws(() => agent.getDepositForPackage({ name: 'THE ICON', deposit: configuredDeposit }), /below the KSh 2,000 minimum/i);
  } finally {
    if (originalEnvironment === undefined) delete process.env.MPESA_ENVIRONMENT;
    else process.env.MPESA_ENVIRONMENT = originalEnvironment;
  }
});

test('rejects an unsupported all-set claim while collecting a new booking time', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'What date and time would work best for Miriam? I will check availability.',
  }];

  assert.equal(
    agent.isUnverifiedBookingConfirmation(
      'Your session is all set for Tuesday, 6 Oct at 4 pm. The payment has gone through.',
      'she would want on 6th at 4pm',
      history
    ),
    true
  );
  assert.equal(agent.isUnverifiedBookingConfirmation('Wonderful choice!', 'Lets go with the Icon', history), false);
});

test('handles a session mix-up correction without changing the existing booking', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T09:00:00Z').getTime() });
  const originals = {
    getDraft: bookingDraftService.get,
    getAvailableSlots: bookingService.getAvailableSlots,
  };
  bookingDraftService.get = async () => null as any;
  (bookingService.getAvailableSlots as any) = async (date: string, duration: number) => {
    assert.equal(date, '2026-10-06');
    assert.equal(duration, 150);
    return ['15:00', '17:00'];
  };
  const history = [
    { role: 'user' as const, content: 'I want the separate session for Miriam.' },
    { role: 'user' as const, content: 'Lets go with the Icon' },
    { role: 'assistant' as const, content: 'Could you let me know a date and time that works best for Miriam?' },
    { role: 'user' as const, content: 'she would want on 6th at 4pm' },
  ];

  try {
    assert.equal(agent.isBookingIdentityCorrection('you are mixing two different sessions, that is mine and we are creating a new one'), true);
    const reply = await agent.getBookingIdentityCorrectionReply('customer-123', history);
    assert.match(reply, /existing appointment is unchanged/i);
    assert.match(reply, /separate THE ICON session for Miriam/i);
    assert.match(reply, /not available/i);
    assert.match(reply, /not created another booking/i);
  } finally {
    bookingDraftService.get = originals.getDraft;
    bookingService.getAvailableSlots = originals.getAvailableSlots;
  }
});

test('date-range availability is bounded and skips Mondays and fully booked days', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T09:00:00Z').getTime() });
  const originals = { bookings: prisma.booking.findMany, drafts: prisma.bookingDraft.findMany, events: googleCalendarService.getEvents };
  const counts = { bookings: 0, drafts: 0, events: 0 };
  let fullyBooked = false;
  (prisma.booking.findMany as any) = async ({ where }: any) => {
    counts.bookings++;
    assert.ok(where.dateTime.gte instanceof Date && where.dateTime.lte instanceof Date);
    return fullyBooked ? [{ dateTime: where.dateTime.gte, durationMinutes: 14 * 24 * 60 }]
      : [{ dateTime: new Date('2026-10-07T06:00:00Z'), durationMinutes: 600 }];
  };
  (prisma.bookingDraft.findMany as any) = async ({ where }: any) => {
    counts.drafts++;
    assert.deepEqual(where.step.in, ['awaiting_confirmation', 'payment_pending']);
    return [];
  };
  (googleCalendarService.getEvents as any) = async (from: Date, to: Date) => {
    counts.events++;
    assert.ok(from < to);
    return [];
  };
  context.after(() => {
    prisma.booking.findMany = originals.bookings;
    prisma.bookingDraft.findMany = originals.drafts;
    googleCalendarService.getEvents = originals.events;
  });
  const result = await bookingService.getAvailableDates('2026-10-05', '2026-10-11', 'THE BLOOM');
  assert.deepEqual(counts, { bookings: 1, drafts: 1, events: 1 });
  assert.equal(result.dates.some((date) => date.weekday === 'Monday'), false);
  assert.equal(result.dates.some((date) => date.date === '2026-10-07'), false);
  assert.deepEqual(result.dates[0], { date: '2026-10-06', weekday: 'Tuesday', slots: ['09:00', '09:30', '10:00'] });
  const longRange = await bookingService.getAvailableDates('2026-10-05', '2026-10-18', 'THE BLOOM');
  assert.deepEqual(counts, { bookings: 2, drafts: 2, events: 2 });
  assert.ok(longRange.dates.every((date) => date.slots.length <= 3));
  assert.ok(JSON.stringify(longRange).length < 1600);
  const clamped = await bookingService.getAvailableDates('2026-10-03', '2026-10-06', 'THE BLOOM');
  assert.equal(clamped.fromDate, '2026-10-04');
  const beforePast = { ...counts };
  const past = await bookingService.getAvailableDates('2026-10-01', '2026-10-03', 'THE BLOOM');
  assert.equal(past.status, 'past');
  assert.match(past.message, /has passed/);
  assert.deepEqual(counts, beforePast);
  fullyBooked = true;
  const empty = await bookingService.getAvailableDates('2026-10-05', '2026-10-11', 'THE BLOOM');
  assert.equal(empty.status, 'unavailable');
  assert.match(empty.message, /closed or fully booked/);
  assert.deepEqual(empty.dates, []);
  const mondayOnly = await bookingService.getAvailableDates('2026-10-05', '2026-10-05', 'THE BLOOM');
  assert.equal(mondayOnly.status, 'unavailable');
  for (const [from, to, service] of [
    ['2026-10-05', '2026-10-19', 'THE BLOOM'],
    ['2026-10-11', '2026-10-05', 'THE BLOOM'],
    ['2026-02-30', '2026-03-01', 'THE BLOOM'],
    ['2026-10-05', '2026-10-11', 'not a package'],
  ]) {
    const before = { ...counts };
    await assert.rejects(bookingService.getAvailableDates(from, to, service));
    assert.deepEqual(counts, before);
  }
  assert.deepEqual(await bookingService.getAvailableSlots('2026-10-05', 90), { status: 'closed', reason: 'Closed on Mondays' });
  assert.deepEqual(await bookingService.getAvailableSlots('2026-10-03', 90), { status: 'closed', reason: 'That date is in the past' });
});

test('availability excludes occupied appointments and competing booking drafts', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-06T06:00:00Z').getTime() });
  const originals = {
    bookingFindMany: prisma.booking.findMany,
    bookingDraftFindMany: prisma.bookingDraft.findMany,
    getEvents: googleCalendarService.getEvents,
  };
  let bookings: any[] = [{
    id: 'existing-booking',
    dateTime: new Date('2026-10-06T10:00:00.000Z'),
    durationMinutes: 150,
  }];
  let drafts: any[] = [];
  (prisma.booking.findMany as any) = async () => bookings;
  (prisma.bookingDraft.findMany as any) = async ({ where }: any) => {
    assert.deepEqual(where.step.in, ['awaiting_confirmation', 'payment_pending']);
    return drafts.filter((draft) => draft.id !== where.id?.not
      && where.step.in.includes(draft.step)
      && draft.updatedAt >= where.updatedAt.gte
      && draft.dateTimeIso !== null);
  };
  (googleCalendarService.getEvents as any) = async () => [];

  try {
    const slotList = (result: Awaited<ReturnType<typeof bookingService.getAvailableSlots>>) => {
      assert.ok(Array.isArray(result), 'expected an open day');
      return result;
    };
    let slots = slotList(await bookingService.getAvailableSlots('2026-10-06', 150));
    assert.equal(slots.includes('13:00'), false);

    bookings = [];
    drafts = [{
      id: 'competing-draft',
      service: 'THE ICON',
      dateTimeIso: '2026-10-06T10:00:00.000Z',
      step: 'collecting_slots',
      date: '2026-10-06',
      time: '13:00',
      updatedAt: new Date(),
    }];
    slots = slotList(await bookingService.getAvailableSlots('2026-10-06', 150));
    assert.equal(slots.includes('13:00'), true, 'collection never holds a slot, even with an ISO value');
    for (const step of ['awaiting_confirmation', 'payment_pending']) {
      drafts[0].step = step;
      drafts[0].updatedAt = new Date();
      slots = slotList(await bookingService.getAvailableSlots('2026-10-06', 150));
      assert.equal(slots.includes('13:00'), false, step);
      drafts[0].updatedAt = new Date(Date.now() - 16 * 60 * 1000);
      slots = slotList(await bookingService.getAvailableSlots('2026-10-06', 150));
      assert.equal(slots.includes('13:00'), true, 'holds expire after fifteen minutes');
    }

    drafts[0].updatedAt = new Date();
    slots = slotList(await bookingService.getAvailableSlots('2026-10-06', 150, undefined, 'competing-draft'));
    assert.equal(slots.includes('13:00'), true);
  } finally {
    prisma.booking.findMany = originals.bookingFindMany;
    prisma.bookingDraft.findMany = originals.bookingDraftFindMany;
    googleCalendarService.getEvents = originals.getEvents;
  }
});

test('recognizes a time reply following a time-only reschedule prompt', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your session is currently on Saturday at 10:00 AM. What time would work better for you that day?'
  }];

  assert.equal(conversationFlows.isTimeOnlyRescheduleSelection('11am', history), true);
  assert.equal(conversationFlows.isTimeOnlyRescheduleSelection('next Tuesday', history), false);
});

test('does not repeat an invalid past-appointment menu', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your appointment has already passed. Would you like to reschedule or cancel it?'
  }];

  assert.equal(agent.isPastAppointmentFollowUp('Do number 2', history), true);
  assert.equal(agent.isPastAppointmentFollowUp('Say that again', history), true);
});

test('recognizes upcoming appointment start-time questions', () => {
  assert.equal(agent.shouldUseUpcomingAppointmentTimeReply('When does it start?'), true);
  assert.equal(agent.shouldUseUpcomingAppointmentTimeReply('When does my session start?'), true);
  assert.equal(agent.shouldUseUpcomingAppointmentTimeReply('What time is my appointment?'), true);
});

test('uses stored appointment duration for session detail replies', () => {
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('Any details about the shoot?'), true);
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('What time is my session?'), false);
  assert.equal(agent.shouldUseLastAppointmentDetailsReply('Tell me about my last session'), true);
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply('Tell me about my last session'), false);
  assert.equal(agent.formatBookingDuration(150), '2 hours 30 minutes');
  assert.equal(agent.formatBookingDuration(210), '3 hours 30 minutes');
});

test('answers upcoming session details naturally and acknowledges repeat questions', async () => {
  const originalBookingFindFirst = prisma.booking.findFirst;
  const originalPaymentFindFirst = prisma.payment.findFirst;
  (prisma.booking.findFirst as any) = async () => ({
    id: 'upcoming-booking',
    service: 'THE ICON',
    dateTime: new Date('2026-09-27T07:00:00.000Z'),
    durationMinutes: 150,
    recipientName: 'Maryanne',
    customer: { name: 'Njerii' },
    bookingAddons: [
      { name: 'Extra outfit beyond package', quantity: 1 },
      { name: 'Styled wig hire', quantity: 1 },
    ],
  });
  (prisma.payment.findFirst as any) = async () => ({ amount: 10 });

  try {
    const reply = await agent.getUpcomingAppointmentDetailsReply('customer-123');
    assert.match(reply || '', /Your THE ICON session is on Sunday, 27 September 2026 at 10:00 AM for Maryanne/);
    assert.match(reply || '', /It runs for 2 hours 30 minutes at our Parklands studio/);
    assert.match(reply || '', /saved extras are Extra outfit beyond package and Styled wig hire/);
    assert.match(reply || '', /confirmed, and your deposit has been paid/);

    const repeatReply = await agent.getUpcomingAppointmentDetailsReply('customer-123', [
      { role: 'user', content: 'Tell me the details of tomorrow’s session' },
      { role: 'assistant', content: reply || '' },
    ]);
    assert.match(repeatReply || '', /^It’s the same session we just discussed:/);
    assert.match(repeatReply || '', /THE ICON.*Sunday, 27 September 2026 at 10:00 AM/);
  } finally {
    prisma.booking.findFirst = originalBookingFindFirst;
    prisma.payment.findFirst = originalPaymentFindFirst;
  }
});

test('does not mistake a general booking-process question for personal session details', () => {
  const question = 'what is the booking process of the studio';

  assert.equal(agent.shouldUseBookingProcessReply(question), true);
  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply(question), false);
});

test('answers last-session questions from the most recent past booking', async () => {
  const originalFindFirst = prisma.booking.findFirst;
  (prisma.booking.findFirst as any) = async () => ({
    service: 'THE ICON',
    dateTime: new Date('2026-08-10T07:00:00.000Z'),
    durationMinutes: 150,
    recipientName: 'Maryanne',
    bookingAddons: [{ name: 'Styled wig hire', quantity: 1 }],
  });

  try {
    const reply = await agent.getLastAppointmentDetailsReply('customer-123');
    assert.match(reply, /most recent past booking.*THE ICON/i);
    assert.match(reply, /\nDate: .*\nDuration: 2 hours 30 minutes\nBooked for: Maryanne/);
    assert.match(reply, /Add-ons recorded:\n- Styled wig hire/);
    assert.match(reply, /Does that sound like the session you mean/);
    assert.doesNotMatch(reply, /upcoming session is on/);
  } finally {
    prisma.booking.findFirst = originalFindFirst;
  }
});

test('routes plural previous-appointment requests to a past-only booking list', async () => {
  const originalFindMany = prisma.booking.findMany;
  let query: any;
  (prisma.booking.findMany as any) = async (args: any) => {
    query = args;
    return [
      { service: 'THE ICON', dateTime: new Date('2026-09-27T07:00:00.000Z'), status: 'confirmed' },
      { service: 'THE MUSE', dateTime: new Date('2026-09-19T07:00:00.000Z'), status: 'confirmed' },
    ];
  };

  try {
    assert.equal(agent.shouldUsePastAppointmentsListReply('Could you show me the previous appointments I have had in the studio?'), true);
    const reply = await agent.getPastAppointmentsListReply('customer-123');
    assert.ok(query.where.dateTime.lt instanceof Date);
    assert.ok(query.where.dateTime.lt.getTime() <= Date.now());
    assert.match(reply, /Sunday, 27 September 2026/);
    assert.match(reply, /Saturday, 19 September 2026/);
    assert.match(reply, /doesn't confirm whether each session took place/i);
  } finally {
    prisma.booking.findMany = originalFindMany;
  }
});

test('does not claim payment was received without a successful payment record', async () => {
  const originals = {
    bookingFindFirst: prisma.booking.findFirst,
    paymentFindFirst: prisma.payment.findFirst,
    draftFindUnique: prisma.bookingDraft.findUnique,
  };
  let payment: any = null;
  (prisma.bookingDraft.findUnique as any) = async () => null;
  (prisma.booking.findFirst as any) = async () => ({
    id: 'confirmed-booking',
    service: 'THE ICON',
    dateTime: new Date('2026-10-06T10:00:00.000Z'),
  });
  (prisma.payment.findFirst as any) = async () => payment;

  try {
    const unpaidStatusReply = await agent.getBookingStatusReply('customer-123');
    assert.match(unpaidStatusReply || '', /session for the Icon edition is confirmed/i);
    assert.match(unpaidStatusReply || '', /can't verify a successful payment/i);
    assert.doesNotMatch(unpaidStatusReply || '', /payment is received/i);

    payment = { mpesaReceipt: 'ABC123' };
    const paidStatusReply = await agent.getBookingStatusReply('customer-123');
    assert.match(paidStatusReply || '', /payment is received and confirmed.*ABC123/i);
  } finally {
    prisma.booking.findFirst = originals.bookingFindFirst;
    prisma.payment.findFirst = originals.paymentFindFirst;
    prisma.bookingDraft.findUnique = originals.draftFindUnique;
  }
});

test('routes a generic reschedule request before tool calling', () => {
  assert.equal(agent.shouldUseRescheduleRequestReply('Can I reschedule?'), true);
  assert.equal(agent.shouldUseRescheduleRequestReply('Can I reschedule the time kindly'), false);
  assert.equal(agent.shouldUseRescheduleRequestReply('Can I reschedule to 2026-09-28 at 10am?'), false);
});

test('stops a reschedule flow when the customer withdraws the request', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your session is within 72 hours, so rescheduling would forfeit your deposit. Would you still like to proceed?'
  }];

  assert.equal(agent.shouldUseRescheduleWithdrawalReply("Let's not reschedule then", history), true);
  assert.equal(agent.shouldUseRescheduleRequestReply("Let's not reschedule then"), true);
});

test('confirms the original booking after a withdrawal follow-up', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'We will keep your original session date and time, and your booking remains unchanged. Your deposit is still held for that session.'
  }];

  assert.equal(agent.shouldConfirmRescheduleWithdrawal('Sure?', history), true);
  assert.equal(agent.shouldConfirmRescheduleWithdrawal('What time is it?', history), false);
  const rescheduleConfirmation = [
    { role: 'assistant' as const, content: 'Your current booking remains unchanged until you confirm a proposed change.' },
    { role: 'user' as const, content: 'Lets go with 2:00 PM.' },
    { role: 'assistant' as const, content: "Could you please confirm that you'd like to reschedule your Goddess session to Sunday at 2:00 PM?" },
  ];
  assert.equal(agent.shouldConfirmRescheduleWithdrawal('yes', rescheduleConfirmation), false);
});

test('returns reschedule confirmation without waiting for Google Calendar', { timeout: 1000 }, async () => {
  const originals = {
    bookingDraftFindUnique: prisma.bookingDraft.findUnique,
    bookingFindUnique: prisma.booking.findUnique,
    bookingUpdate: prisma.booking.update,
    bookingDraftDeleteMany: prisma.bookingDraft.deleteMany,
    updateCalendarEvent: googleCalendarService.updateEvent,
    notifyRescheduleAdmin: agent.notifyRescheduleAdmin,
  };
  let bookingUpdated = false;
  let draftCleared = false;
  (prisma.bookingDraft.findUnique as any) = async () => ({
    id: 'reschedule-draft-123',
    step: 'reschedule_confirm',
    bookingId: 'booking-123',
    date: '2026-10-04',
    time: '15:00',
    dateTimeIso: '2026-10-04T15:00:00',
  });
  (prisma.booking.findUnique as any) = async () => ({
    id: 'booking-123',
    service: 'THE ICON',
    dateTime: new Date('2026-10-03T11:00:00.000Z'),
    googleEventId: 'calendar-event-123',
    customer: { name: 'Joan' },
  });
  (prisma.booking.update as any) = async () => {
    bookingUpdated = true;
    return {};
  };
  (prisma.bookingDraft.deleteMany as any) = async ({ where }: any) => {
    assert.deepEqual(where, { id: 'reschedule-draft-123', customerId: 'customer-123', step: 'reschedule_confirm', bookingId: 'booking-123' });
    draftCleared = true;
    return { count: 1 };
  };
  (googleCalendarService.updateEvent as any) = () => new Promise(() => {});
  agent.notifyRescheduleAdmin = () => new Promise(() => {});

  try {
    const reply = await agent.tryImmediateConfirmation('customer-123', 'yes', [{
      role: 'assistant', content: "To make sure I have this exactly right for you, could you please confirm that you'd like to move your session to Sunday, October 11th at 2:00 PM?",
    }]);

    assert.match(reply, /session has been moved/i);
    assert.equal(bookingUpdated, true);
    assert.equal(draftCleared, true);
  } finally {
    prisma.bookingDraft.findUnique = originals.bookingDraftFindUnique;
    prisma.booking.findUnique = originals.bookingFindUnique;
    prisma.booking.update = originals.bookingUpdate;
    prisma.bookingDraft.deleteMany = originals.bookingDraftDeleteMany;
    googleCalendarService.updateEvent = originals.updateCalendarEvent;
    agent.notifyRescheduleAdmin = originals.notifyRescheduleAdmin;
  }
});

test('recognizes acknowledgements after completed actions', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your THE ICON session has been moved to Friday, September 25, 2026 at 1:00 PM.'
  }];

  assert.equal(agent.isPostActionAcknowledgement('okay thank you', history), true);
  assert.equal(agent.isPostActionAcknowledgement('What time is it?', history), false);
});

test('recognizes acknowledgements after appointment reminders', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Hi Njerii, your THE ICON session is tomorrow at 10:00 AM. Please arrive about 30 minutes early so there is time to get settled and ready.'
  }];

  assert.equal(agent.isPostActionAcknowledgement('okay thank you', history), true);
  assert.equal(agent.isPostActionAcknowledgement('Which package is best?', history), false);
});

test('treats polite thanks as an acknowledgement, not booking confirmation', () => {
  const pendingProposal = [{
    role: 'assistant' as const,
    content: 'If that works for you, reply yes and I will send the M-Pesa prompt.'
  }];

  assert.equal(agent.isPostActionAcknowledgement('Perfect, thanks.', pendingProposal), true);
  assert.equal(agent.isPostActionAcknowledgement('Okay, thank you', pendingProposal), true);
  assert.equal(agent.isPostActionAcknowledgement('okay', pendingProposal), false);
  assert.equal(agent.isPostActionAcknowledgement('Got it', []), true);
});

test('distinguishes booking for a relative from a joint session', () => {
  assert.equal(agent.shouldClarifyBookingForSomeoneElse('I want to book a session for my sister'), true);
  assert.equal(agent.shouldUseMultiPersonBookingReply('I want to book a session for my sister'), false);
  assert.equal(agent.shouldClarifyBookingForSomeoneElse('I want to book a session with my sister'), false);
  assert.equal(agent.shouldUseMultiPersonBookingReply('I want to book a session with my sister'), true);
});

test('handles studio policies without relying on the AI provider', () => {
  assert.match(agent.getStudioPolicyReply('Do you have late night sessions?') || '', /9 AM to 7 PM/i);
  assert.match(agent.getStudioPolicyReply('Can my partner join the maternity shoot?') || '', /welcome/i);
  assert.match(agent.getStudioPolicyReply('Can I do a semi-nude maternity session?') || '', /professionalism and privacy/i);
});

test('keeps partner fee follow-ups in conversational context instead of forcing a template', () => {
  const question = 'Does my husband have to pay extra?';
  assert.equal(agent.getScopeBoundaryReply(question), null);
  assert.equal(agent.shouldClarifyMixedIntent(question), false);
  assert.equal(agent.shouldUseMultiPersonBookingReply(question), false);
});

test('keeps reproductive-health questions outside the studio assistant scope', () => {
  assert.match(agent.getOutOfScopeReply('How do I know my fertile window?') || '', /qualified professional/i);
  assert.match(agent.getOutOfScopeReply('How do I know when I am ovulating?') || '', /qualified professional/i);
  assert.match(agent.getOutOfScopeReply('Can I fuck my best friend for good seeds?') || '', /qualified professional/i);
  assert.match(agent.getOutOfScopeReply('Can you talk dirty to me?') || '', /keep things professional/i);
  assert.equal(agent.getOutOfScopeReply('Can I book a maternity session when I am pregnant?'), null);
});

test('redirects unrelated questions while allowing Fiesta House requests', () => {
  assert.match(agent.getScopeBoundaryReply('What is the capital of France?') || '', /Fiesta House studio assistant/i);
  assert.match(agent.getScopeBoundaryReply('Who is the president of Kenya?') || '', /Fiesta House studio assistant/i);
  assert.match(agent.getScopeBoundaryReply('Tell me a joke') || '', /shoots and bookings/i);
  assert.match(agent.getScopeBoundaryReply('Do I need a girlfriend?') || '', /Fiesta House studio assistant/i);
  assert.match(agent.getScopeBoundaryReply('Should I take out a loan?') || '', /qualified professional/i);
  assert.match(agent.getScopeBoundaryReply('Okay thanks... do I need a girlfriend?') || '', /Fiesta House studio assistant/i);
  assert.equal(agent.getScopeBoundaryReply('Tell me about the business'), null);
  assert.equal(agent.getScopeBoundaryReply('Where is it located at?'), null);
  assert.equal(agent.getScopeBoundaryReply('What does it look like there?'), null);
  assert.equal(agent.getScopeBoundaryReply('What about Saturday?', [{
    role: 'assistant',
    content: 'Fiesta House offers maternity sessions. Which date would you prefer for your booking?'
  }]), null);
  assert.equal(agent.getScopeBoundaryReply('What should I wear for my maternity shoot?'), null);
  assert.equal(agent.getScopeBoundaryReply('Can my partner be in the photos?'), null);
});

test('returns the out-of-scope reply before invoking the AI pipeline', async () => {
  const originalRunAgent = agent.runAgent;
  agent.runAgent = async () => {
    throw new Error('The AI pipeline should not be called');
  };

  try {
    const reply = await agent.handleMessage('customer-123', 'How do I know whether an egg is viable for fertilization?');
    assert.match(reply, /qualified professional/i);
  } finally {
    agent.runAgent = originalRunAgent;
  }
});

test('returns the unrelated-topic redirect before invoking the AI pipeline', async () => {
  const originalRunAgent = agent.runAgent;
  agent.runAgent = async () => {
    throw new Error('The AI pipeline should not be called');
  };

  try {
    const reply = await agent.handleMessage('customer-123', 'Tell me a joke');
    assert.match(reply, /Fiesta House studio assistant/i);
  } finally {
    agent.runAgent = originalRunAgent;
  }
});

test('captures a named recipient after booking-for-someone clarification', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Is the session just for your sister, or would you both like to be photographed together?'
  }];

  assert.equal(agent.shouldCaptureRecipientName('Maryanne Nuduta', history), true);
  assert.equal(agent.shouldCaptureRecipientName('the cheapest one', history), false);
});

test('captures a recipient named before the clarification reply', () => {
  const history = [{
    role: 'user' as const,
    content: 'I wanted to book a session for my sister'
  }];

  assert.equal(agent.shouldCaptureRecipientName('Maryanne Nuduta', history), true);
});

test('does not guess what an ambiguous 10k deposit means', async () => {
  const originalPackageFindUnique = prisma.package.findUnique;
  (prisma.package.findUnique as any) = async () => ({ name: 'THE BLOOM', deposit: 2000 });
  try {
  assert.equal(agent.shouldClarifyAmbiguousDeposit('she wants the one with the 10 sh deposit in it'), true);
    assert.match(await agent.getAmbiguousDepositReply(), /Do you mean a Ksh 10,000 deposit|add-on/i);
  } finally {
    prisma.package.findUnique = originalPackageFindUnique;
  }
});

test('anchors numeric booking dates to the customer message', () => {
  const extractedDate = dayjs().add(1, 'month').startOf('month').date(27);
  assert.equal(
    agent.getAuthoritativeRequestedDate(
      '27th at 9am',
      extractedDate.add(1, 'day').format('YYYY-MM-DD'),
      extractedDate.format('YYYY-MM-DD')
    ),
    extractedDate.format('YYYY-MM-DD')
  );
});

test('keeps a time-only booking reply on the previously offered weekday', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'We have a full slate of slots on Sunday. Which time works best?'
  }];
  const sundayDate = agent.getAuthoritativeRequestedDate('2pm', '2026-10-03', null, history);

  assert.equal(dayjs(sundayDate).day(), 0);
});

test('uses the exact date when the offered weekday context includes it', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Available slots for THE ICON on Sunday, 2026-10-04: 2:00 PM.'
  }];

  assert.equal(
    agent.getAuthoritativeRequestedDate('2pm', '2026-10-03', null, history),
    '2026-10-04'
  );
});

test('formats additions as plain WhatsApp text and uses the package deposit helper', async () => {
  const originalPackageFindFirst = prisma.package.findFirst;
  (prisma.package.findFirst as any) = async () => ({ name: 'THE BLOOM', deposit: 2500 });
  try {
    const reply = await agent.getAdditionsReply();

    assert.doesNotMatch(reply, /\|.*\|/);
    assert.match(reply, /Extra edited photo: Ksh 1,000 each/);
    assert.match(reply, /not included in the Ksh 2,500 deposit/);
    assert.match(reply, /Nothing has been added yet/);
  } finally {
    prisma.package.findFirst = originalPackageFindFirst;
  }
});

test('the additions reply is recognized by its follow-up matcher', () => {
  const reply = buildAdditionsReply(null);
  assert.equal(isAddonListFollowUp('show me', [{ role: 'assistant', content: reply }]), true);
  assert.equal(isAddonListFollowUp('show me', [{ role: 'assistant', content: 'Your session is on Friday.' }]), false);
});

test('earliest photo delivery replies stay paired with their request matcher', async () => {
  const originalFindFirst = prisma.booking.findFirst;
  try {
    (prisma.booking.findFirst as any) = async () => null;
    const noBookingReply = await agent.getEarliestImageDeliveryReply('customer-123');
    assert.equal(agent.shouldUseEarliestImageDeliveryReply('When can I get the photos?'), true);
    assert.match(noBookingReply, /share your booked date/i);

    (prisma.booking.findFirst as any) = async () => ({ dateTime: new Date('2026-07-01T07:00:00.000Z') });
    const bookedReply = await agent.getEarliestImageDeliveryReply('customer-123');
    assert.equal(agent.shouldUseEarliestImageDeliveryReply('When is the delivery date for images?'), true);
    assert.match(bookedReply, /earliest delivery date is/);
  } finally {
    prisma.booking.findFirst = originalFindFirst;
  }
});

test('static reply builders remain paired with their request matchers', async () => {
  const originalGetPackageForDeposit = agent.getPackageForDeposit;
  const originalGetDepositForPackage = agent.getDepositForPackage;
  const originalStudioInfoFindFirst = prisma.studioInfo.findFirst;
  const originalPackageFindMany = prisma.package.findMany;
  agent.getPackageForDeposit = async () => null;
  agent.getDepositForPackage = () => null;
  (prisma.studioInfo.findFirst as any) = async () => null;
  (prisma.package.findMany as any) = async () => [];

  try {
    const bookingProcessReply = await agent.getBookingProcessReply();
    const pairs: Array<{ message: string; matches: (message: string) => boolean; reply: string }> = [
      { message: "What's your cheapest package?", matches: isPackageBudgetRequest, reply: buildPackageBudgetReply() },
      { message: 'What add-ons do you have?', matches: isAdditionsRequest, reply: buildAdditionsReply(null) },
      { message: 'What happens after the shoot?', matches: isPostShootProcessRequest, reply: buildPostShootProcessReply() },
      { message: 'Can I get raw files?', matches: isRawFilesRequest, reply: buildRawFilesReply() },
      { message: 'Do you do bespoke shoots?', matches: isBespokeRequest, reply: buildBespokeReply() },
      { message: "I'm travelling from abroad", matches: isTravellingMothersRequest, reply: buildTravellingMothersReply() },
      { message: "What's your instagram?", matches: isSocialMediaRequest, reply: buildSocialMediaReply() },
      { message: 'How to book a session?', matches: isBookingProcessRequest, reply: bookingProcessReply },
      { message: 'I want to book a session for my sister', matches: isBookingForSomeoneElseRequest, reply: buildBookingForSomeoneElseReply() },
      { message: 'Can my sister join the shoot with me?', matches: isMultiPersonBookingRequest, reply: buildMultiPersonBookingReply() },
    ];

    for (const pair of pairs) {
      assert.equal(pair.matches(pair.message), true, pair.message);
      assert.ok(pair.reply.length > 0, pair.message);
    }
    assert.equal(buildBusinessIntroductionReply(), 'Welcome to Fiesta House Maternity. What kind of session are you planning?');
    assert.match(buildContactDetailsReply(), /Parklands, Nairobi/);
    assert.match(buildWebsiteReply(), /fiestahousematernity\.com/);
    assert.match(buildPortfolioReply(), /portfolio/);
    assert.match(getReviewPageReply('Where can I read your reviews?') || '', /\/reviews/);
    assert.match(getSuspendingConceptGalleryReply('Where can I see the Suspending Concept?', []) || '', /\/gallery\/suspending-concept/);
  } finally {
    agent.getPackageForDeposit = originalGetPackageForDeposit;
    agent.getDepositForPackage = originalGetDepositForPackage;
    prisma.studioInfo.findFirst = originalStudioInfoFindFirst;
    prisma.package.findMany = originalPackageFindMany;
  }
});

test('confirmation proposal builders remain recognized by the history matcher', () => {
  const replies = [
    buildBookingProposalConfirmation('THE ICON', '2026-10-10', '15:00', 3210),
    buildRescheduleProposalConfirmation('THE ICON', '2026-10-17', '16:00'),
    buildTimeOnlyRescheduleProposal('THE ICON', 'Saturday, October 10', '3:00 PM'),
    buildPackageDepositProposal('THE ICON', 'Saturday, October 10', '3:00 PM', 3210),
    buildCancellationProposal('THE ICON', 'THE ICON on Saturday, October 10 at 3:00 PM', 'It is eligible under policy.'),
  ];

  for (const reply of replies) {
    assert.equal(previousMessageRequestsConfirmation([{ role: 'assistant', content: reply }]), true, reply);
  }
});

test('recognizes an add-on selection without restarting booking', () => {
  const addon = agent.getSelectedAddon('okay i would want styles wig');

  assert.equal(addon?.sku, 'wig_hire');
  assert.match(agent.getAddonSelectionReply(addon), /Styled wig hire|Ksh 4,000|not the deposit/i);
  assert.equal(agent.getSelectedAddon('add an extra professional make-up for me as an add on')?.sku, 'extra_makeup');
  assert.equal(agent.getSelectedAddon('lets include the suspenind concep')?.sku, 'suspending_concept');
});

test('persists the common Suspending Concept misspelling as its priced add-on', async () => {
  const originalFindFirst = prisma.bookingAddon.findFirst;
  const originalCreate = prisma.bookingAddon.create;
  let createdAddon: any;
  (prisma.bookingAddon.findFirst as any) = async () => null;
  (prisma.bookingAddon.create as any) = async ({ data }: any) => {
    createdAddon = data;
    return data;
  };

  try {
    const createdCount = await bookingAddonService.createFromNote({
      customerId: 'customer-123',
      bookingId: 'booking-123',
      note: 'lets include the suspenind concep',
    });

    assert.equal(createdCount, 1);
    assert.equal(createdAddon.sku, 'suspending_concept');
    assert.equal(createdAddon.name, 'Suspending Concept');
    assert.equal(createdAddon.unitPrice, 7000);
    assert.equal(createdAddon.totalPrice, 7000);
  } finally {
    prisma.bookingAddon.findFirst = originalFindFirst;
    prisma.bookingAddon.create = originalCreate;
  }
});

test('links to the dedicated Suspending Concept gallery after a contextual visual question', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'The Suspending Concept is a dreamy, ethereal add-on.'
  }];
  const reply = agent.getSuspendingConceptGalleryReply('Where can I see this idea?', history);

  assert.match(reply, /https:\/\/www\.fiestahousematernity\.com\/gallery\/suspending-concept/);
  assert.equal(agent.getSuspendingConceptGalleryReply('Where can I see this idea?', []), null);
  assert.equal(agent.getSuspendingConceptGalleryReply('Show me the packages', history), null);
  assert.match(
    agent.getSuspendingConceptGalleryReply('Show me some pictures', history),
    /https:\/\/www\.fiestahousematernity\.com\/gallery\/suspending-concept/
  );
});

test('links review and testimonial page requests to the reviews page', () => {
  const reply = agent.getReviewPageReply('Is there a reviews page I can see these?');

  assert.match(reply, /https:\/\/www\.fiestahousematernity\.com\/reviews/);
  assert.equal(agent.getReviewPageReply('What do clients say about the studio?'), null);
});

test('sanitizes unverified Fiesta House URLs in model replies', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'The Suspending Concept is one of our add-ons.'
  }];

  assert.match(
    agent.formatCustomerReply('See our testimonials: https://www.fiestahousematernity.com/testimonials'),
    /https:\/\/www\.fiestahousematernity\.com\/reviews/
  );
  assert.match(
    agent.formatCustomerReply('View it here: https://www.fiestahousematernity.com/gallery', 'Where can I see this?', history),
    /https:\/\/www\.fiestahousematernity\.com\/gallery\/suspending-concept/
  );
  assert.match(
    agent.formatCustomerReply('See this page: https://www.fiestahousematernity.com/fake-page'),
    /https:\/\/www\.fiestahousematernity\.com\/$/
  );
});

test('resolves an affirmative reply to a single offered paid add-on', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Professional makeup is included in your THE ICON package. If you’d like an extra makeup touch-up or a second set of looks, we can add that for Ksh 3,500. Just let me know!'
  }];
  const addon = agent.getSelectedAddon('yess thats what i want', history);

  assert.equal(addon?.sku, 'extra_makeup');
  assert.match(agent.getAddonSelectionReply(addon), /Extra professional makeup.*Ksh 3,500/);
});

test('does not infer a specific add-on from a general list or vague affirmation', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Here are the add-ons we offer: extra makeup, styled wig hire, or extra edited photos. Let me know if any interest you.'
  }];

  assert.equal(agent.getSelectedAddon('yes', history), null);
});

test('routes previous add-on questions to booking history', () => {
  const history = [
    { role: 'assistant' as const, content: 'Here are the add-ons we can include with your session.' },
    { role: 'user' as const, content: 'Which one did I choose previously?' },
  ];

  assert.equal(agent.shouldUsePreviousAddonReply('Which one did I choose previously?', history), true);
  assert.equal(agent.shouldUsePreviousAddonReply('Which package should I choose?', history), false);
});

test('treats "show me" after the add-on clarification as a request for the priced list', () => {
  const history = [
    { role: 'assistant' as const, content: 'Which add-on would you like to add to your session? I can show you the available extras if you are not sure yet.' },
  ];

  assert.equal(agent.isAddonListFollowUp('Show me', history), true);
  assert.equal(agent.isAddonListFollowUp('Show me', [{ role: 'assistant' as const, content: 'Your session is confirmed.' }]), false);
  assert.equal(agent.isAddonListFollowUp('okay i would want styled wig', history), false);
  assert.equal(
    agent.isAddonListFollowUp('Show me', [{ role: 'assistant' as const, content: 'Here are the add\u2011ons we can include with your session:' }]),
    true
  );
});

test('add-on pricing injected into the prompt carries exact figures, never "varies"', () => {
  const line = agent.getAddonPricingLine();

  assert.match(line, /Fiesta House Power Suit: Ksh 10,000/);
  assert.match(line, /Suspending Concept: Ksh 7,000/);
  assert.match(line, /Goddess Sculpture Set: Ksh 15,000/);
  assert.doesNotMatch(line, /varies/i);
});

test('"show me all that are in my session today" asks for booking details, not intent clarification', () => {
  const message = 'show me all that are in my session the one to happen today';

  assert.equal(agent.shouldUseUpcomingAppointmentDetailsReply(message), true);
  assert.equal(agent.shouldClarifyMixedIntent(message), false);
  assert.equal(agent.shouldClarifyMixedIntent('can I move my THE ICON booking invoice to next Tuesday'), true);
});

test('clarifies a new add-on request without invoking the model', () => {
  const history = [
    { role: 'assistant' as const, content: 'Which add-on would you like to add to your session?' },
  ];

  assert.equal(agent.shouldClarifyNewAddon('Okay so I want to add a new one on September 25th', history), true);
  assert.equal(agent.shouldClarifyNewAddon('I want to book a new session', history), false);
});

test('enforces the 72-hour reschedule cutoff', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');

  assert.equal(agent.isRescheduleWithin72Hours(new Date('2026-09-24T18:00:00.000Z'), now), true);
  assert.equal(agent.isRescheduleWithin72Hours(new Date('2026-09-27T12:00:00.000Z'), now), false);
  assert.equal(agent.isRescheduleWithin72Hours(new Date('2026-09-23T18:00:00.000Z'), now), false);
  assert.match(agent.getReschedulePolicyMessage(), /within 72 hours|forfeit your deposit/i);
});

test('retries transient WhatsApp delivery failures and normalizes special whitespace', async () => {
  const originalPost = axios.post;
  const calls: any[] = [];

  (axios.post as any) = async (...args: any[]) => {
    calls.push(args[1]);
    const [url, payload] = args;
    if (calls.length === 1) {
      const error = new Error('Service temporarily unavailable');
      (error as any).response = { data: { error: { code: 2, message: 'Service temporarily unavailable' } } };
      (error as any).isAxiosError = true;
      throw error;
    }

    return { data: { messages: [{ id: 'wamid-123' }] } };
  };

  try {
    const result = await whatsappService.sendMessage('254721840961', 'Hello\u202Fthere\u200B');
    assert.equal(result.messages[0].id, 'wamid-123');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].text.body, 'Hello there');
    assert.equal(calls[1].text.body, 'Hello there');
    assert.equal(normalizeWhatsappText('Ksh\u202F35,000'), 'Ksh 35,000');
  } finally {
    axios.post = originalPost;
  }
});

test('routes invoice requests to stored PDF delivery instead of a fabricated invoice text reply', () => {
  assert.equal(agent.shouldUseInvoiceRequestReply('Could you send me the invoice?'), true);
  assert.equal(agent.shouldUseInvoiceRequestReply('What packages do you offer?'), false);
  assert.equal(agent.extractInvoiceNumber('Could you send me invoice INV-2026-005?'), 'INV-2026-005');
  assert.equal(agent.shouldClarifyMixedIntent('Give me the invoice for the 25th sep session'), false);
  assert.deepEqual(
    agent.extractInvoiceSessionDateRange('Give me the invoice for the 25th sep session'),
    { start: new Date('2026-09-24T21:00:00.000Z'), end: new Date('2026-09-25T21:00:00.000Z') }
  );
  assert.equal(agent.shouldDeclineConsolidatedInvoiceRequest('Could you send me the full invoice for all sessions in one?'), true);
  assert.equal(agent.shouldDeclineConsolidatedInvoiceRequest('Could you send me the invoice for the 25th sep session?'), false);
});

test('routes a not-received invoice follow-up to stored invoice delivery', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Your updated invoice has just been sent to your WhatsApp.'
  }];

  assert.equal(agent.shouldUseInvoiceRequestReply('I have not received it', history), true);
  assert.equal(agent.shouldUseInvoiceRequestReply('I have not received it..send it to me', history), true);
  assert.equal(agent.shouldUseInvoiceRequestReply('I have not received it..send it to me', []), false);
});

test('keeps the selected session date when retrying an invoice delivery', () => {
  const history = [
    { role: 'assistant' as const, content: 'Please tell me which session date you need for the invoice.' },
    { role: 'user' as const, content: 'the one on 19th september' },
    { role: 'assistant' as const, content: 'I will pull up the invoice for your THE ICON session on 19 Sep 2026 and send it to you.' },
  ];

  assert.deepEqual(agent.getInvoiceSessionDateFromHistory(history), {
    start: new Date('2026-09-18T21:00:00.000Z'),
    end: new Date('2026-09-19T21:00:00.000Z'),
  });
});

test('routes a selected session date to invoice delivery after asking which invoice is needed', () => {
  const history = [{
    role: 'assistant' as const,
    content: 'Invoices are issued per booking. Please tell me which session date you need.',
  }];

  assert.equal(agent.shouldUseInvoiceRequestReply('the one on 19th september', history), true);
  assert.equal(agent.shouldUseInvoiceRequestReply('the one on 19th september', []), false);
});

test('does not send a single booking invoice for a consolidated invoice request', async () => {
  const originalInvoiceFindFirst = prisma.invoice.findFirst;
  (prisma.invoice.findFirst as any) = async () => {
    throw new Error('A consolidated request must not select one saved invoice');
  };

  try {
    const reply = await agent.sendStoredInvoiceToCustomer(
      'customer-123',
      undefined,
      [],
      'Could you send me the full invoice for all sessions just in one?'
    );
    assert.match(reply, /cannot combine multiple sessions into one invoice/i);
    assert.match(reply, /I have not sent an invoice/i);
  } finally {
    prisma.invoice.findFirst = originalInvoiceFindFirst;
  }
});

test('refreshes an existing invoice with newly selected priced add-ons', async () => {
  const originals = {
    bookingFindUnique: prisma.booking.findUnique,
    invoiceFindUnique: prisma.invoice.findUnique,
    packageFindFirst: prisma.package.findFirst,
    paymentFindMany: prisma.payment.findMany,
    invoiceUpdate: prisma.invoice.update,
    sumForBooking: bookingAddonService.sumForBooking,
    markInvoiced: bookingAddonService.markInvoiced,
    generatePdf: invoiceService.generatePdf,
  };
  const existingInvoice = {
    id: 'invoice-1',
    invoiceNumber: 'INV-2026-006',
    status: 'sent',
    sentAt: new Date('2026-09-30T17:00:00.000Z'),
    paidAt: null,
    tax: 0,
    discount: 0,
    createdAt: new Date('2026-09-30T16:00:00.000Z'),
  };
  let updateData: any;
  let pdfInput: any;

  (prisma.booking.findUnique as any) = async () => ({
    id: 'booking-1',
    customerId: 'customer-1',
    service: 'THE ICON',
    dateTime: new Date('2026-10-03T11:00:00.000Z'),
    customer: { name: 'Joan', phone: '254700000000' },
  });
  (prisma.invoice.findUnique as any) = async () => existingInvoice;
  (prisma.package.findFirst as any) = async () => ({ price: 35000 });
  (prisma.payment.findMany as any) = async () => [{ amount: 10, mpesaReceipt: 'TEST-RECEIPT' }];
  (prisma.invoice.update as any) = async ({ data }: any) => {
    updateData = data;
    return { ...existingInvoice, ...data, booking: { service: 'THE ICON', dateTime: new Date('2026-10-03T11:00:00.000Z') } };
  };
  (bookingAddonService.sumForBooking as any) = async () => ({
    addonsTotal: 3500,
    lineItems: [{ name: 'Extra professional makeup', quantity: 1, unitPrice: 3500, totalPrice: 3500 }],
  });
  (bookingAddonService.markInvoiced as any) = async () => {};
  (invoiceService.generatePdf as any) = async (data: any) => {
    pdfInput = data;
    return Buffer.from('refreshed-pdf');
  };

  try {
    const invoice = await invoiceService.createOrRefreshForBooking('booking-1');

    assert.ok(invoice);
    assert.equal(invoice.invoiceNumber, 'INV-2026-006');
    assert.equal(updateData.total, 38500);
    assert.equal(updateData.depositPaid, 10);
    assert.equal(updateData.balanceDue, 38490);
    assert.equal(updateData.status, 'sent');
    assert.deepEqual(pdfInput.addonLines, [{
      name: 'Extra professional makeup', quantity: 1, unitPrice: 3500, totalPrice: 3500,
    }]);
    assert.equal(updateData.pdfData.toString(), 'refreshed-pdf');
  } finally {
    prisma.booking.findUnique = originals.bookingFindUnique;
    prisma.invoice.findUnique = originals.invoiceFindUnique;
    prisma.package.findFirst = originals.packageFindFirst;
    prisma.payment.findMany = originals.paymentFindMany;
    prisma.invoice.update = originals.invoiceUpdate;
    bookingAddonService.sumForBooking = originals.sumForBooking;
    bookingAddonService.markInvoiced = originals.markInvoiced;
    invoiceService.generatePdf = originals.generatePdf;
  }
});

test('includes add-ons linked through a booking session note when invoicing', async () => {
  const originals = {
    sessionNoteFindMany: prisma.customerSessionNote.findMany,
    addonFindMany: prisma.bookingAddon.findMany,
    addonUpdateMany: prisma.bookingAddon.updateMany,
  };
  let addonFindWhere: any;
  let addonUpdateWhere: any;

  (prisma.customerSessionNote.findMany as any) = async () => [{ id: 'note-1' }];
  (prisma.bookingAddon.findMany as any) = async ({ where }: any) => {
    addonFindWhere = where;
    return [{ name: 'Suspending Concept', quantity: 1, unitPrice: 7000, totalPrice: 7000 }];
  };
  (prisma.bookingAddon.updateMany as any) = async ({ where }: any) => {
    addonUpdateWhere = where;
    return { count: 1 };
  };

  try {
    const result = await bookingAddonService.sumForBooking('booking-1');
    await bookingAddonService.markInvoiced('booking-1');

    const expectedScope = {
      OR: [
        { bookingId: 'booking-1' },
        { sessionNoteId: { in: ['note-1'] } },
      ],
    };
    assert.equal(result.addonsTotal, 7000);
    assert.deepEqual(addonFindWhere, {
      ...expectedScope,
      status: { in: ['pending', 'confirmed', 'invoiced'] },
    });
    assert.deepEqual(addonUpdateWhere, {
      ...expectedScope,
      status: { in: ['pending', 'confirmed'] },
      unitPrice: { gt: 0 },
    });
  } finally {
    prisma.customerSessionNote.findMany = originals.sessionNoteFindMany;
    prisma.bookingAddon.findMany = originals.addonFindMany;
    prisma.bookingAddon.updateMany = originals.addonUpdateMany;
  }
});

test('sends the invoice for the past session discussed immediately before the request', async () => {
  const originalBookingFindFirst = prisma.booking.findFirst;
  const originalInvoiceFindUnique = prisma.invoice.findUnique;
  const originalInvoiceFindFirst = prisma.invoice.findFirst;
  const originalInvoiceUpdate = prisma.invoice.update;
  const originalRefreshInvoice = invoiceService.createOrRefreshForBooking;
  const originalAddonSum = bookingAddonService.sumForBooking;
  const originalSendDocument = whatsappService.sendDocument;
  let sentFileName = '';
  let searchedForLatestInvoice = false;

  (prisma.booking.findFirst as any) = async () => ({ id: 'past-booking' });
  (prisma.invoice.findUnique as any) = async ({ where }: any) => {
    assert.equal(where.bookingId, 'past-booking');
    return {
      id: 'past-invoice',
      invoiceNumber: 'INV-PAST',
      bookingId: 'past-booking',
      total: 35000,
      depositPaid: 2000,
      balanceDue: 33000,
      pdfData: Buffer.from('pdf'),
      booking: { service: 'THE ICON', dateTime: new Date('2026-08-10T07:00:00.000Z') },
    };
  };
  (prisma.invoice.findFirst as any) = async () => {
    searchedForLatestInvoice = true;
    return null;
  };
  (prisma.invoice.update as any) = async () => ({});
  (invoiceService.createOrRefreshForBooking as any) = async () => ({
    id: 'past-invoice',
    invoiceNumber: 'INV-PAST',
    bookingId: 'past-booking',
    total: 35000,
    depositPaid: 2000,
    balanceDue: 33000,
    pdfData: Buffer.from('pdf'),
    booking: { service: 'THE ICON', dateTime: new Date('2026-08-10T07:00:00.000Z') },
  });
  (bookingAddonService.sumForBooking as any) = async () => ({ addonsTotal: 0, lineItems: [] });
  (whatsappService.sendDocument as any) = async (_customerId: string, _data: Buffer, fileName: string) => {
    sentFileName = fileName;
    return {};
  };

  try {
    const reply = await agent.sendStoredInvoiceToCustomer('customer-123', undefined, [{
      role: 'assistant',
      content: 'The most recent past booking I have on record is THE ICON.\nDate: Friday, 25 September 2026 at 1:00 PM',
    }]);

    assert.equal(reply, 'I’ve sent your invoice as a PDF to WhatsApp.');
    assert.equal(sentFileName, 'INV-PAST.pdf');
    assert.equal(searchedForLatestInvoice, false);
  } finally {
    prisma.booking.findFirst = originalBookingFindFirst;
    prisma.invoice.findUnique = originalInvoiceFindUnique;
    prisma.invoice.findFirst = originalInvoiceFindFirst;
    prisma.invoice.update = originalInvoiceUpdate;
    invoiceService.createOrRefreshForBooking = originalRefreshInvoice;
    bookingAddonService.sumForBooking = originalAddonSum;
    whatsappService.sendDocument = originalSendDocument;
  }
});

test('selects the invoice for an explicitly dated session', async () => {
  const originalBookingFindFirst = prisma.booking.findFirst;
  const originalInvoiceFindUnique = prisma.invoice.findUnique;
  const originalInvoiceFindFirst = prisma.invoice.findFirst;
  const originalInvoiceUpdate = prisma.invoice.update;
  const originalRefreshInvoice = invoiceService.createOrRefreshForBooking;
  const originalAddonSum = bookingAddonService.sumForBooking;
  const originalSendDocument = whatsappService.sendDocument;
  let selectedBooking = '';
  let sentFileName = '';
  let sentSummary = '';

  (prisma.booking.findFirst as any) = async ({ where }: any) => {
    assert.equal(where.dateTime.gte.toISOString(), '2026-09-24T21:00:00.000Z');
    assert.equal(where.dateTime.lt.toISOString(), '2026-09-25T21:00:00.000Z');
    return { id: 'september-25-booking' };
  };
  (prisma.invoice.findUnique as any) = async ({ where }: any) => {
    selectedBooking = where.bookingId;
    return {
      id: 'september-25-invoice',
      invoiceNumber: 'INV-2026-004',
      total: 35000,
      depositPaid: 2000,
      balanceDue: 33000,
      pdfData: Buffer.from('pdf'),
      booking: { service: 'THE ICON', dateTime: new Date('2026-09-25T10:00:00.000Z') },
    };
  };
  (prisma.invoice.findFirst as any) = async () => null;
  (prisma.invoice.update as any) = async () => ({});
  (invoiceService.createOrRefreshForBooking as any) = async () => ({
    id: 'september-25-invoice',
    invoiceNumber: 'INV-2026-004',
    bookingId: 'september-25-booking',
    total: 38500,
    depositPaid: 10,
    balanceDue: 38490,
    pdfData: Buffer.from('refreshed-pdf'),
    booking: { service: 'THE ICON', dateTime: new Date('2026-09-25T10:00:00.000Z') },
  });
  (bookingAddonService.sumForBooking as any) = async () => ({
    addonsTotal: 3500,
    lineItems: [{ name: 'Extra professional makeup', quantity: 1, unitPrice: 3500, totalPrice: 3500 }],
  });
  (whatsappService.sendDocument as any) = async (_customerId: string, _data: Buffer, fileName: string, summary: string) => {
    sentFileName = fileName;
    sentSummary = summary;
    return {};
  };

  try {
    const reply = await agent.sendStoredInvoiceToCustomer(
      'customer-123',
      undefined,
      [],
      'Give me the invoice for the 25th sep session'
    );

    assert.equal(selectedBooking, 'september-25-booking');
    assert.equal(sentFileName, 'INV-2026-004.pdf');
    assert.match(sentSummary, /Add-ons:\nExtra professional makeup: KSh 3,500/);
    assert.match(sentSummary, /Total: KSh 38,500/);
    assert.match(sentSummary, /Balance Due: KSh 38,490/);
    assert.equal(reply, 'I’ve sent your invoice as a PDF to WhatsApp.');
  } finally {
    prisma.booking.findFirst = originalBookingFindFirst;
    prisma.invoice.findUnique = originalInvoiceFindUnique;
    prisma.invoice.findFirst = originalInvoiceFindFirst;
    prisma.invoice.update = originalInvoiceUpdate;
    invoiceService.createOrRefreshForBooking = originalRefreshInvoice;
    bookingAddonService.sumForBooking = originalAddonSum;
    whatsappService.sendDocument = originalSendDocument;
  }
});

test('handles ambiguous budget and repeated-package wording before the booking flow gets confused', () => {
  assert.equal(agent.shouldUsePackageBudgetReply('I want the cheapest one'), true);
  assert.equal(agent.shouldUsePackageBudgetReply('same as last time'), true);
  assert.equal(agent.shouldUsePackageBudgetReply('what do you offer?'), false);
  assert.match(agent.getPackageBudgetReply(), /THE BLOOM|THE ICON|cheapest/i);
});

test('renders package cards without corrupted markers or markdown', () => {
  const card = agent.buildPackageCard({
    name: 'THE ICON',
    price: 35000,
    duration: '2.5 hours',
    images: 15,
    makeup: true,
    outfits: 4,
    photobook: false,
    photobookSize: null,
    mount: true,
    balloonBackdrop: false,
    wig: false,
    notes: null,
  });

  assert.match(card, /THE ICON - Ksh 35,000/);
  assert.match(card, /Session length: 2\.5 hours/);
  assert.match(card, /15 final edited photos/);
  assert.match(card, /4 outfits/);
  assert.match(card, /Photo mount \(size to be confirmed\)/);
  assert.doesNotMatch(card, /studio outfits|A3|with styling/);
  assert.doesNotMatch(card, /[âðï�]|\*|â€¢/);
});

test('six inclusion references agree with the actual seed and local FAQ facts', () => {
  const seedPath = path.join(__dirname, '../../../scripts/seed-packages.ts');
  const source = ts.createSourceFile(seedPath, readFileSync(seedPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((entry) => ts.isIdentifier(entry.name) && entry.name.text === 'packages');
  assert.ok(declaration?.initializer && ts.isArrayLiteralExpression(declaration.initializer));
  const rows: Record<string, unknown>[] = declaration.initializer.elements.map((element) => {
    assert.ok(ts.isObjectLiteralExpression(element));
    return Object.fromEntries(element.properties.map((property) => {
      assert.ok(ts.isPropertyAssignment(property));
      assert.ok(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name));
      const value = property.initializer;
      if (ts.isStringLiteral(value)) return [property.name.text, value.text];
      if (ts.isNumericLiteral(value)) return [property.name.text, Number(value.text)];
      if (value.kind === ts.SyntaxKind.TrueKeyword) return [property.name.text, true];
      if (value.kind === ts.SyntaxKind.FalseKeyword) return [property.name.text, false];
      assert.equal(value.kind, ts.SyntaxKind.NullKeyword);
      return [property.name.text, null];
    }));
  });
  const faq: { id: string; answer: string }[] = JSON.parse(readFileSync(path.join(__dirname, '../../../knowledge_base_rows.json'), 'utf8'));
  for (const [name, reference] of Object.entries(SEED_EDITION_INCLUSIONS)) {
    assert.equal(SEED_COMPARISON_DURATIONS[name.toLowerCase()], Number.parseFloat(reference.duration) * 60, `${name}: scheduling duration`);
    const row = rows.find((entry) => entry.name === name);
    assert.ok(row, name);
    for (const [field, value] of Object.entries(reference)) {
      if (field !== 'inclusions') assert.equal(row[field], value, `${name}: ${field}`);
    }
    const answer = faq.find((entry) => entry.id === `pkg_${name.replace(/^THE /, '').toLowerCase()}`)?.answer || '';
    assert.ok(answer.includes(`${reference.duration} studio time`), `${name}: FAQ duration`);
    assert.ok(answer.includes(`${reference.images} final edited photos`), `${name}: FAQ photos`);
    assert.ok(answer.includes(`${reference.outfits} studio outfits + styling`), `${name}: FAQ outfits`);
    for (const item of reference.inclusions) {
      if (/styled wigs?$|fine art mount$|Power Suit|Reel/.test(item)) assert.ok(answer.includes(item.replace(/^5 studio outfits with styling, including the /, '')), `${name}: ${item}`);
    }
  }
  assert.equal(Object.keys(SEED_EDITION_INCLUSIONS).length, 6);
  assert.equal(SEED_EDITION_INCLUSIONS['THE EMPRESS'], undefined);
});

test('edition names cannot create unrecorded inclusions in cards', () => {
  const row = { price: 35000, duration: '2.5 hours', images: 15, makeup: false, outfits: 0, styling: false,
    photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false, notes: null };
  for (const name of ['THE ICON', 'THE EMPRESS', 'THE GODDESS']) {
    const card = agent.buildPackageCard({ ...row, name });
    assert.doesNotMatch(card, /wig|Power Suit|Reel|A2|A3|flowers|Sculpture|Signature|Flagship/);
  }
  const card = agent.buildPackageCard({ ...row, name: 'THE GODDESS', wig: true, mount: true, balloonBackdrop: true });
  assert.match(card, /quantity to be confirmed/);
  assert.match(card, /size to be confirmed/);
  assert.match(card, /design to be confirmed/);
  assert.doesNotMatch(card, /2 styled wigs|Power Suit|Reel|A2|A3|flowers|Sculpture/);
  const explicit = agent.buildPackageCard({ ...row, name: 'An edition', inclusions: ['4 studio outfits with styling', '1 A3 fine art mount'] });
  assert.match(explicit, /4 studio outfits with styling\n- 1 A3 fine art mount/);
  assert.doesNotMatch(explicit, /15 final edited photos|quantity to be confirmed|size to be confirmed/);
});

test('answers package-inclusion follow-ups from stored package facts', async () => {
  const originalFindMany = prisma.package.findMany;
  (prisma.package.findMany as any) = async () => [
    {
      name: 'THE BLOOM', price: 15000, duration: '1.5 hours', images: 6, makeup: true, outfits: 2,
      styling: true, photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false, notes: null,
    },
    {
      name: 'THE ICON', price: 35000, duration: '2.5 hours', images: 15, makeup: true, outfits: 4,
      styling: true, photobook: false, photobookSize: null, mount: true, balloonBackdrop: false, wig: false, notes: null,
    },
  ];

  try {
    const reply = await agent.getPackageCatalogReply(true);
    assert.match(reply || '', /Here are our maternity editions/);
    assert.match(reply || '', /THE BLOOM - Ksh 15,000 \| 1\.5 hours \| 6 edited photos/);
    assert.equal(conversationFlows.isPackageInclusionFollowUp('so what does each come with', [{ role: 'assistant', content: reply! }]), true);
    for (const term of ['packages', 'editions']) assert.equal(conversationFlows.isPackageCatalogRequest(`what ${term} do you have`), true);
    const detail = await agent.getPackageCatalogReply(true, 'What does THE ICON include?');
    assert.match(detail || '', /15 final edited photos[\s\S]*4 studio outfits with styling[\s\S]*1 A3 fine art mount/);
    assert.doesNotMatch(detail || '', /THE BLOOM|size to be confirmed/);
    assert.doesNotMatch(reply || '', /THE BLOOM[\s\S]*?- 5 hours|THE BLOOM[\s\S]*?25 final edited photos/);
  } finally {
    prisma.package.findMany = originalFindMany;
  }
});

test('forces a clarification when one message bundles multiple intents', () => {
  assert.equal(agent.shouldClarifyMixedIntent('I want the cheapest package for next Tuesday and send me my invoice'), true);
  assert.equal(agent.shouldClarifyMixedIntent('Could you send me the invoice?'), false);
  assert.match(agent.getMixedIntentClarificationReply(), /invoice|package|date|which/i);
});

test('elevates high-signal session details into structured note metadata', () => {
  const metadata = agent.extractSessionNoteMetadata(
    'Please add a styled wig hire, bring my husband and my mother, and I use a wheelchair.'
  );

  assert.equal(metadata.category, 'addon');
  assert.equal(metadata.priority, 'high');
  assert.equal(metadata.normalizedType, 'special_request');
  assert.deepEqual(metadata.tags, ['addon', 'companion', 'accessibility', 'styling']);
  assert.deepEqual(metadata.details.addOns, ['Styled wig hire']);
  assert.deepEqual(metadata.details.companions, ['husband', 'mother']);
  assert.deepEqual(metadata.details.accessibilityNeeds, ['wheelchair']);
});
