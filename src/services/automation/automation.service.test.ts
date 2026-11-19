import assert from 'node:assert/strict';
import test from 'node:test';
import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { AutomationService } from './automation.service';
import { whatsappService } from '../messaging/whatsapp.service';

test('follow-up is due one day after the session time, not at midnight', () => {
  const sessionTime = dayjs('2026-09-25T15:00:00+03:00');
  const followupTime = sessionTime.add(1, 'day');

  assert.equal(followupTime.format('YYYY-MM-DD HH:mm'), '2026-09-26 15:00');
});

test('persists sent appointment reminders in WhatsApp conversation history', async () => {
  const originalBookingFindMany = prisma.booking.findMany;
  const originalMessageCreate = prisma.message.create;
  const originalReminderCreate = prisma.bookingReminder.create;
  const originalSendMessage = whatsappService.sendMessage;
  let savedMessage: any;

  (prisma.booking.findMany as any) = async () => [{
    id: 'booking-123',
    dateTime: new Date('2026-09-27T07:00:00.000Z'),
    service: 'THE ICON',
    customer: { id: 'customer-123', name: 'Njerii' }
  }];
  (prisma.message.create as any) = async ({ data }: any) => { savedMessage = data; };
  (prisma.bookingReminder.create as any) = async () => ({});
  (whatsappService.sendMessage as any) = async () => undefined;

  try {
    await new AutomationService().processReminders();

    assert.equal(savedMessage.platform, 'whatsapp');
    assert.equal(savedMessage.direction, 'outbound');
    assert.equal(savedMessage.customerId, 'customer-123');
    assert.match(savedMessage.content, /THE ICON session is tomorrow/);
    assert.equal(savedMessage.handledBy, 'system');
  } finally {
    prisma.booking.findMany = originalBookingFindMany;
    prisma.message.create = originalMessageCreate;
    prisma.bookingReminder.create = originalReminderCreate;
    whatsappService.sendMessage = originalSendMessage;
  }
});