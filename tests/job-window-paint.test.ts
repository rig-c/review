import {describe, expect, test} from 'bun:test';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {
    KNOWN_PARTS_VIEWPORT_LAYOUT,
    assertPartsViewportOracle,
    evaluatePartsViewportPng,
    inspectPartsViewportPng,
    type HalfOpenBox,
    type RgbaTuple,
} from './helpers/job-window-paint.ts';

function buildSyntheticPng(
    width: number,
    height: number,
    fill: RgbaTuple = KNOWN_PARTS_VIEWPORT_LAYOUT.backgroundRgba,
    patches: readonly {box: HalfOpenBox; rgba: RgbaTuple}[] = [],
): Buffer {
    const png = new PNG({width, height});
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            png.data[offset] = fill[0];
            png.data[offset + 1] = fill[1];
            png.data[offset + 2] = fill[2];
            png.data[offset + 3] = fill[3];
        }
    }
    for (const patch of patches) {
        const [left, top, right, bottom] = patch.box;
        for (let y = top; y < bottom; y++) {
            for (let x = left; x < right; x++) {
                const offset = (y * width + x) * 4;
                png.data[offset] = patch.rgba[0];
                png.data[offset + 1] = patch.rgba[1];
                png.data[offset + 2] = patch.rgba[2];
                png.data[offset + 3] = patch.rgba[3];
            }
        }
    }
    return PNG.sync.write(png);
}

describe('job-window parts full-viewport paint oracle', () => {
    test('counts leftROI and rightAdjacent non-background pixels and accepts populated synthetic control', () => {
        const png = buildSyntheticPng(1440, 960, KNOWN_PARTS_VIEWPORT_LAYOUT.backgroundRgba, [
            {box: [250, 710, 260, 720], rgba: [200, 120, 80, 255]},
            {box: [740, 710, 760, 725], rgba: [90, 180, 210, 255]},
        ]);
        const observation = evaluatePartsViewportPng(png);
        expect(observation.supportedViewport).toBe(true);
        expect(observation.inBounds).toBe(true);
        expect(observation.viewport).toEqual({width: 1440, height: 960});
        expect(observation.leftROI.box).toEqual([242, 706, 739, 928]);
        expect(observation.leftROI.totalPixels).toBe(110_334);
        expect(observation.leftROI.nonBgPixels).toBe(100);
        expect(observation.leftROI.backgroundPixels).toBe(110_234);
        expect(observation.rightAdjacent.box).toEqual([739, 706, 1426, 928]);
        expect(observation.rightAdjacent.totalPixels).toBe(152_514);
        expect(observation.rightAdjacent.nonBgPixels).toBe(300);
        expect(observation.rightAdjacent.backgroundPixels).toBe(152_214);
    });

    test('rejects synthetic control when leftROI is all background while rightAdjacent is populated', () => {
        const png = buildSyntheticPng(1440, 960, KNOWN_PARTS_VIEWPORT_LAYOUT.backgroundRgba, [
            {box: [745, 715, 765, 735], rgba: [120, 200, 140, 255]},
        ]);
        const observation = inspectPartsViewportPng(png);
        expect(observation.leftROI.nonBgPixels).toBe(0);
        expect(observation.rightAdjacent.nonBgPixels).toBe(400);
        expect(() => assertPartsViewportOracle(observation)).toThrow(/JOB_WINDOW_PARTS_LEFT_ROI_BLANK/);
    });

    test('refuses unsupported viewport dimensions and out-of-bounds ROI geometry honestly', () => {
        const wrongViewport = buildSyntheticPng(1280, 720);
        const wrongObs = inspectPartsViewportPng(wrongViewport);
        expect(wrongObs.supportedViewport).toBe(false);
        expect(wrongObs.inBounds).toBe(false);
        expect(() => assertPartsViewportOracle(wrongObs)).toThrow(/JOB_WINDOW_PARTS_VIEWPORT_OUT_OF_BOUNDS/);

        const validViewport = buildSyntheticPng(1440, 960);
        const outOfBoundsObs = inspectPartsViewportPng(validViewport, {
            ...KNOWN_PARTS_VIEWPORT_LAYOUT,
            rightAdjacent: [739, 706, 1441, 928],
        });
        expect(outOfBoundsObs.supportedViewport).toBe(true);
        expect(outOfBoundsObs.inBounds).toBe(false);
        expect(() => assertPartsViewportOracle(outOfBoundsObs)).toThrow(/JOB_WINDOW_PARTS_VIEWPORT_OUT_OF_BOUNDS/);
    });

    test('refuses unavailable or corrupt PNG buffers honestly', () => {
        expect(() => inspectPartsViewportPng(Buffer.alloc(0))).toThrow(/JOB_WINDOW_PARTS_SCREENSHOT_UNAVAILABLE/);
        expect(() => inspectPartsViewportPng(Buffer.from('not-a-png'))).toThrow(
            /JOB_WINDOW_PARTS_SCREENSHOT_UNAVAILABLE/,
        );
    });

    const originalPath = '.review-508-input/original/parts.png';
    const diagnosticPath = '.review-508-input/diagnostic/parts.png';
    test.skipIf(!existsSync(originalPath) || !existsSync(diagnosticPath))(
        'evaluates staged offline .review-508-input PNGs when present without committing historical screenshots',
        async () => {
            const originalBytes = await readFile(originalPath);
            const diagnosticBytes = await readFile(diagnosticPath);
            expect(createHash('sha256').update(originalBytes).digest('hex')).toBe(
                '296cece9812e0a31be9e16cbfdc649cd2823fe2dac7890ada5467c902ed51099',
            );
            expect(createHash('sha256').update(diagnosticBytes).digest('hex')).toBe(
                'f3fe90387cff946157dfe6dd99aad85cd27c226b7d2aa5733c3f3823bb8ef28f',
            );

            const originalObs = inspectPartsViewportPng(originalBytes);
            expect(originalObs.leftROI.nonBgPixels).toBe(0);
            expect(originalObs.leftROI.backgroundPixels).toBe(110_334);
            expect(originalObs.rightAdjacent.nonBgPixels).toBe(67_331);
            expect(() => assertPartsViewportOracle(originalObs)).toThrow(/JOB_WINDOW_PARTS_LEFT_ROI_BLANK/);

            const diagnosticObs = evaluatePartsViewportPng(diagnosticBytes);
            expect(diagnosticObs.leftROI.nonBgPixels).toBe(53_622);
            expect(diagnosticObs.rightAdjacent.nonBgPixels).toBe(67_331);
        },
    );
});
