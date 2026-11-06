/**
 * Turns a pattern built for PostgREST's `ilike` (see `ilikePattern`) into its T-SQL LIKE. `%` and
 * `_` mean the same in both. PostgREST also reads `*` as `%`, and T-SQL reads `[` as the start of a
 * character class, which Postgres treats as a literal.
 *
 * `containsPattern` is for raw text; here the wildcards are already in the pattern and would come
 * out literal.
 */
export function ilikeToLike(pattern: string) {
  return pattern.replace(/\*/g, "%").replace(/\[/g, "[[]");
}
