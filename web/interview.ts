import { getLanguage, setLinkLanguage, setLanguagePreference, t } from './i18n.ts';
import { pageInstanceAccess } from './instance-access.ts';
import { mountInterview } from './interview-panel.ts';
import { connectLiveWindow } from './live-connection.ts';
import { bindStageNav } from './stage-nav.ts';

const access = pageInstanceAccess();
const url = new URL(location.href);
const embedded = url.pathname.endsWith('/stage-interview.html');
const lang = url.searchParams.get('lang');
setLanguagePreference(lang === 'en' || lang === 'ko' ? lang : 'system');
const title = document.querySelector('h1')!;
const languages = document.querySelector('select')!;
function localize() {
  document.title = title.textContent = t('interview.title');
  languages.setAttribute('aria-label', t('interview.language'));
}
languages.value = getLanguage();
languages.onchange = () => {
  setLinkLanguage(null);
  setLanguagePreference(languages.value === 'ko' ? 'ko' : 'en');
  localize();
};
localize();
if (embedded) {
  languages.hidden = true;
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'review-stage-language' ||
        (event.data.language !== 'en' && event.data.language !== 'ko')) return;
    setLinkLanguage(null);
    setLanguagePreference(event.data.language);
    localize();
  });
} else {
  bindStageNav({interviewOnly:true, model:false});
  connectLiveWindow(access);
}
const host = document.querySelector('main')!;
host.textContent = t('interview.loading');
await mountInterview(host, access);
