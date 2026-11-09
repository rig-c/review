import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { running } from '../../src/open.ts';
import { cdpRequests, type CdpPageEvent } from '../parts-explorer-browser.ts';
import { withDeadline } from './walk-deadline.ts';

export function chromeRootEndpoint(text: string): string {
  const [port, path, ...extra] = text.trim().split(/\r?\n/);
  if (!port || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 ||
      !path || !/^\/devtools\/browser\/[a-f0-9-]{36}$/i.test(path) || extra.length) {
    throw new Error('TEST_CHROME_ROOT_ENDPOINT: invalid owned DevToolsActivePort');
  }
  return `ws://127.0.0.1:${port}${path}`;
}

export async function openChromeRoot(profileDir: string) {
  const endpoint = chromeRootEndpoint(await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8'));
  const socket = new WebSocket(endpoint);
  const requests = cdpRequests(message => socket.send(message), 5_000);
  let closed = false;
  socket.onmessage = event => requests.receive(JSON.parse(String(event.data)));
  socket.onclose = () => {
    closed = true;
    requests.disconnect('Chrome root socket closed');
  };
  try {
    await withDeadline('CHROME_ROOT_CONNECT', 5_000, () => new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('TEST_CHROME_ROOT_CONNECT: browser root unavailable'));
    }));
    const info: { processInfo?: { type: string; id: number }[] } = await requests.send('SystemInfo.getProcessInfo');
    const processes = info.processInfo?.filter(entry => Number.isSafeInteger(entry.id) && entry.id > 0) ?? [];
    const browser = processes.find(entry => entry.type === 'browser');
    if (!browser || processes.length > 64 || process.platform !== 'linux') {
      throw new Error('TEST_CHROME_ROOT_IDENTITY: expected bounded Linux Chrome process identities');
    }
    const argv = (await readFile(`/proc/${browser.id}/cmdline`, 'utf8')).split('\0');
    if (!argv.includes(`--user-data-dir=${profileDir}`)) {
      throw new Error('TEST_CHROME_ROOT_IDENTITY: browser process does not own the test profile');
    }
    return {
      processes,
      async close() {
        await requests.send('Browser.close');
        await withDeadline('CHROME_NORMAL_EXIT', 10_000, async signal => {
          while (!signal.aborted && (!closed || running(browser.id))) await Bun.sleep(25);
        });
        return { browserPid: browser.id, commandAcknowledged: true, socketClosed: closed, processExited: !running(browser.id) };
      },
      disconnect() { socket.close(); },
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}

export function observeLiveSockets(openUrl: string) {
  const live = new URL('api/live', openUrl);
  live.protocol = 'ws:';
  const events: { method: string; requestId: string; timestamp?: number }[] = [];
  const ids = new Set<string>();
  let overflow = false;
  return {
    onEvent(event: CdpPageEvent) {
      const requestId = event.params?.requestId;
      if (typeof requestId !== 'string') return;
      if (event.method === 'Network.webSocketCreated') {
        if (event.params?.url !== live.href) return;
        if (ids.size === 64) { overflow = true; return; }
        ids.add(requestId);
      }
      if (!ids.has(requestId) || ![
        'Network.webSocketCreated', 'Network.webSocketHandshakeResponseReceived', 'Network.webSocketClosed',
      ].includes(event.method)) return;
      if (events.length === 192) { overflow = true; return; }
      const timestamp = event.params?.timestamp;
      events.push({ method: event.method, requestId, ...(typeof timestamp === 'number' ? { timestamp } : {}) });
    },
    snapshot: () => ({ events: [...events], overflow }),
  };
}

/** Linux-only readout. Each row must belong to a known PID and touch a test loopback port. */
export async function ownedTcpSockets(pids: readonly number[], ports: readonly number[]) {
  return await Promise.all([...new Set(pids)].map(async pid => {
    const root = `/proc/${pid}`;
    try {
      const names = await readdir(join(root, 'fd'));
      if (names.length > 512) return { pid, error: 'descriptor limit' };
      const links = await Promise.all(names.map(name => readlink(join(root, 'fd', name)).catch(() => '')));
      const inodes = new Set(links.flatMap(link => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? []));
      const tables = await Promise.all(['tcp', 'tcp6'].map(name => readFile(join(root, 'net', name), 'utf8')));
      const rows = tables.flatMap(table => table.split('\n').slice(1).flatMap(line => {
        const fields = line.trim().split(/\s+/);
        const [local, remote, state, inode] = [fields[1], fields[2], fields[3], fields[9]];
        if (!local || !remote || !inode || !inodes.has(inode)) return [];
        if (![local, remote].some(endpoint => ports.includes(parseInt(endpoint.split(':').at(-1) ?? '', 16)))) return [];
        return [{ local, remote, state, inode }];
      }));
      return { pid, rows };
    } catch (error) {
      return { pid, error: (error as NodeJS.ErrnoException).code ?? String(error) };
    }
  }));
}
