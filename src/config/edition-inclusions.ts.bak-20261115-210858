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
  'THE BLOOM': {
    duration: '1.5 hours', images: 6, makeup: true, outfits: 2, styling: true,
    photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false,
    inclusions: ['Session length: 1.5 hours', '6 final edited photos', 'Professional makeup', '2 studio outfits with styling'],
  },
  'THE MUSE': {
    duration: '2 hours', images: 12, makeup: true, outfits: 3, styling: true,
    photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false,
    inclusions: ['Session length: 2 hours', '12 final edited photos', 'Professional makeup', '3 studio outfits with styling'],
  },
  'THE ICON': {
    duration: '2.5 hours', images: 15, makeup: true, outfits: 4, styling: true,
    photobook: false, photobookSize: null, mount: true, balloonBackdrop: false, wig: false,
    inclusions: ['Session length: 2.5 hours', '15 final edited photos', 'Professional makeup', '4 studio outfits with styling', '1 A3 fine art mount'],
  },
  'THE LEGEND': {
    duration: '2.5 hours', images: 15, makeup: true, outfits: 4, styling: true,
    photobook: true, photobookSize: '8x8"', mount: false, balloonBackdrop: false, wig: true,
    inclusions: ['Session length: 2.5 hours', '15 final edited photos', 'Professional makeup', '4 studio outfits with styling', '1 styled wig', 'Hardcover photobook (8x8")'],
  },
  'THE QUEEN': {
    duration: '3 hours', images: 20, makeup: true, outfits: 4, styling: true,
    photobook: false, photobookSize: null, mount: true, balloonBackdrop: true, wig: true,
    inclusions: ['Session length: 3 hours', '20 final edited photos', 'Professional makeup', '4 studio outfits with styling', '1 styled wig', 'Custom balloon backdrop with flowers', '1 A3 fine art mount'],
  },
  'THE GODDESS': {
    duration: '5 hours', images: 30, makeup: true, outfits: 5, styling: true,
    photobook: true, photobookSize: '8x8"', mount: true, balloonBackdrop: true, wig: true,
    inclusions: ['Session length: 5 hours', '30 final edited photos', 'Professional makeup', '5 studio outfits with styling, including the Power Suit', '2 styled wigs', 'Custom balloon backdrop or Goddess Sculpture Set', '1 professionally produced Reel', 'Hardcover photobook (8x8")', '1 A2 fine art mount'],
  },
};

export function differingInclusionFields(name: string, row: Record<string, unknown>): string[] {
  const reference = SEED_EDITION_INCLUSIONS[name];
  if (!reference) return [];
  return Object.entries(reference)
    .filter(([field, value]) => field !== 'inclusions' && row[field] !== value)
    .map(([field]) => field);
}