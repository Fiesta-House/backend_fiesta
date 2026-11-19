// Characterization tests: lock which handleMessage route answers a given message.
// Every route handler and the LLM are stubbed to return `ROUTE:<name>`, so no DB or network is touched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentService } from './agent.service';
import { ADDON_MAKEUP_CLARIFICATION } from './constants';

type Msg = { role: 'user' | 'assistant'; content: string };
type HarnessOptions = { natural?: boolean; nullRoutes?: string[]; paymentPending?: boolean };

const ASYNC_HANDLERS: Record<string, string> = {
  getCustomerNameReply: 'customerName',
  getInitialRescheduleReply: 'rescheduleEntry',
  getBookingIdentityCorrectionReply: 'identityCorrection',
  getBookingStatusReply: 'bookingStatus',
  getConfirmedSessionFollowUpReply: 'confirmedSessionFollowUp',
  getUpcomingAppointmentTimeReply: 'upcomingAppointmentTime',
  getPastAppointmentsListReply: 'pastAppointmentsList',
  getLastAppointmentDetailsReply: 'lastAppointmentDetails',
  getUpcomingAppointmentDetailsReply: 'upcomingAppointmentDetails',
  sendStoredInvoiceToCustomer: 'invoice',
  getPastAppointmentReply: 'pastAppointment',
  getPreviousAddonReply: 'previousAddon',
  getEarliestImageDeliveryReply: 'earliestImageDelivery',
  getBookingProcessReply: 'bookingProcess',
  getSameBookingSlotReply: 'sameBookingSlot',
  getPackageSelectionReply: 'packageSelection',
  getPackageAdviceReply: 'packageAdvice',
  getPackageCatalogReply: 'packageCatalog',
  getLashesReply: 'lashes',
  getGreetingReply: 'greeting',
  tryImmediateConfirmation: 'immediateConfirmation',
};

const SYNC_HANDLERS: Record<string, string> = {
  getAmbiguousDepositReply: 'ambiguousDeposit',
  getMixedIntentClarificationReply: 'mixedIntent',
  getBookingForSomeoneElseReply: 'bookingForSomeoneElse',
  getMultiPersonBookingReply: 'multiPersonBooking',
  getPackageBudgetReply: 'packageBudget',
  getLegacyPackageReply: 'legacyPackageName',
  getBusinessIntroductionReply: 'businessIntroduction',
  getWebsiteReply: 'website',
  getContactDetailsReply: 'contactDetails',
  getPortfolioReply: 'portfolio',
  getSocialMediaReply: 'socialMedia',
  getRawFilesReply: 'rawFiles',
  getBespokeReply: 'bespoke',
  getTravellingMothersReply: 'travellingMothers',
  getPostShootProcessReply: 'postShootProcess',
};

// Methods that act as both trigger and reply: keep the real logic, swap the text.
const PREDICATE_HANDLERS: Record<string, string> = {
  getScopeBoundaryReply: 'scopeBoundary',
  getSuspendingConceptGalleryReply: 'suspendingConceptGallery',
  getReviewPageReply: 'reviewPage',
  getWeekdayReply: 'weekday',
};

function createHarness(options: HarnessOptions = {}) {
  const agent = new AgentService() as any;
  agent.naturalAssistantMode = options.natural ?? false;
  const nullRoutes = new Set(options.nullRoutes ?? []);
  const reply = (route: string) => (nullRoutes.has(route) ? null : `ROUTE:${route}`);

  Object.assign(agent, {
    rememberBookingSlots: async () => null,
    getBookingProgressReply: async () => null,
    checkTokenBudget: async () => true,
    trackSentiment: async () => {},
    logAiJobMetric: async () => {},
    logConversationLearning: async () => {},
    escalate: async () => {},
    touchCustomerMemory: async () => {},
    recordTokenUsage: async () => {},
    executeAddNoteTool: async () => ({ created: true, type: 'special_request' }),
    getAddonSelectionReply: () => 'ROUTE:selectedAddon',
    captureMultiPersonBookingNote: async () => {},
    withdrawPendingReschedule: async () => {},
    captureRecipientName: async () => (nullRoutes.has('recipientName') ? null : 'Jane Wanjiku'),
    proposeCancellation: async () => ({ reply: reply('cancellationProposal'), proposed: !nullRoutes.has('cancellationProposal') }),
    runAgent: async () => ({ content: 'ROUTE:runAgent', tokensUsed: 0 }),
    // The payment handler answers only while a payment_pending draft exists; otherwise it yields.
    getPaymentRecoveryReply: async () => (options.paymentPending ? reply('paymentRecovery') : null),
  });

  for (const [method, route] of Object.entries(ASYNC_HANDLERS)) agent[method] = async () => reply(route);
  for (const [method, route] of Object.entries(SYNC_HANDLERS)) agent[method] = () => reply(route);
  // The real handler yields unless a reschedule is in progress; here the history stands in for that state.
  agent.getRescheduleSelectionReply = async (_customer: string, _message: string, history: Msg[]) =>
    (agent.conversationFlows.isRescheduleQuestion(history) ? reply('rescheduleSelection') : null);
  for (const [method, route] of Object.entries(PREDICATE_HANDLERS)) {
    const original = agent[method].bind(agent);
    agent[method] = (...args: any[]) => (original(...args) ? reply(route) : null);
  }

  // getAdditionsReply and getRescheduleTimeReply each serve two routes; remember which trigger fired.
  let addonListHit = false;
  const originalAddonList = agent.isAddonListFollowUp.bind(agent);
  agent.isAddonListFollowUp = (...args: any[]) => (addonListHit = originalAddonList(...args));
  agent.getAdditionsReply = () => (addonListHit ? 'ROUTE:addonListFollowUp' : 'ROUTE:additions');
  agent.getCatalogDisplayReply = (_customer: string, _platform: string, kind: string) => kind === 'addons' ? agent.getAdditionsReply() : reply('packageCatalog');

  let timeOnlyHit = false;
  const flows = agent.conversationFlows;
  const originalTimeOnly = flows.isTimeOnlyRescheduleRequest.bind(flows);
  flows.isTimeOnlyRescheduleRequest = (message: string) => (timeOnlyHit = originalTimeOnly(message));
  agent.getRescheduleTimeReply = async () => reply(timeOnlyHit ? 'timeOnlyRescheduleRequest' : 'rescheduleRequest');

  return agent;
}

function routeOf(reply: string): string {
  if (reply === ADDON_MAKEUP_CLARIFICATION) return 'selectedAddon';
  if (/^You may bring one outfit/.test(reply)) return 'personalOutfit';
  if (/^Basic hair styling is included/.test(reply)) return 'hairWigClarification';
  if (/^The express delivery fee is not listed/.test(reply)) return 'expressDeliveryFee';
  if (/^Extra professional makeup is Ksh /.test(reply)) return 'addonInquiry';
  if (/^Rescheduling: Changes within 72 hours/.test(reply)) return 'bookingPolicyInformation';
  if (reply.startsWith('ROUTE:')) return reply.split('\n')[0].slice('ROUTE:'.length);
  if (/^Yes\. Your original session date and time are still booked/.test(reply)) return 'rescheduleWithdrawalConfirmation';
  if (/^(No rush\.|You are welcome\.)/.test(reply)) return 'postActionAcknowledgement';
  if (/^Which add-on would you like to add/.test(reply)) return 'clarifyNewAddon';
  if (/^Understood! We will keep your original/.test(reply)) return 'rescheduleWithdrawal';
  if (/set the session up for Jane Wanjiku/.test(reply)) return 'recipientName';
  if (/^Got it\. The session will be just for your sister\. What is her full name\?$/i.test(reply)) return 'bookingForSomeoneElseFollowUp';
  if (/^We work strictly by appointment, so we do not take walk-ins/.test(reply)) return 'walkIn';
  if (/^We are open Tuesday to Sunday/.test(reply)) return 'openingHours';
  if (/^Extra outfits beyond your package are Ksh 4,000/.test(reply)) return 'verifiedFacts';
  if (reply === "Of course, we're here when you're ready.") return 'deferral';
  return `UNCLASSIFIED: ${reply}`;
}

const assistant = (content: string): Msg => ({ role: 'assistant', content });

const RESCHEDULE_PROPOSAL = assistant("Great, I can move your THE ICON session to 2026-10-08 at 15:00. If that works for you, just reply yes and I'll confirm it.");
const ADDON_OFFER = assistant('Would you like to include any optional add-ons with your shoot, such as an extra outfit, styled wig hire, or extra edited photos?');
const EXTRA_OUTFIT_EXPLAINED = assistant('An “extra outfit beyond package” means you can bring an additional outfit that isn’t part of the standard outfit selection. The fee is Ksh 4,000.');
const INVOICE_SENT = assistant('I’ve sent your invoice as a PDF to WhatsApp.');
const POLICY_72H = assistant('Your session is within 72 hours. According to our policy, rescheduling now will forfeit your deposit. Would you still like to proceed?');

type Case = {
  message: string;
  history?: Msg[];
  platform?: string;
  nullRoutes?: string[];
  paymentPending?: boolean;
  expected: string;
  /** Route in natural assistant mode; defaults to `expected`, or runAgent for natural-gated routes. */
  naturalExpected?: string;
  note?: string;
  /** Set when the expectation locks in behaviour that is known to be wrong. */
  knownBug?: string;
};

// Routes that only fire when natural assistant mode is off (allowDeterministicInfoReplies).
const NATURAL_GATED_ROUTES = new Set([
  'website', 'portfolio',
  'socialMedia', 'bespoke', 'travellingMothers', 'packageAdvice',
]);

const CASES: Case[] = [
  // Guards
  { message: 'Tell me a joke', expected: 'scopeBoundary' },
  { message: 'Can my husband join the session?', expected: 'scopeBoundary', note: 'studio policy wins over multiPersonBooking' },
  { message: 'Do you do evening sessions?', expected: 'scopeBoundary' },
  { message: "you're mixing up the sessions", expected: 'identityCorrection' },
  { message: 'Jane Wanjiku', history: [assistant('Is the session just for your sister, or would you both like to be photographed together?')], expected: 'recipientName' },
  { message: 'Is the 10k deposit refundable?', expected: 'ambiguousDeposit' },
  { message: 'ok', history: [assistant('Understood! We will keep your original session date and time, and your booking remains unchanged.')], expected: 'rescheduleWithdrawalConfirmation', note: 'beats postActionAcknowledgement' },
  { message: 'yes', history: [assistant('Your current booking remains unchanged until you confirm a proposed change.'), assistant("Could you please confirm that you'd like to reschedule your Goddess session to Sunday at 2:00 PM?")], expected: 'immediateConfirmation', note: 'latest reschedule proposal confirmation wins over stale unchanged-booking wording' },
  { message: 'thanks', expected: 'postActionAcknowledgement' },
  { message: 'What is the rescheduling and cancellation policy?', expected: 'bookingPolicyInformation' },
  { message: 'So whats my name? Do you know it?', expected: 'customerName' },
  { message: 'have you added the add-on', expected: 'previousAddon' },
  { message: 'Did you save the Power Suit?', expected: 'previousAddon' },

  // Appointment info
  { message: 'Is my booking confirmed?', expected: 'bookingStatus' },
  { message: 'Okay...is that it?', expected: 'confirmedSessionFollowUp' },
  { message: 'Is that all?', nullRoutes: ['confirmedSessionFollowUp'], expected: 'runAgent' },
  { message: 'is it confirmed?', nullRoutes: ['bookingStatus'], expected: 'runAgent', note: 'status handler null falls through' },
  { message: 'What time does my session start?', expected: 'upcomingAppointmentTime', note: 'beats upcomingAppointmentDetails' },
  { message: 'Show me my previous bookings', expected: 'pastAppointmentsList' },
  { message: 'Tell me about my last session', expected: 'lastAppointmentDetails' },
  { message: 'Tell me more about my upcoming session', expected: 'upcomingAppointmentDetails' },
  { message: 'What happens after the shoot?', expected: 'postShootProcess', note: 'Phase 1: excluded from upcomingAppointmentDetails' },
  { message: 'What happens after the shoot?', nullRoutes: ['upcomingAppointmentDetails'], expected: 'postShootProcess' },
  { message: 'I want to book THE ICON on the 12th and get the invoice', expected: 'mixedIntent' },
  { message: 'That date already passed', expected: 'pastAppointment' },

  // Invoices
  { message: 'send invoice for 12th Sept', expected: 'invoice' },
  { message: 'Can you send my invoice?', expected: 'invoice' },
  { message: "I didn't receive it", history: [INVOICE_SENT], expected: 'invoice' },

  // Someone else / multi-person
  { message: 'Just for her', history: [assistant('Of course. Is the session just for your sister, or would you both like to be photographed together? Once I know that, I can help with the package, date, and preferred time.')], expected: 'bookingForSomeoneElseFollowUp' },
  { message: 'Only her', history: [assistant('Of course. Is the session just for your sister, or would you both like to be photographed together? Once I know that, I can help with the package, date, and preferred time.')], expected: 'bookingForSomeoneElseFollowUp' },
  { message: 'Just for her', expected: 'runAgent', note: 'relative-booking answer requires the clarification context' },
  { message: 'Jane Wanjiku', history: [assistant('Is the session just for your sister, or would you both like to be photographed together?'), assistant('Got it. The session will be just for your sister. What is her full name?')], expected: 'recipientName' },
  { message: 'I want to book a session for my sister', expected: 'bookingForSomeoneElse' },
  { message: 'Can my sister join the shoot with me?', expected: 'multiPersonBooking' },

  // Packages / budget / payment resend
  { message: "What's your cheapest package?", expected: 'packageBudget' },
  { message: 'Do you have a standard package?', expected: 'legacyPackageName' },
  { message: 'Do you offer eye lashes services in the makeup?', expected: 'lashes' },
  { message: 'Is the makeup inclusive of lashes?', expected: 'lashes' },
  { message: 'Can you resend the payment prompt?', paymentPending: true, expected: 'paymentRecovery' },
  { message: 'Can you resend the payment prompt?', expected: 'runAgent', note: 'no open payment step falls through' },
  { message: 'yes', paymentPending: true, expected: 'immediateConfirmation', note: 'explicit yes reaches immediateConfirmation, which delegates payment_pending drafts to payment recovery' },
  { message: 'It has not arrived', paymentPending: true, expected: 'paymentRecovery' },
  { message: 'Kindly do it the last time', paymentPending: true, expected: 'paymentRecovery' },
  { message: 'i want to finish the payment', paymentPending: true, expected: 'paymentRecovery' },

  // Static info
  { message: 'Where can I see the suspending concept?', expected: 'suspendingConceptGallery' },
  { message: 'Where can I read your reviews?', expected: 'reviewPage' },
  { message: 'Tell me about the business', expected: 'businessIntroduction' },
  { message: 'What day is the 14th?', expected: 'weekday' },
  { message: "What's your website?", expected: 'website' },
  { message: 'Where is your studio location?', expected: 'contactDetails' },
  { message: 'Where are you located?', expected: 'contactDetails' },
  { message: 'Is this fiesta maternity house', expected: 'businessIntroduction' },
  { message: 'Can I walk in?', expected: 'walkIn' },
  { message: 'What are your opening hours?', expected: 'openingHours' },
  { message: 'Let me confirm with my partner and let you know', expected: 'deferral' },
  { message: 'Can I see your portfolio?', expected: 'portfolio' },
  { message: "What's your instagram?", expected: 'socialMedia' },
  { message: 'Can I get raw files?', expected: 'rawFiles' },
  { message: 'How much do I have to pay for photos within 3 working days?', expected: 'expressDeliveryFee' },
  { message: 'Can I come right now?', expected: 'walkIn' },
  { message: 'Could I visit the studio today?', expected: 'walkIn' },
  { message: 'Can I bring one extra outfit of my own?', expected: 'personalOutfit' },
  { message: 'What does professional hair mean, is it wig styling?', expected: 'hairWigClarification' },

  // Add-ons
  { message: 'Which add-ons did I choose before?', history: [assistant('Noted: Extra outfit beyond package (Ksh 4,000 each).')], expected: 'previousAddon' },
  { message: 'I want to add another one', history: [assistant('Noted: Extra outfit beyond package (Ksh 4,000 each). The add-on goes on the balance.')], expected: 'clarifyNewAddon' },
  { message: 'show me', history: [ADDON_OFFER], expected: 'addonListFollowUp' },
  { message: 'i would want 2 of them then', history: [EXTRA_OUTFIT_EXPLAINED], expected: 'selectedAddon' },
  { message: 'In the add-ons I saw extra professional makeup..tell me about that..what does it entail', expected: 'addonInquiry' },
  { message: 'How much is extra makeup?', expected: 'addonInquiry' },
  { message: 'add an extra professional make-up for me', expected: 'selectedAddon' },
  { message: 'What add-ons do you have?', expected: 'additions' },
  { message: 'what extras do you have?', expected: 'additions' },
  { message: 'remove the extra outfit', expected: 'additions', note: 'Phase 8.3: add-on information stays deterministic without reading remove as reschedule' },
  { message: 'Do you do bespoke shoots?', expected: 'bespoke' },
  { message: "I'm travelling from abroad", expected: 'travellingMothers' },
  { message: 'When will I get the photos?', expected: 'earliestImageDelivery' },
  { message: 'How to book a session?', expected: 'bookingProcess' },
  { message: 'How do I book?', expected: 'bookingProcess' },

  // Reschedule
  { message: '3pm', history: [assistant('Of course. What time would work better for you that day?')], expected: 'rescheduleSelection' },
  { message: 'same day but from 5pm', history: [assistant('Sure! What date and time would you like to move your session to?')], expected: 'rescheduleSelection', note: 'reschedule replies keep the existing booking instead of starting a new one' },
  { message: "Let's not reschedule", history: [POLICY_72H], expected: 'rescheduleWithdrawal' },
  { message: 'Can I change the time?', expected: 'rescheduleEntry' },
  { message: "I'd like to move my appointment", expected: 'rescheduleEntry' },
  { message: 'can I exchange my outfit', expected: 'runAgent', note: 'Phase 1 #4 regression: "exchange" must not match the reschedule keyword' },
  { message: 'reschedule to 8th October at 3pm', expected: 'rescheduleEntry' },
  { message: 'Same date and time please', expected: 'sameBookingSlot' },

  // Packages
  { message: "I'll take the icon", expected: 'packageSelection' },
  { message: 'give me the Muse package', expected: 'packageSelection' },
  { message: 'I want the Icon', expected: 'packageSelection' },
  { message: 'the Bloom please', expected: 'packageSelection' },
  { message: 'Which package do you recommend?', expected: 'packageAdvice' },
  { message: 'What packages do you offer?', expected: 'packageCatalog', note: 'catalog is not gated by natural mode' },
  { message: 'share the packages that you offer', expected: 'packageCatalog' },
  { message: 'what packages do you have', expected: 'packageCatalog' },
  { message: 'what do you offer', expected: 'packageCatalog' },
  { message: 'your editions', expected: 'packageCatalog' },

  // Confirmation
  { message: 'yes', history: [RESCHEDULE_PROPOSAL], expected: 'immediateConfirmation' },
  { message: 'okay', history: [RESCHEDULE_PROPOSAL], expected: 'immediateConfirmation', note: 'acknowledgement yields while a confirmation is pending' },
  { message: 'yes', expected: 'immediateConfirmation', note: 'handler checks the draft; without visible proposal context it repeats details rather than charging' },
  { message: 'yes', history: [RESCHEDULE_PROPOSAL], platform: 'instagram', expected: 'runAgent' },

  // LLM fallthrough
  { message: "I'm 7 months pregnant, can we do Saturday at 3pm?", expected: 'runAgent' },
  { message: 'how much is the empress', expected: 'packageCatalog' },
  { message: 'cancel my booking', expected: 'cancellationProposal' },
  { message: 'Hi', expected: 'greeting' },
  { message: 'Hello', nullRoutes: ['greeting'], expected: 'runAgent', note: 'an active draft yields to booking progress' },
];

function expectedRoute(testCase: Case, natural: boolean): string {
  if (!natural) return testCase.expected;
  if (testCase.naturalExpected) return testCase.naturalExpected;
  return NATURAL_GATED_ROUTES.has(testCase.expected) ? 'runAgent' : testCase.expected;
}

for (const natural of [false, true]) {
  for (const testCase of CASES) {
    const expected = expectedRoute(testCase, natural);
    const label = [
      testCase.knownBug ? '[KNOWN BUG]' : '',
      natural ? '[natural]' : '[deterministic]',
      JSON.stringify(testCase.message),
      testCase.history?.length ? `(history ${testCase.history.length})` : '',
      testCase.platform ? `[${testCase.platform}]` : '',
      testCase.nullRoutes?.length ? `[null: ${testCase.nullRoutes.join(',')}]` : '',
      testCase.paymentPending ? '[payment_pending]' : '',
      `-> ${expected}`,
    ].filter(Boolean).join(' ');

    test(`route: ${label}`, async () => {
      const agent = createHarness({ natural, nullRoutes: testCase.nullRoutes, paymentPending: testCase.paymentPending });
      const reply = await agent.handleMessage('customer-test', testCase.message, testCase.history ?? [], testCase.platform ?? 'whatsapp');
      assert.equal(routeOf(reply), expected, testCase.knownBug ?? testCase.note);
    });
  }
}

test('route table covers at least 40 messages', () => {
  assert.ok(CASES.length >= 40);
});

test('message route order remains unchanged', () => {
  const agent = createHarness();
  const routes = agent.createMessageRoutes(
    'customer-test',
    'Hi',
    [],
    'whatsapp',
    Date.now()
  );

  assert.deepEqual(routes.map((route: { name: string }) => route.name), [
    'familyStyling',
    'scopeBoundary',
    'customerName',
    'bookingPolicyInformation',
    'walkIn',
    'openingHours',
    'packageSwitchAnswer',
    'packageChangeRequest',
    'dateAlternatives',
    'rescheduleEntry',
    'identityCorrection',
    'recipientName',
    'ambiguousDeposit',
    'paymentRecovery',
    'rescheduleWithdrawalConfirmation',
    'carryOverAnswer',
    'postActionAcknowledgement',
    'deferral',
    'cancellationDeclined',
    'staleCancellationProposal',
    'cancellationProposal',
    'bookingStatus',
    'upcomingAppointmentTime',
    'pastAppointmentsList',
    'lastAppointmentDetails',
    'upcomingAppointmentDetails',
    'mixedIntent',
    'invoice',
    'confirmedSessionFollowUp',
    'pastAppointment',
    'bookingForSomeoneElseFollowUp',
    'bookingForSomeoneElse',
    'multiPersonBooking',
    'lashes',
    'legacyPackageName',
    'packageBudget',
    'suspendingConceptGallery',
    'reviewPage',
    'greeting',
    'businessIntroduction',
    'weekday',
    'website',
    'contactDetails',
    'portfolio',
    'socialMedia',
    'rawFiles',
    'expressDeliveryFee',
    'previousAddon',
    'addonAdvice',
    'clarifyNewAddon',
    'addonRequest',
    'addonListFollowUp',
    'verifiedFacts',
    'personalOutfit',
    'hairWigClarification',
    'addonInquiry',
    'selectedAddon',
    'additions',
    'bespoke',
    'travellingMothers',
    'earliestImageDelivery',
    'postShootProcess',
    'bookingProcess',
    'rescheduleSelection',
    'rescheduleWithdrawal',
    'timeOnlyRescheduleRequest',
    'rescheduleRequest',
    'sameBookingSlot',
    'packageSelection',
    'packageAdvice',
    'packageCatalog',
    'aboutBusiness',
    'immediateConfirmation',
    'runAgent',
  ]);
});

test('only routes marked natural defer to the model in natural mode', async () => {
  const agent = createHarness({ natural: true });
  const routes = agent.createMessageRoutes(
    'customer-test',
    'Hi',
    [],
    'whatsapp',
    Date.now()
  );
  const gatedNames = routes
    .filter((route: { replyMode?: string }) => route.replyMode === 'natural')
    .map((route: { name: string }) => route.name);

  for (const routeName of gatedNames) {
    const testCase = CASES.find((candidate) => candidate.expected === routeName);
    assert.ok(testCase, `missing deterministic characterization for ${routeName}`);
    const deterministicAgent = createHarness();
    const deterministicReply = await deterministicAgent.handleMessage(
      'customer-test', testCase.message, testCase.history ?? [], testCase.platform ?? 'whatsapp'
    );
    assert.equal(routeOf(deterministicReply), routeName, `${routeName} should match in deterministic mode`);

    const naturalAgent = createHarness({ natural: true });
    const naturalReply = await naturalAgent.handleMessage(
      'customer-test', testCase.message, testCase.history ?? [], testCase.platform ?? 'whatsapp'
    );
    assert.equal(routeOf(naturalReply), 'runAgent', `${routeName} should fall through in natural mode`);
  }
});
