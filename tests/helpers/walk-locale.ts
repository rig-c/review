import { tr, type ResolvedLanguage } from '../../web/i18n.ts';

export function idleAmpSelector(lang: ResolvedLanguage): string {
  // idle-panel emits `${labelText} value`; the DOM i18n pass translates that attribute with tr.
  const label = tr('amp value', lang);
  return `#idle-track-editor input[type=number][aria-label=${JSON.stringify(label)}]`;
}
