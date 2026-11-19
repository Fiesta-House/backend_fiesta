import assert from 'node:assert/strict';
import test from 'node:test';
import { decideWorkflow as decideEvent, type WorkflowDecision, type WorkflowEvent, type WorkflowSnapshot } from './workflow-engine';
import baseline from './workflow-baseline.fixtures.json';

const snapshot: WorkflowSnapshot = {
  status: 'ready', customerId: 'synthetic-customer', customerName: 'Synthetic Customer',
  bookings: [{ id: 'muse-booking', customerId: 'synthetic-customer', service: 'THE MUSE',
    date: '2026-10-09', time: '14:00', dateTimeIso: '2026-10-09T11:00:00Z', status: 'confirmed', paidAmount: 2000 }],
  operation: { id: 'conflicting-draft', customerId: 'synthetic-customer', kind: 'new_booking',
    state: 'collecting', revision: 3, slots: { date: '2026-10-09' } },
  block: { id: 'blocked-reschedule', customerId: 'synthetic-customer', intendedKind: 'reschedule',
    conflictingOperationId: 'conflicting-draft', reason: 'existing_request_requires_review' },
  externalEffect: 'none', now: Date.parse('2026-10-06T06:00:00Z'),
};

function decideWorkflow(current: WorkflowSnapshot, event: WorkflowEvent): WorkflowDecision {
  return decideEvent(current, event, ['availability_result', 'provider_failure'].includes(event.intent) ? 'system' : 'customer');
}

test('workflow core keeps blocked requests blocked independently of history and model suggestions', () => {
  const before = JSON.stringify(snapshot);
  for (const intent of ['clarify', 'provide_slots', 'confirm', 'start', 'availability', 'unknown'] as const) {
    const event: WorkflowEvent = { turnId: `turn-${intent}`, platform: 'whatsapp', intent,
      operationKind: 'reschedule', slots: { date: '2026-10-10', time: '10:00' }, slotSource: 'model' };
    const result = decideWorkflow(snapshot, event);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.transition, 'retain');
    assert.deepEqual(result.commands, []);
    assert.equal(result.expectedOperationId, 'conflicting-draft');
    assert.equal(result.expectedRevision, 3);
    assert.equal(result.modelMayChangeWorkflow, false);
  }
  assert.equal(JSON.stringify(snapshot), before);
});

test('workflow core allows scoped information without clearing a conflict', () => {
  for (const topic of ['name', 'booking', 'payment', 'addons', 'invoice'] as const) {
    const result = decideWorkflow(snapshot, { turnId: `info-${topic}`, platform: 'whatsapp', intent: 'information', topic });
    assert.equal(result.outcome, 'information_requested');
    assert.equal(result.transition, 'retain');
    assert.equal(result.commands[0].kind, 'read_information');
    assert.equal(snapshot.block?.id, 'blocked-reschedule');
  }
});

test('workflow core fails closed on missing authoritative data and foreign targets', () => {
  const event: WorkflowEvent = { turnId: 'foreign', platform: 'whatsapp', intent: 'information', topic: 'invoice', targetBookingId: 'foreign-booking' };
  assert.equal(decideWorkflow(snapshot, event).outcome, 'failed');
  assert.equal(decideWorkflow({ ...snapshot, status: 'unavailable' }, event).commands.length, 0);
  assert.equal(decideWorkflow({ ...snapshot, operation: { ...snapshot.operation!, customerId: 'another-customer' } }, event).outcome, 'failed');
});

test('workflow core does not restart an operation while an external effect is unknown', () => {
  const result = decideWorkflow({ ...snapshot, block: null, externalEffect: 'unknown' },
    { turnId: 'retry', platform: 'whatsapp', intent: 'start', operationKind: 'reschedule' });
  assert.equal(result.outcome, 'reconciliation_pending');
  assert.deepEqual(result.commands, []);
});

function readySnapshot(): WorkflowSnapshot {
  return { ...structuredClone(snapshot), operation: null, block: null,
    packages: [{ service: 'THE MUSE', deposit: 2000 }] };
}

function acceptDecision(current: WorkflowSnapshot, decision: WorkflowDecision): WorkflowSnapshot {
  return { ...current, operation: decision.nextOperation || current.operation,
    block: decision.nextBlock || current.block,
    proposal: decision.nextProposal === undefined ? current.proposal : decision.nextProposal,
    clarification: decision.nextClarification === undefined ? current.clarification : decision.nextClarification };
}

function startReschedule(): WorkflowSnapshot {
  const current = readySnapshot();
  return acceptDecision(current, decideWorkflow(current,
    { turnId: 'start-reschedule', platform: 'whatsapp', intent: 'start', operationKind: 'reschedule' }));
}

function availableResult(current: WorkflowSnapshot, slots: readonly string[] = ['10:00', '14:00']): WorkflowSnapshot {
  return { ...current, availability: { operationId: current.operation!.id, operationRevision: current.operation!.revision,
    date: current.operation!.slots.date!, service: current.operation!.slots.service!, excludeBookingId: current.operation!.targetBookingId,
    status: 'available', slots } };
}

test('workflow engine binds reschedule to the confirmed booking without copying the rejected original date', () => {
  const current = readySnapshot();
  const decision = decideWorkflow(current, { turnId: 'reschedule', platform: 'whatsapp', intent: 'start', operationKind: 'reschedule' });
  assert.equal(decision.requiredInput, 'date');
  assert.equal(decision.nextOperation?.targetBookingId, 'muse-booking');
  assert.equal(decision.nextOperation?.slots.service, 'THE MUSE');
  assert.equal(decision.nextOperation?.slots.date, undefined);
  assert.equal(current.bookings[0].paidAmount, 2000);
  assert.deepEqual(decision.commands, []);
  const rejected = decideWorkflow(acceptDecision(current, decision), { turnId: 'busy-Friday', platform: 'whatsapp',
    intent: 'provide_slots', slotSource: 'rejected', slots: { date: '2026-10-09' } });
  assert.equal(rejected.transition, 'retain');
  assert.deepEqual(rejected.commands, []);
});

test('workflow engine queries date-only availability before asking the customer for a time', () => {
  let current = startReschedule();
  const query = decideWorkflow(current, { turnId: 'free-10th', platform: 'whatsapp', intent: 'availability',
    slots: { date: '2026-10-10' }, slotSource: 'customer' });
  assert.equal(query.outcome, 'availability_requested');
  const command = query.commands[0];
  assert.equal(command.kind, 'check_availability');
  if (command.kind !== 'check_availability') assert.fail('expected availability query');
  assert.equal(command.date, '2026-10-10');
  assert.equal(command.service, 'THE MUSE');
  assert.equal(command.excludeBookingId, 'muse-booking');
  current = availableResult(acceptDecision(current, query));
  const answered = decideWorkflow(current, { turnId: 'slots-result', platform: 'whatsapp', intent: 'availability_result' });
  assert.equal(answered.outcome, 'availability_answered');
  assert.deepEqual(answered.availableSlots, ['10:00', '14:00']);
  assert.equal(answered.requiredInput, 'time');
  assert.equal(answered.nextOperation?.slots.date, '2026-10-10');
});

test('workflow engine preserves selected date through typo clarification and separate action consent', () => {
  let current = startReschedule();
  const date = decideWorkflow(current, { turnId: 'date', platform: 'whatsapp', intent: 'provide_slots',
    slots: { date: '2026-10-10' }, slotSource: 'customer' });
  current = acceptDecision(current, date);
  const typo = decideWorkflow(current, { turnId: 'typo', platform: 'whatsapp', intent: 'provide_slots', rawTime: '1oam', slotSource: 'customer' });
  assert.equal(typo.template, 'confirm_time');
  assert.equal(typo.nextOperation?.slots.date, '2026-10-10');
  assert.equal(typo.nextOperation?.slots.time, undefined);
  current = acceptDecision(current, typo);
  current = { ...current, clarification: { ...current.clarification!, delivered: true } };
  const clarified = decideWorkflow(structuredClone(current), { turnId: 'clarification-yes', platform: 'whatsapp',
    intent: 'accept_clarification', explicitConsent: true, clarificationId: current.clarification!.id });
  assert.equal(clarified.commands[0].kind, 'check_availability');
  assert.equal(clarified.nextOperation?.slots.time, '10:00');
  assert.ok(!clarified.commands.some(command => ['apply_reschedule', 'initiate_payment'].includes(command.kind)));
  current = availableResult(acceptDecision(current, clarified));
  const proposal = decideWorkflow(current, { turnId: 'present', platform: 'whatsapp', intent: 'availability_result' });
  assert.equal(proposal.outcome, 'proposal_required');
  assert.equal(proposal.nextProposal?.delivered, false);
  current = acceptDecision(current, proposal);
  const event: WorkflowEvent = { turnId: 'present', platform: 'whatsapp', intent: 'confirm', explicitConsent: true, proposalId: current.proposal!.id };
  assert.equal(decideWorkflow(current, event).commands.length, 0, 'undelivered same-turn proposal cannot act');
  current = { ...current, proposal: { ...current.proposal!, delivered: true } };
  assert.equal(decideWorkflow(current, event).commands.length, 0, 'even a delivered proposal requires a later turn');
  const confirm = decideWorkflow(current, { ...event, turnId: 'later-yes' });
  assert.equal(confirm.outcome, 'confirmation_accepted');
  assert.equal(confirm.commands[0].kind, 'apply_reschedule');
  if (confirm.commands[0].kind !== 'apply_reschedule') assert.fail('expected bound reschedule command');
  assert.equal(confirm.commands[0].bookingId, 'muse-booking');
  assert.equal(confirm.expectedRevision, current.operation!.revision);
  assert.equal(current.bookings[0].date, '2026-10-09', 'pure decision never mutates the actual booking');
});

test('workflow engine refuses stale availability and stale proposal versions', () => {
  let current = startReschedule();
  current = acceptDecision(current, decideWorkflow(current, { turnId: 'target', platform: 'whatsapp', intent: 'provide_slots',
    slots: { date: '2026-10-10', time: '10:00' }, slotSource: 'customer' }));
  current = availableResult(current);
  const invalid = decideWorkflow({ ...current, availability: { ...current.availability!, excludeBookingId: 'wrong-booking' } },
    { turnId: 'wrong-result', platform: 'whatsapp', intent: 'availability_result' });
  assert.equal(invalid.outcome, 'failed');
  assert.deepEqual(invalid.commands, []);
  current = acceptDecision(current, decideWorkflow(current, { turnId: 'proposal', platform: 'whatsapp', intent: 'availability_result' }));
  current = { ...current, proposal: { ...current.proposal!, delivered: true, operationRevision: current.operation!.revision - 1 } };
  assert.deepEqual(decideWorkflow(current, { turnId: 'yes', platform: 'whatsapp', intent: 'confirm', explicitConsent: true,
    proposalId: current.proposal!.id }).commands, []);
});

test('workflow engine keeps provider failures and restarts from changing accepted operation fields', () => {
  const current = { ...startReschedule(), operation: { ...startReschedule().operation!, slots: { service: 'THE MUSE', date: '2026-10-10' } } };
  const before = JSON.stringify(current);
  const result = decideWorkflow(structuredClone(current), { turnId: 'provider-error', platform: 'whatsapp', intent: 'provider_failure' });
  assert.equal(result.transition, 'retain');
  assert.deepEqual(result.commands, []);
  assert.equal(JSON.stringify(current), before);
  const continued = decideWorkflow(structuredClone(current), { turnId: 'corrected-time', platform: 'whatsapp', intent: 'provide_slots',
    slots: { time: '10:00' }, slotSource: 'customer' });
  assert.equal(continued.nextOperation?.slots.date, '2026-10-10');
  assert.equal(continued.nextOperation?.targetBookingId, 'muse-booking');
});

test('workflow engine distinguishes target ambiguity, competing operations, channel and expiry', () => {
  const ready = readySnapshot();
  const event: WorkflowEvent = { turnId: 'start', platform: 'whatsapp', intent: 'start', operationKind: 'reschedule' };
  assert.equal(decideWorkflow({ ...ready, bookings: [...ready.bookings, { ...ready.bookings[0], id: 'second-booking' }] }, event).requiredInput, 'target');
  assert.equal(decideWorkflow({ ...snapshot, block: null }, event).outcome, 'blocked');
  assert.equal(decideWorkflow(ready, { ...event, platform: 'instagram' }).outcome, 'blocked');
  const current = startReschedule();
  const expired = decideWorkflow({ ...current, operation: { ...current.operation!, expiresAt: current.now } },
    { turnId: 'expired-yes', platform: 'whatsapp', intent: 'confirm', explicitConsent: true });
  assert.equal(expired.transition, 'expire');
  assert.deepEqual(expired.commands, []);
  const timeOnly = decideWorkflow(ready, { ...event, sameDayOnly: true });
  assert.equal(timeOnly.nextOperation?.slots.date, ready.bookings[0].date);
  assert.equal(timeOnly.requiredInput, 'time');
});

test('workflow engine starts a separate new booking without borrowing old session slots', () => {
  const ready = readySnapshot();
  const result = decideWorkflow(ready, { turnId: 'new-session', platform: 'whatsapp', intent: 'start', operationKind: 'new_booking' });
  assert.equal(result.nextOperation?.slots.name, 'Synthetic Customer');
  assert.equal(result.nextOperation?.slots.date, undefined);
  assert.equal(result.nextOperation?.slots.time, undefined);
  assert.equal(result.nextOperation?.targetBookingId, undefined);
  assert.equal(result.requiredInput, 'service');
});

test('frozen blocked incident never produces booking mutations in the pure engine', () => {
  const incident = baseline.incidents.find(value => value.id === 'blocked-reschedule-typo-recovery')!;
  const intents: WorkflowEvent['intent'][] = ['start', 'clarify', 'availability', 'provide_slots', 'provide_slots'];
  const before = JSON.stringify(snapshot);
  incident.turns.forEach((turn, index) => {
    const result = decideWorkflow(structuredClone(snapshot), { turnId: `incident-${index}`, platform: 'whatsapp',
      intent: intents[index], operationKind: 'reschedule', slotSource: 'customer',
      ...(turn.message === '1oam' ? { rawTime: turn.message } : {}),
      ...(index === 4 ? { slots: { date: '2026-10-10', time: '10:00' } } : {}),
    });
    assert.equal(result.outcome, 'blocked', turn.message);
    assert.equal(result.transition, 'retain');
    assert.deepEqual(result.commands, []);
  });
  assert.equal(JSON.stringify(snapshot), before);
});

test('workflow engine plans a separate persistent block without replacing the competing operation', () => {
  const current = { ...structuredClone(snapshot), block: null };
  const decision = decideWorkflow(current, { turnId: 'conflict', platform: 'whatsapp', intent: 'start', operationKind: 'reschedule' });
  assert.equal(decision.transition, 'block');
  assert.equal(decision.nextBlock?.conflictingOperationId, 'conflicting-draft');
  assert.equal(decision.nextOperation, undefined);
  const reloaded = structuredClone(acceptDecision(current, decision));
  assert.equal(decideWorkflow(reloaded, { turnId: 'confused', platform: 'whatsapp', intent: 'clarify' }).outcome, 'blocked');
  assert.equal(reloaded.operation!.id, 'conflicting-draft');
  assert.equal(reloaded.operation!.revision, 3);
});

test('workflow engine rejects invalid persisted fields and never targets a past confirmed booking', () => {
  const current = startReschedule();
  const event: WorkflowEvent = { turnId: 'next', platform: 'whatsapp', intent: 'provide_slots', slots: { time: '10:00' }, slotSource: 'customer' };
  const bad = { ...current, operation: { ...current.operation!, slots: { date: '2026-02-30' } } };
  assert.equal(decideWorkflow(bad, event).outcome, 'failed');
  assert.deepEqual(decideWorkflow(bad, event).commands, []);
  assert.equal(decideWorkflow({ ...readySnapshot(), now: Date.parse('2026-10-10T12:00:00Z') },
    { turnId: 'past', platform: 'whatsapp', intent: 'start', operationKind: 'reschedule' }).outcome, 'failed');
});

test('workflow engine preserves exact 72-hour policy boundaries and requires renewed consent when they change', () => {
  const ready = readySnapshot();
  const bookingTime = Date.parse(ready.bookings[0].dateTimeIso);
  for (const [seconds, eligible] of [[259199, false], [259200, false], [259201, true]] as const) {
    const current = { ...ready, now: bookingTime - seconds * 1000 };
    const proposal = decideWorkflow(current, { turnId: 'cancel-proposal', platform: 'whatsapp', intent: 'start', operationKind: 'cancellation' });
    assert.equal(proposal.nextProposal?.cancellationRefundEligible, eligible);
    assert.ok(!proposal.commands.some(command => command.kind === 'apply_cancellation'));
  }
  const proposed = decideWorkflow(ready, { turnId: 'proposal', platform: 'whatsapp', intent: 'start', operationKind: 'cancellation' });
  const current = acceptDecision(ready, proposed);
  const changed = { ...current, now: bookingTime - 60 * 60 * 1000,
    proposal: { ...current.proposal!, delivered: true } };
  const confirm = decideWorkflow(changed, { turnId: 'later', platform: 'whatsapp', intent: 'confirm', explicitConsent: true, proposalId: changed.proposal.id });
  assert.equal(confirm.reason, 'policy_changed_requires_new_proposal');
  assert.deepEqual(confirm.commands, []);
});

test('workflow engine never initiates payment before a delivered proposal and later explicit consent', () => {
  const ready = readySnapshot();
  let current = acceptDecision(ready, decideWorkflow(ready, { turnId: 'new', platform: 'whatsapp', intent: 'start', operationKind: 'new_booking' }));
  const query = decideWorkflow(current, { turnId: 'fields', platform: 'whatsapp', intent: 'provide_slots', slotSource: 'customer',
    slots: { service: 'THE MUSE', date: '2026-10-10', time: '10:00' }, addonsDecision: 'declined' });
  assert.equal(query.commands[0].kind, 'check_availability');
  current = availableResult(acceptDecision(current, query));
  const proposal = decideWorkflow(current, { turnId: 'deposit-proposal', platform: 'whatsapp', intent: 'availability_result' });
  assert.equal(proposal.nextProposal?.amount, 2000);
  assert.ok(!proposal.commands.some(command => command.kind === 'initiate_payment'));
  current = acceptDecision(current, proposal);
  current = { ...current, proposal: { ...current.proposal!, delivered: true } };
  const event: WorkflowEvent = { turnId: 'customer-yes', platform: 'whatsapp', intent: 'confirm', proposalId: current.proposal!.id, explicitConsent: true };
  const decision = decideWorkflow(current, event);
  assert.equal(decision.commands[0].kind, 'initiate_payment');
  assert.equal(decision.nextOperation?.state, 'payment_open');
  assert.equal(decision.nextOperation?.targetBookingId, undefined);
  assert.deepEqual(decision, decideWorkflow(structuredClone(current), event), 'repeated identical snapshots yield identical idempotency keys');
  assert.deepEqual(decideWorkflow({ ...current, packages: [{ service: 'THE MUSE', deposit: 3000 }] }, event).commands, []);
  assert.deepEqual(decideEvent(current, event, 'model').commands, []);
  assert.equal(decideEvent(current, event, 'model').transition, 'retain');
  assert.deepEqual(decideEvent(current, event, 'system').commands, []);
});

test('workflow engine distinguishes unavailable slots from a failed query and keeps known values', () => {
  let current = startReschedule();
  current = acceptDecision(current, decideWorkflow(current, { turnId: 'availability-query', platform: 'whatsapp', intent: 'availability',
    slots: { date: '2026-10-10' }, slotSource: 'customer' }));
  for (const status of ['failed', 'closed', 'unavailable'] as const) {
    const result = decideWorkflow({ ...availableResult(current, []), availability: { ...availableResult(current).availability!, status, slots: [] } },
      { turnId: `result-${status}`, platform: 'whatsapp', intent: 'availability_result' });
    assert.equal(result.template, status === 'failed' ? 'availability_failed' : 'no_slots');
    assert.equal(result.nextOperation?.slots.date, '2026-10-10');
    assert.equal(result.nextOperation?.targetBookingId, 'muse-booking');
    assert.deepEqual(result.commands, []);
  }
  assert.deepEqual(decideEvent(availableResult(current), { turnId: 'fake-result', platform: 'whatsapp', intent: 'availability_result' }, 'customer').commands, []);
});

test('workflow engine keeps the optional-extra decision before a new-booking proposal', () => {
  const ready = readySnapshot();
  let current = acceptDecision(ready, decideWorkflow(ready, { turnId: 'new', platform: 'whatsapp', intent: 'start', operationKind: 'new_booking' }));
  current = acceptDecision(current, decideWorkflow(current, { turnId: 'slots', platform: 'whatsapp', intent: 'provide_slots', slotSource: 'customer',
    slots: { service: 'THE MUSE', date: '2026-10-10', time: '10:00' } }));
  const result = decideWorkflow(availableResult(current), { turnId: 'available', platform: 'whatsapp', intent: 'availability_result' });
  assert.equal(result.requiredInput, 'addons');
  assert.equal(result.nextProposal, null);
  assert.ok(!result.commands.some(command => command.kind === 'present_proposal' || command.kind === 'initiate_payment'));
  const selected = decideWorkflow(acceptDecision(current, result), { turnId: 'selected-addon', platform: 'whatsapp', intent: 'provide_slots',
    slotSource: 'customer', addonsDecision: 'selected' });
  assert.equal(selected.outcome, 'blocked');
  assert.deepEqual(selected.commands, []);
});

test('workflow engine separates an existing customer name from another session recipient', () => {
  const ready = readySnapshot();
  let current = acceptDecision(ready, decideWorkflow(ready, { turnId: 'recipient-booking', platform: 'whatsapp', intent: 'start', operationKind: 'new_booking', forSomeoneElse: true }));
  const question = decideWorkflow(current, { turnId: 'edition', platform: 'whatsapp', intent: 'provide_slots', slotSource: 'customer', slots: { service: 'THE MUSE' } });
  assert.equal(question.requiredInput, 'recipient');
  assert.equal(question.nextOperation?.slots.name, 'Synthetic Customer');
  assert.equal(question.nextOperation?.slots.recipientName, undefined);
  current = acceptDecision(current, question);
  const recipient = decideWorkflow(current, { turnId: 'recipient-name', platform: 'whatsapp', intent: 'provide_slots', slotSource: 'customer', slots: { recipientName: 'Joan' } });
  assert.equal(recipient.nextOperation?.slots.recipientName, 'Joan');
  assert.equal(recipient.nextOperation?.slots.name, 'Synthetic Customer');
  const name = decideWorkflow(acceptDecision(current, recipient), { turnId: 'my-name', platform: 'whatsapp', intent: 'information', topic: 'name' });
  assert.deepEqual(name.commands, [{ kind: 'read_information', topic: 'name', customerId: 'synthetic-customer' }]);
});

test('workflow engine retains a date supplied in the same turn as a time typo', () => {
  const current = startReschedule();
  const result = decideWorkflow(current, { turnId: 'date-and-typo', platform: 'whatsapp', intent: 'provide_slots',
    slotSource: 'customer', slots: { date: '2026-10-10' }, rawTime: '1oam' });
  assert.equal(result.template, 'confirm_time');
  assert.equal(result.nextOperation?.slots.date, '2026-10-10');
  assert.equal(result.nextOperation?.slots.time, undefined);
  assert.equal(result.nextClarification?.candidateTime, '10:00');
});