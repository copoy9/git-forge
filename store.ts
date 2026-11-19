// store.ts — the forge's data store and domain operations. One Forge holds
// every repository (objects, refs, labels, issues, pull requests) in memory;
// REST, GraphQL and MCP all act on this same store so their views agree.
// Timestamps come from a seeded logical clock, never the wall clock, so a
// replayed request sequence reproduces identical state.

import {
  buildCommit,
  commitAncestors,
  commitsBetween,
  diffTrees,
  flattenTree,
  mergeBase,
  mergeTrees,
  parseCommit,
  parseTree,
  peelToCommit,
  putObject,
  treePathEntry,
  unflattenTree,
  ZERO_OID,
  type FileDiff,
  type Identity,
  type ObjectStore,
  type TreeEntry,
} from './git.ts';

export interface ViewerInfo {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: ViewerInfo = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

const CLOCK_BASE_EPOCH = 1735689600; // 2025-01-01T00:00:00Z

export class DomainError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- global ids

function encodeGlobalId(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

export const repoGlobalId = (id: number): string => encodeGlobalId(`R:${id}`);
export const issueGlobalId = (repoId: number, number: number): string => encodeGlobalId(`I:${repoId}:${number}`);
export const pullGlobalId = (repoId: number, number: number): string => encodeGlobalId(`P:${repoId}:${number}`);
export const commentGlobalId = (id: number): string => encodeGlobalId(`C:${id}`);
export const userGlobalId = (id: number): string => encodeGlobalId(`U:${id}`);

export interface DecodedGlobalId {
  kind: 'R' | 'I' | 'P' | 'C' | 'U';
  parts: number[];
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([RIPCU]):(\d+(?::\d+)?)$/.exec(raw);
  if (match === null) return null;
  return { kind: match[1] as DecodedGlobalId['kind'], parts: (match[2] as string).split(':').map(Number) };
}

// ---------------------------------------------------------------- records

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export class RepoRec {
  readonly objects: ObjectStore = new Map();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  nextNumber = 1;
  updatedAt: string;
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly createdAt: string;

  constructor(
    id: number,
    owner: string,
    name: string,
    description: string,
    isPrivate: boolean,
    defaultBranch: string,
    createdAt: string,
  ) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  tipOf(branch: string): string | undefined {
    return this.refs.get(this.branchRef(branch));
  }

  /** The tree oid of a commit oid, or undefined when it is not a commit. */
  treeOfCommit(commitOid: string): string | undefined {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }
}

export class Forge {
  readonly reposByKey = new Map<string, RepoRec>();
  readonly reposById = new Map<number, RepoRec>();
  private nextRepoId = 1;
  private nextDbId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private clockTick = 0;
  private requestCounter = 0;

  /** Advance the logical clock; returns the new instant as epoch + ISO text. */
  tick(): { epoch: number; iso: string } {
    this.clockTick += 1;
    const epoch = CLOCK_BASE_EPOCH + this.clockTick;
    return { epoch, iso: new Date(epoch * 1000).toISOString() };
  }

  nowIso(): string {
    return new Date((CLOCK_BASE_EPOCH + this.clockTick) * 1000).toISOString();
  }

  requestId(): string {
    this.requestCounter += 1;
    return `forge-${this.requestCounter.toString(16).padStart(8, '0')}`;
  }

  allocDbId(): number {
    const id = this.nextDbId;
    this.nextDbId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  allocLabelId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): RepoRec {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      throw new DomainError(422, 'name is not valid');
    }
    const key = `${owner}/${name}`;
    if (this.reposByKey.has(key)) throw new DomainError(422, 'name already exists on this account');
    const repo = new RepoRec(
      this.nextRepoId,
      owner,
      name,
      options.description ?? '',
      options.isPrivate ?? false,
      options.defaultBranch ?? 'main',
      this.tick().iso,
    );
    this.nextRepoId += 1;
    this.reposByKey.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.reposByKey.get(`${owner}/${name}`);
  }

  requireRepo(owner: string, name: string): RepoRec {
    const repo = this.getRepo(owner, name);
    if (repo === undefined || repo.owner !== VIEWER.login) throw new DomainError(404, 'Not Found');
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo === undefined) return false;
    this.reposByKey.delete(`${owner}/${name}`);
    this.reposById.delete(repo.id);
    return true;
  }

  listRepos(owner: string): RepoRec[] {
    return [...this.reposById.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------- commits made by the forge itself

export function viewerIdentity(forge: Forge): Identity {
  return { name: VIEWER.name, email: VIEWER.email, timestamp: forge.tick().epoch, timezone: '+0000' };
}

export function createCommit(
  forge: Forge,
  repo: RepoRec,
  input: { tree: string; parents: string[]; message: string; author?: Identity },
): string {
  const identity = viewerIdentity(forge);
  const data = buildCommit({
    tree: input.tree,
    parents: input.parents,
    author: input.author ?? identity,
    committer: identity,
    message: input.message,
  });
  return putObject(repo.objects, 'commit', data);
}

export function emptyTreeOid(repo: RepoRec): string {
  return putObject(repo.objects, 'tree', Buffer.alloc(0));
}

/** Resolve a branch name, full ref, or raw oid to a commit oid. */
export function resolveToCommit(repo: RepoRec, ref: string): string | undefined {
  let oid: string | undefined;
  if (repo.refs.has(ref)) oid = repo.refs.get(ref);
  else if (repo.refs.has(repo.branchRef(ref))) oid = repo.refs.get(repo.branchRef(ref));
  else if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) oid = ref;
  if (oid === undefined) return undefined;
  return peelToCommit(repo.objects, oid);
}

// ---------------------------------------------------------------- contents

export type ContentLookup =
  | { kind: 'file'; entry: TreeEntry; data: Buffer }
  | { kind: 'dir'; entries: { entry: TreeEntry; path: string }[] }
  | null;

export function getContent(repo: RepoRec, ref: string | undefined, path: string): ContentLookup {
  const commitOid = resolveToCommit(repo, ref ?? repo.defaultBranch);
  if (commitOid === undefined) return null;
  const tree = repo.treeOfCommit(commitOid);
  if (tree === undefined) return null;
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    const treeObject = repo.objects.get(tree);
    if (treeObject === undefined) return null;
    return { kind: 'dir', entries: parseTree(treeObject.data).map((entry) => ({ entry, path: entry.name })) };
  }
  const entry = treePathEntry(repo.objects, tree, clean);
  if (entry === undefined) return null;
  if (entry.mode === '40000') {
    const subtree = repo.objects.get(entry.oid);
    if (subtree === undefined || subtree.type !== 'tree') return null;
    return {
      kind: 'dir',
      entries: parseTree(subtree.data).map((child) => ({ entry: child, path: `${clean}/${child.name}` })),
    };
  }
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined) return null;
  return { kind: 'file', entry, data: blob.data };
}

export interface PutFileResult {
  status: 200 | 201;
  blobOid: string;
  commitOid: string;
}

export function putFile(
  forge: Forge,
  repo: RepoRec,
  input: { branch: string; path: string; content: Buffer; message: string; sha?: string },
): PutFileResult {
  const path = input.path.replace(/^\/+|\/+$/g, '');
  if (path === '' || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new DomainError(422, 'path is not valid');
  }
  const branchRef = repo.branchRef(input.branch);
  let parent = repo.refs.get(branchRef);
  if (parent === undefined) {
    // A contents write to a fresh branch starts from the default branch tip
    // when there is one; on an empty repository it creates the first commit.
    parent = repo.tipOf(repo.defaultBranch);
  }
  const parentTree = parent === undefined ? undefined : repo.treeOfCommit(parent);
  const flat = parentTree === undefined ? new Map<string, TreeEntry>() : flattenTree(repo.objects, parentTree);
  const existing = flat.get(path);
  let status: 200 | 201 = 201;
  if (existing !== undefined) {
    if (input.sha === undefined) throw new DomainError(422, 'sha is required when updating an existing file');
    if (input.sha !== existing.oid) throw new DomainError(409, `${path} does not match the given sha`);
    status = 200;
  }
  const blobOid = putObject(repo.objects, 'blob', input.content);
  flat.set(path, { mode: '100644', name: path, oid: blobOid });
  const tree = unflattenTree(repo.objects, flat);
  const commitOid = createCommit(forge, repo, {
    tree,
    parents: parent === undefined ? [] : [parent],
    message: input.message,
  });
  repo.refs.set(branchRef, commitOid);
  repo.updatedAt = forge.nowIso();
  return { status, blobOid, commitOid };
}

export function deleteFile(
  forge: Forge,
  repo: RepoRec,
  input: { branch: string; path: string; message: string; sha?: string },
): { commitOid: string } {
  const path = input.path.replace(/^\/+|\/+$/g, '');
  const branchRef = repo.branchRef(input.branch);
  const parent = repo.refs.get(branchRef);
  if (parent === undefined) throw new DomainError(404, 'Not Found');
  const parentTree = repo.treeOfCommit(parent);
  if (parentTree === undefined) throw new DomainError(404, 'Not Found');
  const flat = flattenTree(repo.objects, parentTree);
  const existing = flat.get(path);
  if (existing === undefined) throw new DomainError(404, 'Not Found');
  if (input.sha !== undefined && input.sha !== existing.oid) throw new DomainError(409, `${path} does not match the given sha`);
  flat.delete(path);
  const tree = unflattenTree(repo.objects, flat);
  const commitOid = createCommit(forge, repo, { tree, parents: [parent], message: input.message });
  repo.refs.set(branchRef, commitOid);
  repo.updatedAt = forge.nowIso();
  return { commitOid };
}

// ---------------------------------------------------------------- issues

export function createIssue(
  forge: Forge,
  repo: RepoRec,
  input: { title: string; body?: string; labels?: string[] },
): IssueRec {
  if (typeof input.title !== 'string' || input.title === '') throw new DomainError(422, 'title is required');
  const labelNames = input.labels ?? [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) throw new DomainError(422, `Validation Failed: label "${name}" does not exist`);
  }
  const now = forge.tick().iso;
  const issue: IssueRec = {
    dbId: forge.allocDbId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labelNames],
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.updatedAt = now;
  return issue;
}

export function addComment(forge: Forge, target: { comments: CommentRec[] }, body: string): CommentRec {
  if (typeof body !== 'string' || body === '') throw new DomainError(422, 'body is required');
  const now = forge.tick().iso;
  const comment: CommentRec = { id: forge.allocCommentId(), body, createdAt: now, updatedAt: now };
  target.comments.push(comment);
  return comment;
}

/** Find an issue or pull by its shared repo number (for the comments routes). */
export function issueOrPull(repo: RepoRec, number: number): IssueRec | PullRec | undefined {
  return repo.issues.get(number) ?? repo.pulls.get(number);
}

// ---------------------------------------------------------------- pull requests

export function createPull(
  forge: Forge,
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): PullRec {
  if (typeof input.title !== 'string' || input.title === '') throw new DomainError(422, 'title is required');
  const head = stripOwnerPrefix(input.head);
  const base = stripOwnerPrefix(input.base);
  const headTip = repo.tipOf(head);
  if (headTip === undefined) throw new DomainError(422, `Head ref ${head} does not exist`);
  const baseTip = repo.tipOf(base);
  if (baseTip === undefined) throw new DomainError(422, `Base ref ${base} does not exist`);
  if (head === base) throw new DomainError(422, 'Head and base must be different');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      throw new DomainError(422, `A pull request already exists for ${head} into ${base}`);
    }
  }
  const now = forge.tick().iso;
  const pull: PullRec = {
    dbId: forge.allocDbId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headShaAtCreate: headTip,
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  repo.updatedAt = now;
  return pull;
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

export function pullHeadSha(repo: RepoRec, pull: PullRec): string {
  return repo.tipOf(pull.headRef) ?? pull.headShaAtCreate;
}

export function pullBaseSha(repo: RepoRec, pull: PullRec): string {
  return repo.tipOf(pull.baseRef) ?? ZERO_OID;
}

/** Dry-run the three-way merge; returns the merge base used, or null when unmergeable. */
function dryMerge(repo: RepoRec, pull: PullRec): { base: string; tree: string } | null {
  const baseTip = repo.tipOf(pull.baseRef);
  const headTip = pullHeadSha(repo, pull);
  if (baseTip === undefined) return null;
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === undefined || base === headTip) return null;
  const baseTree = repo.treeOfCommit(base);
  const ourTree = repo.treeOfCommit(baseTip);
  const theirTree = repo.treeOfCommit(headTip);
  if (baseTree === undefined || ourTree === undefined || theirTree === undefined) return null;
  const outcome = mergeTrees(repo.objects, baseTree, ourTree, theirTree);
  if (!outcome.ok) return null;
  return { base, tree: outcome.tree };
}

export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  return dryMerge(repo, pull) !== null ? 'MERGEABLE' : 'CONFLICTING';
}

export function pullFiles(repo: RepoRec, pull: PullRec): FileDiff[] {
  const headTip = pullHeadSha(repo, pull);
  const baseTip = repo.tipOf(pull.baseRef);
  const headTree = repo.treeOfCommit(headTip);
  if (headTree === undefined) return [];
  let fromTree = emptyTreeOid(repo);
  if (baseTip !== undefined) {
    const base = mergeBase(repo.objects, baseTip, headTip);
    const baseTree = base === undefined ? undefined : repo.treeOfCommit(base);
    if (baseTree !== undefined) fromTree = baseTree;
  }
  return diffTrees(repo.objects, fromTree, headTree);
}

export function mergePull(
  forge: Forge,
  repo: RepoRec,
  pull: PullRec,
  method: 'merge' | 'squash' | 'rebase',
): { sha: string } {
  if (pull.state !== 'open' || pull.merged) throw new DomainError(405, 'Pull Request is not mergeable');
  const baseTip = repo.tipOf(pull.baseRef);
  const headTip = pullHeadSha(repo, pull);
  if (baseTip === undefined) throw new DomainError(405, 'Pull Request is not mergeable');
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === undefined || base === headTip) throw new DomainError(405, 'Pull Request is not mergeable');
  let sha: string;
  if (method === 'rebase') {
    const chain = commitsBetween(repo.objects, base, headTip);
    let current = baseTip;
    for (const commitOid of chain) {
      const info = parseCommit((repo.objects.get(commitOid) as { data: Buffer }).data);
      const parentTree = info.parents.length > 0 ? repo.treeOfCommit(info.parents[0] as string) : emptyTreeOid(repo);
      const currentTree = repo.treeOfCommit(current) as string;
      const outcome = mergeTrees(repo.objects, parentTree as string, currentTree, info.tree);
      if (!outcome.ok) throw new DomainError(405, 'Pull Request is not mergeable');
      current = createCommit(forge, repo, { tree: outcome.tree, parents: [current], message: info.message, author: info.author });
    }
    sha = current;
  } else {
    const baseTree = repo.treeOfCommit(base) as string;
    const ourTree = repo.treeOfCommit(baseTip) as string;
    const theirTree = repo.treeOfCommit(headTip) as string;
    const outcome = mergeTrees(repo.objects, baseTree, ourTree, theirTree);
    if (!outcome.ok) throw new DomainError(405, 'Pull Request is not mergeable');
    if (method === 'merge') {
      sha = createCommit(forge, repo, {
        tree: outcome.tree,
        parents: [baseTip, headTip],
        message: `Merge pull request #${pull.number} from ${repo.owner}:${pull.headRef}`,
      });
    } else {
      const body = pull.body === '' ? '' : `\n\n${pull.body}`;
      sha = createCommit(forge, repo, {
        tree: outcome.tree,
        parents: [baseTip],
        message: `${pull.title} (#${pull.number})${body}`,
      });
    }
  }
  repo.refs.set(repo.branchRef(pull.baseRef), sha);
  const now = forge.tick().iso;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = sha;
  pull.closedAt = now;
  pull.updatedAt = now;
  repo.updatedAt = now;
  return { sha };
}

/** Newest-first list of commit infos reachable from a tip (for the REST commits route). */
export function listCommits(repo: RepoRec, tip: string): { oid: string; info: ReturnType<typeof parseCommit> }[] {
  return commitAncestors(repo.objects, tip)
    .map((oid) => ({ oid, info: parseCommit((repo.objects.get(oid) as { data: Buffer }).data) }))
    .sort((a, b) => b.info.committer.timestamp - a.info.committer.timestamp);
}

// ---------------------------------------------------------------- JSON serializers (REST + MCP share these)

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: userGlobalId(VIEWER.id),
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${repo.fullName}`,
    clone_url: `https://forge.invalid/${repo.fullName}.git`,
    git_url: `git://forge.invalid/${repo.fullName}.git`,
    ssh_url: `git@forge.invalid:${repo.fullName}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues + openPulls,
    language: null,
    topics: [],
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    node_id: commentGlobalId(label.id),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: issueGlobalId(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => labelJson(label as LabelRec)),
    user: userJson(),
    assignees: [],
    comments: issue.comments.length,
    locked: false,
    active_lock_reason: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

export function commentJson(repo: RepoRec, issueNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(comment.id),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `https://forge.invalid/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    author_association: 'OWNER',
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  const files = pull.merged || pull.state === 'open' ? safePullFiles(repo, pull) : [];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    id: pull.dbId,
    node_id: pullGlobalId(repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    draft: false,
    head: refJson(pull.headRef, pullHeadSha(repo, pull)),
    base: refJson(pull.baseRef, pullBaseSha(repo, pull)),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    additions,
    deletions,
    changed_files: files.length,
    commits: 0,
    comments: pull.comments.length,
    locked: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${repo.fullName}/pull/${pull.number}`,
  };
}

function safePullFiles(repo: RepoRec, pull: PullRec): FileDiff[] {
  try {
    return pullFiles(repo, pull);
  } catch {
    return [];
  }
}
