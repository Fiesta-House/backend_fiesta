// Rescheduling mutates the existing confirmed booking; it never restarts the new-booking flow.
import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { inBusinessTimezone, nowInBusinessTimezone } from '../../utils/time';
import { AgentService } from './agent.service';
import { extractStatedSlots, isUsableName } from './slot-memory';
import { ConversationFlowMatcher, isBookingPolicyQuestion, rescheduleTargetText } from './conversation-flow.matcher';

const CUSTOMER = 'synthetic-joan';
type Msg = { role: 'user' | 'assistant'; content: string };

function harness(context: any, daysAhead: number) {
  const restores: (() => void)[] = [];
  const stub = (target: any, method: string, implementation: (...args: any[]) => any) => {
    const original = target[method]; target[method] = implementation; restores.push(() => { target[method] = original; });
  };
  context.after(() => restores.reverse().forEach((restore) => restore()));

  const start = nowInBusinessTimezone().add(daysAhead, 'day').hour(15).minute(0).second(0).millisecond(0);
  const state = {
    booking: { id: 'booking-icon', customerId: CUSTOMER, service: 'THE ICON', dateTime: start.toDate(), status: 'confirmed', googleEventId: 'event-icon', customer: { id: CUSTOMER, name: 'No its Joan' } },
    draft: null as any,
    createdSteps: [] as string[],
    bookingsCreated: 0,
    bookingUpdates: [] as any[],
    calendarUpdates: 0,
    invoiceRefreshes: [] as string[],
    slots: ['10:00', '15:00', '17:00'] as string[] | { status: string; reason: string },
    slotQueries: [] as { date: string; excludeBookingId?: string }[],
    deleted: [] as any[],
    availableBookings: null as any[] | null,
    bookingQueries: [] as any[],
  };
  const bookingDay = start.format('YYYY-MM-DD');

  stub(prisma.booking, 'findFirst', async ({ where }: any) => { state.bookingQueries.push(where); return { ...state.booking }; });
  stub(prisma.booking, 'findMany', async () => state.availableBookings ?? [{ ...state.booking }]);
  stub(prisma.booking, 'findUnique', async () => ({ ...state.booking }));
  stub(prisma.booking, 'update', async ({ data }: any) => { state.bookingUpdates.push(data); Object.assign(state.booking, data); return { ...state.booking }; });
  stub(prisma.booking, 'create', async () => { state.bookingsCreated++; return {}; });
  stub(prisma.customer, 'findUnique', async () => ({ id: CUSTOMER, name: 'No its Joan' }));
  stub(prisma.bookingDraft, 'findUnique', async () => (state.draft ? { ...state.draft } : null));
  stub(prisma.bookingDraft, 'create', async ({ data }: any) => { state.createdSteps.push(data.step); state.draft = { id: `draft-${state.createdSteps.length}`, ...data }; return state.draft; });
  stub(prisma.bookingDraft, 'updateMany', async ({ where, data }: any) => {
    if (!state.draft || where.id !== state.draft.id || (where.step && where.step !== state.draft.step)) return { count: 0 };
    Object.assign(state.draft, data);
    return { count: 1 };
  });
  stub(prisma.bookingDraft, 'upsert', async ({ update, create }: any) => { state.draft = state.draft ? { ...state.draft, ...update } : { id: 'reschedule-draft', ...create }; return state.draft; });
  stub(prisma.bookingDraft, 'deleteMany', async ({ where }: any) => {
    state.deleted.push(where);
    if (state.draft && where.id === state.draft.id && where.step === state.draft.step) { state.draft = null; return { count: 1 }; }
    return { count: 0 };
  });
  stub(bookingService, 'getAvailableSlots', async (date: string, _duration: number, excludeBookingId?: string) => {
    state.slotQueries.push({ date, excludeBookingId });
    return state.slots;
  });
  stub(googleCalendarService, 'updateEvent', async () => { state.calendarUpdates++; return true; });
  stub(invoiceService, 'createOrRefreshForBooking', async (bookingId: string) => { state.invoiceRefreshes.push(bookingId); return null; });

  const agent = new AgentService() as any;
  Object.assign(agent, {
    getBookingProgressReply: async () => assert.fail('a reschedule reply must not continue the new-booking flow'),
    checkTokenBudget: async () => true,
    trackSentiment: async () => {},
    logAiJobMetric: async () => {},
    logConversationLearning: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    escalate: async () => {},
    notifyRescheduleAdmin: async () => {},
    runAgent: async () => assert.fail('the reschedule flow must not reach the model'),
  });
  const history: Msg[] = [];
  const say = async (message: string) => {
    const reply: string = await agent.handleMessage(CUSTOMER, message, history.slice(-6), 'whatsapp');
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    return reply;
  };
  say.withHistory = async (extra: Msg[], message: string) => {
    history.push(...extra);
    return say(message);
  };
  return { state, say, bookingDay };
}

test('policy enquiries remain informational even when a draft blocks rescheduling', async (context) => {
  const { state, say } = harness(context, 10);
  for (const step of ['collecting_slots', 'awaiting_confirmation', 'payment_pending', 'reschedule_collecting']) {
    state.draft = { id: 'policy-conflict', step, service: 'THE MUSE', date: '2026-10-10', time: '10:00', name: 'Maryanne' };
    const before = { ...state.draft };
    for (const message of ['What is the rescheduling and cancellation policy?', 'What is your rescheduling policy?',
      'Please explain the cancellation rules', 'What is the rescheduling policy for 10th October?']) {
      const reply = await say(message);
      assert.match(reply, /Rescheduling:.*72 hours[\s\S]*Cancellation:/);
      assert.match(reply, /No booking change or cancellation has been made/);
      assert.doesNotMatch(reply, /resolve the existing step|which package|which new date/i);
      assert.deepEqual(state.draft, before);
    }
  }
  assert.equal(state.createdSteps.length, 0);
  assert.equal(state.deleted.length, 0);
  assert.equal(state.slotQueries.length, 0);
  assert.equal(state.bookingUpdates.length, 0);
  assert.equal(state.calendarUpdates, 0);
});

test('policy matching distinguishes information from actual reschedule intent', () => {
  const flows = new ConversationFlowMatcher();
  for (const text of ['What is the rescheduling and cancellation policy?', 'Tell me the refund terms', 'How much notice is needed for rescheduling?']) {
    assert.equal(isBookingPolicyQuestion(text), true);
    assert.equal(flows.isInitialRescheduleRequest(text), false);
  }
  for (const text of ['i want we reschedule it', 'can we reschedule the session to another time', 'Please move my appointment to Saturday']) {
    assert.equal(isBookingPolicyQuestion(text), false);
    assert.equal(flows.isInitialRescheduleRequest(text), true);
  }
});

test('blocked rescheduling explains the saved draft without assuming it is a genuine separate booking', async (context) => {
  const { state, say } = harness(context, 10);
  for (const [step, phrase] of [['collecting_slots', /Unfinished booking details/], ['awaiting_confirmation', /saved booking proposal/],
    ['payment_pending', /payment status must be checked/]] as const) {
    state.draft = { id: 'existing-draft', step, service: 'THE MUSE', date: '2026-10-10', time: '10:00' };
    const before = { ...state.draft };
    const reply = await say('i want we reschedule it');
    assert.match(reply, phrase);
    assert.match(reply, /0720 111928/);
    assert.match(reply, /No session has been moved or cancelled by this request/);
    assert.doesNotMatch(reply, /separate booking|prompt was sent|payment failed/);
    assert.deepEqual(state.draft, before);
  }
  assert.equal(state.bookingUpdates.length, 0);
  assert.equal(state.createdSteps.length, 0);
  assert.equal(state.deleted.length, 0);
});

test('initial Muse reschedule request treats busy Friday as the rejected date, not a new booking', async (context) => {
  const { state, say } = harness(context, 10);
  state.booking.service = 'THE MUSE';
  state.booking.customer.name = 'Maryanne';
  const before = { ...state.booking };
  const reply = await say.withHistory([{ role: 'assistant', content:
    'Your THE MUSE session is on Friday, 9 October 2026 at 2:00 PM. Your saved extras are Fiesta House Power Suit. It is confirmed, and your deposit has been paid.' }],
    'thats nice can we kindly reschedule it to some other date...i will be busy that Friday');
  assert.match(reply, /Which new date and time would suit you.*Muse/i);
  assert.doesNotMatch(reply, /which package|your name|what time.*Friday|that day/i);
  assert.deepEqual(state.createdSteps, ['reschedule_collecting']);
  assert.equal(state.draft.bookingId, state.booking.id);
  assert.equal(state.draft.service, 'THE MUSE');
  assert.equal(state.draft.date, null);
  assert.equal(state.draft.time, null);
  assert.deepEqual(state.booking, before);
  assert.equal(state.slotQueries.length, 0);
  assert.equal(state.bookingsCreated, 0);
  assert.equal(state.bookingUpdates.length, 0);
  assert.equal(state.calendarUpdates, 0);
  assert.equal(state.invoiceRefreshes.length, 0);
});

test('initial explicit replacement date proposes the same booking and waits for confirmation', async (context) => {
  const { state, say } = harness(context, 10);
  const target = nowInBusinessTimezone().add(11, 'day');
  const originalDate = state.booking.dateTime.getTime();
  const extras = [{ name: 'Fiesta House Power Suit', totalPrice: 10000 }];
  Object.assign(state.booking, { bookingAddons: extras, depositPaid: 2000 });
  const proposal = await say(`Please reschedule my session to ${target.format('YYYY-MM-DD')} at 10am because I will be busy Friday`);
  assert.match(proposal, /10:00 AM is available.*confirm the change\?$/s);
  assert.equal(state.draft.bookingId, 'booking-icon');
  assert.equal(state.draft.date, target.format('YYYY-MM-DD'));
  assert.equal(state.draft.time, '10:00');
  assert.equal(state.booking.dateTime.getTime(), originalDate);
  assert.equal(state.bookingUpdates.length, 0);
  assert.equal(state.calendarUpdates, 0);
  assert.equal(state.invoiceRefreshes.length, 0);
  assert.ok(!state.createdSteps.includes('collecting_slots'));
  assert.ok(state.bookingQueries.length >= 2);
  assert.ok(state.bookingQueries.every(where => where.id === 'booking-icon'), 'selection and proposal both query the bound booking');
  await say('yes');
  assert.equal(state.bookingUpdates.length, 1);
  assert.equal(inBusinessTimezone(state.booking.dateTime).format('YYYY-MM-DD HH:mm'), `${target.format('YYYY-MM-DD')} 10:00`);
  assert.equal((state.booking as any).depositPaid, 2000);
  assert.deepEqual((state.booking as any).bookingAddons, extras);
  assert.equal(state.bookingsCreated, 0);
});

test('replacement date survives date-only selection, trimmed history and an intervening reminder', async (context) => {
  const { state, say } = harness(context, 10);
  const target = nowInBusinessTimezone().add(11, 'day').format('YYYY-MM-DD');
  await say('Can we reschedule to some other date?');
  assert.match(await say(target), /What time on/);
  assert.equal(state.draft.date, target);
  const reminders: Msg[] = Array.from({ length: 8 }, () => ({ role: 'assistant', content: 'Your original session remains booked. We look forward to welcoming you.' }));
  const proposal = await say.withHistory(reminders, '10am please');
  assert.match(proposal, /10:00 AM is available.*confirm the change\?$/s);
  assert.equal(state.draft.date, target);
  assert.equal(state.draft.time, '10:00');
  assert.equal(state.draft.bookingId, 'booking-icon');
  assert.equal(state.bookingUpdates.length, 0);
  assert.ok(!state.createdSteps.includes('collecting_slots'));
});

test('initial reschedule is fail-closed for ambiguous bookings and unrelated active drafts', async (context) => {
  const { state, say } = harness(context, 10);
  state.availableBookings = [state.booking, { ...state.booking, id: 'second-booking', service: 'THE MUSE' }];
  assert.match(await say('Can we reschedule my session?'), /more than one upcoming session.*Which session/);
  assert.equal(state.draft, null);
  assert.equal(state.createdSteps.length, 0);
  state.availableBookings = [];
  assert.match(await say('Can we reschedule my session?'), /could not find an upcoming confirmed session/);
  assert.equal(state.draft, null);
  state.availableBookings = null;
  for (const step of ['collecting_slots', 'awaiting_confirmation', 'payment_pending', 'cancel_confirm']) {
    state.draft = { id: 'other-request', step, service: 'THE MUSE', date: '2026-11-12', time: '14:00', name: 'Maryanne' };
    const before = { ...state.draft };
    assert.match(await say('Can we reschedule my session?'), /not changed your current request or your session/);
    assert.deepEqual(state.draft, before);
  }
  assert.equal(state.bookingUpdates.length, 0);
  assert.equal(state.slotQueries.length, 0);
  assert.equal(state.deleted.length, 0);
});

test('reschedule intent distinguishes unavailable clauses, targets and withdrawal', () => {
  const flows = new ConversationFlowMatcher();
  assert.equal(rescheduleTargetText('move my session from Friday to Saturday at 10am because I am busy Friday').trim(), 'Saturday at 10am');
  assert.equal(rescheduleTargetText("I can't do Friday, reschedule to Saturday at 10am").trim(), 'reschedule to Saturday at 10am');
  assert.equal(flows.isInitialRescheduleRequest("Let's not reschedule"), false);
  assert.equal(flows.isInitialRescheduleRequest('Can I change my name?'), false);
  assert.equal(flows.isInitialRescheduleRequest('remove the extra outfit'), false);
  assert.equal(flows.isInitialRescheduleRequest('Can we reschedule the session?'), true);
});

test('Joan run: same day but from 5pm moves the existing Icon booking without asking name or package', async (context) => {
  const { state, say, bookingDay } = harness(context, 1);

  const ask = await say('Okay can we push it to some other time kindly?');
  assert.match(ask, /within 72 hours.*forfeit your deposit.*share your preferred date and time/s);

  const proposal = await say('same day but from 5pm');
  assert.doesNotMatch(proposal, /your name|which package|No its Joan/i);
  assert.match(proposal, /5:00 PM is available/);
  assert.match(proposal, /Icon edition from 3:00 PM to 5:00 PM/);
  assert.match(proposal, /forfeit your deposit/);
  assert.match(proposal, /confirm the change\?$/);
  assert.deepEqual(state.createdSteps, ['reschedule_collecting'], 'only the reschedule context is stored, never a new-booking draft');
  assert.deepEqual(state.slotQueries.at(-1), { date: bookingDay, excludeBookingId: 'booking-icon' });
  assert.equal(state.draft.step, 'reschedule_confirm');
  assert.equal(state.draft.bookingId, 'booking-icon');
  assert.equal(state.draft.date, bookingDay);
  assert.equal(state.draft.time, '17:00');
  assert.equal(state.draft.service, 'THE ICON');

  const done = await say('yes');
  assert.match(done, /has been moved to/);
  assert.equal(state.bookingsCreated, 0, 'a reschedule never creates a new booking');
  assert.equal(state.bookingUpdates.length, 1);
  assert.equal(inBusinessTimezone(state.bookingUpdates[0].dateTime).format('YYYY-MM-DD HH:mm'), `${bookingDay} 17:00`);
  assert.equal(state.calendarUpdates, 1);
  assert.deepEqual(state.invoiceRefreshes, ['booking-icon'], 'the existing invoice is refreshed, not replaced');
  assert.equal(state.draft, null);
});

test('a booking outside 72 hours proposes the move without a forfeiture warning', async (context) => {
  const { say } = harness(context, 10);
  assert.match(await say('Can I reschedule?'), /Which new date and time would suit you/);
  const proposal = await say('same day but from 5pm');
  assert.match(proposal, /from 3:00 PM to 5:00 PM/);
  assert.doesNotMatch(proposal, /forfeit/);
  assert.match(proposal, /edition and extras stay the same/);
});

test('an unavailable reschedule time offers alternatives on the existing date and keeps the booking', async (context) => {
  const { state, say } = harness(context, 10);
  state.slots = ['10:00', '11:30'];
  await say('Can I reschedule?');
  const reply = await say('5pm please');
  assert.match(reply, /5:00 PM is not available.*closest available times are 10:00 AM, 11:30 AM/s);
  assert.equal(state.draft.step, 'reschedule_collecting', 'the reschedule context survives an unavailable time');
  assert.equal(state.bookingUpdates.length, 0);
});

test('live run: Icon at 5pm explains the latest start, and a later pick survives a reminder in between', async (context) => {
  const { state, say } = harness(context, 1);
  state.slots = ['09:00', '09:30', '10:00', '15:00', '15:30', '16:00', '16:30'];
  await say('can we push it to some other time?');
  const unavailable = await say('yes proceed...i want it on the same day but at 5pm');
  assert.match(unavailable, /5:00 PM is not available.*runs 2 hours 30 minutes.*latest start that day is 4:30 PM/s);
  assert.match(unavailable, /3:30 PM, 4:00 PM, 4:30 PM/);
  const reminder: Msg = { role: 'assistant', content: 'Hi Joan, your THE ICON session is tomorrow at 3:00 PM. Please arrive about 30 minutes early.' };
  const proposal = await say.withHistory([reminder], "Let's go with 10am");
  assert.doesNotMatch(proposal, /which package|your name/i);
  assert.match(proposal, /from 3:00 PM to 10:00 AM.*confirm the change\?$/s);
  assert.equal(state.draft.step, 'reschedule_confirm');
  assert.equal(state.draft.time, '10:00');
  assert.ok(!state.createdSteps.includes('collecting_slots'));
});

test('an empty draft left by the old slot capture does not block the reschedule', async (context) => {
  const { state, say } = harness(context, 10);
  await say('Can I reschedule?');
  state.draft = { id: 'stale', step: 'collecting_slots', name: 'No its Joan', service: null, date: null, time: '17:00' };
  const proposal = await say('same day but from 5pm');
  assert.match(proposal, /confirm the change\?$/);
  assert.equal(state.deleted[0].id, 'stale');
  assert.equal(state.draft.step, 'reschedule_confirm');
});

test('a corrected name answer stores the name, never the correction phrase', () => {
  const asked: Msg[] = [{ role: 'assistant', content: 'May I have your full name to prepare the booking details?' }];
  assert.equal(extractStatedSlots('No its Joan', asked).name, 'Joan');
  assert.equal(extractStatedSlots("It's Joan Wanjiku", asked).name, 'Joan Wanjiku');
  assert.equal(isUsableName('No its Joan'), false);
  assert.equal(isUsableName('WhatsApp User'), false);
  assert.equal(isUsableName('Yesenia Otieno'), true);
});
