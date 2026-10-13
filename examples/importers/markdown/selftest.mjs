import importer from './markdown-recipe.mjs';

let failures = 0;
function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + label);
  if (!cond) failures++;
}

// (a) Sample format from the task
const sample = [
  '# Recipe Title',
  '',
  'Prep: 15 min',
  'Cook: 30 min',
  '',
  '## Ingredients',
  '- 200 g flour',
  '- 2 eggs',
  '',
  '## Steps',
  '1. Mix everything.',
  '2. Bake for 30 minutes.',
  '',
].join('\n');

const result = await importer.import({ kind: 'text', text: sample });
console.log(JSON.stringify(result, null, 2));
check('sample: returns an array with one recipe', Array.isArray(result) && result.length === 1);
const r = result[0] || {};
check('sample: title', r.title === 'Recipe Title');
check('sample: prepMinutes 15', r.prepMinutes === 15);
check('sample: cookMinutes 30', r.cookMinutes === 30);
check('sample: ingredients', JSON.stringify(r.ingredients) === JSON.stringify(['200 g flour', '2 eggs']));
check('sample: steps', JSON.stringify(r.steps) === JSON.stringify(['Mix everything.', 'Bake for 30 minutes.']));
check('metadata: apiVersion 1', importer.apiVersion === 1);
check('metadata: kebab-case id', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(importer.id));
check('metadata: accepts file/text', importer.accepts.includes('file') && importer.accepts.includes('text'));

// (b1) Edge case: missing title -> plain-language thrown error
const noTitle = ['## Ingredients', '- 200 g flour', '', '## Steps', '1. Mix.'].join('\n');
try {
  await importer.import({ kind: 'text', text: noTitle });
  check('missing title: throws', false);
} catch (e) {
  console.log('missing title error: ' + e.message);
  check('missing title: throws plain-language error mentioning title', e instanceof Error && /title/i.test(e.message));
}

// (b2) Edge case: Method-section variant + Prep time:/Cook time: + bullet steps + * bullets
const variant = [
  '# Pancakes  ',
  '',
  'Prep time: 10',
  'Cook time: 20 min',
  '',
  '## Ingredients',
  '* 100 g flour',
  '* 1 egg',
  '',
  '## Method',
  '- Whisk everything.',
  '- Fry on both sides.',
  '',
  '## Notes',
  '- This section should be ignored.',
].join('\n');
const v = await importer.import({ kind: 'file', fileName: 'pancakes.md', text: variant });
console.log(JSON.stringify(v, null, 2));
check('method variant: title trimmed', v[0].title === 'Pancakes');
check('method variant: prep/cook from "time:" plain numbers', v[0].prepMinutes === 10 && v[0].cookMinutes === 20);
check('method variant: * bullets are ingredients', JSON.stringify(v[0].ingredients) === JSON.stringify(['100 g flour', '1 egg']));
check('method variant: bullet steps under ## Method, Notes ignored', JSON.stringify(v[0].steps) === JSON.stringify(['Whisk everything.', 'Fry on both sides.']));

// (b3) Extra edge case: empty input
try {
  await importer.import({ kind: 'text', text: '   \n  ' });
  check('empty input: throws', false);
} catch (e) {
  console.log('empty input error: ' + e.message);
  check('empty input: throws plain-language error', e instanceof Error && e.message.length > 0);
}

// (b4) Extra edge case: no ingredients section
try {
  await importer.import({ kind: 'text', text: '# Soup\n\n## Steps\n1. Boil.\n' });
  check('no ingredients section: throws', false);
} catch (e) {
  console.log('no ingredients error: ' + e.message);
  check('no ingredients section: throws mentioning Ingredients', /[Ii]ngredients/.test(e.message));
}

console.log(failures === 0 ? 'ALL TESTS PASS' : failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
