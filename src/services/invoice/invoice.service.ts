import PDFDocument from 'pdfkit';
import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { bookingAddonService } from '../booking/booking-addon.service';

interface InvoicePdfData {
  invoiceNumber: string;
  customerName: string;
  customerPhone: string | null;
  service: string;
  bookingDateTime: Date;
  subtotal: number;
  addonLines?: { name: string; quantity: number; unitPrice: number; totalPrice: number }[];
  tax: number;
  discount: number;
  total: number;
  depositPaid: number;
  depositReceipts: string[];
  balanceDue: number;
  createdAt: Date;
}

// Brand palette - a deep rose to suit a maternity/photography studio, paired
// with neutral grays so it reads as a real invoice rather than a mockup.
const BRAND = '#9d174d';
const BRAND_LIGHT = '#fdf2f8';
const INK = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export class InvoiceService {
  /** Creates an invoice or refreshes its totals and PDF from current booking data. */
  async createOrRefreshForBooking(bookingId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { customer: true },
    });
    if (!booking) return null;

    const existing = await prisma.invoice.findUnique({ where: { bookingId } });
    const pkg = await prisma.package.findFirst({
      where: { name: { contains: booking.service, mode: 'insensitive' } },
    });
    const packagePrice = pkg?.price || 0;
    const { addonsTotal, lineItems: addonLines } = await bookingAddonService.sumForBooking(bookingId);
    const subtotal = packagePrice + addonsTotal;
    const tax = existing?.tax || 0;
    const discount = existing?.discount || 0;
    const total = subtotal + tax - discount;
    const payments = await prisma.payment.findMany({ where: { bookingId, status: 'success' } });
    const depositPaid = payments.reduce((sum, payment) => sum + payment.amount, 0);
    const depositReceipts = payments.map((payment) => payment.mpesaReceipt).filter((receipt): receipt is string => !!receipt);
    const balanceDue = Math.max(total - depositPaid, 0);
    const year = new Date().getFullYear();
    const invoiceCountThisYear = existing
      ? 0
      : await prisma.invoice.count({ where: { invoiceNumber: { startsWith: `INV-${year}-` } } });
    const invoiceNumber = existing?.invoiceNumber || this.buildInvoiceNumber(year, invoiceCountThisYear + 1);
    const createdAt = existing?.createdAt || new Date();
    const pdfData = await this.generatePdf({
      invoiceNumber,
      customerName: booking.customer.name,
      customerPhone: booking.customer.phone,
      service: this.formatPackageDescription(pkg?.name || booking.service),
      bookingDateTime: booking.dateTime,
      subtotal: packagePrice,
      addonLines,
      tax,
      discount,
      total,
      depositPaid,
      depositReceipts,
      balanceDue,
      createdAt,
    });

    const status = existing?.status === 'paid' && balanceDue > 0
      ? (existing.sentAt ? 'sent' : 'pending')
      : existing?.status || 'pending';
    const data = {
      subtotal,
      tax,
      discount,
      total,
      depositPaid,
      balanceDue,
      status,
      paidAt: balanceDue > 0 ? null : existing?.paidAt,
      pdfData,
    };

    const invoice = existing
      ? await prisma.invoice.update({
          where: { id: existing.id },
          data,
          include: { customer: true, booking: true },
        })
      : await prisma.invoice.create({
          data: {
            ...data,
            invoiceNumber,
            bookingId,
            customerId: booking.customerId,
          },
          include: { customer: true, booking: true },
        });

    await bookingAddonService.markInvoiced(bookingId);
    return invoice;
  }

  /** Formats known edition names for customer-facing invoices. */
  private formatPackageDescription(service: string): string {
    const normalized = service.trim().replace(/^the\s+/i, '').toLowerCase();

    const editions: Record<string, string> = {
      bloom: 'The Bloom',
      muse: 'The Muse',
      icon: 'The Icon',
      legend: 'The Legend',
      queen: 'The Queen',
      empress: 'The Empress',
      goddess: 'The Goddess',
    };

    const edition = editions[normalized];

    return edition
      ? `${edition} - Maternity Photography Session`
      : service;
  }

  /** Renders a professional one-page invoice as a PDF buffer. */
  async generatePdf(data: InvoicePdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // --- Header band ---
      doc.rect(0, 0, PAGE_WIDTH, 12).fill(BRAND);

      doc.fillColor(INK).font('Helvetica-Bold').fontSize(20)
        .text('Fiesta House Maternity', MARGIN, 40);
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
        .text('4th Avenue Parklands, Diamond Plaza Annex, Nairobi, Kenya', MARGIN, 64)
        .text('+254 720 111928  |  info@fiestahousematernity.com  |  www.fiestahousematernity.com', MARGIN, 78);

      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(22)
        .text('INVOICE', MARGIN, 40, { width: CONTENT_WIDTH, align: 'right' });
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
        .text(data.invoiceNumber, MARGIN, 66, { width: CONTENT_WIDTH, align: 'right' })
        .text(dayjs(data.createdAt).format('MMMM D, YYYY'), MARGIN, 79, { width: CONTENT_WIDTH, align: 'right' });

      doc.moveTo(MARGIN, 105).lineTo(PAGE_WIDTH - MARGIN, 105).strokeColor(BORDER).lineWidth(1).stroke();

      // --- Billed To / Session info ---
      const infoY = 125;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('BILLED TO', MARGIN, infoY);
      doc.fillColor(INK).font('Helvetica').fontSize(11).text(data.customerName, MARGIN, infoY + 14);
      if (data.customerPhone) {
        doc.fillColor(MUTED).fontSize(10).text(data.customerPhone, MARGIN, infoY + 30);
      }

      const sessionX = MARGIN + CONTENT_WIDTH / 2;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('SESSION', sessionX, infoY);
      doc.fillColor(INK).font('Helvetica').fontSize(11)
        .text(data.service, sessionX, infoY + 14)
        .fillColor(MUTED).fontSize(10).text(dayjs(data.bookingDateTime).format('MMM D, YYYY, h:mm A'), sessionX, infoY + 30);

      // --- Line items table ---
      let y = infoY + 65;
      const col2X = PAGE_WIDTH - MARGIN - 120;

      doc.rect(MARGIN, y, CONTENT_WIDTH, 26).fill(BRAND_LIGHT);
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(9)
        .text('DESCRIPTION', MARGIN + 12, y + 9)
        .text('AMOUNT', col2X, y + 9, { width: 108, align: 'right' });
      y += 26;

      const rows: [string, string, boolean?][] = [
        [data.service, `KSh ${data.subtotal.toLocaleString()}`],
        ...(data.addonLines || []).map((line) => [
          line.name,
          line.totalPrice > 0 ? `KSh ${line.totalPrice.toLocaleString()}` : 'Quoted',
        ] as [string, string]),
        ...(data.discount > 0 ? [['Discount', `- KSh ${data.discount.toLocaleString()}`] as [string, string]] : []),
        ...(data.tax > 0 ? [['Tax', `KSh ${data.tax.toLocaleString()}`] as [string, string]] : []),
      ];

      for (const [label, value] of rows) {
        doc.fillColor(INK).font('Helvetica').fontSize(10)
          .text(label, MARGIN + 12, y + 8)
          .text(value, col2X, y + 8, { width: 108, align: 'right' });
        doc.moveTo(MARGIN, y + 28).lineTo(PAGE_WIDTH - MARGIN, y + 28).strokeColor(BORDER).lineWidth(0.5).stroke();
        y += 28;
      }

      y += 12;

      // --- Totals summary (right-aligned block) ---
      const summaryLabelX = PAGE_WIDTH - MARGIN - 220;
      const summaryValueX = PAGE_WIDTH - MARGIN - 120;
      const summaryRow = (label: string, value: string, bold = false, color = INK) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(color)
          .text(label, summaryLabelX, y, { width: 100, align: 'left' })
          .text(value, summaryValueX, y, { width: 108, align: 'right' });
        y += bold ? 22 : 18;
      };

      summaryRow('Total', `KSh ${data.total.toLocaleString()}`, true);
      summaryRow('Deposit Paid', `KSh ${data.depositPaid.toLocaleString()}`);
      if (data.depositReceipts.length > 0) {
        doc.fillColor(MUTED).font('Helvetica').fontSize(8)
          .text(`M-Pesa Receipt${data.depositReceipts.length > 1 ? 's' : ''}: ${data.depositReceipts.join(', ')}`, summaryLabelX, y, { width: 228, align: 'right' });
        y += 12;
      }
      doc.moveTo(summaryLabelX, y).lineTo(PAGE_WIDTH - MARGIN, y).strokeColor(BORDER).lineWidth(1).stroke();
      y += 8;

      if (data.balanceDue <= 0) {
        doc.rect(summaryLabelX, y, 228, 28).fill('#dcfce7');
        doc.fillColor('#166534').font('Helvetica-Bold').fontSize(12)
          .text('PAID IN FULL', summaryLabelX, y + 8, { width: 228, align: 'center' });
      } else {
        doc.rect(summaryLabelX, y, 228, 28).fill(BRAND);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12)
          .text('Balance Due', summaryLabelX + 12, y + 8)
          .text(`KSh ${data.balanceDue.toLocaleString()}`, summaryLabelX, y + 8, { width: 216, align: 'right' });
      }
      y += 50;

      // --- Payment instructions (only relevant while a balance remains) ---
      if (data.balanceDue > 0) {
        doc.rect(MARGIN, y, CONTENT_WIDTH, 50).fill(BRAND_LIGHT);
        doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(9)
          .text('PAYMENT INFORMATION', MARGIN + 12, y + 8);
        doc.fillColor(INK).font('Helvetica').fontSize(9)
          .text(
            'A KSh 2,000 booking deposit secures your session. Any remaining balance is payable after your session via M-Pesa Buy Goods Till 670241.',
            MARGIN + 12,
            y + 21,
            { width: CONTENT_WIDTH - 24 }
          );
        y += 50 + 16;
      }

      // --- Footer ---
      doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).strokeColor(BORDER).lineWidth(1).stroke();
      y += 16;
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
        .text('Thank you for choosing Fiesta House Maternity. We look forward to welcoming you to our studio.', MARGIN, y, { width: CONTENT_WIDTH, align: 'center' });

      // --- Closing brand bar, mirrors the header so the page doesn't just
      // trail off into blank space below a short line-item list ---
      doc.rect(0, PAGE_HEIGHT - 12, PAGE_WIDTH, 12).fill(BRAND);

      doc.end();
    });
  }

  /** INV-{year}-{sequential, zero-padded} */
  buildInvoiceNumber(year: number, sequence: number): string {
    return `INV-${year}-${String(sequence).padStart(3, '0')}`;
  }
}

export const invoiceService = new InvoiceService();
