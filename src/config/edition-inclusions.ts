type EditionInclusionReference = {
  duration: string;
  images: number;
  makeup: boolean;
  outfits: number;
  styling: boolean;
  photobook: boolean;
  photobookSize: string | null;
  mount: boolean;
  balloonBackdrop: boolean;
  wig: boolean;
  inclusions: readonly string[];
};

export const SEED_EDITION_INCLUSIONS: Record<string, EditionInclusionReference> = {
  'THE AURA': {
    duration: '1 hour', images: 5, makeup: true, outfits: 1, styling: true,
    photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false,
    inclusions: ['Session length: 1 hour', '5 final edited photos', 'Professional makeup', '1 studio outfit with styling'],
  },
  'THE BLOOM': {
    duration: '1.5 hours', images: 10, makeup: true, outfits: 2, styling: true,
    photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false,
    inclusions: ['Session length: 1.5 hours', '10 final edited photos', 'Professional makeup', '2 studio outfits with styling'],
  },
  'THE MUSE': {
    duration: '2 hours', images: 15, makeup: true, outfits: 3, styling: true,
    photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false,
    inclusions: ['Session length: 2 hours', '15 final edited photos', 'Professional makeup', '3 studio outfits with styling'],
  },
  'THE ICON': {
    duration: '2.5 hours', images: 20, makeup: true, outfits: 4, styling: true,
    photobook: false, photobookSize: null, mount: true, balloonBackdrop: false, wig: false,
    inclusions: ['Session length: 2.5 hours', '20 final edited photos', 'Professional makeup', '4 studio outfits with styling', '1 A3 fine art mount'],
  },
  'THE LEGEND': {
    duration: '2.5 hours', images: 25, makeup: true, outfits: 4, styling: true,
    photobook: true, photobookSize: '8x8"', mount: false, balloonBackdrop: false, wig: false,
    inclusions: ['Session length: 2.5 hours', '25 final edited photos', 'Professional makeup', '4 studio outfits with styling', 'Hardcover photobook (8x8")'],
  },
  'THE QUEEN': {
    duration: '3 hours', images: 30, makeup: true, outfits: 4, styling: true,
    photobook: false, photobookSize: null, mount: true, balloonBackdrop: true, wig: true,
    inclusions: ['Session length: 3 hours', '30 final edited photos', 'Professional makeup', '4 studio outfits with styling', '1 styled wig', 'Custom balloon backdrop with flowers', '1 A3 fine art mount'],
  },
  'THE EMPRESS': {
    duration: '3.5 hours', images: 35, makeup: true, outfits: 4, styling: true,
    photobook: true, photobookSize: '8x8"', mount: true, balloonBackdrop: true, wig: true,
    inclusions: ['Session length: 3.5 hours', '35 final edited photos', 'Professional makeup', '4 studio outfits with styling', 'Fiesta House Power Suit', '2 styled wigs', 'Custom balloon backdrop with flowers', 'Hardcover photobook (8x8")', '1 A3 fine art mount'],
  },
  'THE GODDESS': {
    duration: '5 hours', images: 40, makeup: true, outfits: 5, styling: true,
    photobook: true, photobookSize: '8x8"', mount: true, balloonBackdrop: true, wig: true,
    inclusions: ['Session length: 5 hours', '40 final edited photos', 'Professional makeup', '5 studio outfits with styling, including the Power Suit', '2 styled wigs', 'Custom balloon backdrop with flowers OR Goddess Sculpture Set (one option)', '1 professionally produced Reel', 'Hardcover photobook (8x8")', '1 A2 fine art mount'],
  },
};

export function differingInclusionFields(name: string, row: Record<string, unknown>): string[] {
  const reference = SEED_EDITION_INCLUSIONS[name];
  if (!reference) return [];
  return Object.entries(reference)
    .filter(([field, value]) => field !== 'inclusions' && row[field] !== value)
    .map(([field]) => field);
}