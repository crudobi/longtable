// Longtable Markdown recipe importer — Importer API v1
// Written from docs/importers.md alone (clean-room).
// Self-contained: no imports, per the drop-in plugin contract.
//
// Format:
//   # Recipe Title
//
//   Prep: 15 min
//   Cook: 30 min
//
//   ## Ingredients
//   - 200 g flour
//   - 2 eggs
//
//   ## Steps
//   1. Mix everything.
//   2. Bake for 30 minutes.

function parseMinutes(raw) {
  var value = String(raw).trim().toLowerCase();
  if (!value) return undefined;
  // Hours + minutes, e.g. "1 h 30 min" / "1 hour 30 minutes"
  var hours = value.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  var minutes = value.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
  if (hours || minutes) {
    var total = 0;
    if (hours) total += parseFloat(hours[1]) * 60;
    if (minutes) total += parseFloat(minutes[1]);
    return Math.round(total);
  }
  // Plain number (optionally followed by other text): "15" / "15 min"
  var plain = value.match(/(\d+(?:\.\d+)?)/);
  if (!plain) return undefined;
  return Math.round(parseFloat(plain[1]));
}

function normalizeHeading(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

var STEP_HEADINGS = ['steps', 'method', 'instructions', 'directions'];

function importMarkdown(input) {
  if (!input || typeof input.text !== 'string' || input.text.trim() === '') {
    throw new Error('This Markdown recipe is empty — paste some recipe text or choose a Markdown file that contains a recipe.');
  }
  if (input.kind === 'url') {
    throw new Error('This importer reads Markdown text — it cannot import from a web address. Paste the Markdown text or choose the file instead.');
  }

  var lines = input.text.replace(/\r\n?/g, '\n').split('\n');

  var title = null;
  var prepMinutes;
  var cookMinutes;
  var ingredients = [];
  var steps = [];
  var sawIngredientsSection = false;
  // currentSection: 'ingredients' | 'steps' | 'other' | null (before any section)
  var currentSection = null;

  for (var i = 0; i < lines.length; i++) {
    var rawLine = lines[i];
    var line = rawLine.trim();

    // Section headings: ## ...
    var sectionMatch = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (sectionMatch) {
      var heading = normalizeHeading(sectionMatch[1]);
      if (heading === 'ingredients') {
        currentSection = 'ingredients';
        sawIngredientsSection = true;
      } else if (STEP_HEADINGS.indexOf(heading) !== -1) {
        currentSection = 'steps';
      } else {
        currentSection = 'other';
      }
      continue;
    }

    // Any other markdown heading (# is handled below; ###+ ends a section context conservatively as other)
    if (/^#{3,}\s+/.test(line)) {
      currentSection = 'other';
      continue;
    }

    // Title: single '# ' heading
    var titleMatch = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (titleMatch) {
      if (title === null) {
        title = titleMatch[1].trim();
      }
      continue;
    }

    // Prep / Cook lines: only before the sections, per the format description
    if (currentSection === null) {
      var timeMatch = line.match(/^(prep|cook)(?:\s+time)?\s*:\s*(.+?)\s*$/i);
      if (timeMatch) {
        var parsed = parseMinutes(timeMatch[2]);
        if (parsed !== undefined) {
          if (timeMatch[1].toLowerCase() === 'prep') prepMinutes = parsed;
          else cookMinutes = parsed;
        }
        continue;
      }
    }

    if (currentSection === 'ingredients') {
      var bullet = line.match(/^[-*]\s+(.+?)\s*$/);
      if (bullet) {
        var ingredient = bullet[1].trim();
        if (ingredient) ingredients.push(ingredient);
      }
      continue;
    }

    if (currentSection === 'steps') {
      var numbered = line.match(/^\d+[.)]\s+(.+?)\s*$/);
      if (numbered) {
        var stepText = numbered[1].trim();
        if (stepText) steps.push(stepText);
        continue;
      }
      var stepBullet = line.match(/^[-*]\s+(.+?)\s*$/);
      if (stepBullet) {
        var bulletStep = stepBullet[1].trim();
        if (bulletStep) steps.push(bulletStep);
      }
      continue;
    }

    // Other sections and stray lines are ignored.
  }

  if (title === null || title === '') {
    throw new Error("This doesn't look like a Markdown recipe — it has no title. Add a line starting with '# ' followed by the recipe name at the top.");
  }
  if (!sawIngredientsSection) {
    throw new Error("This Markdown recipe has no Ingredients section. Add a '## Ingredients' heading with a list of ingredients under it.");
  }
  if (ingredients.length === 0) {
    throw new Error("This Markdown recipe's Ingredients section is empty. List at least one ingredient as a '- ' line under '## Ingredients'.");
  }

  var recipe = {
    title: title,
    ingredients: ingredients,
    steps: steps,
  };
  if (prepMinutes !== undefined) recipe.prepMinutes = prepMinutes;
  if (cookMinutes !== undefined) recipe.cookMinutes = cookMinutes;
  return [recipe];
}

var importer = {
  apiVersion: 1,
  id: 'markdown-recipe',
  name: 'Markdown recipe',
  description: 'A recipe written as a Markdown file.',
  accepts: ['file', 'text'],
  fileExtensions: ['.md', '.markdown', '.txt'],
  import: importMarkdown,
};

export { importer };
export default importer;
