import assert from 'node:assert/strict';
import type {CdpSession} from '../parts-explorer-browser.ts';
import {enCatalog} from '../../web/catalog-en.ts';
import {koCatalog} from '../../web/catalog-ko.ts';

type RecordActStatus = {
  statusText: string;
  statusKey: string | null;
  rowVisible: boolean;
  statusInRow: boolean;
  headline: string | null;
  visibleStates: string[];
  visibleControls: string[];
  recordPanelVisible: boolean;
};

/** Read the shared workspace after the last active record ask is accepted. */
export async function expectRecordActSubmitted(
  page: Pick<CdpSession, 'evaluate'>,
  wait: (expression: string, label: string) => Promise<void>,
  language: 'en' | 'ko',
  label: string,
): Promise<{statusText: string; statusKey: string | null}> {
  const catalog = language === 'en' ? enCatalog : koCatalog;
  const submitted = catalog['Submitted'];
  await wait(`(() => {
    const status = document.querySelector('#workspace-act-row #review-draft-state');
    return status?.textContent === ${JSON.stringify(submitted)} && status.dataset.saveState === 'saved' &&
      !document.querySelector('#job-record-asks:not([hidden])');
  })()`, label);
  const readback = await page.evaluate<RecordActStatus>(`(() => {
    const visible = node => !!node && !node.closest('[hidden]') && node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility === 'visible';
    const row = document.getElementById('workspace-act-row');
    const status = document.getElementById('review-draft-state');
    const headline = document.getElementById('workspace-ask-headline');
    const shown = ids => ids.filter(id => visible(document.getElementById(id)));
    return {
      statusText: status.textContent, statusKey: status.dataset.saveState ?? null,
      rowVisible: visible(row), statusInRow: row.contains(status),
      headline: visible(headline) ? headline.textContent : null,
      visibleStates: shown(['review-draft-state', 'dirty', 'draft-state']),
      visibleControls: shown(['save', 'request-changes', 'workspace-pending-ask', 'workspace-pending-record-ask']),
      recordPanelVisible: visible(document.getElementById('job-record-asks')),
    };
  })()`);
  assert.deepEqual(readback, {
    statusText: submitted, statusKey: 'saved', rowVisible: true, statusInRow: true,
    headline: catalog['Nothing is waiting for your answer.'], visibleStates: ['review-draft-state'],
    visibleControls: [], recordPanelVisible: false,
  }, label);
  return {statusText: readback.statusText, statusKey: readback.statusKey};
}
