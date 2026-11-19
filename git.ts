// git.ts — the forge's own git object engine: loose object hashing, tree and
// commit codecs, packfile reading/writing (with delta resolution), pkt-line
// framing, reachability, three-way tree merges and tree diffs. Everything is
// in-process on top of node:zlib and node:crypto; no git binary is involved.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(store: ObjectStore, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Git compares directory names as if they ended in '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> entry, recursing into subtrees. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, name: path, oid: entry.oid });
  }
  return out;
}

/** Rebuild nested tree objects from a flattened path map; returns the root tree oid. */
export function unflattenTree(store: ObjectStore, flat: ReadonlyMap<string, TreeEntry>): string {
  interface DirNode {
    files: TreeEntry[];
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i] as string;
      let child = node.dirs.get(seg);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, name: segments[segments.length - 1] as string, oid: entry.oid });
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Look up one path inside a tree; returns the entry or undefined. */
export function treePathEntry(store: ObjectStore, treeOid: string, path: string): TreeEntry | undefined {
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = store.get(current);
    if (tree === undefined || tree.type !== 'tree') return undefined;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

// ---------------------------------------------------------------- commits and tags

export interface Identity {
  name: string;
  email: string;
  timestamp: number;
  timezone: string;
}

export function formatIdentity(identity: Identity): string {
  return `${identity.name} <${identity.email}> ${identity.timestamp} ${identity.timezone}`;
}

export function parseIdentity(text: string): Identity {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', timestamp: 0, timezone: '+0000' };
  return { name: match[1] as string, email: match[2] as string, timestamp: Number(match[3]), timezone: match[4] as string };
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author: Identity = { name: '', email: '', timestamp: 0, timezone: '+0000' };
  let committer = author;
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue; // header continuation (e.g. gpgsig)
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = parseIdentity(value);
    else if (key === 'committer') committer = parseIdentity(value);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdentity(info.author)}`);
  lines.push(`committer ${formatIdentity(info.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: Identity | null;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: ZERO_OID, type: '', tag: '', tagger: null, message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') info.object = value;
    else if (key === 'type') info.type = value;
    else if (key === 'tag') info.tag = value;
    else if (key === 'tagger') info.tagger = parseIdentity(value);
  }
  return info;
}

/** Follow tag objects until a non-tag object; returns its oid (or the input). */
export function peelToNonTag(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Follow tags until a commit; returns the commit oid or undefined. */
export function peelToCommit(store: ObjectStore, oid: string): string | undefined {
  const target = peelToNonTag(store, oid);
  const object = store.get(target);
  return object !== undefined && object.type === 'commit' ? target : undefined;
}

// ---------------------------------------------------------------- pkt-line framing

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line payload too large');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Pkt =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'end' };

/** Sequential pkt-line reader over a request body. */
export class PktReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  /** The next packet, or null when the buffer is exhausted mid-packet or fully read. */
  next(): Pkt | null {
    if (this.offset + 4 > this.buffer.length) return null;
    const header = this.buffer.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'end' };
    }
    if (length < 4 || this.offset + length > this.buffer.length) return null;
    const data = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', data };
  }

  /** All bytes not yet consumed (the packfile that follows a receive-pack command block). */
  rest(): Buffer {
    return this.buffer.subarray(this.offset);
  }
}

// ---------------------------------------------------------------- packfiles

type InflateWithInfo = (data: Buffer, options: { info: true }) => { buffer: Buffer; engine: { bytesWritten: number } };

function inflateCounted(data: Buffer): { plain: Buffer; consumed: number } {
  const result = (inflateSync as unknown as InflateWithInfo)(data, { info: true });
  return { plain: result.buffer, consumed: result.engine.bytesWritten };
}

/** Apply a git delta buffer to a base object body. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  readVarint(); // base size (trusted)
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface PackEntry {
  offset: number;
  typeCode: number;
  plain?: Buffer;
  baseOffset?: number;
  baseOid?: string;
  delta?: Buffer;
  oid?: string;
  object?: GitObject;
}

/**
 * Read a packfile into the store, resolving OFS/REF deltas against entries in
 * the same pack or objects the lookup supplies. Returns the object count.
 */
export function readPack(store: ObjectStore, bytes: Buffer, lookup: (oid: string) => GitObject | undefined): number {
  if (bytes.length < 32 || bytes.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = bytes.readUInt32BE(8);
  let offset = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = bytes[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = bytes[offset] as number;
      offset += 1;
    }
    const entry: PackEntry = { offset: start, typeCode };
    if (typeCode === 6) {
      let back = bytes[offset] as number;
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = bytes[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      entry.baseOffset = start - value;
    } else if (typeCode === 7) {
      entry.baseOid = bytes.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const { plain, consumed } = inflateCounted(bytes.subarray(offset));
    offset += consumed;
    if (typeCode === 6 || typeCode === 7) entry.delta = plain;
    else entry.plain = plain;
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const resolve = (entry: PackEntry): GitObject => {
    if (entry.object !== undefined) return entry.object;
    let object: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry !== undefined) base = resolve(baseEntry);
      } else {
        const baseEntry = entries.find((candidate) => candidate.oid === entry.baseOid);
        if (baseEntry !== undefined) base = resolve(baseEntry);
        else base = lookup(entry.baseOid as string);
      }
      if (base === undefined || entry.delta === undefined) throw new Error('delta base is missing');
      object = { type: base.type, data: applyDelta(base.data, entry.delta) };
    } else {
      const type = CODE_TO_TYPE[entry.typeCode];
      if (type === undefined || entry.plain === undefined) throw new Error(`bad pack entry type ${entry.typeCode}`);
      object = { type, data: entry.plain };
    }
    entry.object = object;
    entry.oid = hashObject(object.type, object.data);
    return object;
  };
  for (const entry of entries) resolve(entry);
  for (const entry of entries) {
    if (entry.object !== undefined && entry.oid !== undefined && !store.has(entry.oid)) store.set(entry.oid, entry.object);
  }
  return count;
}

/** Serialise full objects (no deltas) into a version-2 packfile. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const first = (TYPE_TO_CODE[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    if (size > 0) {
      headBytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        headBytes.push(size > 0 ? byte | 0x80 : byte);
      }
    } else {
      headBytes.push(first);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- reachability

export interface ClosureOptions {
  /** Commits in this set are treated as having no parents (the client's shallow boundary). */
  parentless?: ReadonlySet<string>;
  /** When set, only commits within this many generations of a root are included. */
  maxCommitDepth?: number;
}

export interface Closure {
  objects: Map<string, GitObject>;
  /** Included commits that have at least one parent left outside the closure. */
  boundary: Set<string>;
}

/** Everything reachable from the root oids, honouring depth and parentless commits. */
export function closureOf(store: ObjectStore, roots: readonly string[], options: ClosureOptions = {}): Closure {
  const objects = new Map<string, GitObject>();
  const boundary = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  const include = (oid: string, depth: number): void => {
    const object = store.get(oid);
    if (object === undefined) return;
    if (object.type === 'commit') {
      const known = commitDepth.get(oid);
      if (known !== undefined && known <= depth) return;
      commitDepth.set(oid, depth);
      queue.push({ oid, depth });
      objects.set(oid, object);
      return;
    }
    if (objects.has(oid)) return;
    objects.set(oid, object);
    if (object.type === 'tag') include(parseTag(object.data).object, depth);
    else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) include(entry.oid, depth);
    }
  };
  for (const root of roots) include(root, 0);
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    const object = store.get(oid) as GitObject;
    const commit = parseCommit(object.data);
    include(commit.tree, depth);
    const parentless = options.parentless !== undefined && options.parentless.has(oid);
    const mayDescend = options.maxCommitDepth === undefined || depth + 1 < options.maxCommitDepth;
    for (const parent of commit.parents) {
      if (parentless || !mayDescend) {
        if (store.has(parent)) boundary.add(oid);
        continue;
      }
      include(parent, depth + 1);
    }
  }
  // A commit whose parent was excluded only because a shallower path existed
  // is not on the boundary; recompute precisely.
  for (const oid of [...boundary]) {
    const object = store.get(oid);
    if (object === undefined) continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => objects.has(parent))) boundary.delete(oid);
  }
  return { objects, boundary };
}

/** All commit ancestors of a commit (including itself), breadth-first. */
export function commitAncestors(store: ObjectStore, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return commitAncestors(store, descendant).includes(ancestor);
}

/** The best common ancestor of two commits (breadth-first approximation of git's paint-down). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | undefined {
  const ancestorsOfA = new Set(commitAncestors(store, a));
  return commitAncestors(store, b).find((oid) => ancestorsOfA.has(oid));
}

/** Commits reachable from tip but not from excludeTip, oldest first. */
export function commitsBetween(store: ObjectStore, excludeTip: string | undefined, tip: string): string[] {
  const excluded = new Set(excludeTip === undefined ? [] : commitAncestors(store, excludeTip));
  return commitAncestors(store, tip)
    .filter((oid) => !excluded.has(oid))
    .reverse();
}

// ---------------------------------------------------------------- tree merge and diff

export type MergeOutcome = { readonly ok: true; readonly tree: string } | { readonly ok: false; readonly conflictPath: string };

/**
 * Three-way merge of two trees against their common ancestor tree, per path:
 * unchanged on one side takes the other side, identical changes merge, and
 * divergent changes on the same path conflict.
 */
export function mergeTrees(store: ObjectStore, baseTree: string, ourTree: string, theirTree: string): MergeOutcome {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, TreeEntry>();
  for (const path of paths) {
    const inBase = base.get(path);
    const inOurs = ours.get(path);
    const inTheirs = theirs.get(path);
    const sameEntry = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean =>
      (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
    let winner: TreeEntry | undefined;
    if (sameEntry(inOurs, inTheirs)) winner = inOurs;
    else if (sameEntry(inBase, inOurs)) winner = inTheirs;
    else if (sameEntry(inBase, inTheirs)) winner = inOurs;
    else return { ok: false, conflictPath: path };
    if (winner !== undefined) merged.set(path, winner);
  }
  return { ok: true, tree: unflattenTree(store, merged) };
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0);
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-change counts between two blob bodies (LCS-based; coarse fallback for huge inputs). */
export function lineChangeCounts(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  if (isBinary(before) || isBinary(after)) return { additions: 0, deletions: 0 };
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) return { additions: b.length, deletions: a.length };
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    let diagonal = 0;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const above = dp[j] as number;
      if (a[i] === b[j]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(above, dp[j + 1] as number);
      diagonal = above;
    }
  }
  const common = dp[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file-level diff between two trees. */
export function diffTrees(store: ObjectStore, fromTree: string, toTree: string): FileDiff[] {
  const from = flattenTree(store, fromTree);
  const to = flattenTree(store, toTree);
  const paths = [...new Set<string>([...from.keys(), ...to.keys()])].sort();
  const diffs: FileDiff[] = [];
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid && before.mode === after.mode) continue;
    if (before === undefined && after !== undefined) {
      const data = store.get(after.oid)?.data ?? Buffer.alloc(0);
      const counts = after.mode === '160000' ? { additions: 0, deletions: 0 } : lineChangeCounts(Buffer.alloc(0), data);
      diffs.push({ path, status: 'added', oldOid: null, newOid: after.oid, additions: counts.additions, deletions: 0 });
    } else if (before !== undefined && after === undefined) {
      const data = store.get(before.oid)?.data ?? Buffer.alloc(0);
      const counts = before.mode === '160000' ? { additions: 0, deletions: 0 } : lineChangeCounts(data, Buffer.alloc(0));
      diffs.push({ path, status: 'removed', oldOid: before.oid, newOid: null, additions: 0, deletions: counts.deletions });
    } else if (before !== undefined && after !== undefined) {
      const beforeData = store.get(before.oid)?.data ?? Buffer.alloc(0);
      const afterData = store.get(after.oid)?.data ?? Buffer.alloc(0);
      const counts = lineChangeCounts(beforeData, afterData);
      diffs.push({ path, status: 'modified', oldOid: before.oid, newOid: after.oid, additions: counts.additions, deletions: counts.deletions });
    }
  }
  return diffs;
}
