// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// A command-line tool that reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none, printing
// what it changed or why it failed. Node 22, standard library alone; run as
// `node main.ts [options] [PATCH]`.
//
// SPEC.md is the whole contract. Every sentence below follows it; where a
// behaviour looks odd (a trailing blank line dropped here, a `\` line there)
// it is the spec's sentence, not a shortcut.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing written. */
class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed: its code and the path it concerns. */
class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`,
 *  and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';
const trailingTrim = (s: string): string => s.replace(/[ \t]+$/, '');

/** A line as a matching tier sees it: tier 0 exact, tier 1 trailing spaces/tabs
 *  removed, tier 2 leading and trailing spaces/tabs removed. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trailingTrim(s);
  return trailingTrim(s.replace(/^[ \t]+/, ''));
}

/** A file as lines: its line break is CRLF when its first line feed follows a
 *  carriage return, LF otherwise; it ends with a line break when its text ends
 *  with that break, and that last empty piece is not a line. */
interface FileModel {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function toModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk. Successful moves are remembered so the output can
 *  print an `R old -> new` line for them. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

// ---------------------------------------------------------------------------
// Matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

/** Positions where O occurs in `lines` at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** Does O occur at `pos` in `lines` at one tier? */
function matchesAt(lines: string[], o: string[], pos: number, tier: number): boolean {
  if (pos < 0 || pos + o.length > lines.length) return false;
  for (let j = 0; j < o.length; j++) {
    if (normLine(lines[pos + j]!, tier) !== normLine(o[j]!, tier)) return false;
  }
  return true;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs
 *  at least once, with every occurrence at that tier. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, o, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** As findTier, but only occurrences at or after `from`. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, o, t).filter((p) => p >= from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The lines that replace a matched block. A context line (one of both O and N)
 *  is written as the file's own matched line, never the patch's. At tier 2
 *  every other line of N is re-indented: F is the leading spaces and tabs of
 *  the file's first matched line and P those of O's first line; a line of N
 *  that is not empty and not only whitespace, and starts with P, has that P
 *  replaced by F. At tiers 0 and 1 the lines of N are written as they are.
 *  `ctxOfN[j]` is the index in O of N's j-th line when it is a context line,
 *  else -1. With an empty O there is nothing to re-indent from, so N is
 *  written as it is. */
function replacementLines(
  o: string[],
  n: string[],
  ctxOfN: number[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  const out: string[] = [];
  for (let j = 0; j < n.length; j++) {
    const ci = ctxOfN[j]!;
    if (ci >= 0) {
      out.push(fileLines[pos + ci]!);
      continue;
    }
    let line = n[j]!;
    if (tier === 2 && o.length > 0) {
      const f = leadingWs(fileLines[pos]!);
      const p = leadingWs(o[0]!);
      if (line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  backslash: boolean;
  rawEmpty: boolean;
}

interface UniHunk {
  a: number;
  items: BodyItem[];
  o: string[];
  n: string[];
  ctxOfN: number[];
  backslashAfterLast: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: UniHunk[];
}

/** The path a `--- ` or `+++ ` line names: the text after the four characters,
 *  up to the first tab, with surrounding spaces removed. `/dev/null` is null. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  return raw;
}

/** A leading `a/` or `b/` is removed from a header path. */
function stripPrefix(p: string | null): string | null {
  if (p === null) return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curHasPaths = false;
  let headerDone = false;
  const startSection = (): UniSection => {
    const s: UniSection = {
      oldPath: null,
      newPath: null,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      isNew: false,
      isDeleted: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  const startsHeaderPair = (i: number): boolean =>
    lines[i]!.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');

  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(L);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      curHasPaths = false;
      headerDone = false;
      i++;
      continue;
    }
    if (startsHeaderPair(i)) {
      if (cur === null || headerDone || curHasPaths) {
        cur = startSection();
        curHasPaths = false;
        headerDone = false;
      }
      cur.oldPath = stripPrefix(headerPath(L));
      cur.newPath = stripPrefix(headerPath(lines[i + 1]!));
      curHasPaths = true;
      i += 2;
      continue;
    }
    if (L.startsWith('--- ')) {
      if (cur !== null && !headerDone) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(L);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      headerDone = true;
      const items: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const B = lines[j]!;
        if (B.startsWith('diff --git ')) break;
        if (startsHeaderPair(j)) break;
        if (B === '' || B.startsWith(' ') || B.startsWith('-') || B.startsWith('+') || B.startsWith('\\')) {
          if (B.startsWith('\\')) {
            if (items.length === 0) throw new Exit2(`error: parse ${j + 1}`);
            items[items.length - 1]!.backslash = true;
          } else if (B === '') {
            items.push({ kind: 'ctx', text: '', backslash: false, rawEmpty: true });
          } else if (B.startsWith(' ')) {
            items.push({ kind: 'ctx', text: B.slice(1), backslash: false, rawEmpty: false });
          } else if (B.startsWith('-')) {
            items.push({ kind: 'old', text: B.slice(1), backslash: false, rawEmpty: false });
          } else {
            items.push({ kind: 'new', text: B.slice(1), backslash: false, rawEmpty: false });
          }
          j++;
        } else {
          break;
        }
      }
      while (items.length > 0 && items[items.length - 1]!.rawEmpty) items.pop();
      const o: string[] = [];
      const n: string[] = [];
      const ctxOfN: number[] = [];
      for (const it of items) {
        if (it.kind === 'ctx') {
          ctxOfN.push(o.length);
          o.push(it.text);
          n.push(it.text);
        } else if (it.kind === 'old') {
          o.push(it.text);
        } else {
          ctxOfN.push(-1);
          n.push(it.text);
        }
      }
      let backslashAfterLast = false;
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k]!;
        if (it.kind === 'ctx' || it.kind === 'new') {
          backslashAfterLast = it.backslash;
          break;
        }
      }
      cur.hunks.push({ a: Number(m[1]), items, o, n, ctxOfN, backslashAfterLast });
      i = j;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (L.startsWith('rename from ')) cur.renameFrom = L.slice('rename from '.length).trim();
      else if (L.startsWith('rename to ')) cur.renameTo = L.slice('rename to '.length).trim();
      else if (L.startsWith('new file mode')) cur.isNew = true;
      else if (L.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i++;
  }
  return sections.map((s) => (tree: Tree) => applyUnifiedSection(tree, s, strict));
}

/** The hunks of a section, in order, applied to a file's lines. `d` is the sum
 *  over this section's hunks applied so far of (N's length minus O's length). */
function applyHunksToModel(model: FileModel, hunks: UniHunk[], strict: boolean, failPath: string): FileModel {
  let lines = [...model.lines];
  let finalBr = model.finalBr;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(lines, h.o, strict);
      if (!found) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const rep = replacementLines(h.o, h.n, h.ctxOfN, lines, best, found.tier);
      if (best + h.o.length === lines.length) finalBr = !h.backslashAfterLast;
      lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + h.o.length)];
      d += h.n.length - h.o.length;
    } else {
      const at = Math.min(h.a + d, lines.length);
      if (at === lines.length) finalBr = !h.backslashAfterLast;
      lines = [...lines.slice(0, at), ...h.n, ...lines.slice(at)];
      d += h.n.length;
    }
  }
  return { lines, br: model.br, finalBr };
}

function applyUnifiedSection(tree: Tree, s: UniSection, strict: boolean): void {
  const oldPath = s.oldPath ?? s.renameFrom ?? s.diffOld;
  const newPath = s.newPath ?? s.renameTo ?? s.diffNew;
  if (s.isNew || oldPath === null) {
    // A creation: the new path does not exist; the file is the `+` lines of
    // all its hunks, in order, written with LF breaks.
    const p = newPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const plus: string[] = [];
    let lastPlusBackslash = false;
    for (const h of s.hunks) {
      for (const it of h.items) {
        if (it.kind === 'new') {
          plus.push(it.text);
          lastPlusBackslash = it.backslash;
        }
      }
    }
    tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
    return;
  }
  const op = oldPath!;
  if (s.isDeleted || newPath === null) {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.set(op, null);
    return;
  }
  const np = newPath!;
  if (op !== np) {
    // A move: the old path exists, the new path does not; the hunks are
    // applied to the old file's lines and the result is written at the new
    // path, the old path deleted.
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    if (tree.get(np) !== null) throw new Fail('exists', np);
    const model = applyHunksToModel(toModel(text), s.hunks, strict, op);
    tree.set(np, fromModel(model));
    tree.set(op, null);
    tree.moves.push({ old: op, new: np });
    return;
  }
  if (!safe(op)) throw new Fail('unsafe', op);
  const text = tree.get(op);
  if (text === null) throw new Fail('missing', op);
  const model = applyHunksToModel(toModel(text), s.hunks, strict, op);
  tree.set(op, fromModel(model));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  old: string[];
  new: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (;;) {
    let j = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    let eq = -1;
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${j + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${j + 1}`);
    let path: string | null = null;
    for (let t = j - 1; t > prevEnd; t--) {
      const L = lines[t]!;
      if (blank(L)) continue;
      if (L.trim().startsWith('```')) continue;
      path = L.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${j + 1}`);
      path = prevPath;
    }
    blocks.push({ path, old: lines.slice(j + 1, eq), new: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => applySRBlock(tree, b, strict));
}

function applySRBlock(tree: Tree, b: SRBlock, strict: boolean): void {
  const p = b.path;
  if (b.old.length === 0) {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.set(p, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
    return;
  }
  if (!safe(p)) throw new Fail('unsafe', p);
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  const model = toModel(text);
  const found = findTier(model.lines, b.old, strict);
  if (!found) throw new Fail('no-match', p);
  if (found.positions.length !== 1) throw new Fail('ambiguous', p);
  const pos = found.positions[0]!;
  const ctxOfN = b.new.map(() => -1);
  const rep = replacementLines(b.old, b.new, ctxOfN, model.lines, pos, found.tier);
  const lines = [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + b.old.length)];
  tree.set(p, fromModel({ lines, br: model.br, finalBr: model.finalBr }));
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  ctxOfN: number[];
  /** True when the raw patch line of a body item was blank (empty or only
   *  whitespace): such lines at the end of a section are not part of it. */
  rawBlank: boolean[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  updateLine: number;
  lines: { text: string; lineNo: number; wsOrigin: boolean }[];
  chunks: V4AChunk[];
}

function chunkFromItems(items: { kind: 'ctx' | 'old' | 'new'; text: string; rawBlank: boolean }[]): Omit<V4AChunk, 'anchor' | 'eof'> {
  const o: string[] = [];
  const n: string[] = [];
  const ctxOfN: number[] = [];
  const rawBlank: boolean[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      ctxOfN.push(o.length);
      o.push(it.text);
      n.push(it.text);
      rawBlank.push(it.rawBlank);
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else {
      ctxOfN.push(-1);
      n.push(it.text);
      rawBlank.push(it.rawBlank);
    }
  }
  return { o, n, ctxOfN, rawBlank };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) {
      i++;
      continue;
    }
    if (L.startsWith('*** Add File: ')) {
      const sec: V4ASection = {
        kind: 'add',
        path: L.slice('*** Add File: '.length).trim(),
        moveTo: null,
        updateLine: i + 1,
        lines: [],
        chunks: [],
      };
      sections.push(sec);
      i++;
      while (i < last) {
        const B = lines[i]!;
        if (isSectionStart(B) || B.trim() === '*** End Patch') break;
        if (B === '') {
          sec.lines.push({ text: '', lineNo: i + 1, wsOrigin: false });
          i++;
          continue;
        }
        if (B.startsWith('+')) {
          sec.lines.push({ text: B.slice(1), lineNo: i + 1, wsOrigin: false });
          i++;
          continue;
        }
        if (blank(B)) {
          // A whitespace-only line: a blank line at the end of the section is
          // not part of it, so it is skipped only when every line after it
          // up to the section's end is blank too; otherwise it is an error.
          let restBlank = true;
          for (let k = i + 1; k < last; k++) {
            if (isSectionStart(lines[k]!) || lines[k]!.trim() === '*** End Patch') break;
            if (!blank(lines[k]!)) {
              restBlank = false;
              break;
            }
          }
          if (!restBlank) throw new Exit2(`error: parse ${i + 1}`);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1]!.text === '') sec.lines.pop();
      continue;
    }
    if (L.startsWith('*** Delete File: ')) {
      sections.push({
        kind: 'delete',
        path: L.slice('*** Delete File: '.length).trim(),
        moveTo: null,
        updateLine: i + 1,
        lines: [],
        chunks: [],
      });
      i++;
      continue;
    }
    if (L.startsWith('*** Update File: ')) {
      const sec: V4ASection = {
        kind: 'update',
        path: L.slice('*** Update File: '.length).trim(),
        moveTo: null,
        updateLine: i + 1,
        lines: [],
        chunks: [],
      };
      sections.push(sec);
      i++;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      let items: { kind: 'ctx' | 'old' | 'new'; text: string; rawBlank: boolean }[] = [];
      let anchor: string | null = null;
      let eof = false;
      let chunkOpen = false;
      let firstChunk = true;
      const closeChunk = (): void => {
        if (!chunkOpen) return;
        const built = chunkFromItems(items);
        sec.chunks.push({ anchor, eof, ...built });
        items = [];
        anchor = null;
        eof = false;
        chunkOpen = false;
      };
      while (i < last) {
        const B = lines[i]!;
        if (isSectionStart(B) || B.trim() === '*** End Patch') break;
        if (B === '*** End of File') {
          if (!chunkOpen) throw new Exit2(`error: parse ${i + 1}`);
          eof = true;
          closeChunk();
          firstChunk = false;
          i++;
          continue;
        }
        if (B.startsWith('@@')) {
          closeChunk();
          const text = B.slice(2).trim();
          anchor = text === '' ? null : text;
          eof = false;
          chunkOpen = true;
          firstChunk = false;
          i++;
          continue;
        }
        if (B === '' || B.startsWith(' ') || B.startsWith('-') || B.startsWith('+')) {
          if (!chunkOpen) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            anchor = null;
            eof = false;
            chunkOpen = true;
            firstChunk = false;
          }
          if (B === '') items.push({ kind: 'ctx', text: '', rawBlank: true });
          else if (B.startsWith(' ')) items.push({ kind: 'ctx', text: B.slice(1), rawBlank: B.trim() === '' });
          else if (B.startsWith('-')) items.push({ kind: 'old', text: B.slice(1), rawBlank: false });
          else items.push({ kind: 'new', text: B.slice(1), rawBlank: false });
          i++;
          continue;
        }
        if (blank(B)) {
          // Only a whitespace-only line that starts with no space reaches
          // here (a space-led line is a body line above). Inside a chunk it
          // is not a body line, so it is an error; between chunks it is an
          // ignored blank separator.
          if (chunkOpen) throw new Exit2(`error: parse ${i + 1}`);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (sec.chunks.length > 0) {
        // Blank lines at the end of a section are not part of it: drop the
        // trailing context lines of the last chunk whose raw patch line was
        // blank. A trailing blank line is always a context line, so its
        // entry in O is the last one.
        const lastChunk = sec.chunks[sec.chunks.length - 1]!;
        while (lastChunk.n.length > 0) {
          const j = lastChunk.n.length - 1;
          const ci = lastChunk.ctxOfN[j]!;
          if (ci < 0 || ci !== lastChunk.o.length - 1 || !lastChunk.rawBlank[j]) break;
          lastChunk.n.pop();
          lastChunk.ctxOfN.pop();
          lastChunk.rawBlank.pop();
          lastChunk.o.pop();
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => (tree: Tree) => applyV4ASection(tree, s, strict));
}

function applyV4ASection(tree: Tree, s: V4ASection, strict: boolean): void {
  const p = s.path;
  if (s.kind === 'add') {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const text = s.lines.map((l) => l.text);
    tree.set(p, text.length === 0 ? '' : text.join('\n') + '\n');
    return;
  }
  if (s.kind === 'delete') {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.set(p, null);
    return;
  }
  if (!safe(p)) throw new Fail('unsafe', p);
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  if (s.moveTo !== null) {
    if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
  }
  let model = toModel(text);
  let cursor = 0;
  for (const chunk of s.chunks) {
    if (chunk.anchor !== null) {
      let foundAt = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const want = normLine(chunk.anchor, t);
        for (let k = cursor; k < model.lines.length; k++) {
          if (normLine(model.lines[k]!, t) === want) {
            foundAt = k;
            break;
          }
        }
        if (foundAt >= 0) break;
      }
      if (foundAt < 0) throw new Fail('no-match', p);
      cursor = foundAt + 1;
    }
    if (chunk.o.length === 0) {
      const at = chunk.eof ? model.lines.length : cursor;
      model = { ...model, lines: [...model.lines.slice(0, at), ...chunk.n, ...model.lines.slice(at)] };
      cursor = at + chunk.n.length;
      continue;
    }
    if (chunk.eof) {
      // An end-of-file chunk takes only an occurrence that ends at the
      // file's last line: the one position that can, at the first tier
      // where it matches there.
      const pos = model.lines.length - chunk.o.length;
      if (pos < cursor) throw new Fail('no-match', p);
      let tier = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        if (matchesAt(model.lines, chunk.o, pos, t)) {
          tier = t;
          break;
        }
      }
      if (tier < 0) throw new Fail('no-match', p);
      const rep = replacementLines(chunk.o, chunk.n, chunk.ctxOfN, model.lines, pos, tier);
      model = { ...model, lines: [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + chunk.o.length)] };
      cursor = pos + chunk.n.length;
      continue;
    }
    const found = findTierFrom(model.lines, chunk.o, cursor, strict);
    if (!found) throw new Fail('no-match', p);
    const pos = found.positions[0]!;
    const rep = replacementLines(chunk.o, chunk.n, chunk.ctxOfN, model.lines, pos, found.tier);
    model = { ...model, lines: [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + chunk.o.length)] };
    cursor = pos + chunk.n.length;
  }
  const out = fromModel(model);
  if (s.moveTo !== null) {
    tree.set(s.moveTo, out);
    tree.set(p, null);
    tree.moves.push({ old: p, new: s.moveTo });
  } else {
    tree.set(p, out);
  }
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

type Edit = (tree: Tree) => void;

/** One JSON edit object, or null when it is not one. A wrong command or a
 *  missing or mistyped key is a parse fault. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const model = toModel(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      const lines = [...model.lines];
      lines.splice(line, 0, ...add);
      tree.set(p, fromModel({ lines, br: model.br, finalBr: model.finalBr }));
    };
  }
  return null;
}

/** The patch is either one JSON array of edit objects, or JSON Lines: one edit
 *  object a line, blank lines ignored. In array form any fault is a parse
 *  error at the line where the array starts; in JSON Lines form a line that
 *  does not hold one valid edit object is a parse error at that line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4) and running (sections 1, 2, 10)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function parsePatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4A(lines, strict);
}

const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // One line for each path whose state changed, in byte order of the paths
  // (UTF-8). A file moved by a move edit that succeeded prints `R old -> new`
  // instead of that pair's `D` and `A` lines, and sorts by `<new>`.
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null &&
      tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      covered.add(mv.old);
      covered.add(mv.new);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
