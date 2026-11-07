import {WORKSPACE_READY_SCHEMA, WORKSPACE_VISIBILITY_SCHEMA} from '../src/open-workspace-contract.ts';
import {setLanguagePreference, setLinkLanguage} from './i18n.ts';

/** Same-origin shipped frames still validate the exact parent and displayed source. */
export function bindWorkspaceVisibility(binding: {key: string; sourceHash: string; pause(): void}) {
  const incarnation = new URL(location.href).searchParams.get('workspace');
  if (parent === window || !incarnation) return;
  const receive = (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== parent || !event.data || typeof event.data !== 'object') return;
    const value = event.data;
    if (value.schema !== WORKSPACE_VISIBILITY_SCHEMA || value.incarnation !== incarnation ||
        value.key !== binding.key || value.sourceHash !== binding.sourceHash || typeof value.visible !== 'boolean') return;
    if (!value.visible) binding.pause();
    if (value.language === 'en' || value.language === 'ko') {
      setLinkLanguage(null); setLanguagePreference(value.language);
    }
  };
  window.addEventListener('message', receive);
  window.addEventListener('pagehide', () => window.removeEventListener('message', receive), {once: true});
  parent.postMessage({schema: WORKSPACE_READY_SCHEMA, incarnation, key: binding.key, sourceHash: binding.sourceHash}, location.origin);
}
