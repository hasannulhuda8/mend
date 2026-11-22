// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats —
// unified diff, SEARCH/REPLACE blocks, V4A, JSON edits — finds the lines each edit names at
// the first of three matching tiers (exact, trailing-whitespace, indentation), and writes
// every change or none, printing what changed or why each edit failed. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in the order their edits ran: [oldPath, newPath]. */
  readonly moves: [string, string][] = [];
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
}

type Edit = (tree: Tree) => void;

// ---- files as lines (SPEC.md section 3) ----

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

// ---- line matching at three tiers (SPEC.md section 5) ----

function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  return /^[ \t]*/.exec(s)![0]!;
}

/** Every 0-based position at which O occurs in `lines` under `tier`. */
function occurrencesAt(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  const want = O.map((l) => tierLine(l, tier));
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (tierLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at least once, or null. `from` limits positions to >= from. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(lines, O, tier).filter((p) => p >= from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: its text, and for context lines the index into O it mirrors. */
interface NLine {
  text: string;
  ctx: number;
}

/** The lines that replace the O.length matched lines at `pos`, honouring context and tier 2. */
function replacement(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const F = leadWs(lines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  return N.map((n) => {
    if (n.ctx >= 0) return lines[pos + n.ctx]!;
    if (tier !== 2) return n.text;
    if (n.text.trim() === '') return n.text;
    return n.text.startsWith(P) ? F + n.text.slice(P.length) : n.text;
  });
}

// ---- format detection (SPEC.md section 4) ----

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

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
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
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f.lines, f.br, f.final));
    };
  }
  return null;
}

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

// ---- unified diffs (SPEC.md section 6) ----

interface BodyLine {
  kind: string; // ' ', '-', '+' or '\\'
  text: string;
  empty: boolean; // the patch line itself was empty (an empty context line)
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
}

function headerPath(raw: string): string {
  const t = raw.split('\t')[0]!.trim();
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const pairAt = (j: number): boolean => (lines[j] ?? '').startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  const newSection = (): Section => {
    const s: Section = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newMode: false, delMode: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/') : -1;
      const x = sep > 2 ? rest.slice(2, sep) : '';
      const y = sep > 2 ? rest.slice(sep + 3) : '';
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = x;
      cur.gitNew = y;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairAt(j)) break;
        const c = b[0];
        if (b === '') body.push({ kind: ' ', text: '', empty: true });
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') body.push({ kind: c, text: b.slice(1), empty: false });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      i = j;
      continue;
    }
    if (pairAt(i)) {
      if (cur === null || cur.hunks.length > 0 || cur.pairOld !== null) cur = newSection();
      cur.pairOld = headerPath(line.slice(4));
      cur.pairNew = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newMode = true;
      else if (line.startsWith('deleted file mode')) cur.delMode = true;
    }
    i += 1;
  }
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` body line. */
function backslashAfterLastWrite(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const kind = body[k]!.kind;
    if (kind === ' ' || kind === '+') return body[k + 1]?.kind === '\\';
  }
  return false;
}

/** Apply one section's hunks to a file's lines; returns the new text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, errPath: string): string {
  const f = splitFile(text);
  const lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const hunk of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of hunk.body) {
      if (b.kind === ' ') {
        O.push(b.text);
        N.push({ text: b.text, ctx: O.length - 1 });
      } else if (b.kind === '-') O.push(b.text);
      else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
    }
    if (O.length === 0) {
      const pos = Math.min(hunk.a + d, lines.length);
      const add = N.map((n) => n.text);
      lines.splice(pos, 0, ...add);
      if (pos + add.length === lines.length && add.length > 0) final = !backslashAfterLastWrite(hunk.body);
      d += add.length;
      continue;
    }
    const found = findTier(lines, O, strict);
    if (found === null) throw new Fail('no-match', errPath);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const rep = replacement(lines, pos, O, N, found.tier);
    const runsToEnd = pos + O.length === lines.length;
    lines.splice(pos, O.length, ...rep);
    if (runsToEnd) final = !backslashAfterLastWrite(hunk.body);
    d += N.length - O.length;
  }
  return joinFile(lines, f.br, final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => {
    const oldPath = s.pairOld ?? s.renameFrom ?? s.gitOld;
    const newPath = s.pairNew ?? s.renameTo ?? s.gitNew;
    const creation = oldPath === '/dev/null' || s.newMode;
    const deletion = newPath === '/dev/null' || s.delMode;
    return (tree: Tree) => {
      // Every path the edit names is safety-checked before anything else (section 10).
      if (!creation && oldPath !== null && oldPath !== '/dev/null' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!deletion && newPath !== null && newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (creation) {
        const p = newPath!;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let lastPlus: { hunk: Hunk; idx: number } | null = null;
        for (const h of s.hunks) {
          h.body.forEach((b, idx) => {
            if (b.kind === '+') {
              plus.push(b.text);
              lastPlus = { hunk: h, idx };
            }
          });
        }
        let final = true;
        if (lastPlus !== null) {
          const lp = lastPlus as { hunk: Hunk; idx: number };
          final = lp.hunk.body[lp.idx + 1]?.kind !== '\\';
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
        return;
      }
      if (deletion) {
        const p = oldPath!;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldPath !== newPath) {
        const before = tree.get(oldPath!);
        if (before === null) throw new Fail('missing', oldPath!);
        if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
        const out = s.hunks.length === 0 ? before : applyHunks(before, s.hunks, strict, oldPath!);
        tree.now.set(oldPath!, null);
        tree.now.set(newPath!, out);
        tree.moves.push([oldPath!, newPath!]);
        return;
      }
      const p = oldPath!;
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, s.hunks, strict, p));
    };
  });
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchLine + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const N: NLine[] = b.newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = replacement(f.lines, pos, b.oldLines, N, found.tier);
    const out = [...f.lines];
    out.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinFile(out, f.br, f.final));
  });
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: string; // 'add', 'delete', 'update'
  path: string;
  line: number; // 1-based line of the section header
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let raw: { text: string; line: number }[] = [];
  const flush = (): void => {
    if (cur === null) return;
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (cur.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) cur.addLines.push(r.text.slice(1));
        else if (r.text === '') cur.addLines.push('');
        else throw new Exit2(`error: parse ${r.line}`);
      }
    } else if (cur.kind === 'delete') {
      for (const r of raw) if (!blank(r.text)) throw new Exit2(`error: parse ${r.line}`);
    } else {
      let chunk: VChunk | null = null;
      let firstContent = true;
      for (const r of raw) {
        const t = r.text;
        if (firstContent && t.startsWith('*** Move to: ')) {
          cur.moveTo = t.slice('*** Move to: '.length).trim();
          firstContent = false;
          continue;
        }
        firstContent = false;
        if (t.startsWith('@@')) {
          chunk = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), eof: false, body: [] };
          cur.chunks.push(chunk);
        } else if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.line}`);
          chunk.eof = true;
          chunk = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            if (cur.chunks.length > 0) throw new Exit2(`error: parse ${r.line}`);
            chunk = { anchor: null, eof: false, body: [] };
            cur.chunks.push(chunk);
          }
          chunk.body.push(t === '' ? { kind: ' ', text: '', empty: true } : { kind: t[0]!, text: t.slice(1), empty: false });
        } else throw new Exit2(`error: parse ${r.line}`);
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.line}`);
    }
    sections.push(cur);
    cur = null;
    raw = [];
  };
  for (let j = first + 1; j < last; j += 1) {
    const t = lines[j]!;
    const starts: [string, string][] = [
      ['*** Add File: ', 'add'],
      ['*** Delete File: ', 'delete'],
      ['*** Update File: ', 'update'],
    ];
    const hit = starts.find(([pre]) => t.startsWith(pre));
    if (hit !== undefined) {
      flush();
      cur = { kind: hit[1]!, path: t.slice(hit[0]!.length).trim(), line: j + 1, addLines: [], moveTo: null, chunks: [] };
      raw = [];
    } else if (cur === null) {
      if (!blank(t)) throw new Exit2(`error: parse ${j + 1}`);
    } else raw.push({ text: t, line: j + 1 });
  }
  flush();
  return sectionsToEdits(sections, strict);
}

function sectionsToEdits(sections: VSection[], strict: boolean): Edit[] {
  return sections.map((s) => (tree: Tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    // update
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    const out = [...f.lines];
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < out.length; k += 1) {
            if (tierLine(out[k]!, tier) === tierLine(chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === ' ') {
          O.push(b.text);
          N.push({ text: b.text, ctx: O.length - 1 });
        } else if (b.kind === '-') O.push(b.text);
        else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
      }
      if (O.length === 0) {
        const pos = chunk.eof ? out.length : Math.min(cursor, out.length);
        const add = N.map((n) => n.text);
        out.splice(pos, 0, ...add);
        cursor = pos + add.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of tiers) {
        const positions = occurrencesAt(out, O, tier).filter((p) => p >= cursor && (!chunk.eof || p + O.length === out.length));
        if (positions.length > 0) {
          placed = { tier, pos: positions[0]! };
          break;
        }
      }
      if (placed === null) throw new Fail('no-match', s.path);
      const rep = replacement(out, placed.pos, O, N, placed.tier);
      out.splice(placed.pos, O.length, ...rep);
      cursor = placed.pos + rep.length;
    }
    const text = joinFile(out, f.br, f.final);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.moves.push([s.path, s.moveTo]);
    } else tree.now.set(s.path, text);
  });
}

// ---- the command line, output and all-or-nothing write (SPEC.md sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, in byte order; a successful move replaces its D and A lines with one R line.
  const bySortKey = new Map<string, string>();
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined) {
      bySortKey.set(n, `R ${o} -> ${n}`);
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    bySortKey.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const keys = [...bySortKey.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows = keys.map((k) => bySortKey.get(k)!);
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
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
