import {expect, test} from 'bun:test';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {getLanguagePreference, getLinkLanguage, setLanguagePreference, setLinkLanguage, t} from '../web/i18n.ts';
import {jobWindowRefusal} from '../web/job-session.ts';

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

for (const [language, sentence] of [
  ['en', 'This review has been updated since you opened this page. Reload the page, or wait for the operator to reopen the review.'],
  ['ko', '이 페이지를 연 뒤 리뷰가 업데이트됐어요. 페이지를 새로고침하거나 담당자가 리뷰를 다시 열 때까지 기다려 주세요.'],
] as const) {
  test(`#908 ${language} moved-record refusal renders recovery copy from the existing catalog key`, () => {
    const preference = getLanguagePreference(), link = getLinkLanguage();
    try {
      setLinkLanguage(null);
      setLanguagePreference(language);
      expect(t('JOB_RECORD_MOVED', undefined, language)).toBe(sentence);
      expect(jobWindowRefusal(new Error('JOB_RECORD_MOVED'), 'JOB_ACT_INVALID')).toBe(sentence);
    } finally {
      setLinkLanguage(link);
      setLanguagePreference(preference);
    }
  });
}
