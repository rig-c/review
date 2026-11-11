/** Entry of the standalone `rig-review interview` root: web/index.html with the interview modal over the shell (#708). */
import { mountWorkspaceShell } from './workspace-ui.ts';
import { getLanguage, setLinkLanguage, setLanguagePreference, t } from './i18n.ts';
import { pageInstanceAccess } from './instance-access.ts';
import { interviewModal, mountInterview } from './interview-panel.ts';
import { connectLiveWindow } from './live-connection.ts';
import { bindStageNav } from './stage-nav.ts';

const access = pageInstanceAccess();
const lang = new URL(location.href).searchParams.get('lang');
setLanguagePreference(lang === 'en' || lang === 'ko' ? lang : 'system');
const app = document.getElementById('app')!;
app.classList.add('interview-app');
const shell = mountWorkspaceShell({compatibility: 'legacyInterviewStep4'});
app.append(shell.header);
const title = shell.title;
const languages = shell.language!;
bindStageNav({interviewOnly:true, model:false});
const trigger = shell.stages!.querySelector<HTMLButtonElement>('[data-review-stage="2"]')!;
let mounted = false;
const modal = interviewModal({parent:document.body, trigger, id:'review-interview-modal', onOpen:() => {
  if (mounted) return;
  mounted = true;
  modal.body.textContent = t('interview.loading');
  void mountInterview(modal.body, access);
}});
function localize() {
  document.title = title.textContent = t('interview.title');
  languages.setAttribute('aria-label', t('interview.language'));
  modal.localize();
}
languages.value = getLanguage();
languages.onchange = () => {
  setLinkLanguage(null);
  setLanguagePreference(languages.value === 'ko' ? 'ko' : 'en');
  localize();
};
localize();
connectLiveWindow(access);
modal.open();
