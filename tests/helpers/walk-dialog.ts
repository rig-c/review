import type { CdpPageEvent } from '../parts-explorer-browser.ts';
import type { walkCheckpoint } from './walk-deadline.ts';

const departureStep = 'en-stage3.navigate';

export function walkDialogs(checkpoint: ReturnType<typeof walkCheckpoint>, initialStep: string) {
  let step = initialStep;
  let opened = false;
  let usedDeparture = false;
  let departure: {source: URL; acceptance?: Promise<void>} | undefined;
  let firstError: Error | undefined;

  function assertClear() {
    if (firstError) throw firstError;
  }

  return {
    enter(key: string) {
      assertClear();
      step = key;
      checkpoint(key);
    },
    assertClear,
    get error() { return firstError; },
    get open() { return opened; },
    get step() { return step; },
    async departFailedSubmit(source: string, navigate: () => Promise<void>) {
      assertClear();
      if (step !== departureStep || usedDeparture) throw new Error('DIALOG_DEPARTURE_SCOPE: ' + step);
      usedDeparture = true;
      const permit: NonNullable<typeof departure> = {source:new URL(source)};
      departure = permit;
      try {
        await navigate();
        await permit.acceptance;
        assertClear();
        checkpoint(permit.acceptance ? 'dialog.finding.observed' : 'dialog.finding.none', {step});
      } finally {
        departure = undefined;
      }
    },
    onEvent(event: CdpPageEvent, send: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
      if (event.method === 'Page.javascriptDialogClosed') {
        opened = false;
        return;
      }
      if (event.method !== 'Page.javascriptDialogOpening') return;
      opened = true;
      const rawType = event.params?.type;
      const type = rawType === 'beforeunload' || rawType === 'alert' || rawType === 'confirm' || rawType === 'prompt'
        ? rawType : 'unknown';
      const rawUrl = event.params?.url;
      let url: URL | undefined;
      try { if (typeof rawUrl === 'string') url = new URL(rawUrl); } catch {}
      const detail = {step, pathname:url?.pathname ?? null};
      checkpoint('dialog.' + type, detail);
      assertClear();
      if (type !== 'beforeunload' || !departure || departure.acceptance ||
        url?.origin !== departure.source.origin || url.pathname !== departure.source.pathname) {
        firstError = new Error(`UNEXPECTED_DIALOG:${type} at ${step}`);
        throw firstError;
      }
      const acceptance = send('Page.handleJavaScriptDialog', {accept:true}).then(() => {
        assertClear();
        checkpoint('dialog.accepted', detail);
      }).catch(error => {
        firstError ??= error instanceof Error ? error : new Error(String(error));
        throw firstError;
      });
      departure.acceptance = acceptance;
      return acceptance;
    },
  };
}
