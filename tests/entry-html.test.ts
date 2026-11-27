import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { buildWeb, entryHtml } from '../src/build.ts';
import { loadReview } from '../src/manifest.ts';
import { startOpenWorkspace } from '../src/open-workspace.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { loadPartsView } from '../src/parts-view.ts';
import { startServer } from '../src/server.ts';
import { scriptedJobWindowFixture } from './helpers/job-window-fixture.ts';
import { writePartsPackage } from './helpers/parts-package.ts';
import { useTemporaryReviewState } from './helpers/temporary-review-state.ts';

useTemporaryReviewState();

/** Pinned from origin/main e4168864 before #655 slice 1 edits; WORKSPACE_HTML_SHA256 updated in slice 2 for data-review-screen="workspace". */
const UNMARKED_HTML_SHA256 = 'f015d5f6c5aa6a79c53374c343a4d6b2cca0401d82418f080fe816a925303f55';
const PARTS_HTML_SHA256 = 'de4aff1ab2d730f9c01014150928aa59614953da79c83d94284faed7ff9679a7';
const WORKSPACE_HTML_SHA256 = 'fb6ba2f861c171e9b975d07199d345f8d73a87b834a8d182616a00cc0235af68';
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const RIG_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; frame-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const PARTS_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const JOB_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const WORKSPACE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const roots: string[] = [];
afterEach(async () => {
  const parent = await realpath(tmpdir());
  for (const root of roots.splice(0)) {
    if (dirname(root) !== parent || !basename(root).startsWith('entry-html-') ||
        !(await lstat(root)).isDirectory() || await realpath(root) !== root) {
      throw new Error('ENTRY_HTML_CLEANUP_REFUSED');
    }
    await rm(root, { recursive: true });
  }
});

async function scratchRoot() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'entry-html-'));
  roots.push(root);
  return root;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function snapshot(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const [key, value] of [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (key === 'date') continue;
    headers[key] = value;
  }
  return { status: response.status, headers, byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

test('#655 slice 1: single rig server serves pinned GET and HEAD HTML bytes and headers on / and /index.html', async () => {
  const work = await scratchRoot();
  const pkg = await loadReview('examples/demo/review.json');
  const server = await startServer(pkg, { port: 0, stateDir: join(work, 'rig-state') });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const expectedGet = {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-length': '291',
        'content-security-policy': RIG_CSP,
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
      byteLength: 291,
      sha256: UNMARKED_HTML_SHA256,
    };
    const expectedHead = {
      ...expectedGet,
      headers: { ...expectedGet.headers, 'content-length': '0' },
      byteLength: 0,
      sha256: EMPTY_BODY_SHA256,
    };
    expect(await snapshot(await fetch(origin + '/'))).toEqual(expectedGet);
    expect(await snapshot(await fetch(origin + '/index.html'))).toEqual(expectedGet);
    expect(await snapshot(await fetch(origin + '/', { method: 'HEAD' }))).toEqual(expectedHead);
    expect(await snapshot(await fetch(origin + '/index.html', { method: 'HEAD' }))).toEqual(expectedHead);
  } finally {
    server.stop(true);
  }
});

test('#655 slice 1: Parts server serves pinned marked HTML on / and /index.html and keeps /parts.html 302 redirect', async () => {
  const work = await scratchRoot();
  await writePartsPackage(work);
  const pkg = await loadPartsView(join(work, 'rig'));
  const server = await startPartsServer(pkg, { port: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const expectedGet = {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-length': '318',
        'content-security-policy': PARTS_CSP,
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
      byteLength: 318,
      sha256: PARTS_HTML_SHA256,
    };
    const expectedHead = {
      ...expectedGet,
      headers: { ...expectedGet.headers, 'content-length': '0' },
      byteLength: 0,
      sha256: EMPTY_BODY_SHA256,
    };
    const expectedRedirect = {
      status: 302,
      headers: {
        'cache-control': 'no-store',
        'content-length': '0',
        'content-security-policy': PARTS_CSP,
        location: '/?lang=ko',
        'x-content-type-options': 'nosniff',
      },
      byteLength: 0,
      sha256: EMPTY_BODY_SHA256,
    };
    expect(await snapshot(await fetch(origin + '/'))).toEqual(expectedGet);
    expect(await snapshot(await fetch(origin + '/index.html'))).toEqual(expectedGet);
    expect(await snapshot(await fetch(origin + '/', { method: 'HEAD' }))).toEqual(expectedHead);
    expect(await snapshot(await fetch(origin + '/index.html', { method: 'HEAD' }))).toEqual(expectedHead);
    expect(await snapshot(await fetch(origin + '/parts.html?lang=ko', { redirect: 'manual' }))).toEqual(expectedRedirect);
    expect(await snapshot(await fetch(origin + '/parts.html?lang=ko', { method: 'HEAD', redirect: 'manual' }))).toEqual(expectedRedirect);
  } finally {
    await server.shutdown();
  }
});

test('#655 slice 1: job front serves pinned GET, HEAD and 304 HTML bytes and headers', async () => {
  const fixture = await scriptedJobWindowFixture();
  try {
    const etag = `"${UNMARKED_HTML_SHA256}"`;
    const expectedGet = {
      status: 200,
      headers: {
        'cache-control': 'no-cache',
        'content-length': '291',
        'content-security-policy': JOB_CSP,
        'content-type': 'text/html; charset=utf-8',
        etag,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
      byteLength: 291,
      sha256: UNMARKED_HTML_SHA256,
    };
    const expectedHead = {
      ...expectedGet,
      headers: { ...expectedGet.headers, 'content-length': '0' },
      byteLength: 0,
      sha256: EMPTY_BODY_SHA256,
    };
    const expectedNotModified = {
      status: 304,
      headers: {
        'cache-control': 'no-cache',
        'content-security-policy': JOB_CSP,
        'content-type': 'text/html; charset=utf-8',
        etag,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
      byteLength: 0,
      sha256: EMPTY_BODY_SHA256,
    };
    expect(await snapshot(await fetch(fixture.locator + '/'))).toEqual(expectedGet);
    expect(await snapshot(await fetch(fixture.locator + '/?lang=ko'))).toEqual(expectedGet);
    expect(await snapshot(await fetch(fixture.locator + '/', { method: 'HEAD' }))).toEqual(expectedHead);
    expect(await snapshot(await fetch(fixture.locator + '/', { headers: { 'If-None-Match': etag } }))).toEqual(expectedNotModified);
  } finally {
    await fixture.close();
  }
});

test('#655 slice 1: owner workspace serves pinned GET and HEAD HTML bytes and headers', async () => {
  const work = await scratchRoot();
  const host = await startOpenWorkspace({ stateDir: join(work, 'ws-state'), fingerprint: 'f'.repeat(64), port: 0 });
  try {
    const expectedGet = {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-length': '322',
        'content-security-policy': WORKSPACE_CSP,
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
      byteLength: 322,
      sha256: WORKSPACE_HTML_SHA256,
    };
    const expectedHead = {
      ...expectedGet,
      headers: { ...expectedGet.headers, 'content-length': '0' },
      byteLength: 0,
      sha256: EMPTY_BODY_SHA256,
    };
    expect(await snapshot(await fetch(host.record.origin + '/'))).toEqual(expectedGet);
    expect(await snapshot(await fetch(host.record.origin + '/?lang=ko'))).toEqual(expectedGet);
    expect(await snapshot(await fetch(host.record.origin + '/', { method: 'HEAD' }))).toEqual(expectedHead);
    const mainJs = await fetch(host.record.origin + '/main.js');
    expect(mainJs.status).toBe(200);
    expect(mainJs.headers.get('content-type')).toBe('text/javascript');
    expect(sha256(new Uint8Array(await mainJs.arrayBuffer()))).toBe(sha256(new Uint8Array(await (await buildWeb()).arrayBuffer())));
  } finally {
    await host.stop();
  }
});

test('#655: entryHtml owns web/index.html reads across all five routes and preserves custom assets and marker checks', async () => {
  for (const screen of ['rig', 'job'] as const) {
    const html = await entryHtml(screen);
    expect(sha256(new TextEncoder().encode(html))).toBe(UNMARKED_HTML_SHA256);
    expect(html).not.toContain('data-review-screen');
  }
  const partsHtml = await entryHtml('parts');
  expect(sha256(new TextEncoder().encode(partsHtml))).toBe(PARTS_HTML_SHA256);
  expect(partsHtml).toContain('<div id="app" data-review-screen="parts"></div>');
  const workspaceHtml = await entryHtml('workspace');
  expect(sha256(new TextEncoder().encode(workspaceHtml))).toBe(WORKSPACE_HTML_SHA256);
  expect(workspaceHtml).toContain('<div id="app" data-review-screen="workspace"></div>');

  const customAssets = await entryHtml('parts', { script: 'custom.js', styles: 'custom.css' });
  expect(customAssets).toContain('href="custom.css"');
  expect(customAssets).toContain('src="custom.js"');

  const brokenRoot = await scratchRoot();
  await mkdir(join(brokenRoot, 'web'), { recursive: true });
  await writeFile(join(brokenRoot, 'web/index.html'), '<!doctype html><html><body></body></html>\n');
  await expect(entryHtml('rig', undefined, brokenRoot)).rejects.toThrow('SETUP_ENTRY_MARKER_MISSING');

  for (const routeFile of ['src/server.ts', 'src/parts-server.ts', 'src/job-front.ts', 'src/open-workspace.ts', 'src/compare-server.ts']) {
    const source = await readFile(routeFile, 'utf8');
    expect(source).toContain('entryHtml(');
    expect(source).not.toContain('web/index.html');
  }
});
