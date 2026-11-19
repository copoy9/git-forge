// rest.ts — the REST v3 surface under /api/v3: repositories, branches, git
// refs, commits, contents, labels, issues, comments and pull requests. Every
// handler is a pure function of the shared Forge store and returns a status
// plus a JSON value; app.ts owns the socket and the shared headers.

import { parseCommit } from './git.ts';
import {
  addComment,
  commentJson,
  createCommit,
  createIssue,
  createPull,
  deleteFile,
  DomainError,
  emptyTreeOid,
  getContent,
  issueJson,
  issueOrPull,
  labelJson,
  listCommits,
  mergePull,
  pullFiles,
  pullJson,
  putFile,
  repoJson,
  resolveToCommit,
  userJson,
  VIEWER,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestRequest {
  forge: Forge;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
  pathname: string;
}

export interface RestResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResult => ({ status: 404, json: { message: 'Not Found' } });

function bodyObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

function paginate<T>(req: RestRequest, items: readonly T[]): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageOf(req.query);
  const total = items.length;
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page < lastPage) {
    const url = new URL(`${req.origin}${req.pathname}`);
    for (const [key, value] of req.query) url.searchParams.set(key, value);
    url.searchParams.set('per_page', String(perPage));
    const links: string[] = [];
    const withPage = (target: number): string => {
      url.searchParams.set('page', String(target));
      return url.toString();
    };
    links.push(`<${withPage(page + 1)}>; rel="next"`);
    links.push(`<${withPage(lastPage)}>; rel="last"`);
    if (page > 1) {
      links.push(`<${withPage(1)}>; rel="first"`);
      links.push(`<${withPage(page - 1)}>; rel="prev"`);
    }
    headers['link'] = links.join(', ');
  }
  return { slice, headers };
}

// ---------------------------------------------------------------- root, meta, user

function rootDocument(): RestResult {
  return {
    status: 200,
    headers: { 'x-oauth-scopes': 'repo, read:org' },
    json: {
      current_user_url: 'https://forge.invalid/api/v3/user',
      current_user_repositories_url: 'https://forge.invalid/api/v3/user/repos{?type,page,per_page,sort}',
      repository_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}',
      issue_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}/issues/{number}',
      pull_request_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}/pulls/{number}',
      label_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}/labels/{name}',
      rate_limit_url: 'https://forge.invalid/api/v3/rate_limit',
    },
  };
}

function metaDocument(): RestResult {
  return {
    status: 200,
    json: {
      installed_version: '1.0.0',
      git_executable: 'forge-builtin',
      tcp: { v4: true, v6: true },
      x_poll_enabled: false,
    },
  };
}

function currentUser(forge: Forge): RestResult {
  return {
    status: 200,
    json: {
      ...userJson(),
      company: null,
      blog: '',
      location: null,
      hireable: null,
      bio: null,
      public_repos: forge.listRepos(VIEWER.login).length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: forge.nowIso(),
    },
  };
}

// ---------------------------------------------------------------- repositories

function createRepo(req: RestRequest): RestResult {
  const body = bodyObject(req.body);
  const name = stringField(body, 'name');
  if (name === undefined || name === '') throw new DomainError(422, 'name is required');
  const repo = req.forge.createRepo(VIEWER.login, name, {
    description: stringField(body, 'description') ?? '',
    isPrivate: body['private'] === true,
    defaultBranch: stringField(body, 'default_branch') ?? 'main',
  });
  if (body['auto_init'] === true) {
    // auto_init: one root commit holding an empty tree on the default branch.
    const tree = emptyTreeOid(repo);
    const commit = createCommit(req.forge, repo, { tree, parents: [], message: 'Initial commit' });
    repo.refs.set(repo.branchRef(repo.defaultBranch), commit);
  }
  return { status: 201, json: repoJson(repo) };
}

function getRepo(req: RestRequest, owner: string, name: string): RestResult {
  const repo = req.forge.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) return notFound();
  return { status: 200, json: repoJson(repo) };
}

function patchRepo(req: RestRequest, owner: string, name: string): RestResult {
  const repo = req.forge.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) return notFound();
  const body = bodyObject(req.body);
  const description = stringField(body, 'description');
  if (description !== undefined) repo.description = description;
  if (typeof body['private'] === 'boolean') repo.isPrivate = body['private'];
  const defaultBranch = stringField(body, 'default_branch');
  if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch;
  repo.updatedAt = req.forge.tick().iso;
  return { status: 200, json: repoJson(repo) };
}

function deleteRepo(req: RestRequest, owner: string, name: string): RestResult {
  const repo = req.forge.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) return notFound();
  req.forge.deleteRepo(owner, name);
  return { status: 204 };
}

function listUserRepos(req: RestRequest): RestResult {
  const repos = req.forge.listRepos(VIEWER.login).map((repo) => repoJson(repo));
  const { slice, headers } = paginate(req, repos);
  return { status: 200, json: slice, headers };
}

// ---------------------------------------------------------------- branches and refs

function branchJson(repo: RepoRec, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${sha}` },
    protected: false,
  };
}

function listBranches(repo: RepoRec): RestResult {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, sha] of [...repo.refs.entries()].sort()) {
    if (ref.startsWith('refs/heads/')) branches.push(branchJson(repo, ref.slice('refs/heads/'.length), sha));
  }
  return { status: 200, json: branches };
}

function getBranch(repo: RepoRec, branch: string): RestResult {
  const sha = repo.refs.get(repo.branchRef(branch));
  if (sha === undefined) return notFound();
  return { status: 200, json: branchJson(repo, branch, sha) };
}

function refJson(repo: RepoRec, ref: string, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  return {
    ref,
    node_id: Buffer.from(`Ref:${repo.id}:${ref}`, 'utf8').toString('base64'),
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha, type: object?.type ?? 'commit', url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
  };
}

function createRef(req: RestRequest, repo: RepoRec): RestResult {
  const body = bodyObject(req.body);
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) throw new DomainError(422, 'ref and sha are required');
  if (repo.refs.has(ref)) throw new DomainError(422, 'Reference already exists');
  const target = resolveToCommit(repo, sha);
  if (target === undefined) throw new DomainError(422, 'sha does not reference a commit');
  repo.refs.set(ref, sha);
  repo.updatedAt = req.forge.tick().iso;
  return { status: 201, json: refJson(repo, ref, sha) };
}

function listRefs(repo: RepoRec): RestResult {
  const refs = [...repo.refs.entries()].sort().map(([ref, sha]) => refJson(repo, ref, sha));
  return { status: 200, json: refs };
}

function getRef(repo: RepoRec, refPath: string): RestResult {
  const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) return notFound();
  return { status: 200, json: refJson(repo, ref, sha) };
}

function deleteRef(repo: RepoRec, refPath: string): RestResult {
  const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  if (!repo.refs.delete(ref)) return notFound();
  return { status: 204 };
}

// ---------------------------------------------------------------- commits

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid) as { data: Buffer };
  const info = parseCommit(object.data);
  const identityJson = (identity: { name: string; email: string; timestamp: number }): Record<string, unknown> => ({
    name: identity.name,
    email: identity.email,
    date: new Date(identity.timestamp * 1000).toISOString(),
  });
  const actorJson = (email: string): Record<string, unknown> | null => (email === VIEWER.email ? userJson() : null);
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`, 'utf8').toString('base64'),
    commit: {
      author: identityJson(info.author),
      committer: identityJson(info.committer),
      message: info.message,
      tree: { sha: info.tree, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/trees/${info.tree}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: actorJson(info.author.email),
    committer: actorJson(info.committer.email),
    parents: info.parents.map((parent) => ({
      sha: parent,
      url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${parent}`,
      html_url: `https://forge.invalid/${repo.fullName}/commit/${parent}`,
    })),
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${oid}`,
    html_url: `https://forge.invalid/${repo.fullName}/commit/${oid}`,
  };
}

function listCommitsRoute(req: RestRequest, repo: RepoRec): RestResult {
  const shaParam = req.query.get('sha') ?? undefined;
  const tip = resolveToCommit(repo, shaParam ?? repo.defaultBranch);
  if (tip === undefined) {
    if (repo.refs.size === 0) throw new DomainError(409, 'Git Repository is empty.');
    return notFound();
  }
  const commits = listCommits(repo, tip).map(({ oid }) => commitJson(repo, oid));
  const { slice, headers } = paginate(req, commits);
  return { status: 200, json: slice, headers };
}

// ---------------------------------------------------------------- contents

function contentEntryJson(repo: RepoRec, path: string, entry: { mode: string; oid: string }, size: number): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  const isDir = entry.mode === '40000';
  return {
    name,
    path,
    sha: entry.oid,
    size: isDir ? 0 : size,
    type: isDir ? 'dir' : 'file',
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/contents/${path}`,
    html_url: `https://forge.invalid/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
    download_url: isDir ? null : `https://forge.invalid/${repo.fullName}/raw/${path}`,
  };
}

function getContentRoute(req: RestRequest, repo: RepoRec, path: string): RestResult {
  const ref = req.query.get('ref') ?? undefined;
  const found = getContent(repo, ref, path);
  if (found === null) return notFound();
  if (found.kind === 'dir') {
    const entries = found.entries.map(({ entry, path: entryPath }) => {
      const size = entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
      return contentEntryJson(repo, entryPath, entry, size);
    });
    entries.sort((a, b) => String(a['name']).localeCompare(String(b['name'])));
    return { status: 200, json: entries };
  }
  const clean = path.replace(/^\/+|\/+$/g, '');
  return {
    status: 200,
    json: {
      ...contentEntryJson(repo, clean, found.entry, found.data.length),
      encoding: 'base64',
      content: found.data.toString('base64'),
    },
  };
}

function commitSummaryJson(repo: RepoRec, commitOid: string, message: string): Record<string, unknown> {
  return {
    sha: commitOid,
    node_id: Buffer.from(`Commit:${commitOid}`, 'utf8').toString('base64'),
    message,
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${commitOid}`,
    html_url: `https://forge.invalid/${repo.fullName}/commit/${commitOid}`,
  };
}

function putContentRoute(req: RestRequest, repo: RepoRec, path: string): RestResult {
  const body = bodyObject(req.body);
  const encoded = stringField(body, 'content');
  if (encoded === undefined) throw new DomainError(422, 'content is required');
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const message = stringField(body, 'message') ?? `Update ${path}`;
  const result = putFile(req.forge, repo, {
    branch,
    path,
    content: Buffer.from(encoded, 'base64'),
    message,
    sha: stringField(body, 'sha'),
  });
  const clean = path.replace(/^\/+|\/+$/g, '');
  return {
    status: result.status,
    json: {
      content: {
        ...contentEntryJson(repo, clean, { mode: '100644', oid: result.blobOid }, Buffer.from(encoded, 'base64').length),
        encoding: 'base64',
      },
      commit: commitSummaryJson(repo, result.commitOid, message),
    },
  };
}

function deleteContentRoute(req: RestRequest, repo: RepoRec, path: string): RestResult {
  const body = bodyObject(req.body);
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const message = stringField(body, 'message') ?? `Delete ${path}`;
  const result = deleteFile(req.forge, repo, {
    branch,
    path,
    message,
    sha: stringField(body, 'sha'),
  });
  return { status: 200, json: { content: null, commit: commitSummaryJson(repo, result.commitOid, message) } };
}

// ---------------------------------------------------------------- labels

function listLabels(repo: RepoRec): RestResult {
  const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name)).map((label) => labelJson(label));
  return { status: 200, json: labels };
}

function createLabel(req: RestRequest, repo: RepoRec): RestResult {
  const body = bodyObject(req.body);
  const name = stringField(body, 'name');
  if (name === undefined || name === '') throw new DomainError(422, 'name is required');
  if (repo.labels.has(name)) throw new DomainError(422, 'Validation Failed: name already exists');
  const color = (stringField(body, 'color') ?? 'ededed').replace(/^#/, '').toLowerCase();
  const label = { id: req.forge.allocLabelId(), name, color, description: stringField(body, 'description') ?? null };
  repo.labels.set(name, label);
  return { status: 201, json: labelJson(label) };
}

function getLabel(repo: RepoRec, name: string): RestResult {
  const label = repo.labels.get(name);
  if (label === undefined) return notFound();
  return { status: 200, json: labelJson(label) };
}

// ---------------------------------------------------------------- issues and comments

function labelNamesOf(body: Record<string, unknown>): string[] {
  const raw = body['labels'];
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
      names.push((item as { name: string }).name);
    }
  }
  return names;
}

function createIssueRoute(req: RestRequest, repo: RepoRec): RestResult {
  const body = bodyObject(req.body);
  const issue = createIssue(req.forge, repo, {
    title: stringField(body, 'title') ?? '',
    body: stringField(body, 'body') ?? '',
    labels: labelNamesOf(body),
  });
  return { status: 201, json: issueJson(repo, issue) };
}

function listIssuesRoute(req: RestRequest, repo: RepoRec): RestResult {
  const state = req.query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') throw new DomainError(422, 'state is not valid');
  const direction = req.query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { slice, headers } = paginate(req, issues);
  return { status: 200, json: slice.map((issue) => issueJson(repo, issue)), headers };
}

function getIssueRoute(repo: RepoRec, number: number): RestResult {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  return { status: 200, json: issueJson(repo, issue) };
}

function patchIssueRoute(req: RestRequest, repo: RepoRec, number: number): RestResult {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  const body = bodyObject(req.body);
  const title = stringField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== undefined) issue.body = text;
  if (Array.isArray(body['labels'])) {
    const names = labelNamesOf(body);
    for (const name of names) {
      if (!repo.labels.has(name)) throw new DomainError(422, `Validation Failed: label "${name}" does not exist`);
    }
    issue.labels = names;
  }
  const state = stringField(body, 'state');
  if (state === 'open' || state === 'closed') {
    issue.state = state;
    issue.closedAt = state === 'closed' ? req.forge.tick().iso : null;
  }
  issue.updatedAt = req.forge.tick().iso;
  return { status: 200, json: issueJson(repo, issue) };
}

function listCommentsRoute(req: RestRequest, repo: RepoRec, number: number): RestResult {
  const target = issueOrPull(repo, number);
  if (target === undefined) return notFound();
  const comments = target.comments.map((comment) => commentJson(repo, number, comment));
  const { slice, headers } = paginate(req, comments);
  return { status: 200, json: slice, headers };
}

function createCommentRoute(req: RestRequest, repo: RepoRec, number: number): RestResult {
  const target = issueOrPull(repo, number);
  if (target === undefined) return notFound();
  const body = bodyObject(req.body);
  const comment = addComment(req.forge, target, stringField(body, 'body') ?? '');
  return { status: 201, json: commentJson(repo, number, comment) };
}

// ---------------------------------------------------------------- pull requests

function createPullRoute(req: RestRequest, repo: RepoRec): RestResult {
  const body = bodyObject(req.body);
  const pull = createPull(req.forge, repo, {
    title: stringField(body, 'title') ?? '',
    body: stringField(body, 'body') ?? '',
    head: stringField(body, 'head') ?? '',
    base: stringField(body, 'base') ?? '',
  });
  return { status: 201, json: pullJson(repo, pull) };
}

function listPullsRoute(req: RestRequest, repo: RepoRec): RestResult {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') throw new DomainError(422, 'state is not valid');
  pulls.sort((a, b) => b.number - a.number);
  const { slice, headers } = paginate(req, pulls);
  return { status: 200, json: slice.map((pull) => pullJson(repo, pull)), headers };
}

function getPullRoute(repo: RepoRec, number: number): RestResult {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  return { status: 200, json: pullJson(repo, pull) };
}

function listPullFilesRoute(repo: RepoRec, number: number): RestResult {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  const files = pullFiles(repo, pull).map((file) => ({
    sha: file.newOid ?? file.oldOid ?? '',
    filename: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.additions + file.deletions,
    blob_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/blobs/${file.newOid ?? ''}`,
    raw_url: `https://forge.invalid/${repo.fullName}/raw/${file.path}`,
    contents_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/contents/${file.path}`,
  }));
  return { status: 200, json: files };
}

function mergePullRoute(req: RestRequest, repo: RepoRec, number: number): RestResult {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  const body = bodyObject(req.body);
  const methodRaw = stringField(body, 'merge_method') ?? 'merge';
  const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
  const { sha } = mergePull(req.forge, repo, pull, method);
  return { status: 200, json: { sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------- router

function parseNumber(segment: string | undefined): number | null {
  if (segment === undefined || !/^\d+$/.test(segment)) return null;
  return Number(segment);
}

function routeRepo(req: RestRequest, owner: string, name: string, rest: string[]): RestResult {
  const forge = req.forge;
  if (rest.length === 0) {
    if (req.method === 'GET') return getRepo(req, owner, name);
    if (req.method === 'PATCH') return patchRepo(req, owner, name);
    if (req.method === 'DELETE') return deleteRepo(req, owner, name);
    return notFound();
  }
  const repo = forge.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) return notFound();
  const [head, ...tail] = rest as [string, ...string[]];

  if (head === 'branches') {
    if (req.method !== 'GET') return notFound();
    if (tail.length === 0) return listBranches(repo);
    return getBranch(repo, tail.join('/'));
  }
  if (head === 'git' && tail[0] === 'refs') {
    if (req.method === 'POST' && tail.length === 1) return createRef(req, repo);
    if (req.method === 'GET' && tail.length === 1) return listRefs(repo);
    if (req.method === 'GET') return getRef(repo, tail.slice(1).join('/'));
    if (req.method === 'DELETE') return deleteRef(repo, tail.slice(1).join('/'));
    return notFound();
  }
  if (head === 'commits' && tail.length === 0 && req.method === 'GET') return listCommitsRoute(req, repo);
  if (head === 'contents') {
    const path = tail.join('/');
    if (req.method === 'GET') return getContentRoute(req, repo, path);
    if (req.method === 'PUT') return putContentRoute(req, repo, path);
    if (req.method === 'DELETE') return deleteContentRoute(req, repo, path);
    return notFound();
  }
  if (head === 'labels') {
    if (req.method === 'GET' && tail.length === 0) return listLabels(repo);
    if (req.method === 'POST' && tail.length === 0) return createLabel(req, repo);
    if (req.method === 'GET' && tail.length === 1) return getLabel(repo, tail[0] as string);
    return notFound();
  }
  if (head === 'issues') {
    if (tail.length === 0) {
      if (req.method === 'GET') return listIssuesRoute(req, repo);
      if (req.method === 'POST') return createIssueRoute(req, repo);
      return notFound();
    }
    const number = parseNumber(tail[0]);
    if (number === null) return notFound();
    if (tail.length === 1) {
      if (req.method === 'GET') return getIssueRoute(repo, number);
      if (req.method === 'PATCH') return patchIssueRoute(req, repo, number);
      return notFound();
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (req.method === 'GET') return listCommentsRoute(req, repo, number);
      if (req.method === 'POST') return createCommentRoute(req, repo, number);
      return notFound();
    }
    return notFound();
  }
  if (head === 'pulls') {
    if (tail.length === 0) {
      if (req.method === 'GET') return listPullsRoute(req, repo);
      if (req.method === 'POST') return createPullRoute(req, repo);
      return notFound();
    }
    const number = parseNumber(tail[0]);
    if (number === null) return notFound();
    if (tail.length === 1 && req.method === 'GET') return getPullRoute(repo, number);
    if (tail.length === 2 && tail[1] === 'files' && req.method === 'GET') return listPullFilesRoute(repo, number);
    if (tail.length === 2 && tail[1] === 'merge' && req.method === 'PUT') return mergePullRoute(req, repo, number);
    return notFound();
  }
  void forge;
  return notFound();
}

/** Dispatch one /api/v3 request. Domain errors become their HTTP status with a {message} body. */
export function handleRest(req: RestRequest): RestResult {
  try {
    const segments = req.segments;
    if (segments.length === 0) {
      return req.method === 'GET' ? rootDocument() : notFound();
    }
    const [head, ...tail] = segments as [string, ...string[]];
    if (head === 'meta' && tail.length === 0 && req.method === 'GET') return metaDocument();
    if (head === 'rate_limit' && tail.length === 0 && req.method === 'GET') {
      return {
        status: 200,
        json: {
          resources: { core: { limit: 5000, remaining: 5000, reset: 1735689600 }, search: { limit: 30, remaining: 30, reset: 1735689600 } },
          rate: { limit: 5000, remaining: 5000, reset: 1735689600 },
        },
      };
    }
    if (head === 'user' && tail.length === 0 && req.method === 'GET') return currentUser(req.forge);
    if (head === 'user' && tail[0] === 'repos' && tail.length === 1) {
      if (req.method === 'GET') return listUserRepos(req);
      if (req.method === 'POST') return createRepo(req);
      return notFound();
    }
    if (head === 'repos' && tail.length >= 2) {
      return routeRepo(req, tail[0] as string, tail[1] as string, tail.slice(2));
    }
    return notFound();
  } catch (err) {
    if (err instanceof DomainError) return { status: err.status, json: { message: err.message } };
    throw err;
  }
}
