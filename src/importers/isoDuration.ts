/**
 * ISO-8601 duration → minutes (shared by the Mealie and URL importers).
 *
 * Accepts "PT1H30M", "PT45M", "PT90S", "P1DT2H", "P1W", "P2M" (months,
 * 30 days each), "P1Y" (365 days), and bare numbers (already minutes).
 * Weeks and months used to be rejected outright (M21: the old regex
 * only knew days/hours/minutes/seconds, so "P1W" parsed to nothing).
 * A zero or unparseable value yields undefined — never 0 minutes for a
 * duration the source did not actually state.
 */

/** Parse an ISO-8601 duration ("PT1H30M", "P1W", "PT45M") to minutes. */
export function isoDurationToMinutes(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value)
  }
  if (typeof value !== 'string') return undefined
  const m =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value.trim(),
    )
  if (!m) return undefined
  const years = Number(m[1] ?? 0)
  const months = Number(m[2] ?? 0)
  const weeks = Number(m[3] ?? 0)
  const days = Number(m[4] ?? 0)
  const hours = Number(m[5] ?? 0)
  const minutes = Number(m[6] ?? 0)
  const seconds = Number(m[7] ?? 0)
  const total =
    years * 525600 + months * 43200 + weeks * 10080 + days * 1440 + hours * 60 + minutes + seconds / 60
  return total > 0 ? Math.round(total) : undefined
}
