import { getLanguage, setLanguagePreference, t } from './i18n.ts';
import { pageInstanceAccess } from './instance-access.ts';
import { mountInterview } from './interview-panel.ts';
import { connectLiveWindow } from './live-connection.ts';
import { bindStageNav } from './stage-nav.ts';

const access = pageInstanceAccess();
const lang = new URL(location.href).searchParams.get('lang');
setLanguagePreference(lang === 'en' || lang === 'ko' ? lang : 'system');
const title = document.querySelector('h1')!;
const languages = document.querySelector('select')!;
function localize() {
  document.title = title.textContent = t('interview.title');
  languages.setAttribute('aria-label', t('interview.language'));
}
languages.value = getLanguage();
languages.onchange = () => {
  setLanguagePreference(languages.value === 'ko' ? 'ko' : 'en');
  localize();
};
localize();
bindStageNav({interviewOnly:true, model:false});
connectLiveWindow(access);
const host = document.querySelector('main')!;
host.textContent = t('interview.loading');
await mountInterview(host, access);
