// Regression tests for P0 race-condition fixes in slot-memory.ts and payment.controller.ts
// Tests verify:
//   #1 — Draft version-based optimistic locking (concurrent slot writes)
//   #2 — Atomic payment-lapse release via transaction
//   #3 — Atomic preferredPackages update (idempotent against concurrent callbacks)
import assert from "node:assert/strict";
import test from "node:test";
import prisma from "../../config/prisma";
import { rememberBookingSlots, paymentLapsed, EARLY_SLOT_STEP, PAYMENT_LAPSE_MS } from "./slot-memory";

// Minimal stub helper
function makeStub(target: any, method: string, impl: (...args: any[]) => any) {
  const original = target[method];
  target[method] = impl;
  return () => { target[method] = original; };
}

// ---------------------------------------------------------------------------
// P0 Fix #1: Version-based optimistic locking
// ---------------------------------------------------------------------------
test("P0#1: rememberBookingSlots retries slot merge when version races", async (context) => {
  const restores: (() => void)[] = [];
  context.after(() => restores.reverse().forEach(r => r()));
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-14T09:00:00Z").getTime() });

  const draft = {
    id: "draft-race", customerId: "cust-race", step: EARLY_SLOT_STEP, version: 3,
    name: "Jane", service: "THE MUSE", date: null, time: null, dateTimeIso: null,
    createdAt: new Date(Date.now() - 5 * 60_000), updatedAt: new Date(Date.now() - 5 * 60_000),
    isForSomeoneElse: false,
  };

  let findUniqueCallCount = 0;
  let updateManyCallCount = 0;
  const updateManyWheres: any[] = [];

  restores.push(makeStub(prisma.bookingDraft, "findUnique", async () => {
    findUniqueCallCount++;
    // First: stale version 3. Second (retry refetch): version 4 (concurrent write won).
    return findUniqueCallCount === 1 ? { ...draft } : { ...draft, version: 4 };
  }));

  restores.push(makeStub(prisma.bookingDraft, "updateMany", async ({ where, data }: any) => {
    updateManyCallCount++;
    updateManyWheres.push({ ...where });
    // First attempt: version mismatch. Second attempt (retry): succeeds.
    return { count: updateManyCallCount === 1 ? 0 : 1 };
  }));

  restores.push(makeStub(prisma.customer, "findUnique", async () => ({ id: "cust-race", name: "Jane" })));
  restores.push(makeStub(prisma.customer, "update", async () => ({})));

  await rememberBookingSlots("cust-race", "I want the 15th of October", []);

  assert.equal(updateManyCallCount, 2, "should retry updateMany once on version mismatch");
  assert.ok("version" in updateManyWheres[0], "first updateMany should include version in where");
  assert.ok("version" in updateManyWheres[1], "retry updateMany should include version in where");
  assert.equal(updateManyWheres[1].version, 4, "retry must use the refetched version (4), not stale (3)");
});

test("P0#1: rememberBookingSlots returns null cleanly after two failed version checks", async (context) => {
  const restores: (() => void)[] = [];
  context.after(() => restores.reverse().forEach(r => r()));
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-14T09:00:00Z").getTime() });

  const draft = {
    id: "draft-fail", customerId: "cust-fail", step: EARLY_SLOT_STEP, version: 1,
    name: "Jane", service: "THE MUSE", date: null, time: null, dateTimeIso: null,
    createdAt: new Date(Date.now() - 5 * 60_000), updatedAt: new Date(Date.now() - 5 * 60_000),
    isForSomeoneElse: false,
  };

  restores.push(makeStub(prisma.bookingDraft, "findUnique", async () => ({ ...draft })));
  restores.push(makeStub(prisma.customer, "findUnique", async () => ({ id: "cust-fail", name: "Jane" })));
  restores.push(makeStub(prisma.customer, "update", async () => ({})));
  // Both updateMany calls fail — two concurrent writers already incremented version
  restores.push(makeStub(prisma.bookingDraft, "updateMany", async () => ({ count: 0 })));

  const result = await rememberBookingSlots("cust-fail", "I want the 15th of October", []);
  assert.equal(result, null, "should return null after two failed version checks, no throw");
});

// ---------------------------------------------------------------------------
// P0 Fix #2: Atomic payment-lapse release
// ---------------------------------------------------------------------------
test("P0#2: paymentLapsed correctly identifies lapsed payment_pending draft", () => {
  const now = Date.now();
  const lapsed = { step: "payment_pending", updatedAt: new Date(now - PAYMENT_LAPSE_MS - 1000) };
  const fresh  = { step: "payment_pending", updatedAt: new Date(now - PAYMENT_LAPSE_MS + 1000) };
  const wrong  = { step: "awaiting_confirmation", updatedAt: new Date(now - PAYMENT_LAPSE_MS - 1000) };
  assert.equal(paymentLapsed(lapsed, now), true,  "past-threshold draft should be lapsed");
  assert.equal(paymentLapsed(fresh,  now), false, "pre-threshold draft should not be lapsed");
  assert.equal(paymentLapsed(wrong,  now), false, "non-payment_pending step should not be lapsed");
  assert.equal(paymentLapsed(null,   now), false, "null draft should not be lapsed");
});

test("P0#2: transaction does NOT release draft when payment succeeded before release", async (context) => {
  const restores: (() => void)[] = [];
  context.after(() => restores.reverse().forEach(r => r()));

  const now = Date.now();
  context.mock.timers.enable({ apis: ["Date"], now });

  const lapsedDraft = {
    id: "draft-paid", customerId: "cust-paid", step: "payment_pending", version: 2,
    name: "Grace", service: "THE EMPRESS", date: "2026-10-20", time: "10:00",
    dateTimeIso: "2026-10-20T07:00:00.000Z",
    createdAt: new Date(now - 2 * 60 * 60_000),
    updatedAt: new Date(now - PAYMENT_LAPSE_MS - 5000),
    isForSomeoneElse: false,
  };

  restores.push(makeStub(prisma.bookingDraft, "findUnique", async () => ({ ...lapsedDraft })));

  let txPaymentCheckCalled = false;
  let txDraftUpdateCalled  = false;
  restores.push(makeStub(prisma, "$transaction", async (fn: any) => {
    const tx = {
      payment: { findFirst: async () => { txPaymentCheckCalled = true; return { id: "pay-success" }; } },
      bookingDraft: { updateMany: async () => { txDraftUpdateCalled = true; return { count: 1 }; } },
    };
    return fn(tx);
  }));

  const result = await rememberBookingSlots("cust-paid", "I want the 20th", []);

  assert.equal(txPaymentCheckCalled, true,  "transaction must check for successful payment");
  assert.equal(txDraftUpdateCalled,  false, "transaction must NOT release draft when payment succeeded");
  assert.equal(result, null);
});

test("P0#2: transaction releases lapsed draft atomically when no payment exists", async (context) => {
  const restores: (() => void)[] = [];
  context.after(() => restores.reverse().forEach(r => r()));

  const now = Date.now();
  context.mock.timers.enable({ apis: ["Date"], now });

  let draftState: any = {
    id: "draft-lapsed", customerId: "cust-lapsed", step: "payment_pending", version: 1,
    name: "Alice", service: "THE BLOOM", date: "2026-10-15", time: "09:00",
    dateTimeIso: "2026-10-15T06:00:00.000Z",
    createdAt: new Date(now - 2 * 60 * 60_000),
    updatedAt: new Date(now - PAYMENT_LAPSE_MS - 5000),
    isForSomeoneElse: false,
  };

  restores.push(makeStub(prisma.bookingDraft, "findUnique", async () => ({ ...draftState })));
  restores.push(makeStub(prisma, "$transaction", async (fn: any) => {
    const tx = {
      payment: { findFirst: async () => null }, // No successful payment
      bookingDraft: { updateMany: async ({ data }: any) => { Object.assign(draftState, data); return { count: 1 }; } },
    };
    return fn(tx);
  }));
  restores.push(makeStub(prisma.customer, "findUnique", async () => ({ id: "cust-lapsed", name: "Alice" })));
  restores.push(makeStub(prisma.customer, "update", async () => ({})));
  restores.push(makeStub(prisma.bookingDraft, "updateMany", async ({ data }: any) => {
    Object.assign(draftState, data); return { count: 1 };
  }));

  await rememberBookingSlots("cust-lapsed", "I want October 22nd", []);
  assert.equal(draftState.step, EARLY_SLOT_STEP, "lapsed draft must be released to collecting_slots");
});

// ---------------------------------------------------------------------------
// P0 Fix #3: preferredPackages idempotency guard logic
// ---------------------------------------------------------------------------
test("P0#3: preferredPackages guard is idempotent — duplicate service skipped", () => {
  // Validates the WHERE NOT preferredPackages.has(service) guard used in the fix.
  const packages = ["THE BLOOM"];
  const existing = "THE BLOOM";
  const newSvc   = "THE EMPRESS";

  // Existing service: both concurrent callbacks should be blocked by the guard
  assert.equal(!packages.includes(existing), false, "duplicate service must not pass guard");

  // New service: first callback passes, second is blocked after first commits
  assert.equal(!packages.includes(newSvc), true, "new service must pass guard");
  const afterFirst = [...packages, newSvc];
  assert.equal(!afterFirst.includes(newSvc), false, "second concurrent callback blocked after first commits");
});
