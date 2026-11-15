import { knowledgeRetrieval } from './src/services/knowledge/retrieval.service';

const questions = [
  'What extra services can I add to my maternity photoshoot?',
  'Can you list all your add-ons and prices?',
  'Can I bring my own wig for styling?',
  'Do you hire out wigs?',
  'Is the Power Suit included in The Empress?',
  'Does The Goddess include the sculpture set?',
  'Is a professional Reel included in The Goddess?',
  'How much are extra edited pictures?',
  'Can I get the original unedited photos?',
  'How much does an extra outfit cost?'
];

async function main() {
  for (const question of questions) {
    console.log('\n' + '='.repeat(85));
    console.log('QUESTION:', question);

    const results = await knowledgeRetrieval.search(question, 5, 0.22);

    for (const [i, result] of results.entries()) {
      console.log(`\n${i + 1}. Score: ${result.score}`);
      console.log(result.content);
    }
  }
}

main().catch(console.error);
