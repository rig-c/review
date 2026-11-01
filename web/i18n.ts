import { enCatalog } from './catalog-en.ts';
import { koCatalog } from './catalog-ko.ts';
import type { WorkspaceLanguage } from './workspace-preferences.ts';

export type ResolvedLanguage = 'en' | 'ko';

export interface NavigatorLanguageLike {
  readonly languages?: readonly string[];
  readonly language?: string;
}

export interface WebStringExemption {
  readonly file: string;
  readonly match: string;
  readonly reason: string;
}

export interface HardcodedStringViolation {
  readonly file: string;
  readonly line: number;
  readonly kind: 'html-text' | 'html-attr' | 'ts-string';
  readonly text: string;
}

export const WEB_STRING_EXEMPTIONS: readonly WebStringExemption[] = [
  {
    file: 'web/stage-comments.ts',
    match: '*',
    reason: 'Temporary exemption for rig-c/review#276: stage-comments UI stays untouched while #276 is in flight.'
  },
  {
    file: 'web/index.html',
    match: 'Comment',
    reason: 'Temporary exemption for rig-c/review#276: #stage-comment button label stays untouched.'
  },
  {
    file: 'web/index.html',
    match: 'Comments (0)',
    reason: 'Temporary exemption for rig-c/review#276: #stage-comment-list-toggle button label stays untouched.'
  },
  {
    file: 'web/index.html',
    match: 'Comment · C (active mesh editor keeps C)',
    reason: 'Temporary exemption for rig-c/review#276: #stage-comment button title stays untouched.'
  },
  {
    file: 'web/compare.html',
    match: 'Comment',
    reason: 'Temporary exemption for rig-c/review#276: #stage-comment button label stays untouched.'
  },
  {
    file: 'web/compare.html',
    match: 'Comments (0)',
    reason: 'Temporary exemption for rig-c/review#276: #stage-comment-list-toggle button label stays untouched.'
  },
  {
    file: 'web/compare.html',
    match: 'Comment · C (active mesh editor keeps C)',
    reason: 'Temporary exemption for rig-c/review#276: #stage-comment button title stays untouched.'
  },
  {
    file: 'web/index.html',
    match: 'boob_r',
    reason: 'Canonical rig bone identifier example on chest region right bone input.'
  },
  {
    file: 'web/index.html',
    match: 'boob_l',
    reason: 'Canonical rig bone identifier example on chest region left bone input.'
  },
  {
    file: 'web/index.html',
    match: '● R',
    reason: 'Right chest region compact coordinate symbol badge.'
  },
  {
    file: 'web/index.html',
    match: '● L',
    reason: 'Left chest region compact coordinate symbol badge.'
  },
  {
    file: 'web/compare.ts',
    match: 'Frames: {0}–{1} (inclusive; explicit producer frame numbers)',
    reason: 'Exported Markdown issue body stays English and byte-identical across languages (Bar 6).'
  },
  {
    file: 'web/compare.ts',
    match: 'Inspection context:',
    reason: 'Exported Markdown issue body heading stays English and byte-identical across languages (Bar 6).'
  },
  {
    file: 'web/compare.ts',
    match: 'Ordered A/B and reference provenance:',
    reason: 'Exported Markdown issue body heading stays English and byte-identical across languages (Bar 6).'
  },
  {
    file: 'web/compare.ts',
    match: 'Ordered compare provenance:',
    reason: 'Exported Markdown issue body heading stays English and byte-identical across languages (Bar 6).'
  },
  {
    file: 'web/compare.ts',
    match: 'Side: {0}',
    reason: 'Exported Markdown issue body field stays English and byte-identical across languages (Bar 6).'
  },
  {
    file: 'web/compare.ts',
    match: 'Target: {0} / {1}',
    reason: 'Exported Markdown issue body field stays English and byte-identical across languages (Bar 6).'
  },
  {
    file: 'web/compare.ts',
    match: 'Validation warnings (must be corrected before submission):',
    reason: 'Exported Markdown issue body heading stays English and byte-identical across languages (Bar 6).'
  },
  {
    file: 'web/compare.ts',
    match: 'Validation warnings:',
    reason: 'Exported Markdown issue body heading stays English and byte-identical across languages (Bar 6).'
  }
];

export function resolveLanguage(
  preference: WorkspaceLanguage = 'system',
  nav?: NavigatorLanguageLike | null
): ResolvedLanguage {
  if (preference === 'en' || preference === 'ko') return preference;
  const source = nav === undefined ? (typeof navigator !== 'undefined' ? navigator : null) : nav;
  if (!source) return 'en';
  let tag = '';
  if (Array.isArray(source.languages)) {
    for (const entry of source.languages) {
      if (typeof entry === 'string' && entry.trim()) {
        tag = entry.trim().toLowerCase();
        break;
      }
    }
  }
  if (!tag && typeof source.language === 'string') {
    tag = source.language.trim().toLowerCase();
  }
  return tag === 'ko' || tag.startsWith('ko-') || tag.startsWith('ko_') ? 'ko' : 'en';
}

let currentPreference: WorkspaceLanguage = 'system';
let currentLanguage: ResolvedLanguage = resolveLanguage('system');
const listeners = new Set<(lang: ResolvedLanguage) => void>();

export function getLanguage(): ResolvedLanguage {
  return currentLanguage;
}

export function getLanguagePreference(): WorkspaceLanguage {
  return currentPreference;
}

export function syncDocumentLanguage(doc?: Document | null): void {
  const target = doc === undefined ? (typeof document !== 'undefined' ? document : null) : doc;
  if (target?.documentElement) {
    target.documentElement.lang = currentLanguage;
  }
}

export function setLanguagePreference(
  preference: WorkspaceLanguage,
  nav?: NavigatorLanguageLike | null
): ResolvedLanguage {
  currentPreference = preference;
  const resolved = resolveLanguage(preference, nav);
  currentLanguage = resolved;
  syncDocumentLanguage();
  if (boundRoot) {
    applyDomI18n(boundRoot);
  }
  for (const listener of listeners) {
    listener(resolved);
  }
  return resolved;
}

export function onLanguageChange(listener: (lang: ResolvedLanguage) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let enToKoMap: Map<string, string> | null = null;
let koToEnMap: Map<string, string> | null = null;

function ensureMaps(): { enToKo: Map<string, string>; koToEn: Map<string, string> } {
  if (enToKoMap && koToEnMap) return { enToKo: enToKoMap, koToEn: koToEnMap };
  enToKoMap = new Map<string, string>();
  koToEnMap = new Map<string, string>();
  for (const [en, ko] of Object.entries(koCatalog)) {
    enToKoMap.set(en, ko);
    if (!koToEnMap.has(ko) || en === ko) {
      koToEnMap.set(ko, en);
    }
  }
  for (const [en, ko] of Object.entries(koCatalog)) {
    if (en.startsWith(' · ') && ko.startsWith(' · ')) {
      const enSub = en.slice(3);
      const koSub = ko.slice(3);
      if (!enToKoMap.has(enSub)) enToKoMap.set(enSub, koSub);
      if (!koToEnMap.has(koSub)) koToEnMap.set(koSub, enSub);
    }
    const enCode = /^([A-Z][A-Z0-9_]{2,}):\s+([\s\S]+)$/.exec(en);
    const koCode = /^([A-Z][A-Z0-9_]{2,}):\s+([\s\S]+)$/.exec(ko);
    if (enCode && koCode && enCode[1] === koCode[1]) {
      const enDetail = enCode[2]!;
      const koDetail = koCode[2]!;
      if (!enToKoMap.has(enDetail)) enToKoMap.set(enDetail, koDetail);
      if (!koToEnMap.has(koDetail)) koToEnMap.set(koDetail, enDetail);
    }
    const enTrim = en.trim();
    const koTrim = ko.trim();
    if (enTrim && koTrim && (enTrim !== en || koTrim !== ko) && !/^[a-z0-9_.-]+$/.test(enTrim)) {
      if (!enToKoMap.has(enTrim)) enToKoMap.set(enTrim, koTrim);
      if (!koToEnMap.has(koTrim)) koToEnMap.set(koTrim, enTrim);
    }
  }
  return { enToKo: enToKoMap, koToEn: koToEnMap };
}

function getEnToKoMap(): Map<string, string> {
  return ensureMaps().enToKo;
}

function getKoToEnMap(): Map<string, string> {
  return ensureMaps().koToEn;
}

interface CompiledPattern {
  readonly regex: RegExp;
  readonly paramOrder: readonly number[];
  readonly targetTemplate: string;
  readonly literalLength: number;
}

let enToKoPatterns: readonly CompiledPattern[] | null = null;
let koToEnPatterns: readonly CompiledPattern[] | null = null;

function buildPatterns(fromCatalog: Readonly<Record<string, string>>, toCatalog: Readonly<Record<string, string>>): readonly CompiledPattern[] {
  const list: CompiledPattern[] = [];
  const tokenRe = /\{(\d+)\}/g;
  for (const key of Object.keys(fromCatalog)) {
    const srcPattern = fromCatalog[key];
    const dstPattern = toCatalog[key];
    if (!srcPattern || !dstPattern || srcPattern === dstPattern) continue;
    if (!srcPattern.includes('{0}')) continue;
    const literalOnly = srcPattern.replace(tokenRe, '').trim();
    // Skip bare structural patterns that have no alphabetic or Korean words of their own
    if (!/[A-Za-z가-힣]{2,}/.test(literalOnly)) continue;
    const paramOrder: number[] = [];
    const isShortOpenEnded =
      /^\{\d+\}/.test(srcPattern) &&
      /\{\d+\}$/.test(srcPattern) &&
      literalOnly.length < 10 &&
      !literalOnly.includes('·') &&
      !literalOnly.includes(':');
    let regexBody = '^';
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    tokenRe.lastIndex = 0;
    while ((match = tokenRe.exec(srcPattern)) !== null) {
      const literalChunk = srcPattern.slice(lastIndex, match.index);
      regexBody += literalChunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      paramOrder.push(Number(match[1]));
      lastIndex = match.index + match[0].length;
      const isAtEnd = lastIndex === srcPattern.length;
      const nextIsToken = srcPattern.slice(lastIndex).startsWith('{');
      regexBody += isShortOpenEnded
        ? '([^\\s]+)'
        : isAtEnd
          ? '([\\s\\S]*)'
          : nextIsToken
            ? '([\\s\\S]*?)'
            : '([\\s\\S]+?)';
    }
    regexBody += srcPattern.slice(lastIndex).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    try {
      list.push({
        regex: new RegExp(regexBody),
        paramOrder,
        targetTemplate: dstPattern,
        literalLength: literalOnly.length
      });
    } catch {
      // Ignore malformed pattern
    }
  }
  list.sort((a, b) => b.literalLength - a.literalLength);
  return list;
}

function getPatterns(lang: ResolvedLanguage): readonly CompiledPattern[] {
  const { enToKo } = ensureMaps();
  const expandedEn: Record<string, string> = {};
  const expandedKo: Record<string, string> = {};
  for (const [en, ko] of enToKo.entries()) {
    expandedEn[en] = en;
    expandedKo[en] = ko;
  }
  if (lang === 'ko') {
    if (!enToKoPatterns) enToKoPatterns = buildPatterns(expandedEn, expandedKo);
    return enToKoPatterns;
  }
  if (!koToEnPatterns) koToEnPatterns = buildPatterns(expandedKo, expandedEn);
  return koToEnPatterns;
}

export function t(
  key: string,
  params?: Readonly<Record<string, string | number>> | readonly (string | number)[],
  lang: ResolvedLanguage = currentLanguage
): string {
  const catalog = lang === 'ko' ? koCatalog : enCatalog;
  const template = catalog[key] ?? enCatalog[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (full, token: string) => {
    if (Array.isArray(params)) {
      const idx = Number(token);
      return Number.isInteger(idx) && idx >= 0 && idx < params.length ? String(params[idx]) : full;
    }
    const rec = params as Readonly<Record<string, string | number>>;
    return Object.prototype.hasOwnProperty.call(rec, token) ? String(rec[token]) : full;
  });
}

const KNOWN_SHORT_PROSE = new Set([
  'applied',
  'pending',
  'reused',
  'keyed',
  'off',
  'active',
  'pass',
  'error',
  'none',
  'not read',
  'not drawn',
  'not loaded',
  'not set',
  'no diff',
  'no bone',
  'no blink',
  'no turn',
  'no ribs',
  'no range',
  'no counts',
  'no chain',
  'no base'
]);

function shouldTranslateCapturedArg(arg: string, lang: ResolvedLanguage): boolean {
  const trimmed = arg.trim();
  if (!trimmed) return false;
  if (/^-?\d+(\.\d+)?(\s*(s|ms|px|°|×))?$/.test(trimmed)) return false;
  if (/^[0-9a-f]{7,64}…?$/i.test(trimmed)) return false;
  if (lang === 'ko') {
    // Bare single-token lowercase identifier (like a bone/slot/animation name) stays untouched unless in KNOWN_SHORT_PROSE
    if (/^[a-z0-9_.-]+$/.test(trimmed) && !KNOWN_SHORT_PROSE.has(trimmed)) return false;
    if (koCatalog[trimmed] !== undefined && koCatalog[trimmed] !== trimmed) return true;
    if (koCatalog[arg] !== undefined && koCatalog[arg] !== arg) return true;
    if (/^[a-z0-9_.-]+$/i.test(trimmed) && !KNOWN_SHORT_PROSE.has(trimmed)) return false;
    return /[A-Za-z]{2,}/.test(trimmed) && (trimmed.includes(' ') || trimmed.includes('·') || trimmed.includes('('));
  }
  const koToEn = getKoToEnMap();
  if (koToEn.has(trimmed) || koToEn.has(arg)) return true;
  return /[가-힣]/.test(trimmed);
}

function translateCore(text: string, lang: ResolvedLanguage, depth: number): string {
  if (!text || depth > 4) return text;
  if (lang === 'ko') {
    const exact = getEnToKoMap().get(text);
    if (exact !== undefined) return exact;
  } else {
    if (getEnToKoMap().has(text)) return text;
    const rev = getKoToEnMap().get(text);
    if (rev !== undefined) return rev;
  }

  // Preserve leading/trailing whitespace if the trimmed version matches
  const leadMatch = /^(\s+)([\s\S]*?)(\s*)$/.exec(text) || /^(\s*)([\s\S]*?)(\s+)$/.exec(text);
  if (leadMatch && (leadMatch[1] || leadMatch[3])) {
    const inner = leadMatch[2];
    if (inner) {
      const innerTranslated = translateCore(inner, lang, depth + 1);
      if (innerTranslated !== inner) {
        return `${leadMatch[1]}${innerTranslated}${leadMatch[3]}`;
      }
    }
  }

  // Preserve ERROR_CODE: <detail> prefix before wildcard pattern matching
  const codeMatch = /^([A-Z][A-Z0-9_]{2,}):\s+([\s\S]+)$/.exec(text);
  if (codeMatch) {
    const code = codeMatch[1]!;
    const detail = codeMatch[2]!;
    const translatedDetail = translateCore(detail, lang, depth + 1);
    if (translatedDetail !== detail) {
      return `${code}: ${translatedDetail}`;
    }
  }

  // Try parameterized patterns
  const patterns = getPatterns(lang);
  for (const pat of patterns) {
    const m = pat.regex.exec(text);
    if (!m) continue;
    const values = new Map<number, string>();
    for (let i = 0; i < pat.paramOrder.length; i++) {
      const idx = pat.paramOrder[i]!;
      const rawArg = m[i + 1] ?? '';
      const translatedArg = shouldTranslateCapturedArg(rawArg, lang)
        ? translateCore(rawArg, lang, depth + 1)
        : rawArg;
      values.set(idx, translatedArg);
    }
    return pat.targetTemplate.replace(/\{(\d+)\}/g, (full, d: string) => {
      const idx = Number(d);
      return values.has(idx) ? values.get(idx)! : full;
    });
  }

  // Compound delimiters: '\n', ' · ', '; '
  for (const sep of ['\n', ' · ', '; ']) {
    if (text.includes(sep)) {
      const parts = text.split(sep);
      let changed = false;
      const sidePrefix =
        sep === ' · ' && /^(?:[◈◇]\s+)?[AB]$/.test(parts[0]?.trim() ?? '');
      const slotIdx = sep === ' · ' ? (sidePrefix ? 1 : 0) : -1;
      const mapped = parts.map((part, idx) => {
        if (idx === slotIdx && /^[a-z0-9_.-]+$/.test(part.trim()) && !KNOWN_SHORT_PROSE.has(part.trim())) {
          return part;
        }
        if (sep === ' · ' && idx > slotIdx) {
          if (lang === 'ko' && part === 'drawn') {
            changed = true;
            return '그려짐';
          }
          if (lang === 'en' && part === '그려짐') {
            changed = true;
            return 'drawn';
          }
        }
        const next = translateCore(part, lang, depth + 1);
        if (next !== part) changed = true;
        return next;
      });
      if (changed) return mapped.join(sep);
    }
  }

  return text;
}

export function tr(raw: string, lang: ResolvedLanguage = currentLanguage): string {
  if (!raw) return raw;
  return translateCore(raw, lang, 0);
}

// DOM binding state
let boundRoot: Document | Element | null = null;
let domObserver: MutationObserver | null = null;
let isApplyingDom = false;

const textNodeSource = new WeakMap<Node, { en: string; lastApplied: string }>();
const elementHintSource = new WeakMap<Element, { enHtml: string; lastAppliedHtml: string }>();
const elementAttrSource = new WeakMap<Element, Map<string, { en: string; lastApplied: string }>>();

const TRANSLATED_ATTRS = ['aria-label', 'title', 'placeholder', 'aria-valuetext'] as const;

function normalizeHtmlKey(html: string): string {
  return html.replace(/\s+/g, ' ').trim();
}

const CONTEXT_LOWER_KEYS = new Set(['bone', 'box', 'from', 'root', 'silhouette', 'slot', 'tip', 'to', 'vs']);

function isExemptElement(el: Element | null): boolean {
  let cur: Element | null = el;
  while (cur) {
    const id = cur.id;
    if (
      id === 'stage-comment' ||
      id === 'stage-comment-list-toggle' ||
      id === 'target-names' ||
      id === 'feedback-target-names' ||
      id === 'lm-bones' ||
      id === 'applied-diff' ||
      id === 'trace'
    ) {
      return true;
    }
    const cls = typeof cur.className === 'string' ? cur.className : '';
    if (
      cls.includes('feedback-summary') ||
      cls.includes('part-slot-name') ||
      cls.includes('animation-lane-label') ||
      cls.includes('animation-tree-bone-name') ||
      cls.includes('stage-comment')
    ) {
      return true;
    }
    const tag = cur.tagName?.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'KBD') {
      return true;
    }
    if (tag === 'CODE') {
      const parentHint = cur.closest('p.hint');
      if (!parentHint) return true;
    }
    if (tag === 'OPTION') {
      const parentSelect = cur.parentElement;
      const selectId = parentSelect?.id;
      if (
        (selectId === 'animation' ||
          selectId === 'animation-select' ||
          selectId === 'bones-select' ||
          selectId === 'weights-bone' ||
          selectId === 'mesh-segment-bone' ||
          selectId === 'chest-0-bone' ||
          selectId === 'chest-1-bone' ||
          selectId === 'person-select') &&
        (cur as HTMLOptionElement).value !== ''
      ) {
        return true;
      }
    }
    cur = cur.parentElement;
  }
  return false;
}

function applyElementI18n(el: Element, lang: ResolvedLanguage): void {
  if (!el || typeof el.getAttribute !== 'function' || isExemptElement(el)) return;

  // Check attributes
  let attrMap = elementAttrSource.get(el);
  for (const attr of TRANSLATED_ATTRS) {
    const val = el.getAttribute(attr);
    if (val === null || !val.trim()) continue;
    if (!attrMap) {
      attrMap = new Map();
      elementAttrSource.set(el, attrMap);
    }
    const existing = attrMap.get(attr);
    let enVal: string;
    if (!existing || (val !== existing.lastApplied && val !== existing.en)) {
      enVal = getKoToEnMap().get(val) ?? tr(val, 'en');
    } else {
      enVal = existing.en;
    }
    const nextVal = lang === 'ko' ? tr(enVal, 'ko') : enVal;
    attrMap.set(attr, { en: enVal, lastApplied: nextVal });
    if (val !== nextVal) {
      el.setAttribute(attr, nextVal);
    }
  }

  // Check rich <p class="hint"> with inline markup
  if (el.tagName?.toUpperCase() === 'P' && el.classList?.contains('hint') && el.children.length > 0) {
    const currentHtml = normalizeHtmlKey(el.innerHTML);
    const existingHint = elementHintSource.get(el);
    let enHtml: string | undefined;
    if (existingHint && (currentHtml === existingHint.lastAppliedHtml || currentHtml === existingHint.enHtml)) {
      enHtml = existingHint.enHtml;
    } else if (koCatalog[currentHtml] !== undefined) {
      enHtml = currentHtml;
    } else {
      const rev = getKoToEnMap().get(currentHtml);
      if (rev !== undefined) enHtml = rev;
    }
    if (enHtml !== undefined) {
      const nextHtml = lang === 'ko' ? (koCatalog[enHtml] ?? enHtml) : enHtml;
      const normalizedNext = normalizeHtmlKey(nextHtml);
      elementHintSource.set(el, { enHtml, lastAppliedHtml: normalizedNext });
      if (currentHtml !== normalizedNext) {
        el.innerHTML = nextHtml;
      }
    }
  }
}

function applyTextNodeI18n(node: Node, lang: ResolvedLanguage): void {
  const parent = node.parentElement;
  if (!parent || isExemptElement(parent)) return;
  if (parent.tagName?.toUpperCase() === 'P' && parent.classList?.contains('hint') && elementHintSource.has(parent)) {
    return;
  }
  const raw = node.nodeValue;
  if (!raw || !raw.trim()) return;

  const existing = textNodeSource.get(node);
  let enText: string;
  if (!existing || (raw !== existing.lastApplied && raw !== existing.en)) {
    const trimmed = raw.trim();
    const revTrimmed = getKoToEnMap().get(trimmed);
    if (revTrimmed !== undefined) {
      const lead = /^(\s*)/.exec(raw)?.[1] ?? '';
      const trail = /(\s*)$/.exec(raw)?.[1] ?? '';
      enText = `${lead}${revTrimmed}${trail}`;
    } else {
      enText = tr(raw, 'en');
    }
  } else {
    enText = existing.en;
  }

  const enTrimmed = enText.trim();
  if (CONTEXT_LOWER_KEYS.has(enTrimmed) || (/^[a-z0-9_.-]+$/.test(enTrimmed) && enTrimmed !== 'none')) {
    const parentTag = parent.tagName?.toUpperCase();
    const allow =
      parentTag === 'LABEL' ||
      (parentTag === 'SPAN' && enTrimmed === 'vs') ||
      (parentTag === 'OPTION' && (enTrimmed === 'silhouette' || enTrimmed === 'box'));
    if (!allow) return;
  }

  const nextText = lang === 'ko' ? tr(enText, 'ko') : enText;
  textNodeSource.set(node, { en: enText, lastApplied: nextText });
  if (raw !== nextText) {
    node.nodeValue = nextText;
  }
}

export function sourceTextContent(node: Node | null | undefined): string {
  if (!node) return '';
  if (node.nodeType === 3) {
    const entry = textNodeSource.get(node);
    const raw = node.nodeValue ?? '';
    if (entry && (raw === entry.lastApplied || raw === entry.en)) return entry.en;
    return tr(raw, 'en');
  }
  const children = node.childNodes;
  if (children && children.length === 1 && children[0]?.nodeType === 3) {
    return sourceTextContent(children[0]);
  }
  const raw = node.textContent ?? '';
  return raw ? tr(raw, 'en') : '';
}

export function applyDomI18n(root: Document | Element = boundRoot ?? document): void {
  if (!root || isApplyingDom) return;
  isApplyingDom = true;
  try {
    const lang = currentLanguage;
    if ('documentElement' in root && root.documentElement) {
      root.documentElement.lang = lang;
    }
    const rootEl: Element | null =
      'documentElement' in root && root.documentElement
        ? root.documentElement
        : 'body' in root && (root as Document).body
          ? (root as Document).body
          : 'getAttribute' in root
            ? (root as Element)
            : null;
    if (!rootEl) return;

    applyElementI18n(rootEl, lang);
    const elements = typeof rootEl.querySelectorAll === 'function' ? rootEl.querySelectorAll('*') : null;
    if (elements) {
      for (const el of elements) {
        applyElementI18n(el, lang);
      }
    }

    const doc = 'ownerDocument' in rootEl && rootEl.ownerDocument ? rootEl.ownerDocument : (root as Document);
    if (doc && typeof doc.createTreeWalker === 'function') {
      const walker = doc.createTreeWalker(rootEl, 4 /* NodeFilter.SHOW_TEXT */);
      let current: Node | null;
      while ((current = walker.nextNode())) {
        applyTextNodeI18n(current, lang);
      }
    }
  } finally {
    isApplyingDom = false;
  }
}

export function bindDomI18n(root?: Document | Element | null): void {
  const target = root === undefined ? (typeof document !== 'undefined' ? document : null) : root;
  if (!target) return;
  boundRoot = target;
  applyDomI18n(target);

  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  if (typeof MutationObserver !== 'undefined') {
    const observeTarget =
      'documentElement' in target && target.documentElement
        ? target.documentElement
        : 'body' in target && (target as Document).body
          ? (target as Document).body
          : target;
    if (observeTarget) {
      domObserver = new MutationObserver((mutations) => {
        if (isApplyingDom) return;
        isApplyingDom = true;
        try {
          const lang = currentLanguage;
          for (const m of mutations) {
            if (m.type === 'characterData') {
              applyTextNodeI18n(m.target, lang);
            } else if (m.type === 'attributes' && m.target.nodeType === 1) {
              applyElementI18n(m.target as Element, lang);
            } else if (m.type === 'childList') {
              if (m.target.nodeType === 1) {
                applyElementI18n(m.target as Element, lang);
              }
              for (const added of m.addedNodes) {
                if (added.nodeType === 3) {
                  applyTextNodeI18n(added, lang);
                } else if (added.nodeType === 1) {
                  const el = added as Element;
                  applyElementI18n(el, lang);
                  const descendants = el.querySelectorAll?.('*');
                  if (descendants) {
                    for (const d of descendants) applyElementI18n(d, lang);
                  }
                  const doc = el.ownerDocument;
                  if (doc && typeof doc.createTreeWalker === 'function') {
                    const w = doc.createTreeWalker(el, 4);
                    let n: Node | null;
                    while ((n = w.nextNode())) applyTextNodeI18n(n, lang);
                  }
                }
              }
            }
          }
        } finally {
          isApplyingDom = false;
        }
      });
      domObserver.observe(observeTarget, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...TRANSLATED_ATTRS]
      });
    }
  }
}

// Bar 1: Catalogue parity check
export function assertCatalogParity(
  en: Readonly<Record<string, string>> = enCatalog,
  ko: Readonly<Record<string, string>> = koCatalog
): void {
  const enKeys = Object.keys(en);
  const koKeys = new Set(Object.keys(ko));
  for (const key of enKeys) {
    if (!koKeys.has(key)) {
      throw new Error(`CATALOG_MISSING_KEY: koCatalog is missing key ${JSON.stringify(key)}`);
    }
  }
  const enKeySet = new Set(enKeys);
  for (const key of koKeys) {
    if (!enKeySet.has(key)) {
      throw new Error(`CATALOG_EXTRA_KEY: koCatalog has key absent from enCatalog: ${JSON.stringify(key)}`);
    }
  }
  const phRe = /\{\d+\}/g;
  for (const key of enKeys) {
    const enVal = en[key]!;
    const koVal = ko[key]!;
    if (!koVal || typeof koVal !== 'string') {
      throw new Error(`CATALOG_EMPTY_VALUE: koCatalog key ${JSON.stringify(key)} has empty value`);
    }
    const enPh = [...new Set(enVal.match(phRe) ?? [])].sort().join(',');
    const koPh = [...new Set(koVal.match(phRe) ?? [])].sort().join(',');
    if (enPh !== koPh) {
      throw new Error(
        `CATALOG_PLACEHOLDER_MISMATCH: key ${JSON.stringify(key)} has placeholders [${enPh}] in en vs [${koPh}] in ko`
      );
    }
  }
}

// Bar 2: Hardcoded visible string check across web/*.html and web/*.ts
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function isSingleSymbolOrKeycap(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length === 1) return true;
  if (/^[-0-9.,:/×°%+–—?·✓○↗◇●\s]+$/.test(t)) return true;
  return false;
}

function isExemptString(
  file: string,
  text: string,
  exemptions: readonly WebStringExemption[]
): boolean {
  for (const ex of exemptions) {
    if (ex.file === file && (ex.match === '*' || ex.match === text)) {
      return true;
    }
  }
  return false;
}

function tokenizeTsStrings(source: string): ReadonlyArray<{ line: number; norm: readonly string[]; contextBefore: string }> {
  const results: Array<{ line: number; norm: readonly string[]; contextBefore: string }> = [];
  let i = 0;
  const n = source.length;
  let line = 1;

  function canStartRegex(pos: number): boolean {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(source[j]!)) j--;
    if (j < 0) return true;
    const ch = source[j]!;
    if ('([{,;:=!&|?+-*~^%<>'.includes(ch)) return true;
    const wordMatch = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(source.slice(Math.max(0, j - 15), j + 1));
    if (wordMatch && ['return', 'throw', 'case', 'typeof', 'void', 'delete', 'in', 'of', 'new'].includes(wordMatch[0])) {
      return true;
    }
    return false;
  }

  function skipTemplateExpr(start: number): { end: number; expr: string; lines: number } {
    let j = start;
    let depth = 1;
    let addedLines = 0;
    while (j < n && depth > 0) {
      const ch = source[j]!;
      if (ch === '\n') addedLines++;
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch;
        j++;
        while (j < n && source[j] !== q) {
          if (source[j] === '\n') addedLines++;
          if (source[j] === '\\') {
            j += 2;
            continue;
          }
          if (q === '`' && source[j] === '$' && source[j + 1] === '{') {
            const sub = skipTemplateExpr(j + 2);
            addedLines += sub.lines;
            j = sub.end;
            continue;
          }
          j++;
        }
        j++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    return { end: j, expr: source.slice(start, j - 1), lines: addedLines };
  }

  while (i < n) {
    const ch = source[i]!;
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '/' && canStartRegex(i)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (source[i] === '\n' && !inClass) break;
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) {
          i++;
          while (i < n && /[a-z]/i.test(source[i]!)) i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const startLine = line;
      const contextBefore = source.slice(Math.max(0, i - 48), i);
      const q = ch;
      i++;
      let val = '';
      while (i < n && source[i] !== q) {
        if (source[i] === '\n') line++;
        if (source[i] === '\\') {
          const next = source[i + 1];
          if (next === 'n') val += '\n';
          else if (next === 't') val += '\t';
          else if (next !== undefined) val += next;
          i += 2;
          continue;
        }
        val += source[i]!;
        i++;
      }
      i++;
      results.push({ line: startLine, norm: [val], contextBefore });
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      const contextBefore = source.slice(Math.max(0, i - 48), i);
      i++;
      let variants: Array<{ text: string; nextIdx: number }> = [{ text: '', nextIdx: 0 }];
      while (i < n && source[i] !== '`') {
        if (source[i] === '\n') line++;
        if (source[i] === '\\') {
          const next = source[i + 1];
          const app = next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '');
          variants = variants.map((v) => ({ text: v.text + app, nextIdx: v.nextIdx }));
          i += 2;
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          const sub = skipTemplateExpr(i + 2);
          line += sub.lines;
          i = sub.end;
          const pluralMatch = /\?\s*(['"])(|s|es)\1\s*:\s*(['"])(|s|es)\3\s*$/.exec(sub.expr.trim());
          if (pluralMatch) {
            const a = pluralMatch[2]!;
            const b = pluralMatch[4]!;
            const expanded: Array<{ text: string; nextIdx: number }> = [];
            for (const v of variants) {
              expanded.push({ text: v.text + a, nextIdx: v.nextIdx });
              expanded.push({ text: v.text + b, nextIdx: v.nextIdx });
            }
            variants = expanded;
          } else {
            variants = variants.map((v) => ({ text: `${v.text}{${v.nextIdx}}`, nextIdx: v.nextIdx + 1 }));
          }
          continue;
        }
        const c = source[i]!;
        variants = variants.map((v) => ({ text: v.text + c, nextIdx: v.nextIdx }));
        i++;
      }
      i++;
      results.push({ line: startLine, norm: variants.map((v) => v.text), contextBefore });
      continue;
    }
    i++;
  }
  return results;
}

function isNonVisibleTsToken(s: string, contextBefore: string): boolean {
  const t = s.trim();
  if (!t || !/[A-Za-z]{2,}/.test(t)) return true;
  if (/(?:from\s+|import\s*\(\s*)$/.test(contextBefore)) return true;
  if (/(?:querySelector(?:All)?|closest|matches|getElementById|createElement(?:NS)?|getAttribute|setAttribute|removeAttribute|hasAttribute|addEventListener|removeEventListener|classList\.(?:add|remove|toggle|contains))\s*\(\s*$/.test(contextBefore)) {
    return true;
  }
  if (/\.className\s*=\s*$/.test(contextBefore)) return true;
  if (!s.includes(' ')) {
    // Single-token string without spaces: only capitalized UI words (>= 2 letters) are visible labels
    if (!/^[A-Z][a-z]+$/.test(s)) return true;
    if (
      s === 'AbortError' ||
      s === 'Canvas2D' ||
      s === 'WebGL' ||
      s === 'Bearer' ||
      s === 'Space' ||
      s === 'Backspace' ||
      s === 'Enter' ||
      s === 'Escape' ||
      s === 'Home' ||
      s === 'End'
    ) {
      return true;
    }
    return false;
  }
  if (
    s.startsWith('[data-') ||
    s.startsWith('.animation-') ||
    s.startsWith('.mode-switch') ||
    s.startsWith('#') ||
    s.startsWith('(prefers-') ||
    s.startsWith('input[') ||
    s.startsWith('option[') ||
    s.startsWith('button,input') ||
    s.startsWith('textarea,select') ||
    s.startsWith('dialog[open]') ||
    s.startsWith('[role=separator]') ||
    s.startsWith('calc(') ||
    s.startsWith('minmax(') ||
    s.startsWith('radial-gradient(') ||
    s.startsWith('translate(') ||
    s.startsWith('scale(') ||
    s.startsWith('var(')
  ) {
    return true;
  }
  if (
    s === ' workspace-side-' ||
    s === 'workspace-separator workspace-' ||
    s === '|inspector-' ||
    s === 'sticky-header settings-header' ||
    s === 'sticky-header workspace-drawer-header' ||
    s === 'animation-key-lane readonly-lane-track' ||
    s === 'animation-readonly-badge animation-readonly-subrow' ||
    s === 'error idle-refusal' ||
    s === 'hint animation-key-empty' ||
    s === 'hint error physics-reason' ||
    s === 'hint pending' ||
    s === 'hint rebuild-drop-notice' ||
    s === 'mesh-region selected' ||
    s === 'physics-control idle-period' ||
    s === 'physics-control idle-period pending' ||
    s === 'physics-control mesh-param' ||
    s === 'physics-control mesh-param pending' ||
    s === 'physics-control pending' ||
    s === 'physics-table idle-table' ||
    s === 'physics-table physics-locked-table' ||
    s === 'physics-toggle mesh-param-toggle' ||
    s === 'physics-toggle pending' ||
    s === 'reading-tick {0}' ||
    s === 'readings-line scratch' ||
    s === 'readings-line {0}{1}' ||
    s === 'rig-fields-arc inward' ||
    s === 'rig-fields-arc outward' ||
    s === 'rig-fields-handle {0}' ||
    s === 'row requirements-bar' ||
    s === 'row retarget-translate' ||
    s === 'tick-swatch scratch' ||
    s === 'tick-swatch {0}' ||
    s === 'bones-anchor pending' ||
    s === 'cloth-field pending' ||
    s === '0px 0px' ||
    s === '600 11px ui-monospace, monospace' ||
    s === '.json,application/json' ||
    s === 'Bearer ' ||
    s === ' C{0} {1} {2} {3} {4} {5}' ||
    s === ' H{0} V{1}' ||
    s === ' s⁻¹' ||
    s === ' ms' ||
    s === 'a, b, …' ||
    s === '{0}px {1}px minmax(0,1fr) {2}px {3}px'
  ) {
    return true;
  }
  return false;
}

export function checkWebHardcodedStrings(
  files: ReadonlyArray<{ path: string; content: string }>,
  options?: {
    readonly catalog?: Readonly<Record<string, string>>;
    readonly exemptions?: readonly WebStringExemption[];
  }
): {
  readonly ok: boolean;
  readonly violations: readonly HardcodedStringViolation[];
  readonly exemptions: readonly WebStringExemption[];
} {
  const catalog = options?.catalog ?? enCatalog;
  const exemptions = options?.exemptions ?? WEB_STRING_EXEMPTIONS;

  for (const ex of exemptions) {
    if (!ex.file || !ex.match || !ex.reason || !ex.reason.trim()) {
      throw new Error(`I18N_EXEMPTION_REASON_REQUIRED: exemption for ${ex.file} (${ex.match}) is missing a reason`);
    }
  }

  const violations: HardcodedStringViolation[] = [];

  for (const file of files) {
    const relPath = file.path.replace(/\\/g, '/');
    if (
      relPath === 'web/catalog-en.ts' ||
      relPath === 'web/catalog-ko.ts' ||
      relPath === 'web/i18n.ts' ||
      isExemptString(relPath, '*', exemptions)
    ) {
      continue;
    }

    if (relPath.endsWith('.html')) {
      const src = file.content;
      // 1. Check attributes (aria-label, title, placeholder)
      const attrRe = /\b(aria-label|title|placeholder)="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(src)) !== null) {
        const rawVal = m[2]!.replace(/\s+/g, ' ').trim();
        const decodedVal = decodeHtmlEntities(rawVal);
        if (isSingleSymbolOrKeycap(decodedVal)) continue;
        if (catalog[rawVal] !== undefined || catalog[decodedVal] !== undefined) continue;
        if (isExemptString(relPath, rawVal, exemptions) || isExemptString(relPath, decodedVal, exemptions)) continue;
        const line = src.slice(0, m.index).split('\n').length;
        violations.push({ file: relPath, line, kind: 'html-attr', text: decodedVal });
      }

      // 2. Check rich <p class="hint"> blocks and strip matched ones before text-node scan
      const strippedHints = src.replace(/<p class="hint[^"]*">([\s\S]*?)<\/p>/g, (full, inner: string) => {
        const normInner = inner.replace(/\s+/g, ' ').trim();
        const decodedInner = decodeHtmlEntities(normInner);
        if (catalog[normInner] !== undefined || catalog[decodedInner] !== undefined) {
          return '\n'.repeat(full.split('\n').length - 1);
        }
        return full;
      });

      // 3. Check remaining text nodes
      const textRe = />([^<]+)</g;
      while ((m = textRe.exec(strippedHints)) !== null) {
        const normTxt = decodeHtmlEntities(m[1]!.replace(/\s+/g, ' ').trim());
        if (isSingleSymbolOrKeycap(normTxt)) continue;
        if (catalog[normTxt] !== undefined) continue;
        if (isExemptString(relPath, normTxt, exemptions)) continue;
        const line = strippedHints.slice(0, m.index).split('\n').length;
        violations.push({ file: relPath, line, kind: 'html-text', text: normTxt });
      }
    } else if (relPath.endsWith('.ts')) {
      const tokens = tokenizeTsStrings(file.content);
      for (const tok of tokens) {
        for (const variant of tok.norm) {
          if (variant.startsWith('<') && variant.includes('>')) {
            // Inline HTML snippet in TS: check its attributes and text nodes
            const subRes = checkWebHardcodedStrings(
              [{ path: `${relPath}#inline.html`, content: variant }],
              { catalog, exemptions }
            );
            for (const v of subRes.violations) {
              violations.push({ file: relPath, line: tok.line, kind: 'ts-string', text: v.text });
            }
            continue;
          }
          if (isNonVisibleTsToken(variant, tok.contextBefore)) continue;
          if (catalog[variant] !== undefined) continue;
          if (isExemptString(relPath, variant, exemptions)) continue;
          violations.push({ file: relPath, line: tok.line, kind: 'ts-string', text: variant });
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    exemptions
  };
}
