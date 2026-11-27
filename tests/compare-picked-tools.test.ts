import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { readingSeekTime } from '../src/readings.ts';
import { formatSeconds } from '../web/format-seconds.ts';

const comparePickedSource = await readFile(new URL('../web/compare-picked-tools.ts', import.meta.url), 'utf8');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) {
    throw new Error(`Slice markers not found: ${startMarker} .. ${endMarker}`);
  }
  return source.slice(start, end);
}

test('#1302: Compare seekReading refuses a reading time outside the shared domain without seeking', async () => {
  const fnCode = transpiler.transformSync(
    sliceBetween(comparePickedSource, '  function seekReading(', '  function sampleLocals('),
  );
  const makeSeekReading = new Function('scope', `with (scope) { ${fnCode}; return seekReading; }`);

  const sought: number[] = [];
  const messages: Array<{ text: string; error: boolean }> = [];
  let pauses = 0;
  let messageElError = false;
  const fakeDoc = {
    getElementById: (id: string) =>
      id === 'message' ? { classList: { contains: (c: string) => c === 'error' && messageElError } } : null,
  };
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });

  try {
    const seekReading = makeSeekReading({
      readingSeekTime,
      formatSeconds,
      clipDuration: () => 2,
      host: {
        duration: () => 1,
        pause: () => { pauses++; },
        message: (text: string, error = false) => {
          messageElError = error;
          messages.push({ text, error });
        },
        seekTo: async (t: number) => {
          messageElError = false;
          sought.push(t);
        },
      },
    }) as (clip: string, frame: number, exact: number | null, label: string) => void;

    // 1. Out-of-domain reading time (1.5 s > 1.0 s shared domain end) is refused with no seek.
    seekReading('inspect', 36, 1.5, 'inspected · folds worst');
    await Promise.resolve();
    expect(sought).toEqual([]);
    expect(pauses).toBe(1);
    expect(messages).toEqual([
      {
        text: 'Explicit time 1.5 s is outside the current range of 1 s. No substitute time was used.',
        error: true,
      },
    ]);

    // 2. Negative or non-finite time is also refused without seeking.
    seekReading('inspect', 0, -0.25, 'inspected · folds worst');
    await Promise.resolve();
    expect(sought).toEqual([]);
    expect(messages.at(-1)).toEqual({
      text: 'Explicit time -0.25 s is outside the current range of 1 s. No substitute time was used.',
      error: true,
    });

    // 3. In-domain reading time seeks normally and reports the reading time.
    seekReading('inspect', 12, 0.5, 'inspected · folds worst');
    await Promise.resolve();
    expect(sought).toEqual([0.5]);
    expect(messages.at(-1)).toEqual({
      text: 'Reading · inspected · folds worst → F12 · 0.5000 s',
      error: false,
    });
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
