import assert from 'node:assert/strict';
import test from 'node:test';
import { businessDay, bookingDateFacts, nextWeekRange, inBusinessTimezone, BUSINESS_TIMEZONE } from './time';

test('booking calendar facts validate dates and resolve next week in Nairobi', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T20:00:00Z').getTime() });
  assert.deepEqual(nextWeekRange(), { fromDate: '2026-10-05', toDate: '2026-10-11' });
  assert.deepEqual(bookingDateFacts('2026-10-06'), { date: '2026-10-06', weekday: 'Tuesday', isMonday: false, isPast: false });
  assert.equal(bookingDateFacts('2026-10-05').isMonday, true);
  assert.equal(bookingDateFacts('2026-10-03').isPast, true);
  for (const date of ['2026-02-30', '2026-13-01', 'October 6', '2026-10-06T10:00']) {
    assert.throws(() => bookingDateFacts(date));
  }
  context.mock.timers.tick(60 * 60 * 1000);
  assert.deepEqual(nextWeekRange(), { fromDate: '2026-10-12', toDate: '2026-10-18' });
  assert.equal(bookingDateFacts('2026-10-04').isPast, true);
});

test('2026-10-06 is Tuesday in the business timezone', () => {
  assert.equal(inBusinessTimezone('2026-10-06T07:00:00Z').format('dddd'), 'Tuesday');
});

test('2026-10-05 is Monday in the business timezone', () => {
  assert.equal(inBusinessTimezone('2026-10-05T07:00:00Z').format('dddd'), 'Monday');
});

test('converts UTC appointment times to Nairobi time', () => {
  const appointment = inBusinessTimezone('2026-09-04T21:30:00.000Z');

  assert.equal(BUSINESS_TIMEZONE, 'Africa/Nairobi');
  assert.equal(appointment.format('YYYY-MM-DD HH:mm'), '2026-09-05 00:30');
  assert.equal(appointment.format('dddd'), 'Saturday');
});

test('creates a Nairobi business-day boundary for availability queries', () => {
  const startOfDay = businessDay('2026-09-05').startOf('day');
  const endOfDay = businessDay('2026-09-05').endOf('day');

  assert.equal(startOfDay.toISOString(), '2026-09-04T21:00:00.000Z');
  assert.equal(endOfDay.toISOString(), '2026-09-05T20:59:59.999Z');
});
