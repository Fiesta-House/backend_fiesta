
import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { googleCalendarService } from '../services/calendar/calendar.service';
import { SERVICE_DURATIONS, DEFAULT_DURATION } from '../config/constants';
import { notifyAdmin } from '../services/notifications/notification.service';
import dayjs from 'dayjs';
import { bookingService } from '../services/booking/booking.service';
import { getBookingPolicyWindow } from '../utils/booking-policy';
import { businessDay } from '../utils/time';

export class BookingController {

  /**
   * List all bookings
   */
  async listBookings(req: Request, res: Response) {
    try {
      const bookings = await prisma.booking.findMany({
        include: {
          customer: true,
          bookingAddons: {
            where: { status: { not: 'cancelled' } },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              name: true,
              sku: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
              status: true,
              note: true,
              createdAt: true,
            }
          },
          payments: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              amount: true,
              status: true,
              mpesaReceipt: true,
              checkoutRequestId: true,
              createdAt: true,
              updatedAt: true,
            }
          }
        },
        orderBy: {
          dateTime: 'desc'
        }
      });
      return res.json({ bookings, total: bookings.length });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Read-only monitor for active booking drafts.
   */
  async listBookingDrafts(_req: Request, res: Response) {
    try {
      const drafts = await prisma.bookingDraft.findMany({
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true,
              whatsappId: true,
              instagramUsername: true,
              messengerId: true,
              messages: {
                take: 8,
                orderBy: { createdAt: 'desc' },
                select: {
                  id: true,
                  content: true,
                  platform: true,
                  direction: true,
                  handledBy: true,
                  createdAt: true,
                },
              },
            },
          },
          payment: {
            select: {
              id: true,
              amount: true,
              phone: true,
              status: true,
              mpesaReceipt: true,
              checkoutRequestId: true,
              bookingId: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      // BookingDraft.bookingId is a scalar, not a Prisma relation.
      // Fetch linked bookings separately for reschedule/cancellation drafts.
      const bookingIds = [
        ...new Set(
          drafts
            .map((draft) => draft.bookingId)
            .filter((id): id is string => Boolean(id))
        ),
      ];

      const linkedBookings = bookingIds.length
        ? await prisma.booking.findMany({
            where: { id: { in: bookingIds } },
            select: {
              id: true,
              service: true,
              dateTime: true,
              status: true,
              recipientName: true,
              recipientPhone: true,
              googleEventId: true,
            },
          })
        : [];

      const bookingsById = new Map(
        linkedBookings.map((booking) => [booking.id, booking])
      );

      const countsByStep = drafts.reduce<Record<string, number>>(
        (counts, draft) => {
          counts[draft.step] = (counts[draft.step] || 0) + 1;
          return counts;
        },
        {}
      );

      const result = drafts.map((draft) => ({
        ...draft,
        linkedBooking: draft.bookingId
          ? bookingsById.get(draft.bookingId) ?? null
          : null,
      }));

      return res.json({
        drafts: result,
        total: result.length,
        countsByStep,
      });
    } catch (error: any) {
      console.error('Failed to list booking drafts:', error);
      return res.status(500).json({
        error: 'Failed to load booking drafts',
        details: error.message,
      });
    }
  }

  /**
   * Get available packages
   */
  async getPackages(req: Request, res: Response) {
    try {
      const packages = await prisma.package.findMany({ orderBy: { price: 'asc' } });
      return res.json(packages);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  private pickPackageFields(body: any) {
    const {
      name, type, price, deposit, duration, images, makeup, outfits,
      styling, photobook, photobookSize, mount, balloonBackdrop, wig, notes
    } = body;
    return { name, type, price, deposit, duration, images, makeup, outfits, styling, photobook, photobookSize, mount, balloonBackdrop, wig, notes };
  }

  /**
   * Create a new package
   */
  async createPackage(req: Request, res: Response) {
    try {
      const pkg = await prisma.package.create({ data: this.pickPackageFields(req.body) });
      return res.status(201).json(pkg);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Update an existing package
   */
  async updatePackage(req: Request, res: Response) {
    try {
      const id = String(req.params.id);
      const pkg = await prisma.package.update({ where: { id }, data: this.pickPackageFields(req.body) });
      return res.json(pkg);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Delete a package
   */
  async deletePackage(req: Request, res: Response) {
    try {
      const id = String(req.params.id);
      await prisma.package.delete({ where: { id } });
      return res.status(204).send();
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get available services
   */
  async getServices(req: Request, res: Response) {
    const services = [
      { name: 'THE BLOOM', duration: 90 },
      { name: 'THE MUSE', duration: 120 },
      { name: 'THE ICON', duration: 150 },
      { name: 'THE LEGEND', duration: 150 },
      { name: 'THE QUEEN', duration: 180 },
      { name: 'THE EMPRESS', duration: 210 },
      { name: 'THE GODDESS', duration: 300 },
    ];
    return res.json(services);
  }

  /**
   * Get available hours for a date
   */
  async getAvailableHours(req: Request, res: Response) {
    try {
      const date = Array.isArray(req.params.date) ? req.params.date[0] : req.params.date;
      const service = typeof req.query.service === 'string' ? req.query.service : 'THE BLOOM';
      const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => service.toLowerCase().includes(key)) || 'bloom';
      const duration = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;
      const availableSlots = await bookingService.getAvailableSlots(date, duration);

      if (!Array.isArray(availableSlots)) {
        return res.json([]);
      }

      return res.json(availableSlots.map((time) => ({
        time: businessDay(date).hour(Number(time.slice(0, 2))).minute(Number(time.slice(3))).second(0).millisecond(0).toISOString(),
        available: true,
      })));
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Confirm booking
   */
  async confirmBooking(req: Request, res: Response) {
    try {
      const id = String(req.params.id);
      const booking = await prisma.booking.update({
        where: { id },
        data: { status: 'confirmed' }
      });
      return res.json(booking);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Update a booking's date/time and/or service - used by admins to manually
   * reschedule a booking (e.g. a customer called in directly instead of
   * messaging), rather than only through the WhatsApp AI flow.
   */
  async updateBooking(req: Request, res: Response) {
    try {
      const id = req.params.id as string;
      const { dateTime, service } = req.body;

      const existing = await prisma.booking.findUnique({ where: { id }, include: { customer: true } });
      if (!existing) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      const customerName = existing.customer.name;

      const newDateTime = dateTime ? new Date(dateTime) : existing.dateTime;
      const newService = service || existing.service;
      const serviceKey = Object.keys(SERVICE_DURATIONS).find(k => newService.toLowerCase().includes(k)) || 'standard';
      const durationMinutes = SERVICE_DURATIONS[serviceKey] || DEFAULT_DURATION;

      const booking = await prisma.booking.update({
        where: { id },
        data: { dateTime: newDateTime, service: newService, durationMinutes },
      });

      if (existing.googleEventId) {
        await googleCalendarService.updateEvent(existing.googleEventId, {
          service: newService,
          dateTime: newDateTime,
          customerName,
          durationMinutes,
        });
      }

      const dateChanged = newDateTime.getTime() !== new Date(existing.dateTime).getTime();
      const serviceChanged = newService !== existing.service;
      if (dateChanged || serviceChanged) {
        await notifyAdmin(
          'reschedule',
          `Manual reschedule: ${customerName}`,
          `${existing.service} moved from ${dayjs(existing.dateTime).format('YYYY-MM-DD HH:mm')} to ${dayjs(newDateTime).format('YYYY-MM-DD HH:mm')}${serviceChanged ? ` (service changed to ${newService})` : ''}.`,
          {
            event: 'manual_reschedule',
            bookingId: existing.id,
            customerId: existing.customerId,
            oldService: existing.service,
            newService,
            oldDateTime: existing.dateTime.toISOString(),
            newDateTime: newDateTime.toISOString(),
          }
        );
      }

      return res.json(booking);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Cancel booking
   */
  async cancelBooking(req: Request, res: Response) {
    try {
      const id = String(req.params.id);
      const existing = await prisma.booking.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      const calendarEventRemoved = existing.googleEventId
        ? await googleCalendarService.deleteEvent(existing.googleEventId)
        : true;

      const booking = await prisma.booking.update({
        where: { id },
        data: {
          status: 'cancelled',
          ...(calendarEventRemoved ? { googleEventId: null } : {}),
        }
      });

      const refundEligible = getBookingPolicyWindow(existing.dateTime).cancellationRefundEligible;
      await notifyAdmin(
        'booking',
        `Booking cancelled: ${existing.customerId}`,
        `${existing.service} on ${dayjs(existing.dateTime).format('YYYY-MM-DD HH:mm')} was cancelled.${refundEligible ? ' Refund eligible (>72h).' : ' Not automatically refundable (<=72h).'}`,
        {
          event: 'manual_cancel',
          bookingId: existing.id,
          customerId: existing.customerId,
          service: existing.service,
          dateTime: existing.dateTime.toISOString(),
          refundEligible,
        }
      );

      return res.json(booking);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get one booking by ID
   */
  async getBookingById(req: Request, res: Response) {
    try {
      const id = String(req.params.id);
      const booking = await prisma.booking.findUnique({
        where: { id },
        include: {
          customer: {
            select: { id: true, name: true, email: true, phone: true }
          },
          bookingAddons: {
            where: { status: { not: 'cancelled' } },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              name: true,
              sku: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
              status: true,
              note: true,
              createdAt: true,
            }
          },
          payments: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              amount: true,
              status: true,
              mpesaReceipt: true,
              checkoutRequestId: true,
              createdAt: true,
              updatedAt: true,
            }
          }
        }
      });

      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      return res.json(booking);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Get all bookings for a specific customer
   */
  async getCustomerBookings(req: Request, res: Response) {
    try {
      const customerId = String(req.params.customerId);
      const bookings = await prisma.booking.findMany({
        where: { customerId },
        include: {
          customer: {
            select: { id: true, name: true, email: true, phone: true }
          },
          bookingAddons: {
            where: { status: { not: 'cancelled' } },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              name: true,
              sku: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
              status: true,
              note: true,
              createdAt: true,
            }
          },
          payments: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              amount: true,
              status: true,
              mpesaReceipt: true,
              checkoutRequestId: true,
              createdAt: true,
              updatedAt: true,
            }
          }
        },
        orderBy: { dateTime: 'desc' }
      });

      return res.json(bookings);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}

export const bookingController = new BookingController();
