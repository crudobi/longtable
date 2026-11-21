/**
 * Shared HowToStep / HowToSection step extraction (schema.org-flavored
 * instruction lists, as used by the URL importer and the Mealie
 * importer).
 *
 * Accepts the shapes sources actually emit:
 * - a single string (one step, or newline-separated steps);
 * - an array of strings, HowToStep objects (`{text}`), HowToSection
 *   groups (`{name, itemListElement: [...]}`), or nested combinations.
 *
 * A HowToStep with only a `name` and no `text` still contributes its
 * name as a step (M21: it used to be dropped). A HowToSection's name
 * is kept by prefixing the first step of the section with it
 * ("Cooking: Fry…"), so the section structure survives flattening
 * instead of vanishing silently (M15).
 */

/** Extract step strings from a schema.org instruction value. */
export function stepsFromInstructions(instructions: unknown): string[] {
  if (typeof instructions === 'string') {
    return instructions
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (!Array.isArray(instructions)) return []
  const out: string[] = []
  const walk = (item: unknown): void => {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim())
      return
    }
    if (typeof item !== 'object' || item === null) return
    const o = item as Record<string, unknown>
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    const hasChildren = Array.isArray(o.itemListElement)
    let pushedOwnStep = false
    if (text) {
      out.push(text)
      pushedOwnStep = true
    } else if (name && !hasChildren) {
      // Name-only HowToStep (a leaf): the name IS the step text. A
      // named item WITH children is a section, not a step — its name
      // prefixes the first child step below instead.
      out.push(name)
      pushedOwnStep = true
    }
    if (Array.isArray(o.itemListElement)) {
      // A section (or a step with sub-steps): walk the children, and
      // when this item is a named section (no step text of its own),
      // prefix its first child step with the section name.
      const before = out.length
      o.itemListElement.forEach(walk)
      if (!pushedOwnStep && name && out.length > before) {
        out[before] = `${name}: ${out[before]}`
      }
    }
  }
  instructions.forEach(walk)
  return out
}
