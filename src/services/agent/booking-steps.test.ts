// Booking collection is owned by code: nextStep() decides the question, date/time turns never reach the model.
import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { knowledgeRetrieval } from '../knowledge/retrieval.service';
import { AgentService } from './agent.service';
import { ADDON_DECISION_QUESTION, nextStep, sampleSlots, STEP_QUESTIONS, type BookingSlots, type BookingStep } from './booking-progress';
import { ADDON_LINK_REPLY, ADDON_MAKEUP_CLARIFICATION, EDITION_LINK_REPLY, OFFICIAL_WEBSITE_URLS } from './constants';
import { addonInquiryReply, isAddonListRequest, selectedAddons } from './addon-capture';
import { verifyModelReply, verifyWithOneRetry } from './output-verifier';
import { normalizeQuotes } from './regex';
import { buildAdditionsReply } from './replies';
import { alternativeDates, carriedOverStale, extractStatedSlots, knownSlotsLine, tidyName } from './slot-memory';

const CUSTOMER = 'synthetic-maryanne';
const NOW = new Date('2026-10-05T20:44:00Z').getTime();
const DAY_SLOTS = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'];
type Msg = { role: 'user' | 'assistant'; content: string };

function harness(context: any, draft: Record<string, unknown> | null, customerName = 'WhatsApp User', now = NOW) {
  context.mock.timers.enable({ apis: ['Date'], now });
  const restores: (() => void)[] = [];
  const stub = (target: any, method: string, implementation: (...args: any[]) => any) => {
    const original = target[method]; target[method] = implementation; restores.push(() => { target[method] = original; });
  };
  context.after(() => restores.reverse().forEach((restore) => restore()));
  const state = {
    draft: null as any,
    customer: { id: CUSTOMER, name: customerName } as any,
    insights: [] as string[],
    notes: [] as string[],
    proposals: [] as { name: string; service: string; dateTime: string }[],
    slots: DAY_SLOTS as string[],
    slotQueries: 0,
    modelCalls: 0,
  };
  const history: Msg[] = [];
  const reset = (fields: Record<string, unknown> | null) => {
    state.draft = fields ? { id: 'muse-draft', customerId: CUSTOMER, step: 'collecting_slots', createdAt: new Date(NOW - 10 * 60_000), isForSomeoneElse: false, name: null, service: null, date: null, time: null, ...fields } : null;
    state.insights = []; state.notes = []; state.proposals = []; history.length = 0;
  };
  reset(draft);
  stub(prisma.bookingDraft, 'findUnique', async () => (state.draft ? { ...state.draft } : null));
  stub(prisma.bookingDraft, 'create', async ({ data }: any) => (state.draft = { id: 'muse-draft', createdAt: new Date(), ...data }));
  stub(prisma.bookingDraft, 'updateMany', async ({ data }: any) => { Object.assign(state.draft, data, { updatedAt: new Date() }); return { count: 1 }; });
  stub(prisma.customer, 'findUnique', async () => state.customer);
  stub(prisma.customer, 'update', async ({ data }: any) => (state.customer = { ...state.customer, ...data }));
  stub(prisma.customerMemory, 'findUnique', async () => ({ keyInsights: [...state.insights], preferredPackages: [], relationshipStage: 'new', totalBookings: 0 }));
  stub(prisma.customerMemory, 'upsert', async () => ({}));
  stub(prisma.customerMemory, 'updateMany', async ({ where, data }: any) => {
    if (where.NOT?.keyInsights?.has && state.insights.includes(where.NOT.keyInsights.has)) return { count: 0 };
    if (data.keyInsights.push) state.insights.push(data.keyInsights.push);
    return { count: 1 };
  });
  stub(prisma.customerSessionNote, 'findFirst', async () => (state.notes.length ? { id: 'addon-note' } : null));
  stub(prisma.unifiedConversation, 'findFirst', async () => null);
  stub(prisma.package, 'findMany', async () => []);
  stub(knowledgeRetrieval, 'search', async () => []);
  stub(bookingService, 'getAvailableSlots', async () => { state.slotQueries++; return state.slots; });
  stub(require('./catalog-policy'), 'claimCatalogLink', async () => true);
  const agent = new AgentService() as any;
  agent.naturalAssistantMode = false;
  Object.assign(agent, {
    decorateTemplateEmoji: async (_c: any, _p: any, reply: string) => reply,
    checkTokenBudget: async () => true,
    trackSentiment: async () => {},
    logAiJobMetric: async () => {},
    logConversationLearning: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    escalate: async () => {},
    executeAddNoteTool: async (_customer: string, _date: string, description: string) => { state.notes.push(description); return { created: true }; },
    executeProposeBookingTool: async (_customer: string, name: string, service: string, dateTime: string) => {
      state.proposals.push({ name, service, dateTime });
      state.draft = { ...state.draft, step: 'awaiting_confirmation' };
      return { depositAmount: 2000 };
    },
    runAgent: async () => { state.modelCalls++; return { content: 'MODEL', tokensUsed: 11500 }; },
  });
  const say = async (message: string) => {
    const reply: string = await agent.handleMessage(CUSTOMER, message, history.slice(-6), 'whatsapp');
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return reply;
  };
  return { state, agent, history, say, reset };
}

test('nextStep walks package, date, time, name, add-on decision, then proposal', () => {
  const full: BookingSlots = { service: 'THE MUSE', date: '2026-10-09', time: '14:00', name: 'Maryanne', addonsDecided: true };
  const cases: [BookingSlots, BookingStep][] = [
    [{}, 'need_package'],
    [{ ...full, service: null }, 'need_package'],
    [{ ...full, date: null }, 'need_date'],
    [{ ...full, date: null, time: null }, 'need_date'],
    [{ ...full, time: null }, 'need_time'],
    [{ ...full, name: null }, 'need_name'],
    [{ ...full, name: 'WhatsApp User' }, 'need_name'],
    [{ ...full, name: 'No its Joan' }, 'need_name'],
    [{ ...full, name: 'Maryanne' }, 'ready_to_propose'],
    [{ ...full, name: 'Maryanne Wanjiru' }, 'ready_to_propose'],
    [{ ...full, addonsDecided: false }, 'need_addon_decision'],
    [{ ...full, name: null, addonsDecided: false }, 'need_name'],
    [full, 'ready_to_propose'],
  ];
  for (const [slots, step] of cases) assert.equal(nextStep(slots), step, JSON.stringify(slots));
  assert.equal(STEP_QUESTIONS.need_name, 'May I have your name for the booking details?');
  assert.doesNotMatch(Object.values(STEP_QUESTIONS).join(' '), /full name/);
});

test('curly apostrophes are normalised before action and verifier matchers', () => {
  const agent = new AgentService() as any;
  const curly = 'I\u2019ve added the extra professional makeup to your Muse session.';
  const notSaved = { rescheduled: false, cancelled: false, noteSaved: false };
  assert.match(agent.getUnverifiedActionReply(curly, notSaved) || '', /couldn't save that add-on/);
  assert.match(agent.getUnverifiedActionReply(curly.replace('\u2019', "'"), notSaved) || '', /couldn't save that add-on/);
  assert.equal(agent.getUnverifiedActionReply(curly, { ...notSaved, noteSaved: true }), null);
  assert.match(agent.getUnverifiedActionReply('Your session has been rescheduled \u2014 I\u2019ve moved it.', notSaved) || '', /haven't been able to apply that reschedule/);
  assert.equal(normalizeQuotes('\u201cyes\u201d it\u2019s'), '"yes" it\'s');
  const verified = verifyModelReply('You\u2019re welcome.', { amounts: [], deposits: [], editions: [] });
  assert.equal(verified.reply, 'You\u2019re welcome.', 'the customer text keeps its own punctuation');
});

test('a model reply claiming "I\u2019ve added ... extra" without a saved note is replaced in runAgent', async (context) => {
  const { agent, state } = harness(context, { service: 'THE MUSE', date: '2026-10-09', time: '14:00' });
  state.customer = { id: CUSTOMER, name: 'Unknown', bookings: [] };
  agent.runAgent = (AgentService.prototype as any).runAgent;
  agent.getPackagePricingLine = async () => '';
  agent.createCompletionWithToolNameGuard = async () => ({ provider: 'groq', completionCalls: 1, response: { choices: [{ message: { role: 'assistant',
    content: 'I\u2019ve added the extra professional makeup to your Muse session.\nCould you please share your full name?' } }], usage: { total_tokens: 1 } } });
  const result = await agent.runAgent(CUSTOMER, 'No it\u2019s for me', [{ role: 'assistant', content: 'Which add-on?' }], 'whatsapp');
  assert.doesNotMatch(result.content, /I.ve added/);
  assert.match(result.content, /couldn't save that add-on/);
});

test('"No, it\'s for me" after the extra-makeup question completes the opted-in add-on', async (context) => {
  const { state, history, say, reset } = harness(context, null);
  for (const answer of ["No it's for me", 'No it\u2019s for me', 'its for myself']) {
    reset({ service: 'THE MUSE', date: '2026-10-09', time: '14:00', name: 'Maryanne' });
    history.push({ role: 'user', content: 'I want the extra professional makeup' }, { role: 'assistant', content: ADDON_MAKEUP_CLARIFICATION });
    assert.deepEqual(selectedAddons(answer, history).map((item) => item.sku), ['extra_makeup'], answer);
    const reply = await say(answer);
    assert.match(reply, /^Noted for your session: Extra professional makeup \(Ksh 3,500\)\./, answer);
    assert.deepEqual(state.notes, ['Extra professional makeup']);
    assert.equal(state.modelCalls, 0);
  }
});

test('"Yes, for my sister" after the extra-makeup question saves it for her', async (context) => {
  const { state, history, say } = harness(context, { service: 'THE MUSE', date: '2026-10-09', time: '14:00', name: 'Maryanne' });
  history.push({ role: 'user', content: 'I want the extra professional makeup' }, { role: 'assistant', content: ADDON_MAKEUP_CLARIFICATION });
  assert.deepEqual(selectedAddons('Yes, for my sister', history).map((item) => item.sku), ['extra_makeup']);
  const reply = await say('Yes, for my sister');
  assert.deepEqual(state.notes, ['Extra professional makeup for my sister']);
  assert.match(reply, /^Noted for your session: Extra professional makeup/);
  assert.match(reply, /deposit is Ksh 2,000/, 'a saved add-on is the add-on decision');
  assert.equal(state.proposals.length, 1);
  assert.equal(state.modelCalls, 0);
});

test('date and time for an active draft are answered from availability in code, never the model', async (context) => {
  const { state, say } = harness(context, { service: 'THE MUSE', name: 'Maryanne' });
  const dateReply = await say('I want it on 9th');
  assert.equal(dateReply, 'Friday, 9 October is open for the Muse edition. Available times include 9:00 AM, 11:30 AM, 2:30 PM and 5:00 PM, with others in between. Which time would suit you?');
  assert.equal(state.draft.date, '2026-10-09');
  const timeReply = await say('2pm');
  assert.equal(timeReply, `2:00 PM on Friday, 9 October is available for the Muse edition. ${ADDON_DECISION_QUESTION}`);
  assert.equal(state.draft.time, '14:00');
  assert.equal(state.modelCalls, 0);
  assert.equal(state.slotQueries, 2);
  for (const reply of [dateReply, timeReply]) assert.doesNotMatch(reply, /\d{4}-\d{2}-\d{2}/);
  assert.deepEqual(sampleSlots(['09:00', '10:00']), ['09:00', '10:00']);
});

test('an unavailable time offers the nearest open times, and a full day asks for another date', async (context) => {
  const { state, say } = harness(context, { service: 'THE MUSE', date: '2026-10-09', name: 'Maryanne' });
  state.slots = ['09:00', '10:00', '13:00', '15:30', '17:00'];
  assert.equal(await say('2pm'), '2:00 PM is not available on Friday, 9 October. The nearest open times are 1:00 PM, 3:30 PM and 5:00 PM. Which would suit you?');
  state.slots = [];
  assert.equal(await say('10th at 2pm'), 'Saturday, 10 October is fully booked for the Muse edition. Which other date would work for you?');
  assert.equal(await say('12th'), 'We are closed on Mondays, so Monday, 12 October is not available. Which other date would work for you?');
  assert.equal(state.modelCalls, 0);
});

test('"Yes" after the time is confirmed asks the next step without restating the date and time', async (context) => {
  const { history, say } = harness(context, { service: 'THE MUSE', date: '2026-10-09', time: '14:00', name: 'Maryanne' });
  history.push({ role: 'user', content: '2pm' }, { role: 'assistant', content: '2:00 PM on Friday, 9 October is available for the Muse edition. Would you like to go ahead with that time?' });
  assert.equal(await say('Yes'), ADDON_DECISION_QUESTION);
});

test('"Show me the add ons" gets the add-on link for the chosen edition, never the editions wording', async (context) => {
  const { state, history, say } = harness(context, { service: 'THE MUSE', date: '2026-10-09', time: '14:00', name: 'Maryanne' });
  for (const message of ['Show me the add ons', 'what add-ons do you have', 'show me the extras']) assert.equal(isAddonListRequest(message), true, message);
  for (const message of ['I want the wig hire', 'show me the packages']) assert.equal(isAddonListRequest(message), false, message);
  history.push({ role: 'user', content: 'Yes' }, { role: 'assistant', content: ADDON_DECISION_QUESTION });
  const reply = await say('Show me the add ons');
  assert.equal(reply, `All the optional extras and their prices are here: ${OFFICIAL_WEBSITE_URLS.packages}\nTell me which you would like for your Muse session, or say no to skip them.`);
  assert.doesNotMatch(reply, /edition catches your eye/);
  assert.equal(state.modelCalls, 0);
  state.draft = { ...state.draft, name: null };
  assert.match(await say('show me the add ons'), /\nMay I have your name for the booking details\?$/, 'returns to the pending question');
});

test('a blocked add-on list from the model falls back to the add-on link, not the editions link', async () => {
  const addonDump = 'For your Muse session: an extra outfit, styled wig hire, extra professional makeup and extra edited photos.';
  const result = await verifyWithOneRetry(addonDump, { amounts: [], deposits: [], editions: [] }, async () => assert.fail('no retry'), async () => assert.fail('no escalation'));
  assert.equal(result.reply, ADDON_LINK_REPLY);
  const editionDump = 'THE BLOOM, THE MUSE and THE ICON are our editions.';
  assert.equal((await verifyWithOneRetry(editionDump, { amounts: [], deposits: [], editions: [] }, async () => '', async () => {})).reply, EDITION_LINK_REPLY);
});

test('declining the displayed optional additions proceeds to the Bloom proposal without a model or payment call', async (context) => {
  const { state, history, say, reset, agent } = harness(context, null);
  agent.executeConfirmBookingTool = async () => assert.fail('declining extras is not payment consent');
  for (const answer of ["No I don't want the extras", "I don't want them", "I don\u2019t want them", 'I do not want any extras']) {
    reset({ service: 'THE BLOOM', date: '2026-10-13', time: '14:00', name: 'Maryanne' });
    history.push({ role: 'assistant', content: buildAdditionsReply(2000) });
    assert.equal(agent.isDecliningOptionalAddons(normalizeQuotes(answer), history), true, answer);
    const reply = await say(answer);
    assert.equal(reply, 'Your details for the Bloom edition are ready for Tuesday, 13 October 2026 at 2:00 PM. The deposit is Ksh 2,000. Reply yes to confirm your booking details and receive payment instructions.');
    assert.equal(state.proposals.length, 1);
    assert.deepEqual(state.notes, []);
    assert.deepEqual(state.insights, ['system:addons-decided:v1:muse-draft']);
    assert.equal(state.modelCalls, 0);
  }
  assert.equal(agent.isDecliningOptionalAddons("I don't want them", [{ role: 'assistant', content: 'Which edition would you like?' }]), false);
});

test('"No" or "skip" at the add-on step is remembered beyond the six-message history window', async (context) => {
  const { state, history, say, reset } = harness(context, null);
  for (const answer of ['No I dont', 'skip', 'No I don\u2019t']) {
    reset({ service: 'THE MUSE', date: '2026-10-09', time: '14:00', name: 'Maryanne' });
    history.push({ role: 'assistant', content: ADDON_DECISION_QUESTION });
    assert.match(await say(answer), /deposit is Ksh 2,000/, answer);
    assert.deepEqual(state.insights, ['system:addons-decided:v1:muse-draft']);
    state.draft = { ...state.draft, step: 'collecting_slots' };
    history.length = 0;
    assert.match(await say('I am ready'), /deposit is Ksh 2,000/, 'the stored decision is not asked again');
  }
});

// A selected makeup add-on for the customer is retained while collecting the remaining booking details.
test('self makeup selection, name collection, then deposit proposal do not repeat add-on clarification', async (context) => {
  const { state, history, say } = harness(context, { service: 'THE MUSE', date: '2026-10-09', time: '14:00', name: null });
  history.push(
    { role: 'user', content: 'Show me the add ons' },
    { role: 'assistant', content: `You can see all our editions, inclusions and prices here: ${OFFICIAL_WEBSITE_URLS.packages}\nTell me which edition catches your eye.` },
    { role: 'user', content: 'I want the extra professional makeup' },
    { role: 'assistant', content: ADDON_MAKEUP_CLARIFICATION },
  );
  const replies = [await say("No it's for me"), await say('Maryanne')];
  assert.match(replies[0], /^Noted for your session: Extra professional makeup \(Ksh 3,500\)\./);
  assert.ok(replies[0].includes(STEP_QUESTIONS.need_name));
  assert.equal(state.draft.name, 'Maryanne');
  assert.equal(replies[1], 'Your details for the Muse edition are ready for Friday, 9 October 2026 at 2:00 PM. The deposit is Ksh 2,000. Reply yes to confirm your booking details and receive payment instructions.');
  assert.deepEqual(state.proposals, [{ name: 'Maryanne', service: 'THE MUSE', dateTime: '2026-10-09T14:00' }]);
  assert.deepEqual(state.notes, ['Extra professional makeup'], 'the extra makeup was explicitly selected for the customer');
  const questions = replies.flatMap((reply) => reply.split('\n').filter((line) => line.endsWith('?')));
  assert.equal(new Set(questions).size, questions.length, 'no question is asked twice');
  assert.ok(replies.every((reply) => !/I.ve added|full name/i.test(reply)));
  assert.equal(state.modelCalls, 0);
});

test('Koros run: stated time survives a date change, info turns are deterministic and pauses get no booking question', async (context) => {
  // Friday 9 October 2026, 08:00 Nairobi. A Legend draft from 20 minutes earlier in the same session.
  const { state, agent, say } = harness(context, { service: 'THE LEGEND', createdAt: new Date('2026-10-09T04:40:00Z') }, 'WhatsApp User', new Date('2026-10-09T05:00:00Z').getTime());
  agent.naturalAssistantMode = true;
  assert.equal(await say('Good morning\nIs this fiesta maternity house'), 'Welcome to Fiesta House Maternity. What kind of session are you planning?');
  assert.match(await say('My name is koros, are you open today?'), /^Welcome, Koros\. Friday, 9 October is open for/);
  assert.match(await say('I think 4: 00pm is perfect for me'), /^4:00 PM on Friday, 9 October is available/);
  assert.equal(state.draft.time, '16:00');
  assert.match(await say('Is Saturday free'), /^4:00 PM on Saturday, 10 October is available/);
  assert.deepEqual([state.draft.date, state.draft.time], ['2026-10-10', '16:00']);
  const bring = await say("That's perfect...is there anything I should bring?");
  assert.match(bring, /black bra and panties/);
  assert.doesNotMatch(bring, /\?/);
  assert.equal(await say('Noted.... thanks \u{1F60A}'), 'You are welcome. I am here if you need anything else.');
  const location = await say('Where are you located?');
  assert.match(location, /Diamond Plaza Annex[\s\S]*by appointment only/);
  assert.doesNotMatch(location, /drop by|tour/i);
  assert.equal(await say('I will \u{1F60A}\nI will call later to confirm my appointment'), "Of course, we're here when you're ready.");
  assert.equal(await say('Let me confirm with my partner and let you know'), "Of course, we're here when you're ready.");
  assert.equal(await say('Can I walk in?'), 'We work strictly by appointment, so we do not take walk-ins. A deposit is required to secure your slot.');
  assert.match(await say('What are your opening hours?'), /^We are open Tuesday to Sunday, 9:00 AM to 7:00 PM/);
  assert.deepEqual([state.draft.date, state.draft.time], ['2026-10-10', '16:00'], 'pauses and info turns keep the saved slots');
  assert.equal(state.modelCalls, 0);
});

test('"tell me about the business" describes the studio; "is this Fiesta?" keeps the short welcome', async (context) => {
  const { state, agent, say } = harness(context, null);
  agent.naturalAssistantMode = true;
  const about = await say('so tell me about the business and what you people do');
  assert.match(about, /^Fiesta House Maternity is a luxury maternity photography studio in Parklands, Nairobi\./);
  assert.match(about, /seven editions[\s\S]*session-packages|seven editions[\s\S]*https:\/\//);
  assert.equal(await say('Is this fiesta maternity house'), 'Welcome to Fiesta House Maternity. What kind of session are you planning?');
  assert.equal(state.modelCalls, 0);
});

test('verifier rejects slot-hold offers and drop-by invitations but not the payment hold wording', () => {
  const facts = { amounts: [], deposits: [], editions: [] };
  for (const reply of [
    'While you chat with your partner, would you like me to hold a few of the Saturday slots for you?',
    'I can reserve 4:00 PM for you until tomorrow.',
    'Shall I hold that time?',
  ]) assert.ok(verifyModelReply(reply, facts).reasons.includes('unsupported_hold_offer'), reply);
  assert.ok(verifyModelReply('Feel free to drop by or let me know if you would like a quick tour!', facts).reasons.includes('walk_in_or_tour_offer'));
  assert.deepEqual(verifyModelReply('Your slot is held for 15 minutes while the M-Pesa prompt is open.', facts).reasons, []);
});

const FRIDAY_8AM = new Date('2026-10-09T05:00:00Z').getTime();
const staleDraft = (fields: Record<string, unknown>) => ({ createdAt: new Date(FRIDAY_8AM - 10 * 86_400_000), updatedAt: new Date(FRIDAY_8AM - 10 * 86_400_000), ...fields });

test('a draft untouched for over two hours is confirmed, not presented as current', async (context) => {
  const { state, say } = harness(context, staleDraft({ service: 'THE LEGEND' }), 'WhatsApp User', FRIDAY_8AM);
  assert.equal(await say('My name is koros, are you open today?'),
    'Welcome, Koros. Last time you were looking at the Legend edition. Would you like to continue with that, or choose a different one?');
  assert.equal(state.draft.date, '2026-10-09', 'the date she just stated is saved');
  assert.equal(state.draft.name, 'Koros');
  assert.equal(state.customer.name, 'Koros');
  assert.match(await say('Yes'), /^Friday, 9 October is open for the Legend edition\./, 'confirmed draft is used');
  assert.equal(state.modelCalls, 0);
});

test('a stale edition, date and time are all named, and declining clears them', async (context) => {
  const { state, say } = harness(context, staleDraft({ service: 'THE LEGEND', date: '2026-10-10', time: '16:00' }), 'WhatsApp User', FRIDAY_8AM);
  assert.equal(await say('Hi'), 'Last time you were looking at the Legend edition on Saturday, 10 October at 4:00 PM. Would you like to continue with that, or choose a different one?');
  assert.equal(await say('No, a different one'), 'No problem. Which edition would you like?');
  assert.deepEqual([state.draft.service, state.draft.date, state.draft.time], [null, null, null]);
  assert.equal(state.modelCalls, 0);
});

test('a stale past date is dropped and info questions are not interrupted', async (context) => {
  const { state, say } = harness(context, staleDraft({ service: 'THE MUSE', date: '2026-09-29', time: '10:00' }), 'WhatsApp User', FRIDAY_8AM);
  assert.match(await say('Where are you located?'), /Diamond Plaza Annex/);
  assert.equal(await say('I want to book'), 'Last time you were looking at the Muse edition. Would you like to continue with that, or choose a different one?');
  assert.deepEqual([state.draft.date, state.draft.time], [null, null]);
});

test('a fresh draft is used silently and the model is told when details are carried over', (context) => {
  const now = FRIDAY_8AM;
  context.mock.timers.enable({ apis: ['Date'], now });
  const fresh = { step: 'collecting_slots', service: 'THE LEGEND', createdAt: new Date(now - 86_400_000), updatedAt: new Date(now - 60 * 60_000) };
  const stale = { ...fresh, updatedAt: new Date(now - 3 * 60 * 60_000) };
  assert.equal(carriedOverStale(fresh, now), false);
  assert.equal(carriedOverStale(stale, now), true);
  assert.equal(carriedOverStale({ ...stale, service: null }, now), false, 'a name alone is not carried over');
  assert.match(knownSlotsLine(stale), /earlier conversation: do not use them until the customer confirms/);
  assert.doesNotMatch(knownSlotsLine(fresh), /earlier conversation/);
});

test('stated names are sanitised and title-cased only when typed in one case', () => {
  assert.equal(extractStatedSlots('My name is koros, are you open today?').name, 'Koros');
  assert.equal(extractStatedSlots('my name is MARY ANNE').name, 'Mary Anne');
  assert.equal(extractStatedSlots("My name is o'brien").name, "O'Brien");
  assert.equal(extractStatedSlots('My name is McDonald').name, 'McDonald');
  assert.equal(tidyName(`  jane\n\nwanjiku${' x'.repeat(60)}`).length <= 60, true);
  assert.equal(tidyName('jane\nwanjiku'), 'Jane Wanjiku');
});

test('single add-on questions explain the item, inclusion, quote and advance-booking rules', () => {
  assert.match(addonInquiryReply('How much is styled wig hire?') || '', /^Styled wig hire: Ksh 4,000 each\. .*booked in advance\.\nWould you like/);
  assert.match(addonInquiryReply('Do you do a professional reel?') || '', /quoted by package tier\. .*included with The Goddess.*team will confirm it\. It needs to be booked in advance\./);
  assert.match(addonInquiryReply('How much is the goddess sculpture set?') || '', /Ksh 15,000\. .*not charged again.*production requirements and availability/);
  assert.match(addonInquiryReply('What is a digital art edit?') || '', /Ksh 3,000 each\. A more creative/);
  assert.doesNotMatch(addonInquiryReply('How much is wig styling?') || '', /4,000/);
});

test('an add-on the edition already includes is not charged', async (context) => {
  const { state, agent, say } = harness(context, { service: 'THE GODDESS', date: '2026-10-09', time: '14:00', name: 'Maryanne' });
  agent.executeAddNoteTool = (AgentService.prototype as any).executeAddNoteTool;
  const reply = await say('I want the power suit');
  assert.equal(reply, 'Fiesta House Power Suit is already included with the Goddess edition, so there is no extra charge.');
  assert.deepEqual(state.notes, []);
});

test('alternative dates are read in order, and only a real choice counts', () => {
  const history: Msg[] = [{ role: 'user', content: 'lets do it on 2026-10-14' }, { role: 'assistant', content: '2:00 PM on Wednesday, 14 October is available.' }];
  assert.deepEqual(alternativeDates('lets do it on 2026-10-14\nor 2026-10-15 either is okay...choose one'), ['2026-10-14', '2026-10-15']);
  assert.deepEqual(alternativeDates('or 2026-10-15 either is okay...choose one', history), ['2026-10-14', '2026-10-15']);
  assert.deepEqual(alternativeDates('2026-10-14 or 2026-10-15'), ['2026-10-14', '2026-10-15']);
  assert.deepEqual(alternativeDates('actually 2026-10-15', history), []);
  assert.deepEqual(alternativeDates('the Bloom or Muse on 2026-10-14'), []);
});

test('"14th, or 15th either is okay...choose one" gets one choice and keeps the first open date', async (context) => {
  const friday = new Date('2026-10-09T13:30:00Z').getTime();
  for (const turns of [['lets do it on 14th\nor 15th either is okay...choose one'], ['lets do it on 14th', 'or 15th either is okay...choose one']]) {
    const { state, say } = harness(context, { service: 'THE BLOOM', time: '14:00', name: 'Wanjiru', createdAt: new Date(friday - 20 * 60_000) }, 'Wanjiru', friday);
    let reply = '';
    for (const turn of turns) reply = await say(turn);
    assert.match(reply, turns.length === 1 ? /^I'll go with Wednesday, 14 October\. 2:00 PM on Wednesday, 14 October is available for the Bloom edition\./ : /^I'll go with Wednesday, 14 October\./, turns.join(' | '));
    assert.doesNotMatch(reply, /15 October/);
    assert.equal(state.draft.date, '2026-10-14', 'the later alternative does not overwrite the chosen date');
    assert.equal(state.modelCalls, 0);
    context.mock.timers.reset();
  }
});
