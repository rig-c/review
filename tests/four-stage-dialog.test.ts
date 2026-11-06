import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpRequests } from './parts-explorer-browser.ts';
import { walkCheckpoint } from './helpers/walk-deadline.ts';
import { walkDialogs } from './helpers/walk-dialog.ts';

const source = 'http://127.0.0.1:4318/instances/failed/?lang=en#cap=opaque';
const step = 'en-stage3.navigate';

function fakeCdp(initialStep = step) {
  const root = mkdtempSync(join(tmpdir(), 'walk-dialog-'));
  const journal = join(root, 'journal.jsonl');
  const dialogs = walkDialogs(walkCheckpoint(journal), initialStep);
  const sent: {id:number;method:string;params:Record<string, unknown>;sessionId?:string}[] = [];
  const requests = cdpRequests(message => sent.push(JSON.parse(message)), 500, dialogs.onEvent);
  return {
    dialogs, sent, requests,
    open(type: string, url = source) {
      requests.receive({method:'Page.javascriptDialogOpening', sessionId:'page',
        params:{type, url, message:'private dialog message'}});
    },
    navigate() {
      return requests.send('Page.navigate', {}, 'page').then(() => {});
    },
    read() { return readFileSync(journal, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)); },
    close() { rmSync(root, {recursive:true,force:true}); },
  };
}

test('the one failed Submit departure accepts a matching beforeunload and journals only pathname', async () => {
  const cdp = fakeCdp();
  try {
    const move = cdp.dialogs.departFailedSubmit(source, cdp.navigate);
    cdp.open('beforeunload');
    expect(cdp.dialogs.open).toBe(true);
    expect(cdp.read().map(({key,step,pathname}) => ({key,step,pathname}))).toEqual([
      {key:'dialog.beforeunload',step,pathname:'/instances/failed/'},
    ]);
    expect(cdp.sent[1]).toMatchObject({method:'Page.handleJavaScriptDialog', params:{accept:true},sessionId:'page'});
    cdp.requests.receive({id:cdp.sent[1]!.id,result:{}});
    cdp.requests.receive({method:'Page.javascriptDialogClosed',sessionId:'page'});
    cdp.requests.receive({id:cdp.sent[0]!.id,result:{}});
    await move;
    const rows = cdp.read();
    expect(rows.map(row => row.key)).toEqual(['dialog.beforeunload','dialog.accepted','dialog.finding.observed']);
    expect(rows.map(row => row.seq)).toEqual([1,2,3]);
    expect(rows[1].monotonicms).toBeGreaterThanOrEqual(rows[0].monotonicms);
    expect(JSON.stringify(rows)).not.toMatch(/private dialog message|opaque|\?lang|127\.0\.0\.1/);
    expect(cdp.dialogs.open).toBe(false);
  } finally { cdp.close(); }
});

test('the departure can complete with no dialog observed', async () => {
  const cdp = fakeCdp();
  try {
    const move = cdp.dialogs.departFailedSubmit(source, cdp.navigate);
    cdp.requests.receive({id:cdp.sent[0]!.id,result:{}});
    await move;
    expect(cdp.sent).toHaveLength(1);
    expect(cdp.read().map(row => row.key)).toEqual(['dialog.finding.none']);
  } finally { cdp.close(); }
});

test('unexpected dialog stops the in-flight command and every later send by the same first error', async () => {
  for (const variant of ['wrong-step','wrong-type','wrong-source','duplicate'] as const) {
    const current = variant === 'wrong-step' ? 'en-stage1.navigate' : step;
    const cdp = fakeCdp(current);
    try {
      const move = variant === 'wrong-step' ? cdp.navigate() : cdp.dialogs.departFailedSubmit(source, cdp.navigate);
      if (variant === 'duplicate') cdp.open('beforeunload');
      const type = variant === 'wrong-type' ? 'confirm' : 'beforeunload';
      cdp.open(type, variant === 'wrong-source' ? source.replace('/failed/','/different/') : source);
      const first = cdp.dialogs.error;
      expect(first?.message).toBe(`UNEXPECTED_DIALOG:${type} at ${current}`);
      await expect(move).rejects.toBe(first);
      expect(() => cdp.dialogs.enter('later')).toThrow(first!.message);
      await expect(cdp.requests.send('Runtime.evaluate')).rejects.toBe(first);
      expect(cdp.sent.map(row => row.method)).toEqual(variant === 'duplicate'
        ? ['Page.navigate','Page.handleJavaScriptDialog'] : ['Page.navigate']);
      expect(cdp.read().map(row => row.key)).toEqual(variant === 'duplicate'
        ? ['dialog.beforeunload','dialog.beforeunload'] : ['dialog.' + type]);
    } finally { cdp.close(); }
  }
});

test('a rejected dialog acceptance stops navigation with the acceptance error', async () => {
  const cdp = fakeCdp();
  try {
    const move = cdp.dialogs.departFailedSubmit(source, cdp.navigate);
    cdp.open('beforeunload');
    cdp.requests.receive({id:cdp.sent[1]!.id,error:{message:'refused'}});
    await expect(move).rejects.toThrow('Page.handleJavaScriptDialog: refused');
    expect(cdp.read().map(row => row.key)).toEqual(['dialog.beforeunload']);
  } finally { cdp.close(); }
});
