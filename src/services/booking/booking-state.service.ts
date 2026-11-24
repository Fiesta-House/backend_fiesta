import prisma from '../../config/prisma';
import { bookingAddonService } from './booking-addon.service';

export const addonDecisionMarker = (draftId: string): string =>
  `system:addons-decided:v1:${draftId}`;

type HistoryMessage = { role: string; content: string };

/**
 * Single source of truth for pending booking-draft state (add-on selections,
 * add-on decision flags, and attaching pending notes/add-ons to a confirmed booking).
 */
export class BookingStateService {
  /**
   * Marks the optional add-ons decision as resolved for the active draft.
   * Safe to call even if no draft exists yet (no-op when draftId is missing).
   */
  async markAddonsDecided(customerId: string, draftId?: string | null): Promise<void> {
    const resolvedDraftId =
      draftId ||
      (
        await prisma.bookingDraft.findUnique({
          where: { customerId },
          select: { id: true },
        })
      )?.id;

    if (!resolvedDraftId) return;

    try {
      const marker = addonDecisionMarker(resolvedDraftId);
      await prisma.customerMemory.upsert({
        where: { customerId },
        update: {},
        create: { customerId },
      });
      await prisma.customerMemory.updateMany({
        where: { customerId, NOT: { keyInsights: { has: marker } } },
        data: { keyInsights: { push: marker } },
      });
    } catch {
      console.warn('[BOOKING_STATE] addon_decision_state=unsaved');
    }
  }

  /**
   * Returns true if the customer has already selected or declined optional add-ons
   * for the active booking draft.
   */
  async hasAddonsDecided(
    customerId: string,
    draft: { id: string; createdAt: Date },
    history: HistoryMessage[] = [],
    isDeclining?: (msg: string, hist: HistoryMessage[]) => boolean
  ): Promise<boolean> {
    if (
      isDeclining &&
      history.some(
        (entry, index) =>
          entry.role === 'user' && isDeclining(entry.content, history.slice(0, index))
      )
    ) {
      return true;
    }

    try {
      const memory = await prisma.customerMemory.findUnique({
        where: { customerId },
        select: { keyInsights: true },
      });
      if (memory?.keyInsights?.includes(addonDecisionMarker(draft.id))) {
        return true;
      }
    } catch {
      console.warn('[BOOKING_STATE] addon_decision_state=unavailable');
    }

    const pendingNote = await prisma.customerSessionNote
      .findFirst({
        where: {
          customerId,
          bookingId: null,
          category: 'addon',
          status: 'pending',
          createdAt: { gte: draft.createdAt },
        },
        select: { id: true },
      })
      .catch(() => null);

    if (pendingNote) return true;

    const pendingAddon = await prisma.bookingAddon
      .findFirst({
        where: {
          customerId,
          bookingId: null,
          status: 'pending',
          createdAt: { gte: draft.createdAt },
        },
        select: { id: true },
      })
      .catch(() => null);

    return Boolean(pendingAddon);
  }

  /**
   * Lists pending add-ons (not yet linked to a confirmed booking) for a customer.
   */
  async getPendingAddons(customerId: string, since?: Date) {
    return prisma.bookingAddon.findMany({
      where: {
        customerId,
        bookingId: null,
        status: 'pending',
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        name: true,
        sku: true,
        quantity: true,
        unitPrice: true,
        totalPrice: true,
      },
    });
  }

  /**
   * Formats a concise, authoritative summary of the current draft's add-on state
   * for injection into the LLM system context.
   */
  async getPendingAddonSummary(
    customerId: string,
    draft?: { id: string; createdAt: Date } | null
  ): Promise<string> {
    if (!draft) return 'None';

    const [pendingAddons, decided] = await Promise.all([
      this.getPendingAddons(customerId, draft.createdAt).catch(() => []),
      this.hasAddonsDecided(customerId, draft).catch(() => false),
    ]);

    if (pendingAddons.length > 0) {
      const list = pendingAddons
        .map((addon) => {
          const qty = addon.quantity > 1 ? `${addon.quantity} x ` : '';
          const price =
            addon.totalPrice > 0
              ? `Ksh ${addon.totalPrice.toLocaleString()}`
              : 'Quoted by package tier';
          return `${qty}${addon.name} (${price})`;
        })
        .join(', ');
      return `Saved for current draft: ${list}. Optional add-ons step is ALREADY decided — do NOT ask about optional add-ons again.`;
    }

    if (decided) {
      return 'Customer declined optional add-ons for this draft. Optional add-ons step is ALREADY decided — do NOT ask about optional add-ons again.';
    }

    return 'None yet (not yet asked or decided).';
  }

  /**
   * Attaches all pending BookingAddon and CustomerSessionNote rows for a customer
   * to a newly confirmed Booking.
   */
  async attachAllPendingToBooking(customerId: string, bookingId: string): Promise<void> {
    await bookingAddonService.attachPendingToBooking(customerId, bookingId);
    await prisma.customerSessionNote.updateMany({
      where: { customerId, bookingId: null, status: 'pending' },
      data: { bookingId },
    });
  }
}

export const bookingStateService = new BookingStateService();
