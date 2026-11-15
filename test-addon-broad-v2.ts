import { knowledgeRetrieval } from './src/services/knowledge/retrieval.service';

const questions = [
  'What optional add-ons and their prices does Fiesta House offer?',
  'What are all the optional extras available for a maternity session?',
  'Could you give me a complete list of add-ons?',
  'Which additional services can I add to my package?'
];

async function main() {
  for (const question of questions) {
    console.log('\n' + '='.repeat(85));
    console.log('QUESTION:', question);

    const results = await knowledgeRetrieval.search(question, 10, 0.22);

    results.forEach((result, i) => {
      const firstLine = result.content.split('\n').slice(0, 2).join(' | ');
      console.log(
        `${i + 1}. Score: ${result.score.toFixed(4)} | ${firstLine}`
      );
    });
  }
}

main().catch(console.error);
