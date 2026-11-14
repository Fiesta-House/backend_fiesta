export const SERVICE_DURATIONS: Record<string, number> = {
  'bloom': 90,
  'the bloom': 90,
  'muse': 120,
  'the muse': 120,
  'icon': 150,
  'the icon': 150,
  'legend': 150,
  'the legend': 150,
  'queen': 180,
  'the queen': 180,
  'empress': 210,
  'the empress': 210,
  'goddess': 300,
  'the goddess': 300,
};

export const DEFAULT_DURATION = 120;
export const MINIMUM_BOOKING_DEPOSIT = 2000;
export const BOOKING_SLOT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Current Editions 2026 + legacy names for extraction / matching */
export const PACKAGE_NAME_PATTERN =
  'bloom|muse|icon|legend|queen|empress|goddess|standard|economy|executive|gold|platinum|vip|vvip';

export const PACKAGE_NAMES_FOR_EXTRACTION = [
  'THE BLOOM', 'THE MUSE', 'THE ICON', 'THE LEGEND',
  'THE QUEEN', 'THE EMPRESS', 'THE GODDESS',
] as const;

export const EDITIONS_PENDING_OWNER_CONFIRMATION: readonly string[] = ['THE EMPRESS'];

/** Priced optional add-ons (settle with balance — not included in deposit) */
export interface AddonCatalogItem {
  sku: string;
  name: string;
  unitPrice: number; // KSH; 0 = quoted / variable
  match: RegExp;
  quantityFromNote?: boolean;
  group: 'Image & delivery' | 'Styling & wardrobe' | 'Creative production';
  description: string;
  bookInAdvance?: boolean;
  /** Editions that already include this item, so it must not be charged as an add-on. */
  includedIn?: readonly string[];
  /** Availability or production details the team confirms before it is promised. */
  teamConfirms?: boolean;
}

export const ADDON_CATALOG: AddonCatalogItem[] = [
  {
    sku: 'extra_edited_photo',
    name: 'Extra edited photo',
    unitPrice: 1000,
    match: /extra\s+edited\s+photo|extra\s+photo(?!\s*book)/i,
    quantityFromNote: true,
    group: 'Image & delivery',
    description: 'An additional individually edited photo beyond the number included in your edition. It is not the same as a Digital Art Edit.',
  },
  {
    sku: 'extra_digital_art',
    name: 'Extra digital art edit',
    unitPrice: 3000,
    match: /digital\s+art|extra\s+art\s+edit/i,
    quantityFromNote: true,
    group: 'Image & delivery',
    description: 'A more creative, artistically produced image that goes beyond the standard editing included with your edition.',
  },
  {
    sku: 'extra_outfit',
    name: 'Extra outfit beyond package',
    unitPrice: 4000,
    match: /extra\s+(?:personal\s+)?outfit/i,
    quantityFromNote: true,
    group: 'Styling & wardrobe',
    description: 'An additional outfit or look for the shoot, beyond the number of outfits included in your edition.',
  },
  {
    sku: 'extra_makeup',
    name: 'Extra professional makeup',
    unitPrice: 3500,
    match: /extra\s+(professional\s+)?make[-\s]?up/i,
    group: 'Styling & wardrobe',
    description: 'An additional professional makeup service beyond the makeup already included in your edition.',
  },
  {
    sku: 'power_suit',
    name: 'Fiesta House Power Suit',
    unitPrice: 10000,
    match: /power\s+suit/i,
    group: 'Styling & wardrobe',
    description: 'A bold, sophisticated maternity look with tailored, structured styling, confident posing and a modern editorial feel, a powerful alternative to the traditional flowing gown.',
    includedIn: ['THE EMPRESS', 'THE GODDESS'],
  },
  {
    sku: 'wig_hire',
    name: 'Styled wig hire',
    unitPrice: 4000,
    match: /wig\s+hire|styled\s+wig|hire\s+(a\s+)?wig/i,
    quantityFromNote: true,
    group: 'Styling & wardrobe',
    description: 'Hire of a wig styled by the studio. A specific wig is only promised once the team confirms it is available.',
    bookInAdvance: true,
  },
  {
    sku: 'wig_styling',
    name: 'Wig styling only',
    unitPrice: 3000,
    match: /wig\s+styling/i,
    quantityFromNote: true,
    group: 'Styling & wardrobe',
    description: 'Professional styling of a wig you already own. This is separate from wig hire.',
    bookInAdvance: true,
  },
  {
    sku: 'suspending_concept',
    name: 'Suspending Concept',
    unitPrice: 7000,
    match: /suspending\s+concept|suspenind\s+concep(?:t)?/i,
    group: 'Creative production',
    description: 'A specialised creative maternity photography concept, produced as a creative set rather than a wardrobe change.',
    teamConfirms: true,
  },
  {
    sku: 'sculpture_set',
    name: 'Goddess Sculpture Set',
    unitPrice: 15000,
    match: /sculpture\s+set|goddess\s+sculpture/i,
    group: 'Creative production',
    description: 'A premium styled, artistic set designed around a goddess, sculptural aesthetic.',
    includedIn: ['THE GODDESS'],
    teamConfirms: true,
  },
  {
    sku: 'professional_reel',
    name: 'Professional Reel',
    unitPrice: 0,
    match: /professional\s+reel|\breel\b/i,
    group: 'Creative production',
    description: 'A professionally produced Reel from your session.',
    bookInAdvance: true,
    includedIn: ['THE GODDESS'],
  },
  {
    sku: 'raw_files',
    name: 'Raw files',
    unitPrice: 0,
    match: /raw\s+files?/i,
    group: 'Image & delivery',
    description: 'The unprocessed image files from your session.',
  },
];
