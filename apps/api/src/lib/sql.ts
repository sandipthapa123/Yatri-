/**
 * Turns an exported constant list (e.g. ACTIVE_TRIP_STATUSES) into a SQL `IN` list, so the
 * statuses are defined once (in @yatri/types / the machine) and SQL derives from them.
 * Only ever call this with code constants — never user input; values are validated anyway.
 */
export function sqlIn(values: readonly string[]): string {
  for (const v of values) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(v)) throw new Error(`sqlIn: unsafe value ${v}`);
  }
  return `(${values.map((v) => `'${v}'`).join(', ')})`;
}
