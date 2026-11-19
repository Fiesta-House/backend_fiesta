import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import { inBusinessTimezone } from '../../utils/time';
import { bookingService } from '../booking/booking.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { knowledgeRetrieval } from '../knowledge/retrieval.service';
import { circuitBreaker } from './resilience.service';
import { AgentService } from './agent.service';
import { SEED_EDITION_INCLUSIONS } from '../../config/edition-inclusions';
import { VERIFIER_CORRECTION_PREFIX } from './output-verifier';
import workflowBaseline from './workflow-baseline.fixtures.json';
import { BUDGET_HANDOFF_REPLY } from './constants';

test('workflow baseline preserves reported turns and labels synthetic state honestly', () => {
  assert.equal(workflowBaseline.historyLimit, 6);
  assert.match(workflowBaseline.customerId, /^synthetic-/);
  assert.equal(workflowBaseline.incidents.length, 4);
  const blocked = workflowBaseline.incidents.find(incident => incident.id === 'blocked-reschedule-typo-recovery');
  assert.ok(blocked);
  assert.deepEqual(blocked.turns.map(turn => turn.message), [
    'can we reschedule my upcoming session', 'i dont understand', 'is there any free slots on the 10th?', '1oam', 'on 10th at 10am',
  ]);
  assert.match(blocked.syntheticConflictEvidence || '', /not a live row/);
  for (const incident of workflowBaseline.incidents) {
    assert.ok(incident.initialContext);
    for (const turn of incident.turns) {
      assert.ok(turn.message && turn.observedReply && turn.requiredOutcome);
      for (const text of [turn.message, turn.observedReply, turn.requiredOutcome]) {
        assert.doesNotMatch(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
      }
    }
  }
});

test.todo('workflow gate: a blocked reschedule stays blocked through clarification without model-led state transitions');
test.todo('workflow gate: date-only availability for an existing session is queried before asking for a time');
test.todo('workflow gate: a time typo and provider outage preserve the stored reschedule operation and date');

type Message = { role: 'user' | 'assistant'; content: string };
type Turn = {
  message: string;
  modelReply: string;
  nextDay?: boolean;
  exhaustedBudget?: boolean;
  tool?: { name: string; args: Record<string, unknown> };
};

const customerId = 'wairimu-replay';
const packages = [
  ['THE BLOOM', 15000, '1.5 hours'],
  ['THE MUSE', 25000, '2 hours'],
  ['THE ICON', 35000, '2.5 hours'],
  ['THE LEGEND', 45000, '2.5 hours'],
  ['THE QUEEN', 55000, '3 hours'],
  ['THE EMPRESS', 70000, '3.5 hours'],
  ['THE GODDESS', 120000, '5 hours'],
].map(([name, price, duration]) => {
  const reference = SEED_EDITION_INCLUSIONS[String(name)];
  return {
    name: String(name), price: Number(price), duration: String(duration), deposit: 2000,
    images: reference?.images ?? 6, makeup: true, outfits: reference?.outfits ?? 2, styling: true,
    photobook: reference?.photobook ?? false, photobookSize: reference?.photobookSize ?? null,
    mount: reference?.mount ?? false, balloonBackdrop: reference?.balloonBackdrop ?? false,
    wig: reference?.wig ?? false, notes: null,
  };
});

const turns: Turn[] = [
  {
    message: 'My name is Wairimu. I am interested in a maternity photoshoot',
    modelReply: 'Welcome, Wairimu. Which package would you like?',
  },
  {
    message: 'Can you please share the packages that you offer',
    modelReply: 'THE BLOOM: 5 hours. THE ICON: 5 hours. THE LEGEND: 5 hours. THE EMPRESS: 3 hours.',
  },
  {
    message: 'I am interested in the Bloom package',
    modelReply: 'What date are you considering?',
  },
  {
    message: 'I also want extra makeup for my sister and an extra outfit',
    modelReply: 'I have noted your extras.',
  },
  {
    message: 'What if I want to hire a wig from you?',
    modelReply: 'Styled wig hire is Ksh 4,000. Would you like to add it?',
  },
  {
    message: 'Which dates are available next week?',
    modelReply: 'Please give me your name and package.',
    tool: {
      name: 'get_available_dates',
      args: { fromDate: '2026-10-05', toDate: '2026-10-11', service: 'THE BLOOM' },
    },
  },
  {
    message: '6th October, 10am',
    modelReply: '6 Oct 2026 is a Monday, so the studio is closed.',
  },
  {
    message: 'I am back. What details are still missing?',
    modelReply: 'What is your name, and which package would you like?',
    nextDay: true,
  },
  {
    message: "What's the booking process and your turnaround policy",
    modelReply: 'We have six editions: Bloom, Muse, Icon, Legend, Queen, Empress and Goddess. A 30% deposit applies: Ksh 4,500 for Bloom and Ksh 7,500 for Muse.',
  },
  {
    message: 'Can I walk in?',
    modelReply: 'Sessions are by appointment only.',
    exhaustedBudget: true,
  },
  {
    message: 'Is the makeup inclusive of lashes?',
    modelReply: 'Lashes are included in all our makeup services, including every package. The extra professional makeup add-on also includes lashes.',
  },
  {
    message: 'Please continue.',
    modelReply: '\u2014 I can help you plan your session.',
  },
];

test('Wairimu conversation replay with six-message history and a next-day return', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T09:00:00Z').getTime() });
  let customer: Record<string, any> = { id: customerId, name: 'WhatsApp User', bookings: [] };
  let draft: Record<string, any> | null = null;
  const notes: string[] = [];
  const escalationCalls: { type: string; description: string }[] = [];
  const frames: {
    reply: string;
    customer: Record<string, any>;
    draft: Record<string, any> | null;
    notes: string[];
    prompts: string[];
    exposedTools: string[];
    toolResults: string[];
    history: Message[];
    escalations: number;
  }[] = [];
  const history: Message[] = [];
  const instance = new AgentService() as any;
  instance.naturalAssistantMode = true;
  let activeTurn = turns[0];
  let totalCompletions = 0;
  const correctionLengths: number[] = [];
  let prompts: string[] = [];
  let exposedTools: string[] = [];
  let toolResults: string[] = [];
  const restorations: (() => void)[] = [];
  context.after(() => restorations.reverse().forEach((restore) => restore()));
  const stub = (target: any, methodName: string, implementation: (...args: any[]) => any) => {
    const original = target[methodName];
    target[methodName] = implementation;
    restorations.push(() => { target[methodName] = original; });
  };

  stub(circuitBreaker, 'isOpen', () => false);
  stub(circuitBreaker, 'recordSuccess', () => {});
  stub(knowledgeRetrieval, 'search', async () => []);
  stub(prisma.customer, 'findUnique', async () => customer);
  stub(prisma.customer, 'update', async ({ data }: any) => (customer = { ...customer, ...data }));
  stub(prisma.customer, 'upsert', async ({ update }: any) => (customer = { ...customer, ...update }));
  stub(prisma.customer, 'create', async ({ data }: any) => (customer = { bookings: [], ...data }));
  stub(prisma.customerMemory, 'findUnique', async () => null);
  stub(require('./catalog-policy'), 'claimCatalogLink', async () => true);
  stub(prisma.bookingDraft, 'findUnique', async () => draft);
  stub(prisma.bookingDraft, 'findMany', async () => draft ? [draft] : []);
  stub(prisma.bookingDraft, 'create', async ({ data }: any) => {
    draft = { id: 'draft-replay', createdAt: new Date(), ...data };
    return draft;
  });
  stub(prisma.bookingDraft, 'updateMany', async ({ data }: any) => {
    draft = { ...draft, ...data, updatedAt: new Date() };
    return { count: 1 };
  });
  stub(prisma.bookingDraft, 'upsert', async ({ create, update }: any) => {
    draft = { id: 'draft-replay', ...(draft ? { ...draft, ...update } : create), updatedAt: new Date() };
    return draft;
  });
  stub(prisma.bookingDraft, 'update', async ({ data }: any) => {
    draft = { id: 'draft-replay', ...draft, ...data, updatedAt: new Date() };
    return draft;
  });
  stub(prisma.bookingDraft, 'deleteMany', async () => { draft = null; return { count: 1 }; });
  stub(prisma.booking, 'findFirst', async () => null);
  stub(prisma.booking, 'findMany', async () => []);
  stub(googleCalendarService, 'getEvents', async () => []);
  stub(prisma.payment, 'findFirst', async () => null);
  stub(prisma.bookingAddon, 'findMany', async () => []);
  stub(prisma.customerSessionNote, 'findFirst', async () => null);
  stub(prisma.package, 'findMany', async () => packages);
  stub(prisma.package, 'findFirst', async () => packages[0]);
  stub(prisma.package, 'findUnique', async ({ where }: any) => packages.find((pkg) => pkg.name === where.name) || null);
  stub(prisma.studioInfo, 'findFirst', async () => ({ location: 'Parklands studio' }));
  stub(bookingService, 'getAvailableSlots', async (date: string) =>
    inBusinessTimezone(`${date}T07:00:00Z`).day() === 1
      ? { status: 'closed', reason: 'Closed on Mondays' }
      : ['10:00', '13:00']
  );

  Object.assign(instance, {
    checkTokenBudget: async () => !activeTurn.exhaustedBudget,
    trackSentiment: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    logAiJobMetric: async () => {},
    logConversationLearning: async () => {},
    escalate: async (_customerId: string, type: string, description: string) => {
      escalationCalls.push({ type, description });
    },
    executeAddNoteTool: async (_customerId: string, _date: string, note: string) => {
      notes.push(note);
      return { created: true, type: 'special_request' };
    },
    createCompletionWithToolNameGuard: async (params: any) => {
      totalCompletions++;
      const finalMessage = params.messages.at(-1);
      if (finalMessage?.role === 'system' && finalMessage.content.startsWith(VERIFIER_CORRECTION_PREFIX)) {
        correctionLengths.push(finalMessage.content.length);
      }
      const systemMessage = params.messages.find((message: any) => message.role === 'system');
      if (systemMessage) prompts.push(systemMessage.content);
      exposedTools.push(...(params.tools || []).map((tool: any) => tool.function.name));
      const results = params.messages.filter((message: any) => message.role === 'tool');
      toolResults.push(...results.map((message: any) => message.content));
      const message = activeTurn.tool && results.length === 0
        ? {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'replay-call', type: 'function', function: {
              name: activeTurn.tool.name, arguments: JSON.stringify(activeTurn.tool.args),
            } }],
          }
        : { role: 'assistant', content: activeTurn.modelReply };
      return {
        provider: 'groq', completionCalls: 1,
        response: { choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } },
      };
    },
  });

  for (const turn of turns) {
    activeTurn = turn;
    if (turn.nextDay) context.mock.timers.tick(24 * 60 * 60 * 1000);
    prompts = [];
    exposedTools = [];
    toolResults = [];
    const visibleHistory = history.slice(-6);
    const reply = await instance.handleMessage(customerId, turn.message, visibleHistory, 'whatsapp');
    frames.push({
      reply, customer: { ...customer }, draft: draft ? Object.assign({}, draft) : null,
      notes: [...notes], prompts: [...prompts], exposedTools: [...exposedTools],
      toolResults: [...toolResults], history: visibleHistory, escalations: escalationCalls.length,
    });
    history.push({ role: 'user', content: turn.message }, { role: 'assistant', content: reply });
  }

  await context.test('[FIXED IN 8.1a] [STATE] first name is persisted as soon as stated', () => {
    assert.equal(frames[0].draft?.name || frames[0].customer.name, 'Wairimu');
  });
  await context.test('[FIXED IN 8.6] [COST + MOCKED CALL] lashes turn is deterministic, so the replay needs no verifier retry', () => {
    // The lashes question used to reach the model and be corrected; it now returns the team-confirm reply directly.
    assert.equal(correctionLengths.length, 0);
    assert.equal(frames[10].prompts.length, 0, 'lashes must not reach the model');
    console.info('[REPLAY_VERIFIER_COST]', JSON.stringify({ turns: turns.length, correctiveCalls: correctionLengths.length, totalMockCompletions: totalCompletions }));
  });
  await context.test('[LINK-FIRST] [ROUTING] first catalog request shares the pricing page without listing editions', () => {
    assert.match(frames[1].reply, /https:\/\/www\.fiestahousematernity\.com\/session-packages/);
    assert.doesNotMatch(frames[1].reply, /Rate Card 2026|Ksh|THE BLOOM|THE EMPRESS/);
    assert.equal(frames[1].prompts.length, 0, 'catalog must bypass model generation');
  });
  await context.test('[FIXED IN 8.1a] [STATE] package selection is persisted immediately', () => {
    assert.equal(frames[2].draft?.service, 'THE BLOOM');
  });
  await context.test('[FIXED IN 8.4 CAPTURE] [CAPTURE] both explicitly chosen extras are saved and acknowledged', () => {
    const saved = frames[3].notes.join('\n');
    assert.match(saved, /makeup/i);
    assert.match(saved, /outfit/i);
    assert.match(frames[3].reply, /makeup/i);
    assert.match(frames[3].reply, /outfit/i);
  });
  await context.test('[FIXED IN 8.4 CAPTURE] [CAPTURE] hypothetical wig question saves nothing', () => {
    assert.deepEqual(frames[4].notes, frames[3].notes);
    assert.doesNotMatch(frames[4].reply, /^Noted:/i);
    assert.match(frames[4].reply, /would you like.*add/i);
  });
  await context.test('[FIXED IN 8.2] [TOOL CONTRACT + MOCKED CALL] next-week request exposes and executes a date-range tool', () => {
    assert.ok(frames[5].exposedTools.includes('get_available_dates'));
    assert.ok(frames[5].toolResults.length > 0);
    assert.ok(frames[5].toolResults.every((result) => !/ERROR|not found/i.test(result)));
    assert.doesNotMatch(frames[5].reply, /give me your name|which package/i);
  });
  await context.test('[FIXED IN 8.2] [STATE + FAULT INJECTION] October 6 reply uses computed Tuesday and retains date/time', () => {
    assert.doesNotMatch(frames[6].reply, /Monday|closed/i);
    assert.match(frames[6].reply, /Tuesday/);
    assert.equal(frames[6].draft?.date, '2026-10-06');
    assert.equal(frames[6].draft?.time, '10:00');
  });
  await context.test('[FIXED IN 8.2] [STATE + FAULT INJECTION] October 5 is refused as a Monday', async () => {
    activeTurn = { message: '5th October', modelReply: 'October 5 is Tuesday and the studio is open.' };
    const reply = await instance.handleMessage(customerId, activeTurn.message, history.slice(-6), 'whatsapp');
    assert.match(reply, /closed on Mondays, so Monday, 5 October is not available/);
    assert.doesNotMatch(reply, /Tuesday|studio is open/);
  });
  await context.test('[FIXED IN 8.8] [STATE/PROMPT + FAULT INJECTION] known slots survive trimmed history and next day', () => {
    assert.equal(frames[7].history.length, 6);
    assert.ok(!frames[7].history.some((message) => /My name is Wairimu/.test(message.content)));
    assert.equal(frames[7].draft?.name || frames[7].customer.name, 'Wairimu');
    assert.equal(frames[7].draft?.service, 'THE BLOOM');
    assert.match(frames[7].prompts.join('\n'), /Known so far:.*name="Wairimu";.*package="THE BLOOM"/);
    assert.doesNotMatch(frames[7].reply, /what is your name|which package/i);
    const nameQuestions = frames.filter((frame) => /what is your name|give me your name/i.test(frame.reply));
    assert.ok(nameQuestions.length <= 1);
  });
  await context.test('[FIXED IN 8.3] [ROUTING + FAULT INJECTION] booking-process and turnaround reply never invents a percentage deposit', () => {
    assert.doesNotMatch(frames[8].reply, /30%|4,500|7,500|six editions/i);
    assert.match(frames[8].reply, /2,000/);
    assert.match(frames[8].reply, /10 working days/);
    assert.equal(frames[8].prompts.length, 0, 'money and policy must bypass model generation');
  });
  await context.test('[FIXED IN 8.7] [SIMULATED QUOTA] exhausted-budget walk-in turn hands off rather than announcing a limit', () => {
    assert.doesNotMatch(frames[9].reply, /conversation limit|quota|today.*limit/i);
    assert.equal(frames[9].reply, BUDGET_HANDOFF_REPLY);
    assert.ok(frames[9].escalations > frames[8].escalations);
  });
  await context.test('[FIXED IN 8.6] [FAULT INJECTION] stale lashes price and retired package wording are blocked', () => {
    assert.doesNotMatch(frames[10].reply, /500|standard makeup package/i);
  });
  await context.test('[FIXED IN 8.6] [FAULT INJECTION] model reply has no leading stray punctuation', () => {
    assert.doesNotMatch(frames[11].reply, /^[\s\u2014\u2013-]+/);
  });
});