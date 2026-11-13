
import prisma from '../../config/prisma';

import { bookingService } from '../booking/booking.service';
import { bookingDraftService } from '../booking/booking-draft.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { TILL_NAME, TILL_NUMBER } from './till-payment';
import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../../config/constants';
import { notifyAdmin } from '../notifications/notification.service';
import { businessDay, bookingDateFacts, inBusinessTimezone } from '../../utils/time';
import { getBookingPolicyWindow } from '../../utils/booking-policy';
import dayjs from 'dayjs';
import { RESCHEDULE_COLLECTING_STEP } from './constants';
import { isUsableName, sanitizeSlotValue } from './slot-memory';
import {
  getPackageForDeposit,
  getDepositForPackage,
} from './booking-deposit';

export {
  getPackageForDeposit,
  getDepositForPackage,
} from './booking-deposit';

export async function executeProposeBookingTool(
  this: any,
  customerId: string,
  name: string,
  service: string,
  date: string
) {
  name = sanitizeSlotValue(name || '');

  if (!isUsableName(name) || !/[a-z]/i.test(name)) {
    throw new Error(
      'A usable customer name is required before proposing a booking. A single first name is sufficient; ask only if no usable name is available.'
    );
  }

  let customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  const existingDraft = await prisma.bookingDraft.findUnique({
    where: { customerId },
  });

  if (
    !existingDraft?.isForSomeoneElse &&
    customer?.name.toLowerCase().startsWith(`${name.toLowerCase()} `)
  ) {
    name = sanitizeSlotValue(customer.name);
  }

  if (!customer) {
    customer = await prisma.customer.create({
      data: { id: customerId, name },
    });
  } else if (customer.name !== name && !existingDraft?.isForSomeoneElse) {
    await prisma.customer.update({
      where: { id: customerId },
      data: { name },
    });
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) =>
    service.toLowerCase().includes(key)
  );

  if (!serviceKey) {
    throw new Error(
      `"${service}" isn't one of our packages. Valid packages are: ${Object.keys(
        SERVICE_DURATIONS
      ).join(', ')}. Ask the customer to pick one of these before booking.`
    );
  }

  const requestedSlot = date.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/
  );

  if (!requestedSlot) {
    throw new Error(
      'The requested date and time are invalid. Ask the customer to provide a date and time, then check availability.'
    );
  }

  const requestedDate = requestedSlot[1];
  const hour = Number(requestedSlot[2]);
  const minute = Number(requestedSlot[3]);

  const requestedTime = `${String(hour).padStart(2, '0')}:${String(
    minute
  ).padStart(2, '0')}`;

  if (hour > 23 || minute > 59) {
    throw new Error(
      'The requested time is invalid. Ask the customer to choose a valid time.'
    );
  }

  // Explicit past-date guard.
  const dateFacts = bookingDateFacts(requestedDate);

  if (dateFacts.isPast) {
    throw new Error(
      `${requestedDate} is in the past. Ask the customer to choose a future date.`
    );
  }

  const slotsResult: any = await bookingService.getAvailableSlots(
    requestedDate,
    SERVICE_DURATIONS[serviceKey],
    undefined,
    existingDraft?.id
  );

  if (slotsResult?.status === 'closed') {
    throw new Error(
      `The studio is closed on ${requestedDate}. Ask the customer to select another date.`
    );
  }

  const availableSlots: string[] = Array.isArray(slotsResult)
    ? slotsResult
    : [];

  if (!availableSlots.includes(requestedTime)) {
    throw new Error(
      `That time is unavailable on ${requestedDate}. Available times are: ${
        availableSlots.join(', ') || 'none'
      }. Ask the customer to choose an available time.`
    );
  }

  const dateTimeIso = businessDay(requestedDate)
    .hour(hour)
    .minute(minute)
    .second(0)
    .millisecond(0)
    .toISOString();

  // Use the shared deposit functions directly.
  const packageForDeposit = await getPackageForDeposit(service);
  const depositAmount = getDepositForPackage(packageForDeposit);

  await bookingDraftService.saveBookingProposal({
    customerId: customer.id,
    service,
    dateTime: dateTimeIso,
    customerName: name,
  });

  return { depositAmount };
}

export async function executeConfirmBookingTool(
  this: any,
  customerId: string,
  initialDraftStep: string | undefined,
  expectedDeposit: number | null
) {
  // Till flow: the customer receives payment details and pays manually.
  if (initialDraftStep === 'awaiting_payment_message') {
    throw new Error(
      'She has already confirmed and was given the payment details. Do not call confirm_booking again; wait for her M-Pesa message or transaction code.'
    );
  }

  if (initialDraftStep !== 'awaiting_confirmation') {
    throw new Error(
      'No pending booking proposal from a prior message. Call propose_booking first and wait for the customer to explicitly confirm on their own next message before calling confirm_booking.'
    );
  }

  const draft = await bookingDraftService.get(customerId);

  if (!draft || draft.step !== 'awaiting_confirmation') {
    throw new Error(
      'No pending booking proposal found. Call propose_booking first.'
    );
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) =>
    draft.service?.toLowerCase().includes(key)
  );

  if (!serviceKey) {
    throw new Error(
      'The pending booking\'s package "' +
        (draft.service || 'unknown') +
        '" isn\'t recognised, so the deposit can\'t be worked out. Do not share payment details; ask the studio team to check the package.'
    );
  }

  if (!draft.date || !draft.time) {
    throw new Error(
      'The pending booking is missing its date or time. Ask the customer to start the booking again.'
    );
  }

  const slotsResult: any = await bookingService.getAvailableSlots(
    draft.date,
    SERVICE_DURATIONS[serviceKey],
    undefined,
    draft.id
  );

  if (slotsResult?.status === 'closed') {
    throw new Error(
      'The studio is closed on ' +
        draft.date +
        '. Do not share payment details for this booking.'
    );
  }

  const availableSlots: string[] = Array.isArray(slotsResult)
    ? slotsResult
    : [];

  if (!availableSlots.includes(draft.time)) {
    throw new Error(
      'The proposed time ' +
        draft.time +
        ' on ' +
        draft.date +
        ' is no longer available. Do not share payment details; ask the customer to choose another time.'
    );
  }

  // Use the same shared deposit calculation used when proposing the booking.
  const packageForDeposit = await getPackageForDeposit(
    draft.service || ''
  );

  const depositAmount = getDepositForPackage(packageForDeposit);

  if (
    expectedDeposit === null ||
    expectedDeposit !== depositAmount
  ) {
    throw new Error(
      'The package deposit no longer matches the amount in the customer-visible proposal. Do not share payment details; prepare a new proposal and ask for confirmation again.'
    );
  }

  // Claims the draft once: a duplicate confirmation fails the version check.
  await bookingDraftService.markAwaitingPaymentMessage(
    customerId,
    draft.version
  );

  return {
    success: true,
    draftId: draft.id,
    depositAmount,
    service: draft.service,
    date: draft.date,
    time: draft.time,
    till: TILL_NUMBER,
    tillName: TILL_NAME,
  };
}

export async function executeProposeRescheduleTool(
  this: any,
  customerId: string,
  newDate: string,
  newTime: string
) {
  const existingDraft = await prisma.bookingDraft.findUnique({
    where: { customerId },
  });

  if (
    existingDraft &&
    existingDraft.step !== 'reschedule_confirm' &&
    existingDraft.step !== RESCHEDULE_COLLECTING_STEP
  ) {
    throw new Error(
      'I have not changed your current request or started a reschedule. Please finish that step or ask the studio team to help.'
    );
  }

  const upcomingBooking = await prisma.booking.findFirst({
    where: {
      customerId,
      status: 'confirmed',
      dateTime: { gte: new Date() },
      ...(existingDraft?.bookingId
        ? { id: existingDraft.bookingId }
        : {}),
    },
    orderBy: { dateTime: 'asc' },
  });

  if (!upcomingBooking) {
    throw new Error('No upcoming confirmed booking found to reschedule.');
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) =>
    upcomingBooking.service.toLowerCase().includes(key)
  );

  const duration = serviceKey
    ? SERVICE_DURATIONS[serviceKey]
    : DEFAULT_DURATION;

  const slotsResult: any = await bookingService.getAvailableSlots(
    newDate,
    duration,
    upcomingBooking.id
  );

  const newDateLabel = `${dayjs(newDate).format(
    'dddd, MMMM D, YYYY'
  )} (${newDate})`;

  if (slotsResult.status === 'closed') {
    throw new Error(
      `We're closed on ${newDateLabel} (${slotsResult.reason}). Ask the customer to pick a different date. Always refer to the date using this exact weekday.`
    );
  }

  const availableSlots: string[] = Array.isArray(slotsResult)
    ? slotsResult
    : [];

  if (!availableSlots.includes(newTime)) {
    throw new Error(
      `${newTime} on ${newDateLabel} isn't available. Available times that day: ${
        availableSlots.length > 0
          ? availableSlots.join(', ')
          : 'none'
      }. Ask the customer to pick one of these instead. Always refer to the date using this exact weekday - do not guess it.`
    );
  }

  const [hour, minute] = newTime.split(':').map(Number);

  const newDateTimeIso = businessDay(newDate)
    .startOf('day')
    .hour(hour)
    .minute(minute)
    .second(0)
    .millisecond(0)
    .toISOString();

  await prisma.bookingDraft.upsert({
    where: { customerId },
    update: {
      bookingId: upcomingBooking.id,
      service: upcomingBooking.service,
      date: newDate,
      time: newTime,
      dateTimeIso: newDateTimeIso,
      step: 'reschedule_confirm',
    },
    create: {
      customerId,
      bookingId: upcomingBooking.id,
      service: upcomingBooking.service,
      date: newDate,
      time: newTime,
      dateTimeIso: newDateTimeIso,
      step: 'reschedule_confirm',
    },
  });

  return {
    service: upcomingBooking.service,
    oldDateTime: upcomingBooking.dateTime,
  };
}

export async function executeConfirmRescheduleTool(
  this: any,
  customerId: string,
  initialDraftStep: string | undefined
) {
  if (initialDraftStep !== 'reschedule_confirm') {
    throw new Error(
      'No pending reschedule proposal from a prior message. Call propose_reschedule first and wait for the customer to explicitly confirm on their own next message.'
    );
  }

  const draft = await prisma.bookingDraft.findUnique({
    where: { customerId },
  });

  if (
    !draft ||
    draft.step !== 'reschedule_confirm' ||
    !draft.bookingId ||
    !draft.dateTimeIso
  ) {
    throw new Error('No pending reschedule proposal found. Call propose_reschedule first.');
  }

  const upcomingBooking = await prisma.booking.findUnique({
    where: { id: draft.bookingId },
    include: { customer: true },
  });

  if (!upcomingBooking) {
    throw new Error('The booking being rescheduled no longer exists.');
  }

  const newDateTime = new Date(draft.dateTimeIso);

  await prisma.booking.update({
    where: { id: upcomingBooking.id },
    data: { dateTime: newDateTime },
  });

  if (upcomingBooking.googleEventId) {
    const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) =>
      upcomingBooking.service.toLowerCase().includes(key)
    );

    const duration = serviceKey
      ? SERVICE_DURATIONS[serviceKey]
      : DEFAULT_DURATION;

    void googleCalendarService
      .updateEvent(upcomingBooking.googleEventId, {
        service: upcomingBooking.service,
        dateTime: newDateTime,
        customerName: upcomingBooking.customer.name,
        durationMinutes: duration,
      })
      .then((updated) => {
        if (!updated) {
          void this.notifyRescheduleAdmin({
            customerId,
            event: 'failed',
            service: upcomingBooking.service,
            newDate: draft.date || undefined,
            newTime: draft.time || undefined,
            reason:
              'The booking was rescheduled, but Google Calendar did not update.',
          });
        }
      })
      .catch((error: unknown) => {
        console.error(
          'Google Calendar reschedule sync failed:',
          error
        );
      });
  }

  await prisma.bookingDraft
    .deleteMany({
      where: {
        id: draft.id,
        customerId,
        step: 'reschedule_confirm',
        bookingId: upcomingBooking.id,
      },
    })
    .catch((err: unknown) =>
      console.error('Failed to clear reschedule draft:', err)
    );

  // Same invoice number; only the PDF session date and totals are regenerated.
  void invoiceService
    .createOrRefreshForBooking(upcomingBooking.id)
    .catch((err: unknown) =>
      console.error(
        'Failed to refresh invoice after reschedule:',
        err
      )
    );

  return {
    newDateTime,
    oldDateTime: upcomingBooking.dateTime,
    service: upcomingBooking.service,
    depositForfeited: this.isRescheduleWithin72Hours(
      upcomingBooking.dateTime
    ),
  };
}

export async function executeConfirmCancellationTool(
  this: any,
  customerId: string,
  initialDraftStep: string | undefined
) {
  if (initialDraftStep !== 'cancel_confirm') {
    throw new Error(
      'No pending cancellation proposal from a prior message. Ask which booking to cancel, propose it, and wait for the customer to explicitly confirm on their own next message.'
    );
  }

  const draft = await prisma.bookingDraft.findUnique({
    where: { customerId },
  });

  if (
    !draft ||
    draft.step !== 'cancel_confirm' ||
    !draft.bookingId ||
    !draft.date
  ) {
    throw new Error(
      'No pending cancellation proposal found. Ask which booking to cancel and propose it first.'
    );
  }

  if (this.isCancellationProposalExpired(draft)) {
    await prisma.bookingDraft.deleteMany({
      where: { customerId, step: 'cancel_confirm' },
    });

    throw new Error(
      'The cancellation proposal expired. Nothing was cancelled; ask the customer to make a new cancellation request.'
    );
  }

  return this.executeCancelBookingTool(
    customerId,
    draft.date,
    draft.bookingId
  );
}

export function getCancellationCompletionReply(result: {
  service: string;
  dateTime: Date;
  refundEligible: boolean;
  depositPaid?: boolean;
}): string {
  const session = `${result.service} on ${inBusinessTimezone(
    result.dateTime
  ).format('dddd, D MMMM YYYY [at] h:mm A')}`;

  if (result.refundEligible) {
    const refundStatus = result.depositPaid
      ? 'A successful deposit is recorded. The studio team has been notified to review any refund; no refund has been issued.'
      : 'This is eligibility under the timing policy only; it does not confirm a refund amount or that money has been returned.';

    return `Your ${session} has been cancelled. It was eligible under the more-than-72-hours refund policy. ${refundStatus}`;
  }

  const refundStatus = result.depositPaid
    ? 'A successful deposit is recorded. The studio team has been notified to review the payment; no refund has been issued.'
    : 'It is not automatically refundable under the timing policy.';

  return `Your ${session} has been cancelled. It was 72 hours away or less. ${refundStatus}`;
}

export async function executeCancelBookingTool(
  this: any,
  customerId: string,
  date?: string,
  bookingId?: string
) {
  const upcoming = await prisma.booking.findMany({
    where: {
      customerId,
      status: { not: 'cancelled' },
      dateTime: { gte: new Date() },
    },
    orderBy: { dateTime: 'asc' },
  });

  if (upcoming.length === 0) {
    throw new Error('No upcoming booking found to cancel.');
  }

  const describe = (booking: {
    service: string;
    dateTime: Date;
  }) =>
    `${booking.service} on ${inBusinessTimezone(
      booking.dateTime
    ).format('YYYY-MM-DD h:mm A')}`;

  const requestedDate = date?.trim();

  const matches = bookingId
    ? upcoming.filter((booking) => booking.id === bookingId)
    : requestedDate
      ? upcoming.filter(
          (booking) =>
            inBusinessTimezone(booking.dateTime).format(
              'YYYY-MM-DD'
            ) === requestedDate
        )
      : upcoming;

  if (matches.length === 0) {
    throw new Error(
      `No upcoming booking on ${requestedDate}. Upcoming bookings: ${upcoming
        .map(describe)
        .join('; ')}. Ask the customer which one to cancel.`
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple upcoming bookings match: ${matches
        .map(describe)
        .join('; ')}. Nothing was cancelled - ask the customer which one to cancel, then call cancel_booking with that date.`
    );
  }

  const booking = matches[0];

  const successfulPayment = await prisma.payment.findFirst({
    where: {
      bookingId: booking.id,
      status: 'success',
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      amount: true,
      mpesaReceipt: true,
    },
  });

  let calendarEventRemoved = !booking.googleEventId;

  if (booking.googleEventId) {
    calendarEventRemoved = await googleCalendarService.deleteEvent(
      booking.googleEventId
    );

    if (!calendarEventRemoved) {
      console.warn(
        'Google Calendar delete failed during cancellation:',
        booking.googleEventId
      );
    }
  }

  await prisma.booking.update({
    where: { id: booking.id },
    data: {
      status: 'cancelled',
      ...(calendarEventRemoved
        ? { googleEventId: null }
        : {}),
    },
  });

  await prisma.bookingDraft.deleteMany({
    where: {
      customerId,
      step: 'cancel_confirm',
      bookingId: booking.id,
    },
  });

  const refundEligible = getBookingPolicyWindow(
    booking.dateTime
  ).cancellationRefundEligible;

  await notifyAdmin(
    'booking',
    `Booking cancelled for ${customerId}`,
    `${booking.service} on ${dayjs(booking.dateTime).format(
      'YYYY-MM-DD HH:mm'
    )} was cancelled via AI assistant. ${
      successfulPayment
        ? `A successful deposit of KSh ${successfulPayment.amount.toLocaleString()} is recorded${
            successfulPayment.mpesaReceipt
              ? ` (M-Pesa receipt ${successfulPayment.mpesaReceipt})`
              : ''
          }. Studio team: manual refund review is required; no refund was issued by the assistant.`
        : 'No successful deposit is recorded.'
    }`,
    {
      customerId,
      event: 'cancel_confirmed',
      bookingId: booking.id,
      service: booking.service,
      dateTime: booking.dateTime.toISOString(),
      refundEligible,
      successfulDepositRecorded: Boolean(successfulPayment),
      depositAmount: successfulPayment?.amount,
      mpesaReceipt: successfulPayment?.mpesaReceipt,
      manualRefundReviewRequired: Boolean(successfulPayment),
      refundReviewOwner: successfulPayment
        ? 'studio_team'
        : undefined,
    }
  );

  return {
    bookingId: booking.id,
    service: booking.service,
    dateTime: booking.dateTime,
    refundEligible,
    depositPaid: Boolean(successfulPayment),
  };
}
