import prisma from '../src/config/prisma';

const packages = [
  { name: 'THE AURA', type: 'studio', price: 10000, deposit: 2000, duration: '1 hour', images: 5, makeup: true, outfits: 1, styling: true, photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false, notes: 'For the mother taking her first step into the house. A gentle introduction to Fiesta House. 1 hour studio time, 5 final edited photos, professional makeup, 1 studio outfit + styling.' },
  { name: 'THE BLOOM', type: 'studio', price: 15000, deposit: 2000, duration: '1.5 hours', images: 10, makeup: true, outfits: 2, styling: true, photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false, notes: 'For the mother in her becoming. An intimate introduction to Fiesta House. 1.5 hours studio time, 10 final edited photos, professional makeup, 2 studio outfits + styling.' },
  { name: 'THE MUSE', type: 'studio', price: 25000, deposit: 2000, duration: '2 hours', images: 15, makeup: true, outfits: 3, styling: true, photobook: false, photobookSize: null, mount: false, balloonBackdrop: false, wig: false, notes: 'For the mother stepping into her glow. 2 hours studio time, 15 final edited photos, professional makeup, 3 studio outfits + styling.' },
  { name: 'THE ICON', type: 'studio', price: 35000, deposit: 2000, duration: '2.5 hours', images: 20, makeup: true, outfits: 4, styling: true, photobook: false, photobookSize: null, mount: true, balloonBackdrop: false, wig: false, notes: 'For the mother who knows she is unforgettable. 2.5 hours studio time, 20 final edited photos, professional makeup, 4 studio outfits + styling, 1 A3 fine art mount.' },
  { name: 'THE LEGEND', type: 'studio', price: 45000, deposit: 2000, duration: '2.5 hours', images: 25, makeup: true, outfits: 4, styling: true, photobook: true, photobookSize: '8x8"', mount: false, balloonBackdrop: false, wig: false, notes: 'For the mother writing her own story. 2.5 hours studio time, 25 final edited photos, professional makeup, 4 studio outfits + styling, 8x8 hardcover photobook.' },
  { name: 'THE QUEEN', type: 'studio', price: 55000, deposit: 2000, duration: '3 hours', images: 30, makeup: true, outfits: 4, styling: true, photobook: false, photobookSize: null, mount: true, balloonBackdrop: true, wig: true, notes: 'For the mother of her own kingdom. 3 hours studio time, 30 final edited photos, professional makeup, 4 studio outfits + styling, custom balloon backdrop with flowers, 1 styled wig, 1 A3 fine art mount.' },
  { name: 'THE EMPRESS', type: 'studio', price: 70000, deposit: 2000, duration: '3.5 hours', images: 35, makeup: true, outfits: 4, styling: true, photobook: true, photobookSize: '8x8"', mount: true, balloonBackdrop: true, wig: true, notes: 'For the mother claiming her throne. Signature Edition (Most Loved). 3.5 hours studio time, 35 final edited photos, professional makeup, 4 studio outfits + styling, signature Fiesta House Power Suit, 2 styled wigs, custom balloon backdrop with flowers, 8x8 hardcover photobook, 1 A3 fine art mount.' },
  { name: 'THE GODDESS', type: 'studio', price: 120000, deposit: 2000, duration: '5 hours', images: 40, makeup: true, outfits: 5, styling: true, photobook: true, photobookSize: '8x8"', mount: true, balloonBackdrop: true, wig: true, notes: 'For the mother who is the moment. Flagship Edition. 5 hours studio time, 40 final edited photos, professional makeup, 5 studio outfits + styling including the signature Fiesta House Power Suit, 2 styled wigs, custom balloon backdrop with flowers OR Goddess Sculpture Set (one option), 1 professionally produced Reel, 8x8 hardcover photobook, 1 A2 fine art mount.' },
];

async function main() {
  for (const pkg of packages) {
    await prisma.package.upsert({
      where: { name: pkg.name },
      update: pkg,
      create: pkg,
    });
    console.log(`Seeded: ${pkg.name}`);
  }
  console.log(`Done. ${packages.length} packages seeded.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
