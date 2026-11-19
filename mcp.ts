// mcp.ts — the Model Context Protocol endpoint at /mcp (Streamable HTTP,
// JSON-RPC 2.0). It answers the modern server/discover handshake as well as
// the legacy initialize flow, serves a constant tool list, and runs the
// forge tools against the same store the REST API uses, so ids and numbers
// agree across surfaces.

import {
  createIssue,
  createPull,
  DomainError,
  issueJson,
  mergePull,
  pullJson,
  repoJson,
  VIEWER,
  type Forge,
  type RepoRec,
} from './store.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const prop = (type: string, description: string): { type: string; description: string } => ({ type, description });

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the signed-in user and return the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('string', 'The repository name.'),
        description: prop('string', 'A short description of the repository.'),
        private: prop('boolean', 'Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Fetch one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository and return the issue object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The issue title.'),
        body: prop('string', 'The issue body text.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        state: prop('string', 'Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The pull request title.'),
        body: prop('string', 'The pull request body text.'),
        head: prop('string', 'The head branch to merge from.'),
        base: prop('string', 'The base branch to merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        pull_number: prop('number', 'The pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Fetch one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        issue_number: prop('number', 'The issue number.'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an open issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        issue_number: prop('number', 'The issue number.'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export interface McpReply {
  status: number;
  json?: unknown;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function requireRepo(forge: Forge, args: Record<string, unknown>): RepoRec {
  const owner = stringArg(args, 'owner');
  const name = stringArg(args, 'repo');
  const repo = forge.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) throw new DomainError(404, `Repository ${owner}/${name} not found`);
  return repo;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      const existing = forge.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return toolSuccess(repoJson(existing));
      const repo = forge.createRepo(VIEWER.login, repoName, {
        description: stringArg(args, 'description'),
        isPrivate: args['private'] === true,
      });
      return toolSuccess(repoJson(repo));
    }
    case 'get_repo': {
      return toolSuccess(repoJson(requireRepo(forge, args)));
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      const issue = createIssue(forge, repo, { title: stringArg(args, 'title'), body: stringArg(args, 'body') });
      return toolSuccess(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      const state = stringArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolSuccess(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      const pull = createPull(forge, repo, {
        title: stringArg(args, 'title'),
        body: stringArg(args, 'body'),
        head: stringArg(args, 'head'),
        base: stringArg(args, 'base'),
      });
      return toolSuccess(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      const number = Number(args['pull_number']);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFailure(`Pull request #${number} not found`);
      mergePull(forge, repo, pull, 'squash');
      return toolSuccess(pullJson(repo, pull));
    }
    case 'get_issue': {
      const repo = requireRepo(forge, args);
      const issue = repo.issues.get(Number(args['issue_number']));
      if (issue === undefined) return toolFailure(`Issue #${String(args['issue_number'])} not found`);
      return toolSuccess(issueJson(repo, issue));
    }
    case 'close_issue': {
      const repo = requireRepo(forge, args);
      const issue = repo.issues.get(Number(args['issue_number']));
      if (issue === undefined) return toolFailure(`Issue #${String(args['issue_number'])} not found`);
      const now = forge.tick().iso;
      issue.state = 'closed';
      issue.closedAt = now;
      issue.updatedAt = now;
      return toolSuccess(issueJson(repo, issue));
    }
    default:
      throw new DomainError(404, `Unknown tool: ${name}`);
  }
}

function handleToolsCall(forge: Forge, id: unknown, params: Record<string, unknown>): McpReply {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null ? params['arguments'] : {}) as Record<string, unknown>;
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(id, -32602, `Missing required argument: ${required}`);
    }
  }
  try {
    return rpcResult(id, callTool(forge, name, args));
  } catch (err) {
    if (err instanceof DomainError) return rpcResult(id, toolFailure(err.message));
    throw err;
  }
}

/** Handle one JSON-RPC message; returns null for notifications (answer 202, empty). */
export function handleMcpMessage(forge: Forge, message: unknown): McpReply | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const record = message as Record<string, unknown>;
  const method = typeof record['method'] === 'string' ? record['method'] : '';
  const id = record['id'];
  const isNotification = id === undefined;
  const params = (typeof record['params'] === 'object' && record['params'] !== null ? record['params'] : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call':
      return handleToolsCall(forge, id, params);
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
