/** Ordinary Nova acceptance for Review #716, using public synthetic PNGs and real retained jobs.
 * main: bun tests/job-checkpoint-pair-browser.ts --baseline --out <baseline-dir>
 * head: bun tests/job-checkpoint-pair-browser.ts --compare <baseline-dir>/observations.json --out <head-dir>
 */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PNG} from 'pngjs';
import {JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_COMMENT_ONLY_ACT_SCHEMA, JOB_RECORD_READER_ID,
    type JobCheckpointEvidence, type JobCheckpointTable, type JobComment, type JobPublication, type JobPublicationV3, type NextValueV3} from '../src/job-contract.ts';
import {parseCommentOnlyAct} from '../src/job-api.ts';
import {startJobHost} from '../src/job-front.ts';
import {differencePixels} from '../src/parts-comparison.ts';
import {parseFeedback, validatePackageFeedback, type Feedback} from '../src/session.ts';
import {feedbackItemComments, parsePictureCommentLabel, projectComments, timeOnlyBasis, type StageComment} from '../src/stage-comment.ts';
import {loadRetainedJobReview} from '../src/job-source.ts';
import type {InspectionBookmark} from '../web/inspection-persistence.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {createSyntheticPlanRecordWorkspace, createSyntheticRecordReader, writeWorkspaceFile} from './helpers/job-record-fixture.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {recordViewportControls} from './helpers/record-viewport-controls.ts';
import legacy from './fixtures/comments-contract-legacy.json';

type Route = 'plan' | 'package';
type Variant = 'pair' | 'no-pair' | 'size-mismatch' | 'two-pairs';
type Language = 'en' | 'ko';
type Host = Awaited<ReturnType<typeof startJobHost>>;
const languages = ['en', 'ko'] as const;
const routes = ['plan', 'package'] as const;
const checkpointId = 'step-one';
const secondCheckpointId = 'step-two';
const width = 144, height = 104;
const catalogs = {en: enCatalog, ko: koCatalog};
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sorted = <T extends {path: string}>(files: T[]) => files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function picture(kind: 'before' | 'after' | 'spare', w = width, offset = 0): Buffer {
    const png = new PNG({width: w, height});
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < w; x++) {
            const split = (kind === 'before' ? 58 : 82) + offset;
            const color = kind === 'spare' ? [31, 38, 51] : x < split ? [222, 77, 110] : [52, 164, 205];
            png.data.set([color[0]!, color[1]!, y < 40 ? color[2]! : 255 - color[2]!, 255], (y * w + x) * 4);
        }
    }
    return PNG.sync.write(png);
}

function createEvidence(root: string, variant: Variant, id = checkpointId) {
    const directory = id === checkpointId ? 'evidence' : 'evidence/' + id;
    const offset = id === checkpointId ? 0 : -20;
    const bytes = {before: picture('before', width, offset), after: picture('after', variant === 'size-mismatch' ? width + 16 : width, offset),
        spare: picture('spare')};
    const tiles = (['after', 'spare', 'before'] as const).map(kind => ({
        id: 'tile-' + kind,
        // Duplicate labels and shuffled order force resolution by the declared seals.
        label: 'Synthetic checkpoint tile',
        ...writeWorkspaceFile(root, directory + '/' + kind + '.png', bytes[kind]),
    }));
    const [after, , before] = tiles;
    assert.ok(before && after);
    const table: JobCheckpointTable = {schema: 'rig-review-checkpoint-table/1', columns: ['Check'], rows: [['Public synthetic pair']]};
    const tableSeal = writeWorkspaceFile(root, directory + '/table.json', JSON.stringify(table));
    const packet: JobCheckpointEvidence = {schema: 'rig-review-checkpoint-evidence/1', checkpointId: id, planStepId: id,
        tiles, table: tableSeal, routesText: '(i) accept\n(ii) repair\n(iii) stop', recommendationText: '(ii) repair',
        ...(variant !== 'no-pair' ? {pair: {
            before: {id: before.id, sha256: before.sha256}, after: {id: after.id, sha256: after.sha256},
        }} : {}),
    };
    return {packet, before, after, bytes, files: [...tiles.map(({path, sha256}) => ({path, sha256})), tableSeal]};
}

async function call<T>(host: Host, schema: typeof JOB_API_SCHEMA | typeof JOB_API_V3_SCHEMA, body: object): Promise<T> {
    const response = await fetch(host.origin + '/jobs/' + host.session.jobId + '/api', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + host.session.hostCredentials().agent},
        body: JSON.stringify({schema, jobId: host.session.jobId, requestId: randomUUID(), ...body}),
    });
    const result = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value as T;
}

async function openFixture(scratch: string, route: Route, variant: Variant, language?: Language, deferAsk = true) {
    const pkg = route === 'package' ? await realJobWindowFixture({scratchParent: scratch}) : null;
    const name = variant + (language ? '-' + language : '') + (deferAsk ? '-no-ask' : '');
    const root = pkg?.input.root ?? join(scratch, 'plan-' + name + '-' + randomUUID().slice(0, 8));
    const subject = {kind: 'checkpoint' as const, checkpointId};
    const steps = [{id: checkpointId, hash: '1'.repeat(64)}];
    if (variant === 'two-pairs') steps.push({id: secondCheckpointId, hash: '2'.repeat(64)});
    let host: Host | undefined = pkg?.host;
    const close = async () => {if (pkg) await pkg.close(); else host?.stop();};
    try {
        if (!pkg) await mkdir(root);
        const plan = createSyntheticPlanRecordWorkspace(root, {
            steps, subjects: [subject],
            text: {does: 'Inspect the evidence', produces: 'Checkpoint decision', bar: 'Match the declared tiles', rests_on: []},
        });
        const evidence = createEvidence(root, variant);
        const secondEvidence = variant === 'two-pairs' ? createEvidence(root, 'pair', secondCheckpointId) : undefined;
        const files = sorted([...plan.files, ...evidence.files, ...(secondEvidence?.files ?? [])]);
        const packets = [evidence.packet, ...(secondEvidence ? [secondEvidence.packet] : [])];
        let publication: JobPublication | JobPublicationV3;
        const schema = pkg ? JOB_API_SCHEMA : JOB_API_V3_SCHEMA;
        if (pkg) {
            pkg.input.setRecordPath('project.json');
            pkg.input.setContext({...pkg.input.getContext(), files, subjects: [subject], checkpointEvidence: packets});
            publication = await pkg.publish();
        } else {
            const context = {...plan.context, files, checkpointEvidence: packets};
            const {reader} = createSyntheticRecordReader({onPlan: () => structuredClone(context)});
            host = await startJobHost({root, stateDir: join(scratch, 'state-' + name + '-' + randomUUID().slice(0, 8)), fingerprint: 'a'.repeat(64),
                reviewer: {id: 'synthetic-owner', role: 'owner'}, publicationMode: 'record-and-package',
                readRecordPublished: reader, recordReaderId: JOB_RECORD_READER_ID, bindingId: 'synthetic-checkpoint-pair/1',
                installWriterBinding: () => {}});
            publication = await call<JobPublicationV3>(host, schema, {verb: 'publish', expectedGeneration: 0,
                idempotencyKey: randomUUID(), freeze: {kind: 'producer-held', holdId: 'synthetic', record: plan.record}, result: plan.result});
        }
        assert.ok(host);
        const mountedHost = host;
        // #1229: fresh checkpoint asks refuse JOB_ASK_INVALID; expose refuseAsk() so #1225/#1229 checks verify named refusal.
        const refuseAsk = async () => {
            const res = await fetch(mountedHost.origin + '/jobs/' + mountedHost.session.jobId + '/api', {
                method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + mountedHost.session.hostCredentials().agent},
                body: JSON.stringify({schema, jobId: mountedHost.session.jobId, requestId: randomUUID(), verb: 'ask',
                    expectedGeneration: mountedHost.session.status().generation, idempotencyKey: randomUUID(),
                    publicationId: publication.publicationId, subject}),
            });
            const body = await res.json();
            return {status: res.status, body};
        };
        if (!deferAsk) {
            const refused = await refuseAsk();
            assert.equal(refused.status, 409);
            assert.equal(refused.body.ok, false);
            assert.equal(refused.body.error.code, 'JOB_ASK_INVALID');
        }
        assert.deepEqual(publication.source.checkpointEvidence, packets, 'retained checkpoint evidence identity');
        const display = host.session.displayPublication(publication.publicationId);
        const base = host.origin + '/jobs/' + host.session.jobId + '/publications/' + publication.publicationId +
            '/instances/' + display.publication.instanceKey;
        const response = await fetch(base + '/api/review');
        assert.equal(response.status, 200);
        const metadata = await response.json();
        const retained = metadata.checkpointEvidence[0] as Omit<JobCheckpointEvidence, 'tiles'> & {
            tiles: (JobCheckpointEvidence['tiles'][number] & {url: string})[];
        };
        assert.deepEqual(retained.pair, evidence.packet.pair);
        for (const tile of evidence.packet.tiles) {
            const file = retained.tiles.find(candidate => candidate.id === tile.id);
            assert.ok(file);
            const res = await fetch(base + file.url);
            assert.equal(res.status, 200);
            assert.equal(sha256(Buffer.from(await res.arrayBuffer())), tile.sha256, tile.path);
        }
        return {host, publication, evidence, secondEvidence, close, refuseAsk, sourceHash: metadata.sourceHash as string};
    } catch (error) {
        await close();
        throw error;
    }
}

const viewport = '#stage-layout .viewport';
const visible = `node => {
    const box = node.getBoundingClientRect(), pane = node.closest('.viewport')?.getBoundingClientRect();
    return node.checkVisibility({checkVisibilityCSS: true, checkOpacity: true}) && box.width > 0 && box.height > 0 &&
        (!pane || box.right > pane.left && box.left < pane.right && box.bottom > pane.top && box.top < pane.bottom);
}`;
const differenceCanvas = `canvas => /difference/i.test(canvas.id + ' ' + canvas.className) ||
    canvas.width === ${width} && canvas.height === ${height}`;
type ViewObservation = {
    language: string;
    controls: {id: string; disabled: boolean; text: string}[];
    menu: {id: string; disabled: boolean; text: string; reason: string; pressed: boolean}[];
    panes: {id: string; shown: boolean; images: number; canvases: number}[];
    tiles: {id: string; pane: string; width: number; height: number}[];
    differenceCanvases: number;
    differenceEnabled: boolean;
    evidenceCount: number;
};

async function observe(page: InputCdpSession, evidence: ReturnType<typeof createEvidence>, language: Language): Promise<ViewObservation> {
    const tiles = (['before', 'after', 'spare'] as const).map(kind => {
        const png = PNG.sync.read(evidence.bytes[kind]);
        return {id: 'tile-' + kind, width: png.width, height: png.height, pixels: sha256(png.data)};
    });
    return page.evaluate<ViewObservation>(`(async () => {
        const shown = ${visible};
        const q = selector => [...document.querySelectorAll(selector)];
        const evidence = ${JSON.stringify(tiles)};
        const menu = q('#view-menu [data-view]').map(option => ({
            id: option.dataset.view, disabled: option.disabled, text: option.textContent.trim(),
            reason: option.getAttribute('aria-description') || option.title, pressed: option.getAttribute('aria-pressed') === 'true',
        }));
        const tiles = [];
        for (const img of q('${viewport} img').filter(img => shown(img) && img.complete && img.naturalWidth)) {
            const width = img.naturalWidth, height = img.naturalHeight;
            if (!evidence.some(tile => tile.width === width && tile.height === height)) continue;
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
            const {data} = context.getImageData(0, 0, width, height);
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
            const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
            const tile = evidence.find(tile => tile.pixels === hash);
            if (tile) tiles.push({id: tile.id, pane: img.closest('.viewport').id, width: img.naturalWidth, height: img.naturalHeight});
        }
        const isDifference = ${differenceCanvas};
        return {language: document.documentElement.lang,
            controls: q('#zoom-in, #zoom-out, #fit, #native-one, #view-menu').map(node =>
                ({id: node.id, disabled: node.disabled ?? node.getAttribute('aria-disabled') === 'true', text: node.id === 'view-menu'
                    ? node.querySelector('summary').getAttribute('aria-label') : node.textContent.trim()})),
            menu,
            panes: q('#stage-layout .stage-pane').map(node => ({id: node.id, shown: !node.hidden,
                images: q('#' + node.id + ' .viewport img').filter(shown).length,
                canvases: q('#' + node.id + ' .viewport canvas').filter(shown).length})),
            tiles,
            differenceCanvases: q('${viewport} canvas').filter(node => shown(node) && isDifference(node)).length,
            differenceEnabled: menu.some(option => option.text === ${JSON.stringify(catalogs[language].Difference)} && !option.disabled),
            evidenceCount: q('[data-job-checkpoint-evidence]').length,
        };
    })()`);
}

async function waitFor<T>(label: string, check: () => Promise<T | false | undefined>, timeoutMs = 25_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await Bun.sleep(50);
    }
    throw new Error('CHECKPOINT_PAIR_WAIT ' + label);
}

async function settle(page: InputCdpSession) {
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
}

async function showFixture(page: InputCdpSession, fixture: Awaited<ReturnType<typeof openFixture>>, language: Language, _hasAsk = false) {
    const owner = new URL(fixture.host.ownerUrl);
    owner.searchParams.set('lang', language);
    await page.goto(owner.href, language);
    // #1229: neither records nor packages mount a checkpoint Pass/Fail form; wait for the shared workspace ready state.
    await waitFor('ready without checkpoint form', () => page.evaluate<boolean>(`document.body.dataset.ready === 'true'`));
    await settle(page);
}

type Fixture = Awaited<ReturnType<typeof openFixture>>;
let command: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;

async function showSeededDraft(page: InputCdpSession, fixture: Fixture, key: string, draft: unknown, hasAsk = true) {
    assert.ok(command);
    const origin = new URL(fixture.host.ownerUrl).origin;
    const source = `if(location.origin===${JSON.stringify(origin)})localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(draft))});`;
    const {identifier} = await command('Page.addScriptToEvaluateOnNewDocument', {source}) as {identifier: string};
    try {
        await page.goto('about:blank');
        await showFixture(page, fixture, 'en', hasAsk);
    } finally {
        await command('Page.removeScriptToEvaluateOnNewDocument', {identifier});
    }
}

type PairView = 'before' | 'after' | 'compare' | 'difference';
const composer = '.stage-comment-composer';
const summary = '#stage-comment-list .stage-comment-summary';
const errors = '#message.error, #review-message.error';
const viewOrder = ['compare', 'before', 'after', 'difference'];
const controls = ['zoom-in', 'zoom-out', 'fit', 'native-one', 'view-menu'];
const alignment = 'PARTS_DIFFERENCE_ALIGNMENT: integer native placement and exact PNG dimensions required';

async function capture(page: InputCdpSession, directory: string, name: string, size = [1440, 900]) {
    await settle(page);
    const bytes = await page.screenshot();
    const {width, height} = PNG.sync.read(bytes);
    assert.deepEqual([width, height], size, name);
    await writeFile(join(directory, name + '.png'), bytes);
}

async function chooseView(page: InputCdpSession, mode: string) {
    if (!(await page.evaluate<boolean>("document.querySelector('#view-menu').open"))) await click(page, '#view-menu summary');
    await click(page, '#view-menu [data-view="' + mode + '"]');
}

async function pairView(page: InputCdpSession, fixture: Pick<Fixture, 'evidence'>, language: Language, mode: PairView,
    enabled = true, timeoutMs = 25_000, selectedPair?: string) {
    const {before, after, bytes} = fixture.evidence;
    const tile = (side: 'before' | 'after', pane: string) => {
        const png = PNG.sync.read(bytes[side]);
        return {id: (side === 'before' ? before : after).id, pane, width: png.width, height: png.height};
    };
    const expected = mode === 'compare' ? [tile('before', 'reference-viewport'), tile('after', 'rig-viewport')] :
        mode === 'difference' ? [] : [tile(mode, 'reference-viewport')];
    const view = await waitFor(language + ' ' + mode + ' painted', async () => {
        const view = await observe(page, fixture.evidence, language);
        const selected = view.menu.filter(option => option.pressed).map(option => option.id);
        return selected.join() === [mode, selectedPair].filter(Boolean).join() && view.tiles.length === expected.length &&
            view.differenceCanvases === Number(mode === 'difference') && view;
    }, timeoutMs);
    assert.deepEqual(view.tiles, expected, mode + ' draws the declared native tiles in order');
    assert.equal(view.panes.reduce((count, pane) => count + pane.images, 0), expected.length,
        mode + ' has only the intended native images');
    assert.deepEqual(view.controls.map(control => control.id), controls, 'shared controls appear once and in order');
    assert.ok(view.controls.every(control => !control.disabled), 'shared controls remain available');
    const layoutMenu = selectedPair ? view.menu.slice(0, viewOrder.length) : view.menu;
    assert.deepEqual(layoutMenu.map(option => option.id), viewOrder);
    assert.deepEqual(layoutMenu.map(option => option.text), [catalogs[language]['Side by side'],
        language === 'en' ? 'Before' : '이전', language === 'en' ? 'After' : '이후', catalogs[language].Difference]);
    assert.equal(view.differenceEnabled, enabled);
    assert.equal(view.evidenceCount, 0, 'retired evidence grid stays absent');
    if (mode === 'compare') {
        assert.ok(await page.evaluate<boolean>(`document.querySelector('#reference-viewport').getBoundingClientRect().right <=
            document.querySelector('#rig-viewport').getBoundingClientRect().left + 1`), 'Before sits to the left of After');
    } else {
        assert.deepEqual(view.panes.filter(pane => pane.shown).map(pane => pane.id), ['reference-pane'], mode + ' is a single pane');
    }
    return view;
}

async function differenceBytes(page: InputCdpSession, evidence: Fixture['evidence']) {
    const before = PNG.sync.read(evidence.bytes.before), after = PNG.sync.read(evidence.bytes.after);
    const expected = differencePixels(after, {x: 0, y: 0, w: after.width, h: after.height}, before, [], 0, false, 'previous-draft');
    const actual = await page.evaluate<{width: number; height: number; rgba: string}>(`(() => {
        const canvas = document.querySelector('#checkpoint-difference-canvas');
        const {width, height} = canvas;
        const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
        return {width, height, rgba: btoa(String.fromCharCode(...rgba))};
    })()`);
    const rgba = Buffer.from(actual.rgba, 'base64');
    const digest = sha256(rgba), expectedDigest = sha256(Buffer.from(expected.data));
    assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], 'Difference canvas native grid');
    assert.ok(rgba.equals(Buffer.from(expected.data)), 'Difference byte mismatch: actual ' + digest + ', expected ' + expectedDigest);
    return {width: actual.width, height: actual.height, bytes: rgba.length, sha256: digest};
}

async function pointAt(page: InputCdpSession, selector: string, fraction: number) {
    const {x, y} = await page.evaluate<{x: number; y: number}>(`(() => {
        const image = document.querySelector(${JSON.stringify(selector)}), pane = image.closest('.viewport');
        const rect = image.getBoundingClientRect();
        const x = rect.left + rect.width * ${fraction}, y = rect.top + rect.height * 0.47;
        if (!pane.contains(document.elementFromPoint(x, y))) throw new Error('Pin coordinate outside target pane');
        return {x, y};
    })()`);
    await page.mouse('mouseMoved', x, y);
    await page.mouse('mousePressed', x, y);
    await page.mouse('mouseReleased', x, y);
}

async function startCapture(page: InputCdpSession) {
    const active = "!!document.querySelector('#reference-viewport.stage-comment-mode')";
    if (!(await page.evaluate<boolean>(active))) await click(page, '#stage-comment');
    await waitFor('reference capture enabled', () => page.evaluate<boolean>(active));
    await settle(page);
}

async function placePin(page: InputCdpSession, text: string, mode: PairView, fraction: number) {
    const operand = mode === 'difference' ? '#checkpoint-difference-canvas' : '#reference-content img';
    await pointAt(page, operand, fraction);
    const hasComposer = '!!document.querySelector(' + JSON.stringify(composer + ' input') + ')';
    await waitFor(text + ' composer', () => page.evaluate<boolean>(hasComposer));
    await page.evaluate(`(() => {
        const form = document.querySelector(${JSON.stringify(composer)});
        form.querySelector('input').value = ${JSON.stringify(text)};
        form.requestSubmit();
    })()`);
    await waitFor(text + ' saved', () => page.evaluate<boolean>('!' + hasComposer));
    return page.evaluate<{id: string; text: string}>(`(() => {
        const row = [...document.querySelectorAll(${JSON.stringify(summary)})].find(node =>
            node.textContent.endsWith(${JSON.stringify(text)}));
        if (!row) throw new Error('Saved comment row missing');
        return {id: row.closest('[data-comment-id]').dataset.commentId, text: row.textContent};
    })()`);
}

type PinRow = Feedback & {context: {comment: StageComment}};
type DraftEntry = {key: string; draft: {schema?: string; comments?: PinRow[]; session?: {feedback: PinRow[]}}};
async function savedDraft(page: InputCdpSession, ids: string[]): Promise<DraftEntry | undefined> {
    return page.evaluate<DraftEntry | undefined>(`(() => {
        for (const [key, value] of Object.entries(localStorage)) {
            if (!key.startsWith('rig-review-record-comments/1:') && !key.startsWith('rig-review-draft/1:')) continue;
            const draft = JSON.parse(value), rows = draft.comments ?? draft.session?.feedback;
            if (rows && ${JSON.stringify(ids)}.every(id => rows.some(row => row.id === id))) return {key, draft};
        }
    })()`);
}

function feedbackRows(entry: DraftEntry) {
    return entry.draft.comments ?? entry.draft.session?.feedback ?? [];
}

async function verifyReplay(page: InputCdpSession, id: string, text: string) {
    const selector = `[data-comment-id="${id}"] .stage-comment-summary`;
    await waitFor(text + ' recovered row', () => page.evaluate<boolean>('!!document.querySelector(' + JSON.stringify(selector) + ')'));
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await waitFor(text + ' replayed composer', () => page.evaluate<boolean>(`document.querySelector(${JSON.stringify(composer + ' input')})?.value === ${JSON.stringify(text)}`));
    assert.deepEqual(await inspectionErrors(page), [], text + ' replays without an inspection error');
}

async function inspectionErrors(page: InputCdpSession) {
    return page.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(errors)})].map(node => node.textContent).filter(Boolean)`);
}

async function clickScrolled(page: InputCdpSession, selector: string) {
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`);
    await settle(page);
    await click(page, selector);
}

// #1229: converted from submitCheckpoint (removed Pass/Fail form) to Send comments (act@10) on the paired record.
async function submitPairComments(page: InputCdpSession, fixture: Fixture, route: Route, expectedComments: readonly JobComment[], expectedWords: string) {
    const {host, publication} = fixture;
    await waitFor('Send comments enabled', () => page.evaluate<boolean>(
        `!!document.getElementById('send-comments') && !document.getElementById('send-comments').hidden && !document.getElementById('send-comments').disabled`));
    await click(page, '#send-comments');
    const schema = route === 'plan' ? JOB_API_V3_SCHEMA : JOB_API_SCHEMA;
    const event = await waitFor('finalized comment-only act', async () => {
        const next = await call<NextValueV3>(host, schema, {verb: 'next', after: null, waitMs: 0});
        return next.events.find(item => item.type === 'act' && item.act.publicationId === publication.publicationId && item.act.kind === 'comments');
    });
    assert.equal(event.type, 'act');
    assert.equal(event.act.schema, JOB_COMMENT_ONLY_ACT_SCHEMA);
    const parsed = parseCommentOnlyAct(event.act);
    const plain = parsed.value.comments.map(({context: _context, ...comment}) => comment);
    assert.deepEqual(plain, expectedComments);
    assert.equal(projectComments(plain, [fixture.evidence.before, fixture.evidence.after]), expectedWords);
    return {actId: parsed.actId};
}

type TileSeal = Pick<JobCheckpointEvidence['tiles'][number], 'id' | 'path' | 'sha256'>;
type ReplayPin = {id: string; text: string; tile: TileSeal};

async function replaySubmittedPin(page: InputCdpSession, fixture: Fixture, language: Language, pin: ReplayPin) {
    const selector = `[data-comment-id="${pin.id}"] .stage-comment-summary`;
    await waitFor(pin.text + ' saved row', () => page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`));
    await clickScrolled(page, selector);
    const state = await waitFor(pin.text + ' replay after submission', async () => {
        const refusals = await inspectionErrors(page);
        const view = await observe(page, fixture.evidence, language);
        const tiles = view.tiles.filter(tile => tile.pane === 'reference-viewport');
        return refusals.length || tiles.some(tile => tile.id === pin.tile.id) ? {tiles, refusals} : false;
    });
    assert.deepEqual(state.refusals, [], pin.text + ' replays without refusal after submission');
    await waitFor(pin.text + ' reopened comment', () => page.evaluate<boolean>(
        `document.querySelector(${JSON.stringify('#reference-viewport ' + composer + ' input')})?.value === ${JSON.stringify(pin.text)}`));
    // The fixture verifies encoded bytes from the sealed routes. Match the visible pixels
    // to the same fixture tiles without fetching a blob URL under the page's CSP.
    const tiles = state.tiles.map(({id}) => {
        const tile = fixture.evidence.packet.tiles.find(candidate => candidate.id === id);
        assert.ok(tile);
        return {id, path: tile.path, sha256: tile.sha256};
    });
    assert.deepEqual(tiles, [pin.tile], pin.text + ' restores the exact sealed tile after submission');
    assert.deepEqual(await inspectionErrors(page), [], pin.text + ' remains free of refusal after paint');
    return tiles[0];
}

async function runRecordPair(page: InputCdpSession, fixture: Fixture, language: Language, captures: string) {
    const route: Route = 'plan';
    const observations = {} as Record<PairView, ViewObservation>;
    const pins: {mode: PairView; id: string; text: string; tile: Fixture['evidence']['after']}[] = [];
    await pairView(page, fixture, language, 'after');
    await capture(page, captures, route + '-opening-' + language);
    await chooseView(page, 'compare');
    await pairView(page, fixture, language, 'compare');
    await capture(page, captures, route + '-side-by-side-' + language);
    await chooseView(page, 'difference');
    await pairView(page, fixture, language, 'difference');
    await capture(page, captures, route + '-difference-' + language);
    const rgba = await differenceBytes(page, fixture.evidence);
    await chooseView(page, 'after');
    for (const [index, mode] of (['after', 'compare', 'before', 'difference'] as const).entries()) {
        if (index) await chooseView(page, mode);
        observations[mode] = await pairView(page, fixture, language, mode);
        await startCapture(page);
        if (mode === 'compare') {
            await pointAt(page, '#rig-root img', 0.53);
            await settle(page);
            assert.equal(await page.evaluate<boolean>('!!document.querySelector(' + JSON.stringify(composer) + ')'), false,
                'the right After pane cannot receive a side-by-side pin');
        }
        const label = 'Checkpoint pin ' + mode;
        const row = await placePin(page, label, mode, 0.22 + index * 0.17);
        const tile = mode === 'after' || mode === 'difference' ? fixture.evidence.after : fixture.evidence.before;
        if (mode === 'difference') {
            const onAfter = catalogs[language][' on {0}']!.replace('{0}', language === 'en' ? 'After' : '이후');
            assert.ok(row.text.includes(onAfter), 'Difference pin row says ' + onAfter + ': ' + row.text);
        }
        pins.push({mode, ...row, tile});
    }
    const ids = pins.map(pin => pin.id);
    const entry = await waitFor('four pins persisted', () => savedDraft(page, ids));
    assert.ok(entry.key.startsWith('rig-review-record-comments/1:'), 'pins persist through the record draft store');
    const rows = feedbackRows(entry);
    const anchors = pins.map(({id, mode, text, tile}) => {
        const row = rows.find(item => item.id === id);
        assert.ok(row);
        const {viewport, referenceId, referenceHash, world, bookmark, sourceHash} = row.context.comment;
        assert.equal(viewport, 'reference', mode);
        assert.equal(referenceId, tile.path, mode + ' sealed path');
        assert.equal(referenceHash, tile.sha256, mode + ' sealed hash');
        assert.equal(sourceHash, fixture.sourceHash, mode + ' inspected source');
        assert.equal((bookmark as InspectionBookmark).selection.reference, tile.path, mode + ' replay selection');
        assert.ok(world.x >= 0 && world.x < width && world.y >= 0 && world.y < height, mode + ' native pixels');
        return {mode, id, text, tileId: tile.id, referenceId, referenceHash, sourceHash, world, bookmark};
    });
    const expectedComments = feedbackItemComments(rows);
    const words = projectComments(expectedComments, [fixture.evidence.before, fixture.evidence.after]);
    const labels = words.split('\n\n').map(block => parsePictureCommentLabel(block.split('\n')[0]!.slice(1, -1)));
    assert.deepEqual(labels.map(row => ({path: row.referenceId, sha256: row.referenceHash})),
        pins.map(pin => ({path: pin.tile.path, sha256: pin.tile.sha256})), 'pair pin comments carry sealed labels');
    await page.goto('about:blank');
    await showFixture(page, fixture, language);
    const restored = await waitFor('draft survives reload', () => savedDraft(page, ids));
    assert.deepEqual(feedbackRows(restored), rows, 'saved pin bytes survive reload');
    await waitFor('four restored pin rows', () => page.evaluate<boolean>(
        `${JSON.stringify(ids)}.every(id => !!document.querySelector('[data-comment-id="' + id + '"] .stage-comment-summary'))`));
    await chooseView(page, 'before');
    await pairView(page, fixture, language, 'before');
    await verifyReplay(page, pins[3]!.id, 'Checkpoint pin difference');
    await pairView(page, fixture, language, 'after');
    await page.evaluate(`document.querySelector('.stage-comment-composer input')?.dispatchEvent(
        new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    const {actId: submittedAct} = await submitPairComments(page, fixture, route, expectedComments, words);
    const postSubmitReplay = {released: false, pins: [] as {
        mode: 'after' | 'before'; id: string; expected: TileSeal; observed?: Awaited<ReturnType<typeof replaySubmittedPin>>;
        error?: string; refusals: string[];
    }[], releaseError: ''};
    try {
        await pairView(page, fixture, language, 'after');
        postSubmitReplay.released = true;
        // Replay Before first while After is shown, then After, proving pin clicks switch and restore each sealed tile.
        for (const mode of ['before', 'after'] as const) {
            const {id} = pins.find(pin => pin.mode === mode)!;
            const {id: tileId, path, sha256} = fixture.evidence[mode];
            const expected = {id: tileId, path, sha256};
            try {
                const observed = await replaySubmittedPin(page, fixture, language, {id, text: 'Checkpoint pin ' + mode, tile: expected});
                postSubmitReplay.pins.push({mode, id, expected, observed, refusals: []});
            } catch (error) {
                postSubmitReplay.pins.push({mode, id, expected, error: String(error), refusals: await inspectionErrors(page)});
            }
        }
    } catch (error) {
        postSubmitReplay.releaseError = String(error);
    }
    const counts = {tiles: observations.compare.tiles.length, canvases: observations.difference.differenceCanvases,
        differenceEnabled: observations.after.differenceEnabled};
    return {counts, views: observations, rgba, anchors, labels, rightPaneRefused: true, replayedAfterNative: true, submittedAct, postSubmitReplay};
}

/** #1229 owner ruling 11-25: converted package-pair case — packages keep their rig/reference screen without mounting
 * the tile pair view, while retaining tile-bound pin labels and pin replay through host.checkpointPairs. */
async function verifyPackageTilePinReplay(page: InputCdpSession, fixture: Fixture) {
    const {host, publication, sourceHash, evidence} = fixture;
    const retained = host.session.retainedSource(publication.publicationId);
    const review = await loadRetainedJobReview(retained, host.session.attestation().fingerprint);
    const camera: StageComment['camera'] = {space: 'image', center: {x: 32, y: 24}, zoom: 1,
        viewport: {width: 64, height: 48}, visible: {x: 0, y: 0, width: 64, height: 48}};
    const cropHash = sha256(Buffer.from(legacy.stillPng, 'base64'));
    const region = {x: 22, y: 19, width: 0, height: 0};
    const makeRow = (side: 'before' | 'after') => {
        const tile = evidence[side];
        const bookmark: InspectionBookmark = {schema: 'rig-review-inspection/1',
            binding: {mode: 'single', sourceHash, rigs: [review.reviewedSource.rig?.sha256 ?? null]},
            animation: null, time: 0, theme: 'system', layers: {images: true, meshes: false, bones: false},
            view: {schema: 'rig-review-view/1', cameraSync: false, activeCamera: 'reference',
                cameras: {reference: camera, rig: null, a: null, b: null}},
            selection: {view: 'reference', part: null, checkpoint: checkpointId, reference: tile.path, inspector: 'rig'}};
        const mark: StageComment = {schema: 'rig-review-comment/1', mode: 'setup', viewport: 'reference',
            frame: null, timeBasis: timeOnlyBasis, time: 0, animation: null, sourceHash, modelHash: null,
            referenceHash: tile.sha256, referenceId: tile.path, camera, screen: region, world: region, slots: [],
            crop: {path: 'comment-crops/' + cropHash + '.png', sha256: cropHash, png: 'data:image/png;base64,' + legacy.stillPng,
                width: 1, height: 1}, bookmark};
        return {id: 'historical-package-tile-' + side, frameStart: null, frameEnd: null,
            target: {kind: 'rig' as const, name: 'viewport-387-public'}, category: 'defect' as const,
            summary: 'Saved package tile ' + side,
            context: {animation: null, time: 0, frame: null, interval: null, comment: mark}};
    };
    const beforeRow = makeRow('before'), afterRow = makeRow('after');
    const key = `rig-review-draft/1:single:${review.manifest.id}:${sourceHash}:${sourceHash}`;
    const current = JSON.parse(await waitFor('current package draft envelope for tile replay', async () =>
        await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`) ?? false));
    const draft = {...current, schema: 'rig-review-local-draft/1', reviewDirty: true,
        session: {...current.session, feedback: [beforeRow, afterRow]}};
    await showSeededDraft(page, fixture, key, draft);
    // Opening with saved tile pins still keeps the package's normal rig/reference view until a pin is replayed.
    const initial = await observe(page, evidence, 'en');
    assert.equal(initial.tiles.length, 0, 'saved tile pins do not mount the pair view on package load');
    const summaries = await waitFor('tile labels rendered on package comment list', async () => {
        const list = await page.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(summary)})].map(n => n.textContent ?? '')`);
        return list.length === 2 ? list : false;
    });
    assert.ok(summaries.some(text => text.includes(' on Before') && text.endsWith('Saved package tile before')),
        'Before tile label bound via checkpointPairTile: ' + JSON.stringify(summaries));
    assert.ok(summaries.some(text => text.includes(' on After') && text.endsWith('Saved package tile after')),
        'After tile label bound via checkpointPairTile: ' + JSON.stringify(summaries));
    const replayedBefore = await replaySubmittedPin(page, fixture, 'en', {
        id: beforeRow.id, text: beforeRow.summary, tile: {id: evidence.before.id, path: evidence.before.path, sha256: evidence.before.sha256},
    });
    const replayedAfter = await replaySubmittedPin(page, fixture, 'en', {
        id: afterRow.id, text: afterRow.summary, tile: {id: evidence.after.id, path: evidence.after.path, sha256: evidence.after.sha256},
    });
    // Clicking an inspector mode leaves the replayed tile and returns to the package rig view.
    await click(page, '[data-mode="rig"]');
    await waitFor('package rig view restored after pin replay', async () =>
        (await observe(page, evidence, 'en')).tiles.length === 0);
    return {replayedBefore, replayedAfter};
}

/** A correctly sealed third tile is still neither a manifest reference nor a member of the pair. */
async function refuseOutsidePair(page: InputCdpSession, fixture: Fixture, entry: DraftEntry, id: string) {
    const draft = structuredClone(entry.draft);
    const row = feedbackRows({key: entry.key, draft}).find(item => item.id === id);
    const spare = fixture.evidence.packet.tiles.find(tile => tile.id === 'tile-spare');
    assert.ok(row && spare);
    row.context.comment.referenceId = spare.path;
    row.context.comment.referenceHash = spare.sha256;
    (row.context.comment.bookmark as InspectionBookmark).selection.reference = spare.path;
    await showSeededDraft(page, fixture, entry.key, draft, false);
    if (!(await inspectionErrors(page)).some(error => error.includes('COMMENT_REFERENCE_MISMATCH'))) {
        const selector = `[data-comment-id="${id}"] .stage-comment-summary`;
        await waitFor('planted record row restored', () => page.evaluate<boolean>('!!document.querySelector(' + JSON.stringify(selector) + ')'));
        await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    }
    await waitFor('outside-pair path refuses by name', async () =>
        (await inspectionErrors(page)).some(error => error.includes('COMMENT_REFERENCE_MISMATCH')));
    assert.equal(await page.evaluate<boolean>('!!document.querySelector(' + JSON.stringify(composer) + ')'), false);
    await pairView(page, fixture, 'en', 'after');
    const refusal = await inspectionErrors(page);
    return {path: spare.path, sha256: spare.sha256, refusal};
}

// #1229 owner ruling 11-25: converted outside-pair pin refusal control from package to plan record (with no ask)
// because packages no longer mount the checkpoint tile pair view for placing new tile pins.
async function runOutsidePairControl(page: InputCdpSession, scratch: string) {
    const fixture = await openFixture(scratch, 'plan', 'pair', 'en', true);
    try {
        await showFixture(page, fixture, 'en', false);
        await chooseView(page, 'difference');
        await pairView(page, fixture, 'en', 'difference');
        await startCapture(page);
        const {id} = await placePin(page, 'Checkpoint pin difference', 'difference', 0.73);
        const draft = await waitFor('outside-pair control draft', () => savedDraft(page, [id]));
        const result = await refuseOutsidePair(page, fixture, draft, id);
        await page.goto('about:blank');
        return result;
    } finally {
        await fixture.close();
    }
}

/** The pre-step-3 viewport-387 public package declares the raster by manifest ID. Replay a
 * historical-format row against that package, with only the active source identity filled in. */
async function historicalReference(page: InputCdpSession, fixture: Fixture) {
    const {host, publication, sourceHash} = fixture;
    const retained = host.session.retainedSource(publication.publicationId);
    const review = await loadRetainedJobReview(retained, host.session.attestation().fingerprint);
    const referenceId = 'raster';
    const referenceHash = review.referenceHashes?.[referenceId];
    assert.ok(referenceHash);
    const original = PNG.sync.read(await readFile(join(retained.snapshotRoot, 'out', 'rigid.png')));
    const camera: StageComment['camera'] = {space: 'image', center: {x: 32, y: 24}, zoom: 1,
        viewport: {width: 64, height: 48}, visible: {x: 0, y: 0, width: 64, height: 48}};
    const bookmark: InspectionBookmark = {schema: 'rig-review-inspection/1',
        binding: {mode: 'single', sourceHash, rigs: [review.reviewedSource.rig?.sha256 ?? null]},
        animation: 'inspect', time: 0, theme: 'system', layers: {images: true, meshes: false, bones: false},
        view: {schema: 'rig-review-view/1', cameras: {reference: camera, rig: null, a: null, b: null}},
        selection: {view: 'reference', reference: referenceId, inspector: 'playback'}};
    const cropHash = sha256(Buffer.from(legacy.stillPng, 'base64'));
    const region = {x: 22, y: 19, width: 0, height: 0};
    const mark: StageComment = {schema: 'rig-review-comment/1', mode: 'animate', viewport: 'reference',
        frame: {index: 0, basis: 'producer'}, time: 0, animation: 'inspect', sourceHash, modelHash: null,
        referenceHash, referenceId, camera, screen: region, world: region, slots: [],
        crop: {path: 'comment-crops/' + cropHash + '.png', sha256: cropHash, png: 'data:image/png;base64,' + legacy.stillPng,
            width: 1, height: 1}, bookmark};
    const prior = {id: 'historical-raster-pin', frameStart: 0, frameEnd: 0,
        target: {kind: 'rig', name: 'viewport-387-public'}, category: 'defect', summary: 'Historical manifest reference',
        context: {animation: 'inspect', time: 0, frame: 0, interval: {frameStart: 0, frameEnd: 0, inclusive: true}, comment: mark}};
    const bytes = JSON.stringify(prior);
    const row = parseFeedback(JSON.parse(bytes));
    assert.equal(JSON.stringify(row), bytes, 'historical package parser preserves bytes');
    assert.equal(JSON.stringify(validatePackageFeedback(row, {...review, sourceHash})), bytes, 'historical package validation preserves bytes');
    const golden = '[["rig-review-comment/1","animate","reference","rig","viewport-387-public",0,0]]\nHistorical manifest reference';
    assert.equal(projectComments(feedbackItemComments([row])), golden);
    const key = `rig-review-draft/1:single:${review.manifest.id}:${sourceHash}:${sourceHash}`;
    const current = JSON.parse(await waitFor('current package draft envelope', async () =>
        await page.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`) ?? false));
    const draft = {...current, schema: 'rig-review-local-draft/1', reviewDirty: true, bookmark,
        session: {...current.session, feedback: [row]}};
    await showSeededDraft(page, fixture, key, draft);
    const restored = feedbackRows(await waitFor('historical draft survives reload', () => savedDraft(page, [row.id])))[0];
    assert.ok(restored);
    if (restored.context.comment.crop.png === 'draft-crop:' + cropHash) restored.context.comment.crop.png = mark.crop.png;
    assert.equal(JSON.stringify(restored), bytes, 'historical manifest reference persists byte for byte');
    await chooseView(page, 'rig');
    await verifyReplay(page, row.id, row.summary);
    const actual = await page.evaluate<{width: number; height: number; selected: string}>(`(() => {
        const image = document.querySelector('#reference-content img');
        return {width: image?.naturalWidth, height: image?.naturalHeight, selected: document.querySelector('#reference-select').value};
    })()`);
    assert.deepEqual(actual, {width: original.width, height: original.height, selected: referenceId});
    return {referenceId, referenceHash, golden, feedbackSha256: sha256(Buffer.from(bytes)), replayedNative: actual};
}

function arg(name: string) {
    const position = Bun.argv.indexOf(name);
    if (position < 0) return undefined;
    const value = Bun.argv[position + 1];
    assert.ok(value && !value.startsWith('--'), name + ' requires a path');
    return value;
}

/** #1253 uses the same sealed fixtures on the base and the candidate at the owner's viewport size. */
async function recordPairSelection(page: InputCdpSession, scratch: string, captures: string, baseline: boolean) {
    const size = [1280, 800] as const;
    const pairId = (id: string) => 'checkpoint-pair-' + id;
    const menuHtml = () => page.evaluate<string>(`document.querySelector('#view-menu').outerHTML`);
    const observations: Record<string, {singleMenu: string; twoPairMenu: string; pairTwoMenu?: string}> = {};
    await page.setViewport(...size);
    for (const language of languages) {
        const single = await openFixture(scratch, 'plan', 'pair', language);
        let singleMenu: string;
        try {
            await showFixture(page, single, language);
            await pairView(page, single, language, 'after');
            await click(page, '#view-menu summary');
            await capture(page, captures, 'single-pair-' + language, [...size]);
            singleMenu = await menuHtml();
        } finally {
            await page.goto('about:blank');
            await single.close();
        }
        const multi = await openFixture(scratch, 'plan', 'two-pairs', language);
        try {
            const evidence = multi.secondEvidence;
            assert.ok(evidence);
            const first = pairId(checkpointId), second = pairId(secondCheckpointId);
            await showFixture(page, multi, language);
            assert.equal(await page.evaluate<number>(`document.querySelectorAll('form[data-job-ask]').length`), 0);
            const opening = await pairView(page, multi, language, 'after', true, 6_000, baseline ? undefined : first);
            await click(page, '#view-menu summary');
            await capture(page, captures, 'two-pairs-' + language, [...size]);
            const twoPairMenu = await menuHtml();
            observations[language] = {singleMenu, twoPairMenu};
            if (baseline) {
                assert.equal(twoPairMenu, singleMenu, 'the base does not expose the second pair');
            } else {
                const labels = language === 'en' ? ['Pair 1', 'Pair 2'] : ['쌍 1', '쌍 2'];
                assert.deepEqual(opening.menu.slice(4).map(({id, text}) => [id, text]),
                    [[first, labels[0] + ' · ' + checkpointId], [second, labels[1] + ' · ' + secondCheckpointId]]);
                assert.equal(await page.evaluate<number>(`document.querySelectorAll('#view-menu [role="separator"]').length`), 1);
                for (const mode of ['after', 'compare', 'before', 'difference'] as const) {
                    await chooseView(page, mode);
                    await chooseView(page, second);
                    await pairView(page, {evidence}, language, mode, true, 6_000, second);
                    if (mode === 'after') {
                        await click(page, '#view-menu summary');
                        await capture(page, captures, 'pair-two-' + language, [...size]);
                        observations[language]!.pairTwoMenu = await menuHtml();
                    }
                    if (mode === 'difference') await differenceBytes(page, evidence);
                    await chooseView(page, first);
                    await pairView(page, multi, language, mode, true, 6_000, first);
                }
                await chooseView(page, second);
                await chooseView(page, 'after');
                await startCapture(page);
                const {id} = await placePin(page, 'Second pair pin', 'after', 0.5);
                await chooseView(page, first);
                await verifyReplay(page, id, 'Second pair pin');
                await pairView(page, {evidence}, language, 'after', true, 6_000, second);
            }
            console.log('1253_RECORD_PAIR_SELECTION_PASS ' + language + (baseline ? ' baseline' : ' candidate'));
        } finally {
            await page.goto('about:blank');
            await multi.close();
        }
    }
    return observations;
}

/** #1229 fail-first case (owner ruling 11-25): a record publication with a declared pair and NO checkpoint ask
 * mounts and switches the pair view from the start. Fails on 8ee04367 where pair mounting required a pending ask. */
async function recordPairWithoutAsk(page: InputCdpSession, scratch: string, captures: string) {
    const out: Record<string, unknown> = {};
    for (const language of languages) {
        const fixture = await openFixture(scratch, 'plan', 'pair', language, true);
        try {
            await showFixture(page, fixture, language, false);
            assert.equal(await page.evaluate<number>(`document.querySelectorAll('form[data-job-ask]').length`), 0,
                'record has no pending checkpoint ask');
            const after = await pairView(page, fixture, language, 'after', true, 6_000);
            await capture(page, captures, 'plan-no-ask-opening-' + language);
            await chooseView(page, 'compare');
            await pairView(page, fixture, language, 'compare');
            await chooseView(page, 'difference');
            await pairView(page, fixture, language, 'difference');
            const rgba = await differenceBytes(page, fixture.evidence);
            out[language] = {tiles: after.tiles.length, differenceSha256: rgba.sha256};
            console.log('1229_RECORD_PAIR_NO_ASK_PASS ' + language);
        } finally {
            await page.goto('about:blank');
            await fixture.close();
        }
    }
    return out;
}

async function checkpointViewportControls(page: InputCdpSession, scratch: string) {
    for (const language of languages) {
        // #1128 empty record controls check uses no-pair, because under #1229 owner ruling 11-25 a declared pair is up from the start.
        const emptyFixture = await openFixture(scratch, 'plan', 'no-pair', language, true);
        try {
            await showFixture(page, emptyFixture, language, false);
            await waitFor('1128 empty record without pair', () => page.evaluate<boolean>(`document.body.dataset.ready === 'true' &&
                document.querySelector('#rig-empty')?.checkVisibility() && !!document.querySelector('#view-menu [data-view="compare"]')`));
            await recordViewportControls(page, command!, language, true);
        } finally {
            await page.goto('about:blank');
            await emptyFixture.close();
        }
        const fixture = await openFixture(scratch, 'plan', 'pair', language, true);
        try {
            const url = new URL(fixture.host.ownerUrl);
            url.searchParams.set('lang', language);
            await page.goto(url.href, language);
            // #1229: on a record, the first declared pair is up from the start with no checkpoint form;
            // a producer checkpoint ask refuses JOB_ASK_INVALID while shared viewport controls keep working.
            await pairView(page, fixture, language, 'after');
            await recordViewportControls(page, command!, language, false);
            const refused = await fixture.refuseAsk();
            assert.equal(refused.status, 409);
            assert.equal(refused.body.ok, false);
            assert.equal(refused.body.error.code, 'JOB_ASK_INVALID');
            await pairView(page, fixture, language, 'after');
            await recordViewportControls(page, command!, language, false);
            const scale = () => page.evaluate<number>("new DOMMatrix(getComputedStyle(document.querySelector('#reference-content')).transform).a");
            await click(page, '#fit');
            const fit = await scale();
            await click(page, '#native-one');
            assert.equal(await scale(), 1);
            await click(page, '#zoom-in');
            assert.ok(await scale() > 1);
            await click(page, '#zoom-out');
            assert.equal(await scale(), 1);
            await click(page, '#fit');
            assert.equal(await scale(), fit);
            await chooseView(page, 'before');
            await pairView(page, fixture, language, 'before');
            await recordViewportControls(page, command!, language, false);
            console.log('1128_CHECKPOINT_PASS ' + language);
        } finally {
            await page.goto('about:blank');
            await fixture.close();
        }
    }
}

/** #1225 / #1229 owner check: a producer that still sends a checkpoint ask receives JOB_ASK_INVALID,
 * and the browser page still renders the record pair or package rig screen plus Send comments without breaking. */
async function checkpointAskRefusalKeepsScreen(page: InputCdpSession, scratch: string) {
    const out: Record<string, unknown> = {};
    for (const route of routes) {
        const fixture = await openFixture(scratch, route, 'pair', 'en', true);
        try {
            const refused = await fixture.refuseAsk();
            assert.equal(refused.status, 409, route + ' checkpoint ask HTTP 409');
            assert.equal(refused.body.ok, false);
            assert.equal(refused.body.error.code, 'JOB_ASK_INVALID', route + ' named refusal');
            await showFixture(page, fixture, 'en');
            assert.deepEqual(await inspectionErrors(page), [], route + ' renders without error banner after refused ask');
            assert.equal(await page.evaluate<number>(`document.querySelectorAll('form[data-job-ask],[id="job-record-asks"],[id="workspace-pending-record-ask"]').length`), 0);
            if (route === 'plan') {
                await pairView(page, fixture, 'en', 'after');
            } else {
                const view = await observe(page, fixture.evidence, 'en');
                assert.equal(view.tiles.length, 0, 'package keeps rig/reference screen');
                assert.ok(await page.evaluate<boolean>(`!!document.querySelector('#rig-root canvas')`), 'package rig canvas drawn');
            }
            const commentText = 'Owner comment after refused checkpoint ask · ' + route;
            if (route === 'package') await click(page, '#stage-comment');
            await page.evaluate(`document.querySelector('[data-comment-general]').click()`);
            await waitFor('general comment input', () => page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(composer + ' input')})`));
            await page.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(composer)}); f.querySelector('input').value = ${JSON.stringify(commentText)}; f.requestSubmit(); })()`);
            await waitFor('general comment saved', () => page.evaluate<boolean>(`!document.querySelector(${JSON.stringify(composer)})`));
            const {actId} = await submitPairComments(page, fixture, route, [{text: commentText}], '[general]\n' + commentText);
            out[route] = {refusal: refused.body.error.code, actId};
            console.log('1225_REFUSAL_SCREEN_PASS ' + route);
        } finally {
            await page.goto('about:blank');
            await fixture.close();
        }
    }
    return out;
}

async function run() {
    const baseline = Bun.argv.includes('--baseline');
    const recordNoAskOnly = Bun.argv.includes('--record-no-ask');
    const comparisonPath = arg('--compare');
    const output = resolve(arg('--out') ?? (baseline ? 'artifacts/716-baseline' : 'artifacts/716'));
    const captures = join(output, 'owner-look');
    await mkdir(captures, {recursive: true});
    const comparison = comparisonPath ? JSON.parse(await readFile(comparisonPath, 'utf8')) as {
        noPair: Record<string, ViewObservation>;
    } : null;
    const scratch = await mkdtemp(join(tmpdir(), 'review-716-browser-'));
    const results = {baseline, noPair: {} as Record<string, ViewObservation>, cases: {} as Record<string, unknown>};
    const replayFailures: string[] = [];
    let page: InputCdpSession | undefined;
    let active = '';
    try {
        page = await launchCdpSession(join(scratch, 'profile'), {sendDeadlineMs: 15_000, onEvent: async (event, send) => {
            if (event.sessionId) command = send;
            if (event.method !== 'Page.javascriptDialogOpening') return;
            assert.equal(event.params?.type, 'beforeunload', 'only departure with unsent test pins is allowed');
            await send('Page.handleJavaScriptDialog', {accept: true});
        }});
        if (Bun.argv.includes('--pair-selection') || Bun.argv.includes('--pair-selection-baseline')) {
            active = 'record-pair-selection';
            results.cases.recordPairSelection = await recordPairSelection(page, scratch, captures,
                Bun.argv.includes('--pair-selection-baseline'));
            await writeFile(join(output, 'observations.json'), JSON.stringify(results, null, 2) + '\n');
            return;
        }
        await page.setViewport(1440, 900);
        if (!baseline) {
            active = 'record-pair-no-ask';
            const noAskScratch = await mkdtemp(join(scratch, 'record-no-ask-'));
            try {
                results.cases.recordPairNoAsk = await recordPairWithoutAsk(page, noAskScratch, captures);
            } finally {
                await rm(noAskScratch, {recursive: true, force: true});
            }
            if (recordNoAskOnly) {
                await writeFile(join(output, 'observations.json'), JSON.stringify(results, null, 2) + '\n');
                return;
            }
            active = 'checkpoint-viewport-controls';
            const viewportScratch = await mkdtemp(join(scratch, 'viewport-controls-'));
            try {
                await checkpointViewportControls(page, viewportScratch);
            } finally {
                await rm(viewportScratch, {recursive: true, force: true});
            }
        }
        if (Bun.argv.includes('--viewport-controls')) return;
        for (const route of routes) {
            // #1229 owner ruling 11-25: deleted package-*-size-mismatch because packages no longer mount the checkpoint tile pair view;
            // plan-*-size-mismatch covers the pair Difference alignment refusal on records.
            const variants: Variant[] = baseline || route === 'package' ? ['no-pair', 'pair'] : ['no-pair', 'pair', 'size-mismatch'];
            for (const variant of variants) {
                for (const language of languages) {
                    active = route + '-' + language + '-' + variant;
                    const fixture = await openFixture(scratch, route, variant, language);
                    try {
                        const key = route + '-' + language;
                        let casePassed = true;
                        await showFixture(page, fixture, language);
                        if (baseline || variant === 'no-pair') {
                            const view = await observe(page, fixture.evidence, language);
                            assert.equal(view.language, language);
                            if (variant === 'no-pair') {
                                results.noPair[key] = view;
                                if (comparison) {
                                    const prior = comparison.noPair[key]!;
                                    const expected = route === 'plan' ? {...prior, controls: prior.controls.map(control => ({...control, disabled: true}))} : prior;
                                    assert.deepEqual(view, expected, active + ' matches baseline with the record viewport availability change');
                                }
                            }
                            assert.equal(view.tiles.length, 0, active + ' evidence tiles drawn');
                            assert.equal(view.differenceCanvases, 0, active + ' Difference canvases');
                            assert.equal(view.differenceEnabled, false, active + ' Difference enabled');
                            results.cases[active] = view;
                            await capture(page, captures, route + '-' + variant + '-' + language);
                            console.log('CHECKPOINT_PAIR_COUNTS ' + JSON.stringify({case: active, tiles: view.tiles.length,
                                canvases: view.differenceCanvases, differenceEnabled: view.differenceEnabled}));
                            if (!baseline && variant === 'no-pair' && route === 'package' && language === 'en')
                                results.cases.historicalManifestReference = await historicalReference(page, fixture);
                        } else if (variant === 'pair' && route === 'package') {
                            // #1229 owner ruling 11-25: converted package-*-pair from mounting the removed tile pair view to verifying
                            // the package keeps its old rig/reference screen while retaining tile-bound pin labels and pin replay.
                            const view = await observe(page, fixture.evidence, language);
                            assert.equal(view.language, language);
                            assert.equal(view.tiles.length, 0, active + ' package does not mount checkpoint pair tiles');
                            assert.equal(view.differenceCanvases, 0, active + ' package has no tile Difference canvas');
                            assert.deepEqual(view.menu.map(option => option.id), ['compare', 'reference', 'rig', 'difference'],
                                active + ' package keeps its standard view switch without pair entries');
                            await capture(page, captures, route + '-pair-removed-' + language);
                            console.log('CHECKPOINT_PAIR_COUNTS ' + JSON.stringify({case: active, tiles: view.tiles.length,
                                canvases: view.differenceCanvases, differenceEnabled: view.differenceEnabled}));
                            const tileReplay = language === 'en' ? await verifyPackageTilePinReplay(page, fixture) : undefined;
                            results.cases[active] = {view, ...(tileReplay ? {tileReplay} : {})};
                        } else if (variant === 'pair') {
                            const result = await runRecordPair(page, fixture, language, captures);
                            results.cases[active] = result;
                            console.log('CHECKPOINT_PAIR_COUNTS ' + JSON.stringify({case: active, ...result.counts}));
                            const replay = result.postSubmitReplay;
                            console.log('CHECKPOINT_PAIR_POST_SUBMIT ' + JSON.stringify({case: active, submittedAct: result.submittedAct, ...replay}));
                            const failedPins = replay.pins.filter(pin => pin.error).map(pin => active + '/' + pin.mode);
                            if (replay.releaseError) replayFailures.push(active + '/release');
                            replayFailures.push(...failedPins);
                            casePassed = replay.released && failedPins.length === 0;
                        } else {
                            const view = await pairView(page, fixture, language, 'after', false);
                            const difference = view.menu.find(option => option.id === 'difference');
                            assert.equal(difference?.reason, catalogs[language][alignment], active + ' names existing size refusal');
                            await click(page, '#view-menu summary');
                            await capture(page, captures, route + '-size-mismatch-' + language);
                            results.cases[active] = view;
                        }
                        if (casePassed) console.log('CHECKPOINT_PAIR_PASS ' + active);
                        await page.goto('about:blank');
                    } finally {
                        await fixture.close();
                    }
                }
            }
        }
        active = 'post-submit-replay';
        if (replayFailures.length) throw new Error('CHECKPOINT_PAIR_POST_SUBMIT_REPLAY ' + replayFailures.join(', '));
        if (!baseline) {
            active = 'outside-pair-control';
            results.cases.outsidePair = await runOutsidePairControl(page, scratch);
            active = 'refused-checkpoint-ask-screen';
            results.cases.refusedCheckpointAskScreen = await checkpointAskRefusalKeepsScreen(page, scratch);
            active = 'record-pair-selection';
            results.cases.recordPairSelection = await recordPairSelection(page, scratch, captures, false);
        }
        await writeFile(join(output, 'observations.json'), JSON.stringify(results, null, 2) + '\n');
    } catch (error) {
        const detail = String(error).replace(/#cap=[^\s"']+/g, '#cap=<redacted>');
        await writeFile(join(output, 'failure.json'), JSON.stringify({active, detail, ...results}, null, 2) + '\n');
        if (page && active !== 'post-submit-replay')
            await page.screenshot().then(png => writeFile(join(output, 'failure.png'), png)).catch(() => {});
        throw new Error(detail);
    } finally {
        try {await page?.close();}
        finally {await rm(scratch, {recursive: true, force: true});}
    }
}

if (import.meta.main) await run();
