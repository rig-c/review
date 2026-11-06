import type { CdpSession } from '../parts-explorer-browser.ts';
import type { walkCheckpoint } from './walk-deadline.ts';

export async function freshWalkReopen(
  page: Pick<CdpSession, 'goto' | 'evaluate'>, url: string, locale: 'en' | 'ko', step: string, seq: number,
  enter: (key: string) => void, checkpoint: ReturnType<typeof walkCheckpoint>,
): Promise<void> {
  const sentinel = JSON.stringify(locale + '-' + seq);
  enter(step + '.sentinel');
  if (await page.evaluate(`(()=>{window.__walkDoc=${sentinel};return window.__walkDoc===${sentinel};})()`) !== true) {
    throw new Error('REOPEN_SENTINEL_NOT_SET: ' + step);
  }
  async function hop(name: string, destination: string, language?: 'en' | 'ko') {
    const key = step + '.' + name;
    enter(key);
    await page.goto(destination, language, result => {
      const loaderId = typeof result.loaderId === 'string' && result.loaderId ? result.loaderId : null;
      checkpoint('reopen.loader', {step:key,loaderId});
      if (!loaderId) throw new Error('REOPEN_SAME_DOCUMENT: ' + key);
    });
  }
  await hop('blank', 'about:blank');
  await hop('handoff', url, locale);
  enter(step + '.document');
  if (await page.evaluate('!Object.hasOwn(window,"__walkDoc")') !== true) {
    throw new Error('REOPEN_SENTINEL_PERSISTED: ' + step);
  }
  checkpoint('reopen.fresh', {step});
}
