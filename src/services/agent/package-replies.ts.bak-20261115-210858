import dayjs from 'dayjs';
import prisma from '../../config/prisma';
import { bookingService } from '../booking/booking.service';
import { DEFAULT_DURATION, EDITIONS_PENDING_OWNER_CONFIRMATION, PACKAGE_NAMES_FOR_EXTRACTION, SERVICE_DURATIONS } from '../../config/constants';
import { EDITION_CATALOG_HEADER, EDITION_CATALOG_INTRO, EDITION_CATALOG_FOLLOW_UP, OFFICIAL_WEBSITE_URLS } from './constants';
import { differingInclusionFields, SEED_EDITION_INCLUSIONS } from '../../config/edition-inclusions';
import { formatCustomerDate, inBusinessTimezone } from '../../utils/time';
import { getDepositForPackage, getPackageForDeposit } from './booking-tools';
import { editionInText } from './reply-voice';
import { selectedEdition } from './conversation-flow.matcher';
import { formatCustomerTime } from './replies';
import { EARLY_SLOT_STEP } from './slot-memory';
import { CARRY_OVER_PREFIX } from './booking-progress';

function canonicalEditionName(name: string): string {
  const normalized = name.trim().toUpperCase().replace(/^THE\s+/, '').replace(/\s+PACKAGE$/, '');
  return PACKAGE_NAMES_FOR_EXTRACTION.find((edition) =>
    edition.replace(/^THE\s+/, '').toUpperCase() === normalized
  ) || name.trim().toUpperCase();
}

export function editionSelectedDateQuestion(name: string): string {
  const title = name.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return `${title} it is. What date would suit you? You can see everything included here: ${OFFICIAL_WEBSITE_URLS.packages}`;
}

export function buildPackageCard(pkg: {
  name: string;
  price: number;
  duration: string;
  images: number;
  makeup: boolean;
  outfits: number;
  styling?: boolean;
  photobook: boolean;
  photobookSize: string | null;
  mount: boolean;
  balloonBackdrop: boolean;
  wig: boolean;
  notes: string | null;
  inclusions?: readonly string[] | null;
}): string {
  const canonicalName = canonicalEditionName(pkg.name);
  const isLegend = canonicalName === 'THE LEGEND';
  const inclusions = pkg.inclusions?.length ? pkg.inclusions
    : differingInclusionFields(canonicalName, pkg).length === 0 ? SEED_EDITION_INCLUSIONS[canonicalName]?.inclusions : undefined;
  if (inclusions) {
    const visible = isLegend ? inclusions.filter(item => !/\bwig/i.test(item)) : inclusions;
    const legendNote = isLegend ? '\nThe team will confirm the remaining inclusions for you.' : '';
    return `${pkg.name} - Ksh ${pkg.price.toLocaleString()}\n${visible.map((item) => `- ${item}`).join('\n')}${legendNote}`;
  }
  const items: string[] = [];
  if (pkg.duration) items.push(`Session length: ${pkg.duration}`);
  if (pkg.images > 0) items.push(`${pkg.images} final edited photos`);
  if (pkg.makeup) items.push('Professional makeup');

  if (pkg.outfits > 0) {
    items.push(`${pkg.outfits} outfit${pkg.outfits > 1 ? 's' : ''}`);
  }
  if (pkg.styling) items.push('Styling');

  if (pkg.wig && !isLegend) {
    items.push('Styled wig included (quantity to be confirmed)');
  }

  if (pkg.balloonBackdrop) {
    items.push('Balloon backdrop (design to be confirmed)');
  }

  if (pkg.photobook) {
    const size = pkg.photobookSize ? ` (${pkg.photobookSize})` : '';
    items.push(`Photobook${size}`);
  }

  if (pkg.mount) {
    items.push('Photo mount (size to be confirmed)');
  }

  return `${pkg.name} - Ksh ${pkg.price.toLocaleString()}\n${items.map((item) => `- ${item}`).join('\n')}${isLegend ? '\nThe team will confirm the remaining inclusions for you.' : ''}`;
}

export async function getPackageCatalogReply(_showInclusions = false, userMessage = ''): Promise<string | null> {
  try {
    const packages = await prisma.package.findMany({
      orderBy: [{ price: 'asc' }, { name: 'asc' }],
      select: {
        name: true,
        price: true,
        duration: true,
        images: true,
        makeup: true,
        outfits: true,
        styling: true,
        photobook: true,
        photobookSize: true,
        mount: true,
        balloonBackdrop: true,
        wig: true,
        notes: true,
      }
    });

    if (!packages.length) return null;

    const editions = packages.filter((pkg) => PACKAGE_NAMES_FOR_EXTRACTION.some((name) => name === pkg.name));
    if (!editions.length) return null;
    const needsReview = (pkg: typeof editions[number]) => {
      const canonicalName = canonicalEditionName(pkg.name);
      const differences = differingInclusionFields(canonicalName, pkg);
      if (differences.length) console.warn('Edition fields disagree with seed inclusion reference:', pkg.name, differences.join(', '));
      return EDITIONS_PENDING_OWNER_CONFIRMATION.includes(canonicalName)
        || differences.length > 0;
    };
    const requested = editions.filter((pkg) => new RegExp(`\\b${pkg.name.replace(/^THE /, '')}\\b`, 'i').test(userMessage));
    if (requested.length === 1) {
      const edition = requested[0];
      return needsReview(edition)
        ? 'The team will confirm the exact inclusions for you.'
        : buildPackageCard({ ...edition, inclusions: SEED_EDITION_INCLUSIONS[canonicalEditionName(edition.name)]?.inclusions });
    }
    const overview = editions.map((pkg) => needsReview(pkg)
      ? `${pkg.name} - Ksh ${pkg.price.toLocaleString()} | Ask me for details`
      : `${pkg.name} - Ksh ${pkg.price.toLocaleString()} | ${pkg.duration} | ${pkg.images} edited photos`);
    return `${EDITION_CATALOG_HEADER}\n\n${EDITION_CATALOG_INTRO}\n${overview.join('\n')}\n\n${EDITION_CATALOG_FOLLOW_UP}`;
  } catch (err) {
    console.error('Failed to build package catalog reply:', err);
    return null;
  }
}

export async function getPackageAdviceReply(userMessage: string): Promise<string | null> {
  const packages = await prisma.package.findMany({
    orderBy: [{ price: 'asc' }, { name: 'asc' }],
    select: {
      name: true,
      price: true,
      duration: true,
      images: true,
      makeup: true,
      outfits: true,
      photobook: true,
      photobookSize: true,
      mount: true,
      balloonBackdrop: true,
      wig: true,
      notes: true,
    },
  });

  const text = userMessage.toLowerCase();
  const mentionedPackages = packages.filter((pkg) => new RegExp(`\\b${pkg.name.replace(/^THE /, '').replace(/ package$/i, '')}\\b`, 'i').test(text));
  if (mentionedPackages.length >= 2) {
    const [first, second] = mentionedPackages;
    const differences: string[] = [];
    if (first.price !== second.price) differences.push(`${first.name} is Ksh ${first.price.toLocaleString()}, while ${second.name} is Ksh ${second.price.toLocaleString()}`);
    if (first.images !== second.images) differences.push(`${first.name} includes ${first.images} edited images and ${second.name} includes ${second.images}`);
    if (first.duration !== second.duration) differences.push(`${first.name} is ${first.duration}, while ${second.name} is ${second.duration}`);
    if (first.photobook !== second.photobook) differences.push(second.photobook ? `${second.name} includes an ${second.photobookSize || ''} photobook`.replace('an  photobook', 'a photobook') : `${first.name} includes an ${first.photobookSize || ''} photobook`.replace('an  photobook', 'a photobook'));
    if (first.mount !== second.mount) differences.push(first.mount ? `${first.name} includes an A3 mount` : `${second.name} includes an A3 mount`);

    const higherValuePackage = first.price >= second.price ? first : second;
    const lowerCostPackage = higherValuePackage === first ? second : first;
    return `${differences.join('. ')}. ${higherValuePackage.name} makes sense if its extra inclusions matter to you; ${lowerCostPackage.name} is the lower-cost option. Will your older child be joining you in the shoot?`;
  }

  const higherValue = packages.find((pkg) => ['the empress', 'the goddess', 'the queen', 'the legend'].includes(pkg.name.toLowerCase())) || packages[packages.length - 1];
  const lowerCost = packages.find((pkg) => ['the icon', 'the muse', 'the bloom'].includes(pkg.name.toLowerCase())) || packages[0];
  if (!higherValue || !lowerCost) return null;

  const higherPhotobookInfo = higherValue.photobook ? ` and a photobook` : '';
  return `Congratulations on your pregnancy! I would lean toward ${higherValue.name} if you would enjoy more variety: it includes ${higherValue.images} edited images${higherPhotobookInfo} for Ksh ${higherValue.price.toLocaleString()}. ${lowerCost.name} is Ksh ${lowerCost.price.toLocaleString()} and includes ${lowerCost.images} edited images, so it is a lovely option as well. Will your partner or family be joining you in the shoot?`;
}

export async function getPackageSelectionReply(customerId: string, userMessage: string): Promise<string | null> {
  const text = userMessage.toLowerCase();
  const packages = await prisma.package.findMany({ select: { name: true, deposit: true } });
  const chosen = selectedEdition(userMessage);
  const selectedPackage = (chosen && packages.find((pkg) => pkg.name.toUpperCase() === chosen))
    || packages.find((pkg) => text.includes(pkg.name.replace(/ package$/i, '').toLowerCase()));
  if (!selectedPackage) return null;

  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (draft?.step === 'awaiting_confirmation' && draft.date && draft.time && draft.dateTimeIso) {
    const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => selectedPackage.name.toLowerCase().includes(key));
    const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
    const slotsResult = await bookingService.getAvailableSlots(draft.date, duration);

    if (!Array.isArray(slotsResult)) {
      return `We are closed on ${dayjs(draft.date).format('dddd, MMMM D')}, so that date will not work. What other day would suit you?`;
    }

    if (!slotsResult.includes(draft.time)) {
      const alternatives = slotsResult.slice(0, 3).join(', ');
      return `${selectedPackage.name} needs a different amount of time, and ${draft.time} is not free on ${dayjs(draft.date).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would you prefer?`;
    }

    let deposit: number;
    try {
      deposit = getDepositForPackage(selectedPackage);
    } catch {
      console.warn('Unable to resolve package-selection deposit.');
      return `${selectedPackage.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The studio team will confirm the deposit before payment instructions are shared.`;
    }
    await prisma.bookingDraft.update({
      where: { customerId },
      data: { service: selectedPackage.name, step: 'awaiting_confirmation' },
    });

    return `${selectedPackage.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes to confirm and receive payment instructions.`;
  }

  if (draft?.step && !['collecting_slots', 'service'].includes(draft.step)) return null;

  if (draft && ['collecting_slots', 'service'].includes(draft.step)) {
    await prisma.bookingDraft.updateMany({
      where: { id: draft.id, step: draft.step },
      data: { service: selectedPackage.name, step: 'collecting_slots' },
    });
  } else if (!draft) {
    try {
      await prisma.bookingDraft.create({
        data: { customerId, service: selectedPackage.name, step: 'collecting_slots' },
      });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
    }
  }

  if (!draft?.date) return editionSelectedDateQuestion(selectedPackage.name);
  if (!draft.time) return `You've chosen ${editionInText(selectedPackage.name)}. What time would suit you?`;
  return `Your details for ${editionInText(selectedPackage.name)} are noted. Would you like to go ahead?`;
}

export async function getSameBookingSlotReply(
  customerId: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<string | null> {
  const draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  if (draft?.step !== 'awaiting_confirmation' || !draft.date || !draft.time || !draft.dateTimeIso || !draft.service) {
    return null;
  }

  const packages = await prisma.package.findMany({ select: { name: true } });
  const selectedPackage = history
    .filter((message) => message.role === 'user')
    .reverse()
    .map((message) => packages.find((pkg) => message.content.toLowerCase().includes(pkg.name.replace(/ package$/i, '').toLowerCase())))
    .find((pkg): pkg is { name: string } => Boolean(pkg));
  const packageToUse = selectedPackage || packages.find((pkg) => pkg.name === draft.service);
  if (!packageToUse) return null;

  let deposit: number;
  try {
    deposit = getDepositForPackage(await getPackageForDeposit(packageToUse.name));
  } catch {
    console.warn('Unable to resolve same-slot package deposit.');
    return 'I have the session details, but the studio team will confirm the deposit before I send a payment proposal.';
  }

  const serviceKey = Object.keys(SERVICE_DURATIONS).find((key) => packageToUse.name.toLowerCase().includes(key));
  const duration = serviceKey ? SERVICE_DURATIONS[serviceKey] : DEFAULT_DURATION;
  const slotsResult = await bookingService.getAvailableSlots(draft.date, duration);
  if (!Array.isArray(slotsResult)) {
    return `We are closed on ${dayjs(draft.date).format('dddd, MMMM D')}, so that date will not work. What other day would suit you?`;
  }
  if (!slotsResult.includes(draft.time)) {
    const alternatives = slotsResult.slice(0, 3).join(', ');
    return `${packageToUse.name} is not available at ${draft.time} on ${dayjs(draft.date).format('dddd, MMMM D')}. The available times are ${alternatives || 'fully booked that day'}. Which would you prefer?`;
  }

  await prisma.bookingDraft.update({
    where: { customerId },
    data: { service: packageToUse.name, step: 'awaiting_confirmation' },
  });

  return `${packageToUse.name} works for ${dayjs(draft.date).format('dddd, MMMM D')} at ${dayjs(draft.dateTimeIso).format('h:mm A')}. The deposit is Ksh ${deposit.toLocaleString()}. If you are happy with that, reply yes to confirm and receive payment instructions.`;
}

export const DEFAULT_PACKAGE_PRICES: Record<string, number> = {
  'THE BLOOM': 15000,
  'THE MUSE': 25000,
  'THE ICON': 35000,
  'THE LEGEND': 45000,
  'THE QUEEN': 55000,
  'THE EMPRESS': 70000,
  'THE GODDESS': 120000,
};

export const CANONICAL_PACKAGE_NAMES = [
  'THE BLOOM',
  'THE MUSE',
  'THE ICON',
  'THE LEGEND',
  'THE QUEEN',
  'THE EMPRESS',
  'THE GODDESS',
];

export type ParsedPackageTarget = {
  package: { name: string; price: number; deposit?: number };
  priceText?: string;
} | {
  unknownPrice: number;
  priceText: string;
};

export function parsePackageOrPriceTarget(
  message: string,
  availablePackages: Array<{ name: string; price: number; deposit?: number }> = []
): ParsedPackageTarget | null {
  const text = message.trim().toLowerCase();
  const packages = availablePackages.length ? availablePackages : CANONICAL_PACKAGE_NAMES.map(name => ({
    name,
    price: DEFAULT_PACKAGE_PRICES[name] || 0,
    deposit: 2000,
  }));

  // 1. Shorthand price like 55k, 55 k, 55000, 55,000, 55 thousand, the 55 thousand one, the 55k one
  const kMatch = text.match(/\b(?:the\s+)?(\d{2,3})\s*k(?:\s+(?:one|package|edition))?\b/i);
  const thousandMatch = text.match(/\b(?:the\s+)?(\d{2,3})\s*thousand(?:\s+(?:one|package|edition))?\b/i);
  const commaMatch = text.match(/\b(\d{1,3}),(\d{3})\b/);
  const numberMatch = text.match(/\b(\d{5,6})\b/);

  let amount: number | null = null;
  let priceText: string | undefined = undefined;

  if (kMatch) {
    amount = Number(kMatch[1]) * 1000;
    priceText = `${kMatch[1]}k`;
  } else if (thousandMatch) {
    amount = Number(thousandMatch[1]) * 1000;
    priceText = `${thousandMatch[1]} thousand`;
  } else if (commaMatch) {
    amount = Number(commaMatch[1] + commaMatch[2]);
    priceText = commaMatch[0];
  } else if (numberMatch) {
    amount = Number(numberMatch[1]);
    priceText = numberMatch[1];
  }

  if (amount !== null) {
    const matched = packages.find(pkg => pkg.price === amount);
    if (matched) return { package: matched, priceText };
    return { unknownPrice: amount, priceText: priceText || String(amount) };
  }

  // 2. Edition name: bloom, muse, icon, legend, queen, empress, goddess
  for (const pkg of packages) {
    const keyword = pkg.name.replace(/^THE\s+/i, '').toLowerCase();
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(text)) {
      return { package: pkg };
    }
  }

  return null;
}

export function isPackageChangeRequest(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }> = []): boolean {
  const text = message.trim().toLowerCase();
  if (/\b(?:change|switch|move|upgrade|downgrade)\b.*\b(?:package|edition|booking)\b/i.test(text)) return true;
  if (/\b(?:package|edition|booking)\b.*\b(?:change|switch|move|upgrade|downgrade)\b/i.test(text)) return true;
  if (/\b(?:can\s+(?:i|we)\s+)?(?:change|switch|upgrade|downgrade)\s+to\b/i.test(text)) return true;
  if (/\b(?:i\s+(?:want|would like)\s+to\s+)?(?:change|switch)\s+(?:my\s+)?(?:package|edition)\s+to\b/i.test(text)) return true;

  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  if (lastAssistant.includes(CARRY_OVER_PREFIX)) {
    if (/\b\d{2,3}\s*k\b|\b\d{5,6}\b|\b\d{1,3},\d{3}\b|\b(?:the\s+)?(?:bloom|muse|icon|legend|queen|empress|goddess)\b/i.test(text)) {
      return true;
    }
  }
  return false;
}

export async function getPackageChangeReply(
  customerId: string,
  userMessage: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = []
): Promise<{ reply: string; escalateToTeam?: boolean; escalationReason?: string } | null> {
  let packages: Array<{ name: string; price: number; deposit?: number }> = [];
  try {
    packages = await prisma.package.findMany({ select: { name: true, price: true, deposit: true } });
  } catch {
    // fallback
  }
  if (!packages.length) {
    packages = CANONICAL_PACKAGE_NAMES.map(name => ({
      name,
      price: DEFAULT_PACKAGE_PRICES[name] || 0,
      deposit: 2000,
    }));
  }

  const parsed = parsePackageOrPriceTarget(userMessage, packages);
  if (!parsed) return null;

  if ('unknownPrice' in parsed) {
    return {
      reply: `We don't have an edition at Ksh ${parsed.unknownPrice.toLocaleString()}. Our editions are Bloom (15k), Muse (25k), Icon (35k), Legend (45k), Queen (55k), Empress (70k), and Goddess (120k). You can view details here: ${OFFICIAL_WEBSITE_URLS.packages}`,
    };
  }

  const targetPackage = parsed.package;
  const targetLabel = targetPackage.name.replace(/^THE\s+/i, '').toLowerCase().replace(/\b[a-z]/g, (l) => l.toUpperCase());
  const pricePrefix = parsed.priceText ? `${parsed.priceText} is the ${targetLabel} edition. ` : '';

  let confirmed = null;
  try {
    confirmed = await prisma.booking.findFirst({
      where: { customerId, status: 'confirmed', dateTime: { gte: new Date() } },
    });
  } catch {
    // ignore
  }

  if (confirmed) {
    return {
      reply: `${pricePrefix}Since your booking is already confirmed, changing your package involves adjusting the deposit and price difference. The studio team will confirm that for you. You can also reach them on 0720 111928.`,
      escalateToTeam: true,
      escalationReason: `Customer requested to change confirmed booking package to ${targetPackage.name}: "${userMessage.slice(0, 300)}".`,
    };
  }

  let draft = null;
  try {
    draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  } catch {
    // ignore
  }

  const currentService = draft?.service;
  if (currentService && currentService.toUpperCase() !== targetPackage.name.toUpperCase()) {
    const fromLabel = currentService.replace(/^THE\s+/i, '').toLowerCase().replace(/\b[a-z]/g, (l) => l.toUpperCase());
    return {
      reply: `${pricePrefix}Shall I switch your booking from the ${fromLabel} to the ${targetLabel}?`,
    };
  }

  return {
    reply: `${pricePrefix}Shall I switch your booking to the ${targetLabel}?`,
  };
}

export const PACKAGE_SWITCH_CONFIRMATION_PATTERN = /Shall I (?:switch|set) your booking (?:from (?:the )?([A-Za-z]+) )?to (?:the )?([A-Za-z]+)\?/i;

export function isPackageSwitchQuestion(history: Array<{ role: 'user' | 'assistant'; content: string }>): boolean {
  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  return PACKAGE_SWITCH_CONFIRMATION_PATTERN.test(lastAssistant);
}

export function isPackageSwitchAnswer(
  userMessage: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): boolean {
  if (!isPackageSwitchQuestion(history)) return false;
  const text = userMessage.trim().toLowerCase();
  const isAffirmative = /^(?:yes+|yeah|yep|sure|ok(?:ay)?|please|proceed|confirm|do\s+that|switch|let'?s\s+do\s+that|switch\s+to\s+\w+)[.! ]*$/i.test(text);
  const isDecline = /^(?:no+|nope|keep\s+(?:it|my\s+booking|the\s+\w+)|don'?t\s+switch|cancel)[.! ]*$/i.test(text);
  return isAffirmative || isDecline;
}

export async function getPackageSwitchAnswerReply(
  customerId: string,
  userMessage: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string | null> {
  const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
  const match = lastAssistant.match(PACKAGE_SWITCH_CONFIRMATION_PATTERN);
  if (!match) return null;

  const fromLabel = match[1];
  const targetLabel = match[2];
  const targetPackageName = `THE ${targetLabel.toUpperCase()}`;

  const text = userMessage.trim().toLowerCase();
  const isAffirmative = /^(?:yes+|yeah|yep|sure|ok(?:ay)?|please|proceed|confirm|do\s+that|switch|let'?s\s+do\s+that|switch\s+to\s+\w+)[.! ]*$/i.test(text);

  let draft = null;
  try {
    draft = await prisma.bookingDraft.findUnique({ where: { customerId } });
  } catch {
    // ignore
  }

  if (isAffirmative) {
    if (draft) {
      await prisma.bookingDraft.updateMany({
        where: { id: draft.id },
        data: {
          service: targetPackageName,
          step: draft.date && draft.time ? draft.step : EARLY_SLOT_STEP,
          dateTimeIso: null,
        },
      }).catch(() => null);
    } else {
      await prisma.bookingDraft.create({
        data: {
          customerId,
          service: targetPackageName,
          step: EARLY_SLOT_STEP,
        },
      }).catch(() => null);
    }

    const lead = `I’ve switched your booking to the ${targetLabel} edition.`;
    if (!draft?.date) {
      return `${lead} What date would suit you? You can see everything included here: ${OFFICIAL_WEBSITE_URLS.packages}`;
    }
    if (draft.date && !draft.time) {
      return `${lead} What time on ${formatCustomerDate(draft.date)} would suit you?`;
    }
    if (draft.date && draft.time) {
      return `${lead} Your session is set for ${formatCustomerDate(draft.date)} at ${formatCustomerTime(draft.time)}. Would you like to go ahead?`;
    }
    return `${lead} What date would suit you? You can see everything included here: ${OFFICIAL_WEBSITE_URLS.packages}`;
  }

  if (fromLabel) {
    return `No problem. We'll keep the ${fromLabel} edition. ${draft?.date ? 'Would you like to continue with that date, or choose a different one?' : 'What date would suit you?'}`;
  }
  return `No problem. Which package would you like instead?`;
}
