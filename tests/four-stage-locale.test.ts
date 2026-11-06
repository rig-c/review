import { expect, test } from 'bun:test';
import { t } from '../web/i18n.ts';
import { idleAmpSelector } from './helpers/walk-locale.ts';

type Field = { container: string; tag: string; type: string; 'aria-label': string };

// Fake page for the scoped tag-and-attribute selectors used by the Idle editor.
function idlePage(fields: readonly Field[]) {
  return {
    querySelectorAll(selector: string) {
      const match = /^#([\w-]+) (\w+)\[type=(\w+)\]\[aria-label=("[^"]+")\]$/.exec(selector);
      if (!match) throw new Error('Unsupported fixture selector: ' + selector);
      const [, container, tag, type, quotedLabel] = match;
      return fields.filter(field => field.container === container && field.tag === tag &&
        field.type === type && field['aria-label'] === JSON.parse(quotedLabel!));
    },
  };
}

for (const lang of ['en', 'ko'] as const) {
  test(`four-stage ${lang} amp selector resolves exactly one input`, () => {
    // Render the fixture from the shipped catalog template, independent of the runner's tr path.
    const amp: Field = {container:'idle-track-editor', tag:'input', type:'number',
      'aria-label':t('{0} value', ['amp'], lang)};
    const page = idlePage([
      amp,
      {...amp, type:'range', 'aria-label':'amp'},
      {...amp, 'aria-label':t('{0} value', ['phase'], lang)},
      {...amp, container:'other-editor'},
    ]);
    expect(page.querySelectorAll(idleAmpSelector(lang))).toEqual([amp]);
    if (lang === 'ko') expect(page.querySelectorAll(idleAmpSelector('en'))).toHaveLength(0);
  });
}
