
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

function stableFaqId(question: string, chunk: string): string {
  const hash = createHash('sha256')
    .update(`${question}\n${chunk}`)
    .digest('hex')
    .slice(0, 24);

  return `faq_${hash}`;
}


function createCompactAddonOverview(answer: string): string {
  const lines = answer.split(/\r?\n/);
  const sections: string[] = [];
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (
      /^(IMAGE AND DELIVERY|STYLING AND WARDROBE|CREATIVE EXPERIENCES)$/i.test(
        trimmed
      )
    ) {
      currentSection = trimmed;
      sections.push(`\n${currentSection}`);
      continue;
    }

    if (!trimmed.startsWith('- ')) continue;

    const item = trimmed.slice(2).trim();
    const sentences = item.match(/[^.!?]+[.!?]+/g) || [item];
    let summary = sentences[0].trim();

    if (/Power Suit/i.test(summary)) {
      summary += ' Included in The Empress and The Goddess.';
    }

    if (/Goddess Sculpture Set/i.test(summary)) {
      summary += ' The Goddess includes a choice between this set and the custom balloon backdrop with flowers.';
    }

    if (/Professional Reel/i.test(summary)) {
      summary += ' The Goddess includes one professionally produced Reel.';
    }

    sections.push(`- ${summary}`);
  }

  return `Optional Fiesta House Maternity add-ons and their prices:\n${sections.join('\n')}`;
}


function createAddonCategoryChunks(answer: string): {
  heading: string;
  content: string;
}[] {
  const headings = [
    'IMAGE AND DELIVERY',
    'STYLING AND WARDROBE',
    'CREATIVE EXPERIENCES'
  ];

  const sections: { heading: string; content: string }[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  const saveSection = () => {
    if (currentHeading && currentLines.length) {
      sections.push({
        heading: currentHeading,
        content: currentLines.join('\n').trim()
      });
    }
  };

  for (const line of answer.split(/\r?\n/)) {
    const trimmed = line.trim();

    const matchedHeading = headings.find(
      heading => heading.toLowerCase() === trimmed.toLowerCase()
    );

    if (matchedHeading) {
      saveSection();
      currentHeading = matchedHeading;
      currentLines = [];
      continue;
    }

    if (currentHeading && trimmed) {
      currentLines.push(trimmed);
    }
  }

  saveSection();

  return sections;
}

export async function loadFaqChunks(
  embedder: any,
  chunkText: (text: string) => string[],
  _startChunkId: number = 10000
) {
  const faqPath = path.resolve(
    __dirname,
    '../../../knowledge_base_rows.json'
  );

  if (!fs.existsSync(faqPath)) {
    console.log('No FAQ JSON found, skipping FAQ ingestion.');
    return [];
  }

  const faqData = JSON.parse(fs.readFileSync(faqPath, 'utf-8'));
  const faqChunks: {
    id: string;
    content: string;
    embedding: number[];
    source: string;
  }[] = [];

  for (const row of faqData) {
    const q = row.question?.trim();
    const a = row.answer?.trim();

    if (!q || !a) continue;

    let chunks: { question: string; content: string }[] = [];

   if (row.id === 'additions_all') {
  // A concise semantic description keeps the complete add-on catalogue
  // prominent in the embedding instead of consuming tokens with variants.
  chunks = [{
    question: 'Complete catalogue of optional Fiesta House Maternity add-ons, extra services, package upgrades and prices.',
    content: createCompactAddonOverview(a)
  }];
} else if (row.id === 'addon_details') {
      // Keep each add-on category intact and independently retrievable.
      const sections = createAddonCategoryChunks(a);

      chunks = sections.map(section => ({
        question: `${q} ${section.heading.toLowerCase()} section`,
        content: `${section.heading}\n${section.content}`
      }));
    } else {
      // Preserve the existing behavior for every other FAQ.
      chunks = chunkText(a).map(content => ({
        question: q,
        content
      }));
    }

    for (const item of chunks) {
      if (!item.content.trim()) continue;

      const content = `${item.question}\n${item.content}`;

      const output = await embedder(content, {
        pooling: 'mean',
        normalize: true
      });

      const vector = Array.from(output.data) as number[];

      faqChunks.push({
        id: stableFaqId(item.question, item.content),
        content,
        embedding: vector,
        source: 'faq'
      });
    }
  }

  return faqChunks;
}
