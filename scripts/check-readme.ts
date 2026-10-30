import {readFileSync} from 'node:fs';

// #224: post-cut words + 10%, rounded up to 50; the earlier 2,500-word limit wins.
export const README_WORD_CAP = 800;
export const README_HEADINGS = [
  'Links', 'Place in the toolchain', 'Start', 'Existing output handoff', 'Compare two outputs',
  'Feedback ownership', 'Development', 'Frame strip export', 'One-command owner handoff',
  'Control the current inspection page', 'Keep and share an inspection',
  'Workspace settings and panels', 'Inspect animation keys', 'Inspect a part',
  'Chest regions (designate, rebuild, watch)', 'Mesh panel (density, regions, segments → remesh)',
  'Weights (setup pose, watch only)', 'Bones (config anchors, check, rebuild)',
  'Rig fields (regions, still row, stops, inherit, turn)',
  'Cuts (cut polygons, patch boxes, limb joints → rig-parts build)',
  'Mesh edit (typed delta, preview only)', 'Retarget (map, flags → rig-pose, watch)', 'License',
] as const;

export function readmeWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

export function checkReadme(text: string): string[] {
  const failures: string[] = [];
  const words = readmeWords(text);
  if (words > README_WORD_CAP) failures.push(`README_WORD_CAP: ${words} words > ${README_WORD_CAP}`);
  if (/\b(?:measured|read)\s+on\s+20/iu.test(text)) failures.push('README_DATED_MEASUREMENT: dated measurement phrase');
  let fence: {char: string; length: number} | null = null;
  const lines: {text: string; line: number}[] = [];
  for (const [i, line] of text.split(/\r?\n/u).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      const run = marker[1]!;
      if (!fence) fence = {char: run[0]!, length: run.length};
      else if (run[0] === fence.char && run.length >= fence.length && !marker[2]!.trim()) fence = null;
      lines.push({text: '', line: i + 1});
      continue;
    }
    if (fence) { lines.push({text: '', line: i + 1}); continue; }
    const heading = /^ {0,3}##[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/u.exec(line)?.[1];
    if (heading && !README_HEADINGS.some(allowed => allowed === heading)) failures.push(`README_HEADING: line ${i + 1}: ${heading}`);
    lines.push({text: line, line: i + 1});
  }
  // GFM tables may omit the leading/trailing pipes. A delimiter row establishes the table.
  const cells = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
  for (let i = 1; i < lines.length; i++) {
    const delimiter = lines[i]!.text;
    if (!delimiter.includes('|') || !cells(delimiter).every(cell => /^:?-+:?$/u.test(cell))) continue;
    for (let j = i - 1; j < lines.length && lines[j]!.text.includes('|'); j++) {
      const row = lines[j]!;
      if (/\b\d{4}-\d{2}-\d{2}\b/u.test(row.text)) failures.push(`README_TABLE_DATE: line ${row.line}: date inside table cell`);
    }
  }
  return failures;
}

if (import.meta.main) {
  const path = process.argv[2] ?? new URL('../README.md', import.meta.url);
  const text = readFileSync(path, 'utf8');
  const failures = checkReadme(text);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log(`README_OK: ${readmeWords(text)} words <= ${README_WORD_CAP}`);
}
