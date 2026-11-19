// Payment recovery: replies come from the draft step and latest payment row, never from the model.
import assert from 'node:assert/strict';
import test from 'node:test';
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { bookingAddonService } from '../booking/booking-addon.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { whatsappService } from '../messaging/whatsapp.service';
import { mpesaService } from '../payment/mpesa.service';
import { paymentController } from '../../controllers/payment.controller';
import { AgentService } from './agent.service';
import {
  classifyPaymentMessage,
  describeDarajaResult,
  getPaymentSituation,
  MAX_PAYMENT_ATTEMPTS,
  paymentFailureMessage,
} from './payment-recovery';
import { rememberBookingSlots } from './slot-memory';
import { bookingDraftService } from '../booking/booking-draft.service';

const CUSTOMER = '254712345678';
const MINUTE = 60_000;

type State = {
  draft: any;
  payment: any;
  slots: string[] | { status: string };
  stkPushes: number;
  escalations: string[];
  sent: string[];
  bookingsCreated: number;
  calendarEvents: number;
};

function harness(context: any, overrides: { draft?: Record<string, unknown>; payment?: Record<string, unknown> | null } = {}) {
  const restores: (() => void)[] = [];
  const stub = (target: any, method: string, implementation: (...args: any[]) => any) => {
    const original = target[method]; target[method] = implementation; restores.push(() => { target[method] = original; });
  };
  context.after(() => restores.reverse().forEach((restore) => restore()));

  const state: State = {
    draft: {
      id: 'draft-joan', customerId: CUSTOMER, step: 'payment_pending', service: 'THE ICON',
      date: '2026-10-08', time: '15:00', dateTimeIso: '2026-10-08T12:00:00.000Z', name: 'Joan',
      version: 2, createdAt: new Date(Date.now() - 30 * MINUTE), updatedAt: new Date(Date.now() - MINUTE),
      ...overrides.draft,
    },
    payment: overrides.payment === null ? null : {
      id: 'payment-joan', bookingDraftId: 'draft-joan', bookingId: null, amount: 2000, phone: CUSTOMER,
      status: 'pending', mpesaReceipt: null, checkoutRequestId: 'ws_CO_1', createdAt: new Date(Date.now() - MINUTE),
      updatedAt: new Date(Date.now() - MINUTE), ...overrides.payment,
    },
    slots: ['15:00'],
    stkPushes: 0,
    escalations: [],
    sent: [],
    bookingsCreated: 0,
    calendarEvents: 0,
  };

  const matches = (row: any, where: any) => Boolean(row) && Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (value && typeof value === 'object' && 'not' in (value as any)) return row[key] !== (value as any).not;
    return row[key] === value;
  });
  const apply = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in (value as any)) row[key] = (row[key] ?? 1) + (value as any).increment;
      else if (value && typeof value === 'object' && 'decrement' in (value as any)) row[key] = (row[key] ?? 1) - (value as any).decrement;
      else row[key] = value;
    }
    return { ...row };
  };
  const notFound = () => Object.assign(new Error('Record to update not found.'), { code: 'P2025' });

  stub(prisma.bookingDraft, 'findUnique', async () => (state.draft ? { ...state.draft } : null));
  stub(prisma.bookingDraft, 'update', async ({ where, data }: any) => {
    if (!matches(state.draft, where)) throw notFound();
    return apply(state.draft, { ...data, updatedAt: new Date() });
  });
  stub(prisma.bookingDraft, 'delete', async () => { const removed = state.draft; state.draft = null; if (state.payment) state.payment.bookingDraftId = null; return removed; });
  stub(prisma.payment, 'findFirst', async ({ where }: any) => {
    if (!state.payment) return null;
    if (where?.checkoutRequestId && where.checkoutRequestId !== state.payment.checkoutRequestId) return null;
    if (where?.bookingDraftId && where.bookingDraftId !== state.payment.bookingDraftId) return null;
    if (typeof where?.status === 'string' && where.status !== state.payment.status) return null;
    if (where?.booking) return state.payment.status === 'success' && state.payment.booking ? { ...state.payment } : null;
    const draft = state.payment.bookingDraftId && state.draft ? { ...state.draft, customer: { id: CUSTOMER, name: 'Joan' } } : null;
    return { ...state.payment, bookingDraft: draft, booking: state.payment.booking ?? null };
  });
  stub(prisma.payment, 'update', async ({ data }: any) => apply(state.payment, { ...data, updatedAt: new Date() }));
  stub(prisma.payment, 'updateMany', async ({ where, data }: any) => {
    if (!matches(state.payment, where)) return { count: 0 };
    apply(state.payment, { ...data, updatedAt: new Date() });
    return { count: 1 };
  });
  stub(prisma.package, 'findUnique', async () => ({ name: 'THE ICON', deposit: 2000 }));
  stub(bookingService, 'getAvailableSlots', async () => state.slots);
  stub(mpesaService, 'initiateStkPush', async () => {
    state.stkPushes++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { CheckoutRequestID: `ws_CO_${state.stkPushes + 1}` };
  });
  stub(whatsappService, 'sendMessage', async (_to: string, message: string) => { state.sent.push(message); return {}; });
  stub(whatsappService, 'sendDocument', async (_to: string, _pdf: unknown, _name: string, message: string) => { state.sent.push(message); return {}; });
  stub(prisma.notification, 'create', async () => ({ id: 'notification-test' }));
  stub(prisma.booking, 'create', async ({ data }: any) => {
    state.bookingsCreated++;
    const booking = { id: `booking-${state.bookingsCreated}`, ...data, customer: { id: CUSTOMER, name: 'Joan' } };
    state.payment.booking = booking;
    return booking;
  });
  stub(prisma.booking, 'update', async ({ data }: any) => ({ ...state.payment.booking, ...data }));
  stub(bookingAddonService, 'attachPendingToBooking', async () => {});
  stub(prisma.customerSessionNote, 'updateMany', async () => ({ count: 0 }));
  stub(googleCalendarService, 'createEvent', async () => { state.calendarEvents++; return `event-${state.calendarEvents}`; });
  stub(invoiceService, 'createOrRefreshForBooking', async () => ({ invoiceNumber: 'INV-TEST-1', pdfData: null, balanceDue: 33000 }));
  stub(prisma.customerMemory, 'findUnique', async () => null);
  stub(prisma.customerMemory, 'upsert', async () => ({}));
  stub(prisma.customerMemory, 'update', async () => ({ totalBookings: 1 }));
  stub(prisma.customerMemory, 'updateMany', async () => ({ count: 1 }));
  // Stub $transaction so rememberBookingSlots' atomic lapse-release runs through
  // the existing individual stubs (payment.findFirst, bookingDraft.updateMany) rather
  // than attempting a real DB transaction.
  stub(prisma, '$transaction', async (fn: any) => fn(prisma));

  const agent = new AgentService() as any;
  Object.assign(agent, {
    rememberBookingSlots: async () => null,
    getBookingProgressReply: async () => null,
    checkTokenBudget: async () => true,
    trackSentiment: async () => {},
    logAiJobMetric: async () => {},
    logConversationLearning: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    escalate: async (_customer: string, _type: string, description: string) => { state.escalations.push(description); },
    runAgent: async () => assert.fail('payment recovery messages must never reach the model'),
  });
  const say = (message: string) => agent.handleMessage(CUSTOMER, message, [], 'whatsapp') as Promise<string>;
  return { state, agent, say };
}

const attemptsOf = (draft: any) => draft.version - 1;

test('classifies the payment phrases from the Joan run', () => {
  for (const [message, kind] of [
    ['can we retry this', 'resend'],
    ['Kindly do it the last time', 'resend'],
    ['resend', 'resend'],
    ['It has not arrived', 'not_arrived'],
    ["I haven't received anything", 'not_arrived'],
    ['did it go through?', 'status_check'],
    ['I paid', 'paid_claim'],
    ["I've already paid", 'paid_claim'],
    ['i want to finish the payment', 'consent'],
    ['yes', 'consent'],
    ['start again', 'restart'],
    ['SFK7ABC123', 'receipt'],
    ['what is the payment details', 'payment_details'],
    ['what are the payment details?', 'payment_details'],
    ['where do I pay?', 'payment_details'],
    ['Where am I sending the money to?', 'payment_details'],
    ['Where do I send the deposit?', 'payment_details'],
    ['Where am I supposed to send the money?', 'payment_details'],
  ] as const) {
    assert.equal(classifyPaymentMessage(message), kind, message);
  }
  for (const message of ['cancel my booking', "no don't send it", 'what is your location?', 'thanks', 'ok']) {
    assert.equal(classifyPaymentMessage(message), null, message);
  }
});

test('payment-detail questions use the official Till without resending or invoking the model', async (context) => {
  const { state, say } = harness(context, {
    draft: {
      date: '2026-10-31',
      dateTimeIso: '2026-10-31T12:00:00.000Z',
    },
  });

  const reply = await say('Where am I sending the money to?');

  assert.match(reply, /Buy Goods Till Number 670241/);
  assert.match(reply, /Ksh 2,000/);
  assert.doesNotMatch(reply, /0700-XXXXXX/);
  assert.equal(state.stkPushes, 0);
  assert.equal(state.bookingsCreated, 0);
});
test('Daraja result codes map to customer sentences without raw Daraja text', () => {
  assert.equal(describeDarajaResult(1032).status, 'cancelled');
  for (const code of [1, 2001, 1037, 1001, 9999]) assert.equal(describeDarajaResult(code).status, 'failed');
  assert.match(describeDarajaResult('1').reason, /insufficient funds/);
  assert.match(describeDarajaResult(2001).reason, /PIN/);
  assert.match(describeDarajaResult(1037).reason, /timed out/);
  assert.match(describeDarajaResult(1001).reason, /already in progress/);
  const draft = { id: 'd', step: 'payment_pending', version: 2, updatedAt: new Date('2026-10-05T12:00:00Z') };
  const message = paymentFailureMessage(1032, draft);
  assert.match(message, /cancelled/);
  assert.match(message, /held until 3:15 PM/);
  assert.match(message, /Reply yes/);
  assert.doesNotMatch(message, /\.\.|Request Cancelled by user/);
  assert.match(paymentFailureMessage(1, { ...draft, version: MAX_PAYMENT_ATTEMPTS + 1 }), /0720 111928/);
  assert.doesNotMatch(paymentFailureMessage(1, { ...draft, version: MAX_PAYMENT_ATTEMPTS + 1 }), /Reply yes/);
});

test('getPaymentSituation reads the draft step and latest payment row', async (context) => {
  const { state } = harness(context);
  const now = Date.now();
  const kind = async () => (await getPaymentSituation(CUSTOMER, now)).kind;
  state.payment.updatedAt = new Date(now - 30_000);
  assert.equal(await kind(), 'prompt_sent');
  state.payment.updatedAt = new Date(now - 3 * MINUTE);
  assert.equal(await kind(), 'prompt_stale');
  state.payment.status = 'cancelled';
  assert.equal(await kind(), 'cancelled');
  state.payment.status = 'failed';
  assert.equal(await kind(), 'failed');
  state.draft.updatedAt = new Date(now - 16 * MINUTE);
  assert.equal(await kind(), 'hold_expired');
  state.payment.status = 'success';
  assert.equal(await kind(), 'paid');
  state.draft.step = 'awaiting_confirmation';
  state.payment = null;
  assert.equal(await kind(), 'none');
});

test('pending, then cancelled callback, then retry provides Till 670241 instructions', async (context) => {
  const { state, say } = harness(context, { draft: { version: 2 } });
  await paymentController.processMpesaCallback({ CheckoutRequestID: 'ws_CO_1', ResultCode: 1032, ResultDesc: 'Request Cancelled by user.' });
  assert.equal(state.payment.status, 'cancelled');

  const reply = await say('can we retry this');
  assert.match(reply, /670241/);
  assert.match(reply, /paste or forward the M-Pesa confirmation message/);
  assert.equal(state.stkPushes, 0);
});

test('cancelled twice, then yes provides Till payment instructions', async (context) => {
  const { state, say } = harness(context, { draft: { version: 3 }, payment: { status: 'cancelled' } });
  const reply = await say('yes');
  assert.match(reply, /670241/);
  assert.match(reply, /paste or forward the M-Pesa confirmation message/);
  state.payment.status = 'cancelled';
  state.draft.version = MAX_PAYMENT_ATTEMPTS + 1;
  const lastTime = await say('Kindly do it the last time');
  assert.match(lastTime, /won't send another.*0720 111928/s);
});

test('a young pending request reports accepted without claiming phone delivery or sending again', async (context) => {
  const { state, say } = harness(context, { payment: { updatedAt: new Date(Date.now() - 20_000) } });
  const reply = await say('yes');
  assert.match(reply, /670241/);
  assert.match(reply, /paste or forward the M-Pesa confirmation message/);
  assert.doesNotMatch(reply, /sent.*to your phone|booking is confirmed|session.*is booked/i);
  assert.equal(state.stkPushes, 0);
});

test('three failed prompts stop with a team message and one escalation', async (context) => {
  const { state, say } = harness(context, { draft: { version: MAX_PAYMENT_ATTEMPTS + 1 }, payment: { status: 'failed' } });
  const reply = await say('yes');
  assert.match(reply, /sent the M-Pesa prompt a few times.*check your M-Pesa line.*0720 111928/s);
  assert.equal(state.stkPushes, 0);
  assert.equal(state.escalations.length, 1);
  assert.match(state.escalations[0], /3 M-Pesa prompts/);
});

test('the prompt limit lapses with the unpaid request: two days later a yes re-proposes instead of refusing forever', async (context) => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * MINUTE);
  const { state, say } = harness(context, { draft: { date: '2027-10-08', version: MAX_PAYMENT_ATTEMPTS + 1, updatedAt: twoDaysAgo }, payment: { status: 'failed', updatedAt: twoDaysAgo } });
  const reply = await say('yes');
  assert.doesNotMatch(reply, /a few times/);
  assert.match(reply, /still free.*deposit is Ksh 2,000.*Reply yes/s);
  assert.equal(state.draft.step, 'awaiting_confirmation');
  assert.equal(state.draft.version, 1, 'the new attempt starts with a fresh prompt count');
  assert.equal(state.stkPushes, 0, 'a fresh explicit yes is still needed before any prompt');
  assert.deepEqual(state.escalations, []);
});

test('a lapsed unpaid request for a date that has passed is released, not re-proposed', async (context) => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * MINUTE);
  const { state, say } = harness(context, { draft: { date: '2026-10-01', version: MAX_PAYMENT_ATTEMPTS + 1, updatedAt: twoDaysAgo }, payment: { status: 'failed', updatedAt: twoDaysAgo } });
  const reply = await say('yes');
  assert.match(reply, /has lapsed, and no payment was taken\. Which date would you like now\?/);
  assert.deepEqual([state.draft.step, state.draft.date, state.draft.time, state.draft.version], ['collecting_slots', null, null, 1]);
  assert.equal(state.stkPushes, 0);
});

test('new booking details replace a lapsed unpaid payment step, but never a paid or recent one', async (context) => {
  const { state } = harness(context, { draft: { version: MAX_PAYMENT_ATTEMPTS + 1, updatedAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE) }, payment: { status: 'failed' } });
  const original = { updateMany: prisma.bookingDraft.updateMany, customer: prisma.customer.findUnique };
  context.after(() => { prisma.bookingDraft.updateMany = original.updateMany; prisma.customer.findUnique = original.customer; });
  (prisma.bookingDraft.updateMany as any) = async ({ where, data }: any) => {
    if (where.step && where.step !== state.draft.step) return { count: 0 };
    Object.assign(state.draft, data, { updatedAt: new Date() }); return { count: 1 };
  };
  (prisma.customer.findUnique as any) = async () => ({ id: CUSTOMER, name: 'Joan' });
  await rememberBookingSlots(CUSTOMER, 'lets do it on 2027-10-14', []);
  // Version sequence: lapse-release resets to 1, then the slot update increments to 2
  // in the same rememberBookingSlots call, so the final version is 2.
  assert.deepEqual([state.draft.step, state.draft.date, state.draft.version], ['collecting_slots', '2027-10-14', 2]);

  for (const blocked of [{ status: 'success', updatedAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE) }, { status: 'failed', updatedAt: new Date(Date.now() - 5 * MINUTE) }]) {
    Object.assign(state.draft, { step: 'payment_pending', date: '2027-10-08', version: 4, updatedAt: blocked.updatedAt });
    state.payment.status = blocked.status;
    await rememberBookingSlots(CUSTOMER, 'lets do it on 2027-10-14', []);
    assert.deepEqual([state.draft.step, state.draft.date], ['payment_pending', '2027-10-08'], JSON.stringify(blocked));
  }
});

test('a proposal for a different edition or slot starts a fresh prompt count; re-proposing the same slot does not', async (context) => {
  const original = { findUnique: prisma.bookingDraft.findUnique, upsert: prisma.bookingDraft.upsert };
  context.after(() => { prisma.bookingDraft.findUnique = original.findUnique; prisma.bookingDraft.upsert = original.upsert; });
  const updates: any[] = [];
  (prisma.bookingDraft.findUnique as any) = async () => ({ service: 'THE ICON', date: '2027-10-08', time: '15:00' });
  (prisma.bookingDraft.upsert as any) = async ({ update }: any) => { updates.push(update); return update; };
  await bookingDraftService.saveBookingProposal({ customerId: CUSTOMER, service: 'THE BLOOM', dateTime: '2027-10-15T11:00:00.000Z', customerName: 'Joan' });
  await bookingDraftService.saveBookingProposal({ customerId: CUSTOMER, service: 'THE ICON', dateTime: '2027-10-08T12:00:00.000Z', customerName: 'Joan' });
  assert.equal(updates[0].version, 1);
  assert.equal('version' in updates[1], false);
});

test('"hello" with a lapsed unpaid request gets its status, not the model', async (context) => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * MINUTE);
  const { say } = harness(context, { draft: { service: 'THE BLOOM', date: '2027-10-15', time: '14:00', version: MAX_PAYMENT_ATTEMPTS + 1, updatedAt: twoDaysAgo }, payment: { status: 'failed', updatedAt: twoDaysAgo } });
  const reply = await say('hello');
  assert.match(reply, /^Welcome back\. Your earlier request for the Bloom edition on .*15 October at 2:00 PM was not paid, so nothing is booked yet\. Reply yes/);
  assert.doesNotMatch(reply, /a few times|can.t confirm a new booking/);
});

test('it has not arrived after 30 seconds answers from state without the model or a new push', async (context) => {
  const { state, say } = harness(context, { payment: { updatedAt: new Date(Date.now() - 30_000) } });
  const reply = await say('It has not arrived');
  assert.match(reply, /number ending 678/);
  assert.match(reply, /phone is on.*signal/);
  assert.match(reply, /reply resend/i);
  assert.match(reply, /0720 111928/);
  assert.equal(state.stkPushes, 0);
});

test('the reported prompt never came keeps payment pending and does not push or confirm again', async (context) => {
  const { state, say } = harness(context);
  const reply = await say('The prompt never came');
  assert.equal(classifyPaymentMessage('The prompt never came'), 'not_arrived');
  assert.match(reply, /can't verify that a prompt reached your phone/);
  assert.match(reply, /number ending 678/);
  assert.doesNotMatch(reply, /sent.*to your phone|payment (?:is )?confirmed/i);
  assert.equal(state.stkPushes, 0);
  assert.equal(state.bookingsCreated, 0);
  assert.equal(state.calendarEvents, 0);
  assert.equal(state.payment.status, 'pending');
  assert.equal(state.draft.step, 'payment_pending');
});

test('an expired 16 minute hold rechecks the slot before re-proposing, never pushing directly', async (context) => {
  const { state, say } = harness(context, { draft: { date: '2027-10-08', updatedAt: new Date(Date.now() - 16 * MINUTE) }, payment: { status: 'failed' } });
  let rechecked = 0;
  (bookingService.getAvailableSlots as any) = async (date: string, _duration: number, _booking: unknown, excludeDraftId: string) => {
    rechecked++; assert.equal(date, '2027-10-08'); assert.equal(excludeDraftId, 'draft-joan'); return ['15:00'];
  };
  const reply = await say('yes');
  assert.equal(rechecked, 1);
  assert.equal(state.stkPushes, 0);
  assert.equal(state.draft.step, 'awaiting_confirmation');
  assert.match(reply, /hold ended.*still free/s);
  assert.match(reply, /deposit is Ksh 2,000.*Reply yes/s);
});

test('a slot taken during the expired hold offers alternatives and keeps the package', async (context) => {
  const { state, say } = harness(context, { draft: { date: '2027-10-08', updatedAt: new Date(Date.now() - 16 * MINUTE) }, payment: { status: 'cancelled' } });
  state.slots = ['10:00', '11:30'];
  const reply = await say('yes');
  assert.equal(state.stkPushes, 0);
  assert.equal(state.draft.step, 'collecting_slots');
  assert.equal(state.draft.service, 'THE ICON');
  assert.equal(state.draft.date, '2027-10-08');
  assert.equal(state.draft.time, null);
  assert.match(reply, /Icon edition/);
  assert.match(reply, /10:00 AM.*11:30 AM/);
});

test('I paid without a success row does not confirm and asks for the receipt code', async (context) => {
  const { state, say } = harness(context, { payment: { status: 'pending', updatedAt: new Date(Date.now() - 3 * MINUTE) } });
  const reply = await say('I paid');
  assert.match(reply, /can't see the payment yet.*receipt code/s);
  assert.doesNotMatch(reply, /confirmed|received/i);
  assert.equal(state.stkPushes, 0);
  const receipt = await say('SFK7ABC123');
  assert.match(receipt, /SFK7ABC123.*team/s);
  assert.doesNotMatch(receipt, /booking is confirmed/i);
  assert.ok(state.escalations.some((entry) => /SFK7ABC123/.test(entry)));
});

test('a success callback confirms once and a duplicate callback creates nothing', async (context) => {
  const { state, say } = harness(context);
  const callback = {
    CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
    CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'SFK7SUCCESS' }] },
  };
  await paymentController.processMpesaCallback(callback);
  assert.equal(state.bookingsCreated, 1);
  assert.equal(state.calendarEvents, 1);
  assert.equal(state.payment.status, 'success');
  assert.equal(state.draft, null);
  const confirmations = state.sent.length;
  await paymentController.processMpesaCallback(callback);
  assert.equal(state.bookingsCreated, 1);
  assert.equal(state.calendarEvents, 1);
  assert.equal(state.sent.length, confirmations);
  assert.match(await say('did it go through?'), /payment is confirmed/);
});

test('duplicate yes within 5 seconds returns payment instructions without STK push', async (context) => {
  const { state, say } = harness(context, { payment: { status: 'cancelled' } });
  const replies = await Promise.all([say('yes'), say('yes')]);
  assert.equal(state.stkPushes, 0);
  assert.ok(replies.every((reply) => /670241/.test(reply)));
});

test('forwarding full M-Pesa SMS message records receipt and notifies team that member will verify', async (context) => {
  const { state, say } = harness(context, { payment: { status: 'pending', amount: 2000 } });
  const mpesaSms = 'QA12BC34DE Confirmed. Ksh2,000.00 sent to Fiesta House Maternity on 27/10/26 at 5:05 PM. New M-PESA balance is Ksh15,450.00. Transaction cost, Ksh0.00.';
  const reply = await say(mpesaSms);
  assert.match(reply, /QA12BC34DE/);
  assert.match(reply, /team member will verify/i);
  assert.doesNotMatch(reply, /booking is confirmed/i);
  assert.equal(state.payment.mpesaReceipt, 'QA12BC34DE');
  assert.ok(state.escalations.some((entry) => /QA12BC34DE/.test(entry)));
});
