/** Stable request JSON, preserving JSON.stringify's ordering of integer-like keys.
 * The closed mesh edit grammar has no integer-like object keys.
 */
export function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, sorted(child)]));
    }
    return item;
  };
  return JSON.stringify(sorted(value));
}
