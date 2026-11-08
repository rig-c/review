import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';

export type HalfOpenBox = readonly [left: number, top: number, right: number, bottom: number];
export type RgbaTuple = readonly [r: number, g: number, b: number, a: number];

export interface PartsViewportOracleLayout {
    readonly viewport: {readonly width: number; readonly height: number};
    readonly backgroundRgba: RgbaTuple;
    readonly leftROI: HalfOpenBox;
    readonly rightAdjacent: HalfOpenBox;
}

export const KNOWN_PARTS_VIEWPORT_LAYOUT: PartsViewportOracleLayout = {
    viewport: {width: 1440, height: 960},
    backgroundRgba: [13, 21, 43, 255],
    leftROI: [242, 706, 739, 928],
    rightAdjacent: [739, 706, 1426, 928],
};

export interface RegionPixelCount {
    readonly box: HalfOpenBox;
    readonly width: number;
    readonly height: number;
    readonly totalPixels: number;
    readonly backgroundPixels: number;
    readonly nonBgPixels: number;
}

export interface PartsViewportPaintObservation {
    readonly supportedViewport: boolean;
    readonly inBounds: boolean;
    readonly viewport: {readonly width: number; readonly height: number};
    readonly expectedViewport: {readonly width: number; readonly height: number};
    readonly backgroundRgba: RgbaTuple;
    readonly leftROI: RegionPixelCount;
    readonly rightAdjacent: RegionPixelCount;
}

function isBoxValidAndInBounds(box: HalfOpenBox, width: number, height: number): boolean {
    const [left, top, right, bottom] = box;
    return (
        Number.isInteger(left) &&
        Number.isInteger(top) &&
        Number.isInteger(right) &&
        Number.isInteger(bottom) &&
        left >= 0 &&
        top >= 0 &&
        left < right &&
        top < bottom &&
        right <= width &&
        bottom <= height
    );
}

function countRegionPixels(
    png: PNG,
    box: HalfOpenBox,
    backgroundRgba: RgbaTuple,
    inBounds: boolean,
): RegionPixelCount {
    const [left, top, right, bottom] = box;
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const totalPixels = width * height;
    if (!inBounds) {
        return {box, width, height, totalPixels, backgroundPixels: 0, nonBgPixels: 0};
    }
    const [bgR, bgG, bgB, bgA] = backgroundRgba;
    let backgroundPixels = 0;
    let nonBgPixels = 0;
    for (let y = top; y < bottom; y++) {
        let offset = (y * png.width + left) * 4;
        for (let x = left; x < right; x++, offset += 4) {
            const r = png.data[offset];
            const g = png.data[offset + 1];
            const b = png.data[offset + 2];
            const a = png.data[offset + 3];
            if (r === bgR && g === bgG && b === bgB && a === bgA) {
                backgroundPixels++;
            } else {
                nonBgPixels++;
            }
        }
    }
    return {box, width, height, totalPixels, backgroundPixels, nonBgPixels};
}

export function inspectPartsViewportPng(
    pngBytes: Uint8Array | Buffer | null | undefined,
    layout: PartsViewportOracleLayout = KNOWN_PARTS_VIEWPORT_LAYOUT,
): PartsViewportPaintObservation {
    if (!pngBytes || pngBytes.byteLength === 0) {
        throw new Error('JOB_WINDOW_PARTS_SCREENSHOT_UNAVAILABLE: full-viewport PNG buffer is empty or missing');
    }
    let png: PNG;
    try {
        png = PNG.sync.read(Buffer.from(pngBytes));
    } catch (error) {
        throw new Error(
            'JOB_WINDOW_PARTS_SCREENSHOT_UNAVAILABLE: failed to decode PNG (' +
                (error instanceof Error ? error.message : String(error)) +
                ')',
        );
    }
    const supportedViewport =
        png.width === layout.viewport.width && png.height === layout.viewport.height;
    const leftInBounds = isBoxValidAndInBounds(layout.leftROI, png.width, png.height);
    const rightInBounds = isBoxValidAndInBounds(layout.rightAdjacent, png.width, png.height);
    const inBounds = supportedViewport && leftInBounds && rightInBounds;
    return {
        supportedViewport,
        inBounds,
        viewport: {width: png.width, height: png.height},
        expectedViewport: layout.viewport,
        backgroundRgba: layout.backgroundRgba,
        leftROI: countRegionPixels(png, layout.leftROI, layout.backgroundRgba, inBounds),
        rightAdjacent: countRegionPixels(png, layout.rightAdjacent, layout.backgroundRgba, inBounds),
    };
}

export function assertPartsViewportOracle(observation: PartsViewportPaintObservation): void {
    if (!observation.supportedViewport || !observation.inBounds) {
        throw new Error(
            `JOB_WINDOW_PARTS_VIEWPORT_OUT_OF_BOUNDS: expected ${observation.expectedViewport.width}x${observation.expectedViewport.height} supporting leftROI=${JSON.stringify(observation.leftROI.box)} and rightAdjacent=${JSON.stringify(observation.rightAdjacent.box)}, got ${observation.viewport.width}x${observation.viewport.height}`,
        );
    }
    if (observation.leftROI.nonBgPixels === 0 && observation.rightAdjacent.nonBgPixels > 0) {
        throw new Error(
            `JOB_WINDOW_PARTS_LEFT_ROI_BLANK: known fixture leftROI ${JSON.stringify(observation.leftROI.box)} has 0/${observation.leftROI.totalPixels} non-background pixels (all rgba(${observation.backgroundRgba.join(',')})) while rightAdjacent ${JSON.stringify(observation.rightAdjacent.box)} has ${observation.rightAdjacent.nonBgPixels}/${observation.rightAdjacent.totalPixels} non-background pixels`,
        );
    }
    if (observation.leftROI.nonBgPixels <= 0 || observation.rightAdjacent.nonBgPixels <= 0) {
        throw new Error(
            `JOB_WINDOW_PARTS_ROI_UNPOPULATED: leftROI nonBgPixels=${observation.leftROI.nonBgPixels}, rightAdjacent nonBgPixels=${observation.rightAdjacent.nonBgPixels}`,
        );
    }
}

export function evaluatePartsViewportPng(
    pngBytes: Uint8Array | Buffer | null | undefined,
    layout: PartsViewportOracleLayout = KNOWN_PARTS_VIEWPORT_LAYOUT,
): PartsViewportPaintObservation {
    const observation = inspectPartsViewportPng(pngBytes, layout);
    assertPartsViewportOracle(observation);
    return observation;
}

if (import.meta.main) {
    const target = Bun.argv[2];
    if (!target) {
        console.error('Usage: bun tests/helpers/job-window-paint.ts <png-path>');
        process.exit(2);
    }
    const bytes = await readFile(target);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const observation = inspectPartsViewportPng(bytes);
    try {
        assertPartsViewportOracle(observation);
        console.log(JSON.stringify({ok: true, target, sha256, observation}));
    } catch (error) {
        console.error(
            JSON.stringify({
                ok: false,
                target,
                sha256,
                error: error instanceof Error ? error.message : String(error),
                observation,
            }),
        );
        process.exit(1);
    }
}
