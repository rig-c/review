import {expect, test} from 'bun:test';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {t} from '../web/i18n.ts';

test('#815 removes the unavailable-panel template with no runtime producer in either language', () => {
  for (const catalog of [enCatalog, koCatalog]) {
    expect(Object.hasOwn(catalog, 'JOB_PANEL_UNAVAILABLE')).toBe(false);
  }
});

for (const [language, sentence] of [
  ['en', 'This page has lost its access. Ask the agent to open the job again.'],
  ['ko', '이 페이지의 접근 권한이 만료됐어요. 에이전트에게 작업을 다시 열어 달라고 요청해 주세요.'],
] as const) {
  test(`#815 ${language} missing-access refusal tells the reviewer how to reopen the job`, () => {
    expect(t('JOB_CAPABILITY_REQUIRED', undefined, language)).toBe(sentence);
  });
}
