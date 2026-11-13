
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { googleCalendarService } from '../calendar/calendar.service';
import { invoiceService } from '../invoice/invoice.service';
import { notifyAdmin } from '../notifications/notification.service';

import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../../config/constants';
import { inBusinessTimezone } from '../../utils/time';

import { parseMpesaMessage } from './till-payment';
import {
  getPackageForDeposit,
  getDepositForPackage,
} from './booking-deposit';

export async function completeTillBooking(
  customerId: string,
  message: string
): Promise<string | null> {
  const parsed = parseMpesaMessage(message);

  // A valid receipt code is required. A vague "I've paid" message
  // must not create a confirmed booking.
  if (!parsed.code) {
    return null;
  }

  const draft = await prisma.bookingDraft.findUnique({
    where: { customerId },
  });

  if (!draft || draft.step !== 'awaiting_payment_message') {
    return null;
  }

  if (!draft.service || !draft.date || !draft.time) {
    throw new Error(
      'The pending Till booking is missing its service, date or time.'
    );
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) =>
    draft.service!.toLowerCase().includes(key)
  );

  if (!serviceKey) {
    throw new Error(`Unrecognised booking package: ${draft.service}`);
  }

  const durationMinutes =
    SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

  const pkg = await getPackageForDeposit(draft.service);
  const depositAmount = getDepositForPackage(pkg);

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  if (!customer) {
    throw new Error(
      'The customer associated with this booking could not be found.'
    );
  }

  const dateTime = draft.dateTimeIso
    ? new Date(draft.dateTimeIso)
    : inBusinessTimezone(`${draft.date}T${draft.time}`).toDate();

  if (Number.isNaN(dateTime.getTime())) {
    throw new Error('The pending booking has an invalid date or time.');
  }

  // Check whether this transaction code has already been used.
  const existingReceipt = await prisma.payment.findFirst({
    where: { mpesaReceipt: parsed.code },
    include: { booking: true },
  });

  if (existingReceipt) {
    if (existingReceipt.booking?.customerId === customerId) {
      return `Thank you. Receipt ${parsed.code} has already been received for your booking. The studio team is checking the payment.`;
    }

    await notifyAdmin(
      'booking',
      'Duplicate M-Pesa receipt submitted',
      `Receipt ${parsed.code} was submitted by customer ${customerId}, but it is already associated with another payment. Please investigate. Message: ${message.slice(0, 500)}`,
      {
        customerId,
        event: 'duplicate_till_receipt',
        receipt: parsed.code,
      }
    );

    return 'Thank you for sharing the receipt. The studio team needs to check this transaction before completing your booking. They will follow up with you.';
  }

  // Check availability while excluding this customer's own draft.
  const slotsResult: any = await bookingService.getAvailableSlots(
    draft.date,
    durationMinutes,
    undefined,
    draft.id
  );

  if (slotsResult?.status === 'closed') {
    throw new Error(
      'The studio is closed on the date in the pending booking.'
    );
  }

  const availableSlots: string[] = Array.isArray(slotsResult)
    ? slotsResult
    : [];

  if (!availableSlots.includes(draft.time)) {
    await notifyAdmin(
      'booking',
      'Paid booking requires availability review',
      `Customer ${customerId} submitted receipt ${parsed.code} for ${draft.service} on ${draft.date} at ${draft.time}, but the slot is no longer available. Please contact the customer.`,
      {
        customerId,
        event: 'till_receipt_slot_conflict',
        receipt: parsed.code,
        service: draft.service,
        date: draft.date,
        time: draft.time,
      }
    );

    return 'Thank you for sending your M-Pesa receipt. The studio team needs to review the session time before finalising your booking. They will contact you shortly.';
  }

  // Record amount discrepancies for admin review.
  // A customer-supplied receipt does not independently verify payment.
  const amountMismatch =
    parsed.amount !== null && parsed.amount !== depositAmount;

  // Create the booking and pending payment together.
  // Claiming the draft prevents duplicate webhook deliveries from
  // completing the same booking simultaneously.
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.bookingDraft.updateMany({
      where: {
        id: draft.id,
        customerId,
        step: 'awaiting_payment_message',
      },
      data: {
        step: 'processing_till_receipt',
      },
    });

    if (claimed.count !== 1) {
      throw new Error(
        'This booking receipt is already being processed.'
      );
    }

    // Recheck receipt uniqueness inside the transaction.
    const duplicate = await tx.payment.findFirst({
      where: { mpesaReceipt: parsed.code },
      include: { booking: true },
    });

    if (duplicate) {
      throw new Error(
        'This M-Pesa receipt has already been recorded.'
      );
    }

    const booking = await tx.booking.create({
      data: {
        customerId,
        service: draft.service!,
        dateTime,
        status: 'confirmed',
        durationMinutes,
        recipientName: draft.recipientName || null,
        recipientPhone: draft.recipientPhone || null,
      },
    });

    const payment = await tx.payment.create({
      data: {
        bookingId: booking.id,
        amount: depositAmount,
        phone:
          customer.phone ||
          customer.whatsappId ||
          'Not provided',
        status: 'pending',
        mpesaReceipt: parsed.code,
      },
    });

    await tx.bookingDraft.delete({
      where: { id: draft.id },
    });

    return { booking, payment };
  });

  // Calendar and invoice work happen after the transaction.
  // Their failure must not undo the confirmed booking.
  let calendarEventId: string | null = null;
  let calendarFailed = false;

  try {
    calendarEventId =
      (await googleCalendarService.createEvent({
        service: result.booking.service,
        dateTime: result.booking.dateTime,
        customerName: customer.name,
        durationMinutes,
      })) ?? null;

    if (calendarEventId) {
      await prisma.booking.update({
        where: { id: result.booking.id },
        data: { googleEventId: calendarEventId },
      });
    } else {
      calendarFailed = true;
    }
  } catch (error) {
    calendarFailed = true;
    console.error(
      '[TILL_BOOKING] Calendar creation failed:',
      error
    );
  }

  let invoiceFailed = false;

  try {
    await invoiceService.createOrRefreshForBooking(
      result.booking.id
    );
  } catch (error) {
    invoiceFailed = true;
    console.error(
      '[TILL_BOOKING] Invoice creation failed:',
      error
    );
  }

  const issues = [
    amountMismatch
      ? `Receipt amount KSh ${parsed.amount?.toLocaleString()} does not match the expected deposit of KSh ${depositAmount.toLocaleString()}.`
      : null,
    calendarFailed
      ? 'Google Calendar event creation failed.'
      : null,
    invoiceFailed
      ? 'Invoice creation failed.'
      : null,
  ].filter((issue): issue is string => Boolean(issue));

  // Notify the studio after the booking has been created.
  // Notification failure must not undo the booking.
  try {
    await notifyAdmin(
      'booking',
      `New Till booking: ${result.booking.service}`,
      [
        `Customer: ${customer.name}`,
        `Customer ID: ${customerId}`,
        `Session: ${result.booking.dateTime.toISOString()}`,
        `Booking ID: ${result.booking.id}`,
        `Expected deposit: KSh ${depositAmount.toLocaleString()}`,
        `Receipt: ${parsed.code}`,
        `Receipt amount: ${
          parsed.amount !== null
            ? `KSh ${parsed.amount.toLocaleString()}`
            : 'Not available in message'
        }`,
        'Payment status: PENDING — manual verification required.',
        ...issues,
        `Original message: ${message.slice(0, 500)}`,
      ].join('\n'),
      {
        customerId,
        event: 'till_booking_created',
        bookingId: result.booking.id,
        paymentId: result.payment.id,
        receipt: parsed.code,
        expectedDeposit: depositAmount,
        receiptAmount: parsed.amount,
        amountMismatch,
        calendarFailed,
        invoiceFailed,
        paymentStatus: 'pending',
      }
    );
  } catch (error) {
    console.error(
      '[TILL_BOOKING] Admin notification failed:',
      error
    );
  }

  const when = inBusinessTimezone(result.booking.dateTime);

  return [
    `Thank you! Your ${result.booking.service} session is booked for ${when.format('dddd, D MMMM YYYY')} at ${when.format('h:mm A')}.`,
    `I've received your M-Pesa receipt ${parsed.code}. The studio team will verify the payment separately.`,
    amountMismatch
      ? 'The amount shown in the receipt differs from the expected deposit, so the team will check it with you.'
      : null,
  ]
    .filter(Boolean)
    .join(' ');
}
