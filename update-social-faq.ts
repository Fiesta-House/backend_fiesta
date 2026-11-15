import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from '@xenova/transformers';
import { chunkText } from './src/utils/chunking';
import { pineconeService } from './src/services/knowledge/pinecone.service';

async function main() {
  const faqPath = path.resolve('knowledge_base_rows.json');
  const embeddingsPath = path.resolve('docs/business_knowledge_embeddings.json');
  const oldId = 'faq_c6544124d8f84153c115aa4b';
  const targetId = 'cmo8l30ga001810wy49hmx7tc';

  const faqRows = JSON.parse(fs.readFileSync(faqPath, 'utf8'));
  const matches = faqRows.filter((row: any) => row.id === targetId);

  if (matches.length !== 1) {
    throw new Error(`Expected one FAQ record, found ${matches.length}`);
  }

  const row = matches[0];
  const chunks = chunkText(row.answer.trim());

  if (!chunks.length || chunks.some(chunk => !chunk.trim())) {
    throw new Error('FAQ produced invalid chunks.');
  }

  const embeddings = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8'));
  const oldVectors = embeddings.filter((item: any) => item.id === oldId);

  if (oldVectors.length !== 1) {
    throw new Error(`Expected one old local vector, found ${oldVectors.length}`);
  }

  const newVectors: any[] = [];
  const embedder = await pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2'
  );

  for (const chunk of chunks) {
    const id = 'faq_' + createHash('sha256')
      .update(`${row.question.trim()}\n${chunk}`)
      .digest('hex')
      .slice(0, 24);

    const content = `${row.question.trim()}\n${chunk}`;

    const output = await embedder(content, {
      pooling: 'mean',
      normalize: true
    });

    newVectors.push({
      id,
      content,
      embedding: Array.from(output.data) as number[],
      source: 'faq'
    });
  }

  if (newVectors.some(v => v.id === oldId)) {
    throw new Error('Unexpected ID collision with old vector.');
  }

  if (newVectors.some(v => v.embedding.length !== oldVectors[0].embedding.length)) {
    throw new Error('Embedding dimensions do not match the existing vector.');
  }

  const backupPath = `${embeddingsPath}.${Date.now()}.bak`;
  fs.copyFileSync(embeddingsPath, backupPath);
  console.log(`Local backup created: ${backupPath}`);

  // Upsert the replacement before deleting the old vector.
  await pineconeService.upsertVectors(
    newVectors.map(v => ({
      id: v.id,
      values: v.embedding,
      metadata: {
        content: v.content,
        source: v.source
      }
    }))
  );

  console.log('New social-media FAQ vector upserted.');

  // Delete only the previous social-media FAQ vector.
  await pineconeService.deleteIds([oldId]);
  console.log('Old social-media FAQ vector deleted.');

  // Preserve every other local embedding.
  const updatedEmbeddings = embeddings.filter(
    (item: any) => item.id !== oldId
  );

  updatedEmbeddings.push(...newVectors);

  const tempPath = `${embeddingsPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(updatedEmbeddings, null, 2));
  fs.renameSync(tempPath, embeddingsPath);

  console.log('Local embeddings backup updated.');
  console.log(`Old vector: ${oldId}`);
  console.log('New vector IDs:', newVectors.map(v => v.id));
  console.log(`Total local vectors: ${updatedEmbeddings.length}`);
  console.log('Targeted FAQ update completed.');
}

main().catch(error => {
  console.error('Targeted FAQ update failed:', error);
  process.exit(1);
});
