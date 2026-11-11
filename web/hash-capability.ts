/** Move a handoff hash into its host's session slot, preserving its stored-value policy. */
export function hashCapabilityAccess(url: URL, slotName: string,
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | null,
  replace: (href: string) => void, storedValue: 'validate' | 'preserve'): string {
  let capability = url.hash.startsWith('#cap=') ? url.hash.slice(5) : '';
  if (!/^[a-f0-9]{64}$/.test(capability)) capability = '';
  try {
    if (capability) storage()?.setItem(slotName, capability);
    else capability = storage()?.getItem(slotName) ?? '';
  } catch { /* Memory-only owner access. */ }
  if (storedValue === 'validate' && !/^[a-f0-9]{64}$/.test(capability)) capability = '';
  url.hash = ''; replace(url.href);
  return capability;
}
