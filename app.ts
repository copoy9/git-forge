// app.ts — the HTTP front door: one node:http server that routes health
// checks, the REST API, GraphQL, MCP and the git smart-HTTP transport, all
// backed by a single Forge store. Authentication is the suite's bearer
// token, checked on everything except /healthz.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  closureOf,
  isAncestor,
  peelToNonTag,
  pktFlush,
  pktLine,
  PktReader,
  readPack,
  writePack,
  ZERO_OID,
} from './git.ts';
import { handleRest, type RestResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcpMessage, type McpReply } from './mcp.ts';
import { Forge, VIEWER, type RepoRec } from './store.ts';

const AGENT = 'makefun-forge/1.0';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

export function expectedToken(): string {
  return process.env['MAKEFUN_SHOP_TOKEN'] ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === '') return true; // local development without a configured token
  const header = req.headers['authorization'];
  return header === `Bearer ${expected}` || header === expected;
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  sendBuffer(res, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(value), 'utf8'), headers);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- REST + GraphQL + MCP plumbing

function restReply(forge: Forge, res: ServerResponse, result: RestResult): void {
  const headers: Record<string, string> = { 'x-github-request-id': forge.requestId(), ...(result.headers ?? {}) };
  if (result.status === 204 || result.json === undefined) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  sendJson(res, result.status, result.json, headers);
}

async function handleApi(forge: Forge, req: IncomingMessage, res: ServerResponse, segments: string[], url: URL): Promise<void> {
  if (!authorized(req)) {
    restReply(forge, res, { status: 401, json: { message: 'Requires authentication' } });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      restReply(forge, res, { status: 400, json: { message: 'Problems parsing JSON' } });
      return;
    }
  }
  const result = handleRest({
    forge,
    method: req.method ?? 'GET',
    segments: segments.slice(2),
    query: url.searchParams,
    body,
    origin: `http://${req.headers['host'] ?? 'localhost'}`,
    pathname: url.pathname,
  });
  restReply(forge, res, result);
}

async function handleGraphQLRoute(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
    return;
  }
  const reply = handleGraphQL(forge, body);
  sendJson(res, reply.status, reply.json);
}

async function handleMcpRoute(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(body)) {
    const replies: unknown[] = [];
    for (const entry of body) {
      const reply: McpReply | null = handleMcpMessage(forge, entry);
      if (reply !== null && reply.json !== undefined) replies.push(reply.json);
    }
    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, replies);
    return;
  }
  const reply = handleMcpMessage(forge, body);
  if (reply === null || reply.json === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, reply.status, reply.json);
}

// ---------------------------------------------------------------- git smart HTTP

const GIT_ROUTE = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function refAdvertisementLines(forge: Forge, repo: RepoRec, caps: string): Buffer[] {
  void forge;
  const lines: Buffer[] = [];
  const headRef = repo.branchRef(repo.defaultBranch);
  const headOid = repo.refs.get(headRef);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'utf8')])));
    return lines;
  }
  let first = true;
  const pushLine = (oid: string, name: string): void => {
    if (first) {
      lines.push(pktLine(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${name}\n`));
    }
  };
  pushLine(headOid ?? ZERO_OID, 'HEAD');
  for (const [ref, oid] of refs) {
    pushLine(oid, ref);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      lines.push(pktLine(`${peelToNonTag(repo.objects, oid)} ${ref}^{}\n`));
    }
  }
  return lines;
}

function handleInfoRefs(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec, url: URL): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBuffer(res, 403, 'text/plain; charset=utf-8', Buffer.from('service not available\n', 'utf8'));
    return;
  }
  const protocol = req.headers['git-protocol'];
  const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    const parts = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ];
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
    return;
  }
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${repo.branchRef(repo.defaultBranch)}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts = [pktLine(`# service=${service}\n`), pktFlush(), ...refAdvertisementLines(forge, repo, caps), pktFlush()];
  const contentType = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  sendBuffer(res, 200, contentType, Buffer.concat(parts));
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsReply(repo: RepoRec, args: LsRefsArgs): Buffer {
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = repo.branchRef(repo.defaultBranch);
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (args.unborn) {
      lines.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let suffix = '';
    const object = repo.objects.get(oid);
    if (args.peel && object !== undefined && object.type === 'tag') suffix = ` peeled:${peelToNonTag(repo.objects, oid)}`;
    lines.push(pktLine(`${oid} ${ref}${suffix}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function sidebandWrap(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
}

function computeFetchPack(repo: RepoRec, plan: FetchPlan): { pack: Buffer; boundary: string[]; unshallow: string[] } {
  const store = repo.objects;
  const wants = plan.wants.filter((oid) => store.has(oid));
  const shallowSet = new Set(plan.shallow);
  const wantClosure = closureOf(store, wants, { maxCommitDepth: plan.deepen });
  let entries = [...wantClosure.objects.entries()];
  if (plan.haves.length > 0) {
    const haveClosure = closureOf(store, plan.haves.filter((oid) => store.has(oid)), { parentless: shallowSet });
    entries = entries.filter(([oid]) => !haveClosure.objects.has(oid));
  }
  const pack = writePack(entries.map(([, object]) => object));
  const boundary = [...wantClosure.boundary];
  const unshallow = plan.shallow.filter((oid) => wantClosure.objects.has(oid) && !wantClosure.boundary.has(oid));
  return { pack, boundary, unshallow };
}

function fetchReply(repo: RepoRec, plan: FetchPlan, version2: boolean): Buffer {
  const store = repo.objects;
  const { pack, boundary, unshallow } = computeFetchPack(repo, plan);
  const parts: Buffer[] = [];
  const shallowInvolved = plan.deepen !== undefined || plan.shallow.length > 0 || boundary.length > 0;
  if (version2) {
    if (plan.haves.length > 0) {
      const ackLines: Buffer[] = [pktLine('acknowledgments\n')];
      const present = plan.haves.filter((oid) => store.has(oid));
      if (present.length === 0) ackLines.push(pktLine('NAK\n'));
      else for (const oid of present) ackLines.push(pktLine(`ACK ${oid}\n`));
      ackLines.push(pktFlush());
      parts.push(...ackLines);
    }
    if (shallowInvolved) {
      const lines: Buffer[] = [pktLine('shallow-info\n')];
      for (const oid of boundary) lines.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) lines.push(pktLine(`unshallow ${oid}\n`));
      lines.push(pktFlush());
      parts.push(...lines);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandWrap(pack));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (plan.haves.length > 0) {
    const present = plan.haves.filter((oid) => store.has(oid));
    if (present.length === 0) parts.push(pktLine('NAK\n'));
    else for (const oid of present) parts.push(pktLine(`ACK ${oid}\n`));
  }
  if (shallowInvolved) {
    for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(...sidebandWrap(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseFetchRequest(body: Buffer, version2: boolean): FetchPlan | 'ls-refs' | LsRefsArgs | null {
  const reader = new PktReader(body);
  const plan: FetchPlan = { wants: [], haves: [], shallow: [] };
  if (version2) {
    let command = '';
    let inArgs = false;
    const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (;;) {
      const packet = reader.next();
      if (packet === null || packet.kind === 'flush') break;
      if (packet.kind === 'end') break;
      if (packet.kind === 'delim') {
        inArgs = true;
        continue;
      }
      const line = packet.data.toString('utf8').replace(/\n$/, '');
      if (!inArgs) {
        if (line.startsWith('command=')) command = line.slice('command='.length);
        continue;
      }
      if (command === 'ls-refs') {
        if (line === 'peel') lsArgs.peel = true;
        else if (line === 'symrefs') lsArgs.symrefs = true;
        else if (line === 'unborn') lsArgs.unborn = true;
        else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
      } else if (command === 'fetch') {
        if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) plan.deepen = Number.parseInt(line.slice(7), 10);
      }
    }
    if (command === 'ls-refs') return lsArgs;
    if (command === 'fetch') return plan;
    return null;
  }
  // Protocol v0: want lines up to a flush, then have lines up to flush/EOF.
  let section: 'want' | 'have' = 'want';
  for (;;) {
    const packet = reader.next();
    if (packet === null) break;
    if (packet.kind === 'flush') {
      if (section === 'want') {
        section = 'have';
        continue;
      }
      break;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.deepen = Number.parseInt(line.slice(7), 10);
  }
  return plan;
}

async function handleUploadPack(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  void forge;
  const raw = await readBody(req);
  const protocol = req.headers['git-protocol'];
  const version2 = (typeof protocol === 'string' && protocol.includes('version=2')) || raw.toString('latin1', 0, 64).includes('command=');
  const parsed = parseFetchRequest(raw, version2);
  if (parsed === null) {
    sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('unsupported request\n', 'utf8'));
    return;
  }
  if (typeof parsed === 'object' && 'prefixes' in parsed) {
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsReply(repo, parsed));
    return;
  }
  const plan = parsed as FetchPlan;
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchReply(repo, plan, version2));
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  const raw = await readBody(req);
  const reader = new PktReader(raw);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (;;) {
    const packet = reader.next();
    if (packet === null || packet.kind === 'flush' || packet.kind === 'end') break;
    if (packet.kind !== 'data') break;
    let line = packet.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = reader.rest();
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      readPack(repo.objects, packBytes, (oid) => repo.objects.get(oid));
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }
  const wantsReport = capabilities.includes('report-status');
  const useSideband = capabilities.includes('side-band-64k');
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    results.push(applyPushCommand(repo, command));
  }
  if (results.some((result) => result.ok)) repo.updatedAt = forge.tick().iso;
  if (!wantsReport) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportParts: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  reportParts.push(pktFlush());
  const report = Buffer.concat(reportParts);
  if (useSideband) {
    const wrapped = [...sidebandWrap(report), pktFlush()];
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(wrapped));
    return;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', report);
}

function applyPushCommand(repo: RepoRec, command: PushCommand): { ref: string; ok: boolean; reason?: string } {
  const { ref, oldOid, newOid } = command;
  if (!ref.startsWith('refs/')) return { ref, ok: false, reason: 'invalid ref' };
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return { ref, ok: false, reason: 'reference does not exist' };
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  const object = repo.objects.get(newOid);
  if (object === undefined) return { ref, ok: false, reason: 'new object not found' };
  if (ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return { ref, ok: false, reason: 'not a commit' };
    if (current !== ZERO_OID) {
      const currentObject = repo.objects.get(current);
      if (currentObject !== undefined && currentObject.type === 'commit' && !isAncestor(repo.objects, current, newOid)) {
        return { ref, ok: false, reason: 'non-fast-forward' };
      }
    }
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true };
}

// ---------------------------------------------------------------- server

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const pathname = url.pathname;
  if (pathname === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }
  const rawSegments = pathname.split('/').filter((segment) => segment !== '');
  const segments = rawSegments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (segments[0] === 'api' && segments[1] === 'v3') {
    await handleApi(forge, req, res, segments, url);
    return;
  }
  if (pathname === '/api/graphql') {
    await handleGraphQLRoute(forge, req, res);
    return;
  }
  if (pathname === '/mcp') {
    await handleMcpRoute(forge, req, res);
    return;
  }
  const gitMatch = GIT_ROUTE.exec(pathname);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined || repo.owner !== VIEWER.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const endpoint = gitMatch[3] as string;
    if (endpoint === 'info/refs' && req.method === 'GET') {
      handleInfoRefs(forge, req, res, repo, url);
      return;
    }
    if (endpoint === 'git-upload-pack' && req.method === 'POST') {
      await handleUploadPack(forge, req, res, repo);
      return;
    }
    if (endpoint === 'git-receive-pack' && req.method === 'POST') {
      await handleReceivePack(forge, req, res, repo);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

export function createForgeServer(forge: Forge): Server {
  const server = createServer((req, res) => {
    handle(forge, req, res).catch((err: unknown) => {
      console.error('forge: request failed:', err);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  return server;
}
