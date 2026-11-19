import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visionService, OutfitAnalysisResult } from './vision.service';
import { STUDIO_WARDROBE_CATALOG, getStudioCatalogPromptSummary } from './studio-wardrobe.catalog';
import prisma from '../../config/prisma';

test('VisionService creates polite, rule-compliant fallback when vision is invoked without media buffer', async () => {
  const reply = await visionService.handleIncomingImage({
    platform: 'whatsapp',
    customerId: 'test-user-vision-1',
    caption: 'Can I wear this for my session?'
  });

  assert.ok(reply);
  // Must NOT give the old rejection:
  assert.doesNotMatch(reply, /I can only read text messages right now/i);
  // Must mention studio wardrobe and saving styling note:
  assert.match(reply, /studio wardrobe/i);
  assert.match(reply, /300 luxury maternity gowns/i);
  // Must acknowledge they can bring their own outfit:
  assert.match(reply, /bring your own outfit/i);
});

test('VisionService prompt includes studio wardrobe catalog from the atelier website', () => {
  const prompt = (visionService as any).buildPrompt('I had an inspo i wanted to show you');
  // Must contain signature studio items from fiestahousematernity.com/maternity-gowns:
  assert.match(prompt, /Champagne Gold Goddess Draped Look & Handcrafted Crown/i);
  assert.match(prompt, /Fiesta House Signature Power Suit/i);
  assert.match(prompt, /White Couture Gown with Statement Chest Bow & Opera Gloves/i);
  assert.match(prompt, /Royal Blue Tiered Ruffle & Butterfly Wing Gown/i);
  assert.match(prompt, /Scarlet Red High-Slit Gown/i);

  // Must check studio catalog first:
  assert.match(prompt, /CHECK AGAINST OUR STUDIO CATALOG FIRST/i);
});

test('VisionService correctly sanitizes in-closet vs external outfit analysis results', () => {
  // Case A: In-closet studio match (like Maryanne's Champagne Gold Goddess gown)
  const studioMatchAI = {
    outfitDescription: 'Champagne gold goddess draped gown with metallic sunburst headpiece',
    category: 'gown',
    primaryColor: 'Champagne gold',
    styleDetails: 'Sheer beaded draped fabric with sunburst crown',
    isInStudioWardrobeStyle: true,
    isStudioPiece: true,
    matchedStudioItemName: 'Champagne Gold Goddess Draped Look & Handcrafted Crown',
    customerIntent: 'inspiration',
    customerReply: 'Yes! That is our signature Champagne Gold Goddess Draped Look with our handcrafted crown! ✨ It is one of our most loved studio atelier looks and is available right in our studio wardrobe for your session.',
    photographerNotes: 'Client selected signature Champagne Gold Goddess studio look.'
  };

  const sanitizedStudio = (visionService as any).sanitizeAnalysisResult(studioMatchAI);
  assert.equal(sanitizedStudio.isStudioPiece, true);
  assert.equal(sanitizedStudio.matchedStudioItemName, 'Champagne Gold Goddess Draped Look & Handcrafted Crown');
  assert.match(sanitizedStudio.customerReply, /Champagne Gold Goddess/i);

  // Case B: External reference not in closet
  const externalAI = {
    outfitDescription: 'Floral print casual maternity wrap dress',
    category: 'dress',
    primaryColor: 'Multi-color',
    styleDetails: 'Short casual summer floral wrap dress',
    isInStudioWardrobeStyle: false,
    isStudioPiece: false,
    matchedStudioItemName: null,
    customerIntent: 'bringing_own',
    customerReply: 'What a lovely floral dress! ✨ While this exact piece is an external design, you are warmly welcome to bring it to your shoot as your personal outfit.',
    photographerNotes: 'Client bringing personal casual floral dress.'
  };

  const sanitizedExternal = (visionService as any).sanitizeAnalysisResult(externalAI);
  assert.equal(sanitizedExternal.isStudioPiece, false);
  assert.equal(sanitizedExternal.matchedStudioItemName, null);
  assert.match(sanitizedExternal.customerReply, /external design/i);
});
