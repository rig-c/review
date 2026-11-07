import {WORKSPACE_TARGET_LIMIT, WORKSPACE_READY_SCHEMA, WORKSPACE_SCHEMA, WORKSPACE_TARGET_DOMAIN, WORKSPACE_VISIBILITY_SCHEMA,
  type WorkspaceList, type WorkspaceTargetView} from '../src/open-workspace-contract.ts';
import {getLanguage, onLanguageChange, setLanguagePreference, setLinkLanguage, tr} from './i18n.ts';
import {connectLiveWindow} from './live-connection.ts';

const root = document.getElementById('owner-workspace')!;
const header = document.createElement('header'); header.className = 'owner-header';
const heading = document.createElement('h1');
const status = document.createElement('p'); status.className = 'owner-status'; status.setAttribute('role', 'status');
const language = document.createElement('select');
for (const value of ['en', 'ko'] as const) {
  const option = document.createElement('option'); option.value = value; language.append(option);
}
header.append(heading, status, language);
const list = document.createElement('nav'); list.className = 'owner-list';
const stage = document.createElement('main'); stage.className = 'owner-stage';
root.append(header, list, stage);
let current: WorkspaceList | null = null, selected: string | null = null, disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const cancellation = new AbortController();
const frames = new Map<string, {frame: HTMLIFrameElement; target: WorkspaceTargetView}>();
const locationURL = new URL(location.href);
let capability = locationURL.hash.startsWith('#cap=') ? locationURL.hash.slice(5) : '';
const storageKey = 'rig-review-owner-workspace/1:' + location.origin;
if (!/^[a-f0-9]{64}$/.test(capability)) capability = '';
try {
  if (capability) sessionStorage.setItem(storageKey, capability);
  else capability = sessionStorage.getItem(storageKey) ?? '';
} catch {}
locationURL.hash = '';
history.replaceState(history.state, '', locationURL);

function text() {
  document.documentElement.lang = getLanguage();
  heading.textContent = tr('Review workspace'); document.title = tr('Review workspace');
  list.setAttribute('aria-label', tr('Review targets'));
  language.setAttribute('aria-label', tr('Language'));
  language.options[0]!.textContent = tr('English'); language.options[1]!.textContent = tr('Korean');
  language.value = getLanguage();
}

function visibility(entry: {frame: HTMLIFrameElement; target: WorkspaceTargetView}) {
  entry.frame.contentWindow?.postMessage({schema: WORKSPACE_VISIBILITY_SCHEMA,
    incarnation: current?.incarnation, key: entry.target.key, sourceHash: entry.target.contentHash,
    visible: selected === entry.target.key, language: getLanguage()}, location.origin);
}

async function grant(key: string) {
  const encoder = new TextEncoder();
  const secret = await crypto.subtle.importKey('raw', encoder.encode(capability), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', secret, encoder.encode(WORKSPACE_TARGET_DOMAIN + '\0' + current!.incarnation + '\0' + key));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

let selecting = 0;
async function select(target: WorkspaceTargetView) {
  const intent = ++selecting;
  if (target.unavailable) {status.textContent = tr(target.unavailable); return;}
  let entry = frames.get(target.key);
  if (!entry) {
    if (frames.size >= WORKSPACE_TARGET_LIMIT) {status.textContent = tr('WORKSPACE_TARGET_LIMIT'); return;}
    const token = await grant(target.key);
    if (disposed || intent !== selecting) return;
    const frame = document.createElement('iframe');
    frame.title = target.title; frame.hidden = true;
    frame.src = target.entry + '&lang=' + getLanguage() + '#cap=' + token;
    entry = {frame, target}; frames.set(target.key, entry); stage.append(frame);
  }
  selected = target.key;
  for (const mounted of frames.values()) {
    visibility(mounted);
    mounted.frame.hidden = mounted.target.key !== selected;
    mounted.frame.inert = mounted.frame.hidden;
    mounted.frame.setAttribute('aria-hidden', String(mounted.frame.hidden));
  }
  render();
}

function render() {
  text(); list.replaceChildren();
  for (const target of current?.targets ?? []) {
    const button = document.createElement('button'); button.type = 'button';
    button.dataset.targetKey = target.key; button.setAttribute('aria-pressed', String(target.key === selected));
    const title = document.createElement('span'); title.className = 'owner-target-title'; title.textContent = target.title;
    const state = document.createElement('span'); state.className = 'owner-target-status';
    state.textContent = tr(target.unavailable ?? (target.viewOnly ? 'Inspection only' : 'Review target'));
    const animation = document.createElement('span'); animation.className = 'owner-target-animation'; animation.textContent = target.animation;
    button.append(title, state, animation); button.onclick = () => {void select(target).catch(() => {status.textContent = tr('WORKSPACE_REQUEST_REFUSED');});};
    list.append(button);
  }
}

async function refresh() {
  try {
    if (!capability) {status.textContent = tr('WORKSPACE_CAPABILITY_REQUIRED'); return;}
    const response = await fetch('/workspace/api/targets', {
      headers: {'X-Review-Capability': capability}, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
    });
    const value = await response.json() as WorkspaceList & {error?: string};
    if (!response.ok) {status.textContent = tr(value.error ?? 'WORKSPACE_REQUEST_REFUSED'); return;}
    if (value.schema !== WORKSPACE_SCHEMA || !Array.isArray(value.targets) || value.targets.length > WORKSPACE_TARGET_LIMIT ||
        current && current.incarnation !== value.incarnation) {status.textContent = tr('WORKSPACE_HOST_MISMATCH'); return;}
    const changed = JSON.stringify(value) !== JSON.stringify(current);
    if (!current) status.textContent = tr('Select a target. Drafts stay with their original source.');
    current = value;
    if (changed) render();
    if (!selected && value.targets[0]) await select(value.targets[0]);
  } catch {if (!disposed) status.textContent = tr('WORKSPACE_REQUEST_REFUSED');}
  finally {if (!disposed) timer = setTimeout(() => {void refresh();}, 1000);}
}

window.addEventListener('message', event => {
  if (event.origin !== location.origin || !current || !event.data || typeof event.data !== 'object') return;
  const value = event.data;
  if (value.schema !== WORKSPACE_READY_SCHEMA || value.incarnation !== current.incarnation) return;
  const entry = frames.get(value.key);
  if (entry && entry.frame.contentWindow === event.source && entry.target.contentHash === value.sourceHash) visibility(entry);
});
language.onchange = () => {setLinkLanguage(null); setLanguagePreference(language.value === 'ko' ? 'ko' : 'en');};
onLanguageChange(() => {render(); for (const entry of frames.values()) visibility(entry);});
const disconnect = connectLiveWindow({route: () => '/workspace/live'});
window.addEventListener('pagehide', () => {disposed = true; clearTimeout(timer); cancellation.abort(); disconnect();}, {once: true});
text();
void refresh();
