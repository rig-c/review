import {expect, test} from 'bun:test';
import {readFile, lstat, writeFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import {assertRetainedSnapshotIntact} from '../src/job-source.ts';
import {loadPartsView, verdictSource, assertPartsUnchanged} from '../src/parts-view.ts';
import {readPngCrop, resolvedCropPath} from '../src/comment-crops.ts';
import type {PartsIssue} from '../src/parts-comment.ts';

useTemporaryReviewState();
// Public EN packet retained from Nova20261109T204747Z, with incoming nativeCrop=null.
// The original KO request was not retained. Its camera-height variant below is a reconstruction.
const capturedENInput: PartsIssue = {
  "schema": "rig-review-parts-comment/2",
  "id": "88d486e5-3181-4e0f-a20a-d0c65d277403",
  "summary": "Visible boundary defect",
  "parts": [
    {
      "name": "mesh",
      "imageHash": "3c53c17cafd9c4aebfadf42b20b379b35ff9a62099155c709789b16aa38b1287"
    }
  ],
  "sourceHash": "075d92c15bbf51a3b4500186e95df1b2b6170e085675d72a5681c700dfec6d14",
  "imageRegion": {
    "x": 2,
    "y": 2,
    "width": 10,
    "height": 10
  },
  "rigRegion": {
    "x": 2,
    "y": 2,
    "width": 10,
    "height": 10
  },
  "view": {
    "mode": "item",
    "camera": {
      "zoom": 2.44140625,
      "center": {
        "x": 10,
        "y": 10
      },
      "viewport": {
        "width": 437,
        "height": 704
      }
    },
    "cameraSync": false,
    "referenceCamera": null,
    "background": "green",
    "alpha": false,
    "footprints": false,
    "mesh": false,
    "comparison": {
      "mode": "part",
      "opacity": 0.5
    }
  },
  "crop": {
    "path": "comment-crops/2792c6c13a0da8cfb867a6cf2382526327768416d9e7fd81f2f0102227b30d1f.png",
    "sha256": "2792c6c13a0da8cfb867a6cf2382526327768416d9e7fd81f2f0102227b30d1f",
    "png": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEUAAABGCAYAAACaGVmHAAABn0lEQVR4AezSvUoDQRTF8ZuxSEIaN4okT+FTCGon2Fn5ZjaWgpWIPoVPEQXZpBA/CmdNs4WTUwjOXTPmH3JZ9sDO7P7mhP5o0jDfDYLxWxEAZYXEDBRQhICIaAooQkBENAUUISAimgKKEBARTQFFCIiIpmwUivjYn0Y0RUiBAooQEFGWpkwfJlbypC5ZUNJFS78HRZwgKKAIARE5NqVng7jrNv1Yic/JE7mhDOKOndb3bnO0uMwjIFZxQ2n3aizaW3jON715u7Tb1R3lPdR2NT7INrfVmRtGu7A7SrtRSVdQxGmtOYp44w4iUAQyKKAIARHRFFCEgIhoCihCQEQ0BRQhICKaAooQEBFNAUUIiIim/BGK2Ha9I/+mNFs2itNsM4x77qLuKMOmspP6JtscLi7KRWns017CzG1ew5MbjltTPsLcrsfHbnO3fV4eitsbd7CwW1M6eHe3LUARtKCAIgRERFNAEQIioimgCAER0ZTfoIhn/21EU8TRggKKEBARTQFFCIiIpnihzPYfreRJXWhKKrK8B2WJkP5BSUXM7AsAAP//hzKptgAAAAZJREFUAwCdSvOpFN7zMwAAAABJRU5ErkJggg==",
    "width": 69,
    "height": 70
  },
  "nativeCrop": null
};

test('crop409 leads: EN act leaves package immutable and independent KO-height replay keeps exact job source binding', async () => {
    const cases: {root: string; snapshot: string; sourceHash: string; standaloneHash: string;
        verdictOutput: boolean; status: number}[] = [];
    let firstInputs: Record<string, string> | undefined;
    for (const language of ['en', 'ko-reconstructed']) {
        const fixture = await scriptedJobWindowFixture();
        try {
            const publication = await fixture.publish('parts', 'parts-issue');
            expect(publication.source.sourceHash).toBe(capturedENInput.sourceHash);
            const ask = await fixture.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
            const retained = fixture.host.session.retainedSourceV3(publication.publicationId);
            assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals);
            const pkg = await loadPartsView(fixture.packageRoot);
            const standaloneHash = verdictSource(pkg).sha256;
            expect(standaloneHash).not.toBe(publication.source.sourceHash);
            const before = await jobInputHashes(fixture.input.root);
            if (firstInputs) expect(before).toEqual(firstInputs);
            else firstInputs = before;
            const raw = structuredClone(capturedENInput);
            if (language !== 'en') raw.view.camera.viewport.height = 695;
            const descriptor = await (await fetch(fixture.locator + '/publications/' + publication.publicationId)).json();
            const endpoint = fixture.host.origin + descriptor.value.routes.apiBase + 'stage-parts/comment';
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json', Origin: fixture.host.origin,
                    'X-Review-Capability': fixture.host.session.hostCredentials().ui},
                body: JSON.stringify(raw),
            });
            const result = await response.json();
            expect(response.status).toBe(200);
            const comment: PartsIssue = result.comment;
            expect(comment.sourceHash).toBe(publication.source.sourceHash);
            expect(comment.parts).toEqual(raw.parts);
            const original = PNG.sync.read(await readFile(pkg.imagePaths[0]!));
            const actual = PNG.sync.read(await readPngCrop(comment.nativeCrop!));
            const region = raw.imageRegion!;
            const expected = Buffer.alloc(region.width * region.height * 4);
            for (let y = 0; y < region.height; y++) {
                const start = ((region.y + y) * original.width + region.x) * 4;
                original.data.copy(expected, y * region.width * 4, start, start + region.width * 4);
            }
            expect(actual.data).toEqual(expected);
            const pageId = 'crop-diagnostic-' + language;
            const displayed = await fixture.ui('displayed', {publicationId: publication.publicationId, pageId,
                sourceHash: publication.source.sourceHash});
            const displayResult = await displayed.json();
            expect(displayed.status).toBe(200);
            const submitted = await fixture.ui('acts', {
                kind: 'parts-verdict', publicationId: publication.publicationId, askId: ask.askId, pageId,
                displayedNonce: displayResult.value.displayedNonce,
                expectedGeneration: fixture.host.session.status().generation,
                submissionId: 'crop-diagnostic-' + language,
                value: {verdict: 'changes-requested', words: '', issues: [comment]},
            });
            expect(submitted.status).toBe(200);
            expect((await submitted.json()).value.schema).toBe('rig-review/act@6');
            expect(await jobInputHashes(fixture.input.root)).toEqual(before);
            await assertPartsUnchanged(pkg);
            assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals);
            const verdictOutput = await lstat(pkg.verdictPath).then(() => true, () => false);
            expect(verdictOutput).toBe(false);
            cases.push({root: fixture.input.root, snapshot: retained.snapshotRoot,
                sourceHash: publication.source.sourceHash, standaloneHash, verdictOutput, status: response.status});
        } finally {
            await fixture.close();
        }
    }
    expect(cases[0]!.root).not.toBe(cases[1]!.root);
    expect(cases[0]!.snapshot).not.toBe(cases[1]!.snapshot);
    console.log('CROP409_LEADS ' + JSON.stringify({rootsDistinct: true, snapshotsDistinct: true,
        sourceHashes: cases.map(value => value.sourceHash), standaloneHashes: cases.map(value => value.standaloneHash),
        statuses: cases.map(value => value.status), verdictOutputs: cases.map(value => value.verdictOutput),
        boundary: 'KO camera-height replay is reconstructed, not the missing original KO packet.'}));
});

test('crop409 diagnostics retain rejection codes and identify bounded PNG invariants without exposing request text or state paths', async () => {
    const fixture = await scriptedJobWindowFixture();
    try {
        const publication = await fixture.publish('parts', 'parts-issue');
        const descriptor = await (await fetch(fixture.locator + '/publications/' + publication.publicationId)).json();
        const endpoint = fixture.host.origin + descriptor.value.routes.apiBase + 'stage-parts/comment';
        const post = (issue: PartsIssue) => fetch(endpoint, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Origin: fixture.host.origin,
                'X-Review-Capability': fixture.host.session.hostCredentials().ui},
            body: JSON.stringify(issue),
        });
        const before = await jobInputHashes(fixture.input.root);
        const cases: {field: string; expected: string | number[]; received: string | number[];
            mutate: (issue: PartsIssue) => void}[] = [
            {field: 'crop.dimensions', expected: [69, 69], received: [69, 70],
                mutate: issue => { issue.crop.height = 69; }},
            {field: 'crop.sha256', expected: 'f'.repeat(64), received: capturedENInput.crop.sha256,
                mutate: issue => { issue.crop.sha256 = 'f'.repeat(64); issue.crop.path = `comment-crops/${issue.crop.sha256}.png`; }},
            {field: 'rigRegion', expected: 'exact placement plus imageRegion', received: 'rejected by existing validator',
                mutate: issue => { issue.rigRegion.x += 1; }},
            {field: 'crop', expected: 'bounded content-addressed PNG metadata', received: 'rejected by existing validator',
                mutate: issue => { issue.crop.path = '/private/request-must-not-be-returned.png'; }},
        ];
        for (const control of cases) {
            const issue = structuredClone(capturedENInput);
            issue.summary = 'private reviewer text must not be returned';
            control.mutate(issue);
            const response = await post(issue);
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body.error).toEqual({code: 'JOB_SOURCE_MISMATCH', message: 'JOB_SOURCE_MISMATCH',
                diagnostic: {field: control.field, expected: control.expected, received: control.received}});
            expect(JSON.stringify(body)).not.toContain(issue.summary);
            expect(JSON.stringify(body)).not.toContain(fixture.input.root);
            expect(JSON.stringify(body)).not.toContain('request-must-not-be-returned');
            expect(JSON.stringify(body)).not.toContain('data:image');
        }
        const stale = structuredClone(capturedENInput);
        stale.sourceHash = 'f'.repeat(64);
        const staleResponse = await post(stale);
        expect(staleResponse.status).toBe(409);
        expect((await staleResponse.json()).error).toEqual({code: 'JOB_ACT_SOURCE_STALE', message: 'JOB_ACT_SOURCE_STALE'});
        const staleImage = structuredClone(capturedENInput);
        staleImage.parts[0]!.imageHash = 'f'.repeat(64);
        const staleImageResponse = await post(staleImage);
        expect(staleImageResponse.status).toBe(409);
        expect((await staleImageResponse.json()).error).toEqual({code: 'PARTS_COMMENT_STALE_SOURCE', message: 'PARTS_COMMENT_STALE_SOURCE'});
        // Reuse content-addressed evidence, then plant corruption only in this test's derived state.
        expect((await post(structuredClone(capturedENInput))).status).toBe(200);
        const storedPath = resolvedCropPath(capturedENInput.crop.path);
        const storedBytes = await readFile(storedPath);
        try {
            await writeFile(storedPath, 'test-only corrupt derived evidence');
            const response = await post(structuredClone(capturedENInput));
            expect(response.status).toBe(409);
            expect((await response.json()).error).toEqual({code: 'JOB_SOURCE_MISMATCH', message: 'JOB_SOURCE_MISMATCH',
                diagnostic: {field: 'crop.storage', expected: 'regular file with matching SHA-256', received: 'rejected by existing validator'}});
        } finally {
            await writeFile(storedPath, storedBytes);
        }
        expect((await post(structuredClone(capturedENInput))).status).toBe(200);
        expect(await jobInputHashes(fixture.input.root)).toEqual(before);
        const retained = fixture.host.session.retainedSourceV3(publication.publicationId);
        assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals);
        console.log('CROP409_DIAGNOSTIC_CONTROLS ' + JSON.stringify({fields: [...cases.map(control => control.field), 'crop.storage'],
            sourceMismatchCodePreserved: true, staleCodesPreserved: true, recoveredAfterDerivedStateRestore: true,
            boundary: 'Planted invalid controls exercise diagnostics. They do not establish the original KO failure cause.'}));
    } finally {
        await fixture.close();
    }
});
