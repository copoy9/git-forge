// graphql.ts — a small GraphQL engine for the shapes the suite (and tools
// like gh) send: a lexer and parser for operations, fragments, variables and
// inline input values, plus an executor over the shared Forge store with the
// repository/issue/pull-request surface and the __type introspection the
// checks probe. No external GraphQL library — the documents are fixed and
// this keeps the runtime dependency-free.

import { parseCommit } from './git.ts';
import {
  addComment,
  createIssue,
  createPull,
  decodeGlobalId,
  DomainError,
  issueGlobalId,
  mergePull,
  pullFiles,
  pullGlobalId,
  pullHeadSha,
  pullBaseSha,
  pullMergeable,
  repoGlobalId,
  commentGlobalId,
  userGlobalId,
  VIEWER,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ---------------------------------------------------------------- lexer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- AST and parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export type SelectionNode =
  | { kind: 'field'; alias?: string; name: string; args: Map<string, ValueNode>; selection: SelectionNode[] | null }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

export interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
  variableDefaults: Map<string, ValueNode>;
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(kind: Token['kind'], value?: string): Token {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind}, found ${token.value}`);
    }
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet(), variableDefaults: new Map() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${token.value}`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefaults = new Map<string, ValueNode>();
        if (this.atPunct('(')) this.parseVariableDefinitions(variableDefaults);
        this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selection: this.parseSelectionSet(),
          variableDefaults,
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      // Schema/type-system definitions are parsed over and ignored.
      this.skipDefinition();
    }
    return { operations, fragments };
  }

  private skipDefinition(): void {
    // Skip tokens until the next top-level definition boundary: a balanced
    // block, if any, then stop when a name or '{' begins at depth zero.
    let depth = 0;
    let consumed = 0;
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (consumed > 0 && depth === 0 && (token.kind === 'name' || (token.kind === 'punct' && token.value === '{'))) return;
      if (token.kind === 'punct' && (token.value === '{' || token.value === '(' || token.value === '[')) depth += 1;
      if (token.kind === 'punct' && (token.value === '}' || token.value === ')' || token.value === ']')) depth -= 1;
      this.next();
      consumed += 1;
    }
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expect('punct', '(');
    while (!this.atPunct(')')) {
      this.expect('punct', '$');
      const name = this.expect('name').value;
      this.expect('punct', ':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        defaults.set(name, this.parseValue());
      }
      this.skipDirectives();
    }
    this.expect('punct', ')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    if (this.atPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expect('name');
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expect('name');
          this.expect('punct', ':');
          this.parseValue();
        }
        this.expect('punct', ')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('punct', '{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          const name = this.expect('name').value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.expect('name').value;
      let alias: string | undefined;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.expect('name').value;
      }
      const args = new Map<string, ValueNode>();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.expect('name').value;
          this.expect('punct', ':');
          args.set(argName, this.parseValue());
        }
        this.expect('punct', ')');
      }
      this.skipDirectives();
      const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.expect('punct', '}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expect('name').value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expect('punct', ']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expect('name').value;
        this.expect('punct', ':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('punct', '}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function evaluate(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evaluate(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluate(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema tables (introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'updateIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createLabel', 'deleteLabel'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl', 'bio', 'company', 'location', 'websiteUrl', 'createdAt', 'updatedAt', 'isViewer', 'viewerIsFollowing', 'followers', 'following', 'repositories', 'issues', 'pullRequests'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'isFork', 'isArchived', 'isDisabled',
    'isEmpty', 'isLocked', 'isMirror', 'isTemplate', 'url', 'homepageUrl', 'sshUrl', 'createdAt', 'updatedAt', 'pushedAt',
    'viewerCanAdminister', 'viewerCanUpdateTopics', 'viewerHasStarred', 'viewerSubscription', 'stargazerCount', 'forkCount',
    'watchers', 'primaryLanguage', 'languages', 'labels', 'milestones', 'collaborators', 'assignableUsers', 'mentionableUsers',
    'mergeCommitAllowed', 'rebaseMergeAllowed', 'squashMergeAllowed', 'autoMergeAllowed', 'deleteBranchOnMerge',
    'hasProjectsEnabled', 'hasWikiEnabled', 'hasDiscussionsEnabled', 'visibility', 'diskUsage', 'licenseInfo', 'codeOfConduct',
    'repositoryTopics', 'projects', 'securityPolicyUrl', 'tempCloneToken', 'fundingLinks', 'contactLinks',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'bodyHTML', 'author', 'repository', 'labels',
    'comments', 'assignees', 'createdAt', 'updatedAt', 'closedAt', 'url', 'resourcePath', 'locked', 'milestone',
    'reactions', 'participants', 'viewerCanUpdate', 'viewerCanReact', 'viewerCanSubscribe', 'viewerSubscription',
    'viewerCanDelete', 'viewerCanPin', 'viewerCanLock', 'viewerCanConvertToDiscussion', 'viewerCanTransfer',
    'lastEditedAt', 'publishedAt', 'editor', 'stateReason', 'isPinned', 'hovercard', 'projectCards', 'linkedBranches',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'files', 'author', 'repository',
    'mergeCommit', 'createdAt', 'updatedAt', 'closedAt', 'url', 'resourcePath', 'additions', 'deletions', 'changedFiles',
    'commits', 'comments', 'labels', 'isDraft', 'locked', 'mergedBy', 'reviewRequests', 'reviews', 'participants',
    'viewerCanUpdate', 'viewerCanSubscribe', 'viewerSubscription', 'activeLockReason', 'suggestedReviewers',
    'potentialMergeCommit', 'isCrossRepository', 'isReadByViewer', 'viewerCanApplySuggestion', 'viewerCanDeleteHeadRef',
  ],
  Ref: ['name', 'prefix', 'target', 'repository', 'associatedPullRequests'],
  Commit: ['oid', 'abbreviatedOid', 'message', 'messageHeadline', 'messageBody', 'committedDate', 'authoredDate', 'author', 'committer', 'tree', 'parents', 'url', 'repository', 'additions', 'deletions', 'changedFilesIfAvailable', 'zipballUrl', 'tarballUrl'],
  Tree: ['oid', 'abbreviatedOid', 'entries', 'repository'],
  TreeEntry: ['name', 'path', 'mode', 'type', 'object', 'isGenerated', 'extension', 'language', 'lineCount', 'size', 'oid'],
  Blob: ['oid', 'abbreviatedOid', 'byteSize', 'isBinary', 'isTruncated', 'text', 'commitResourcePath', 'commitUrl'],
  GitActor: ['name', 'email', 'date', 'user', 'avatarUrl'],
  Label: ['id', 'name', 'color', 'description', 'url', 'createdAt', 'updatedAt', 'isDefault', 'issues', 'pullRequests', 'repository'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'issue', 'repository', 'viewerCanUpdate', 'viewerCanDelete', 'reactions', 'minimizedReason', 'isMinimized'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommitHistoryConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL', 'isOneOf', 'interfaces', 'specifiedByUrl'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives', 'description'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  IssueClosedStateReason: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'],
  PullRequestChangedFileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
  RepositoryVisibility: ['PUBLIC', 'PRIVATE', 'INTERNAL'],
  CommentAuthorAssociation: ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE'],
};

const ENUM_TYPES = new Set(Object.keys(ENUM_VALUES));
const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'Base64String', 'HTML', 'X509Certificate', 'GitTimestamp', 'PreciseDateTime', 'Date']);
const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label']);
const INPUT_TYPES = new Set(['CreateIssueInput', 'CloseIssueInput', 'CreatePullRequestInput', 'MergePullRequestInput', 'AddCommentInput', 'IssueOrder', 'PullRequestOrder']);

const KNOWN_TYPES = new Set<string>([
  ...Object.keys(TYPE_FIELDS),
  ...ENUM_TYPES,
  ...SCALAR_TYPES,
  ...INPUT_TYPES,
  'Node',
  'SearchResultItemConnection',
]);

function typeKind(name: string): string {
  if (ENUM_TYPES.has(name)) return 'ENUM';
  if (SCALAR_TYPES.has(name)) return 'SCALAR';
  if (INPUT_TYPES.has(name) || name.endsWith('Input') || name.endsWith('Order')) return 'INPUT_OBJECT';
  if (name === 'Node') return 'INTERFACE';
  return 'OBJECT';
}

// ---------------------------------------------------------------- executor

interface Box {
  __type: string;
  value: unknown;
}

const box = (type: string, value: unknown): Box => ({ __type: type, value });

function isBox(value: unknown): value is Box {
  return typeof value === 'object' && value !== null && '__type' in value && 'value' in value;
}

interface GqlError {
  message: string;
  path: (string | number)[];
}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
  errors: GqlError[];
}

interface ConnSource {
  items: { node: Box; cursor: string }[];
  hasNextPage: boolean;
  totalCount: number;
}

const encodeCursor = (n: number): string => Buffer.from(`cursor:${n}`, 'utf8').toString('base64');

function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function makeConnection(type: string, all: { node: Box; key: number }[], args: Record<string, unknown>): Box {
  let start = 0;
  const after = args['after'];
  if (typeof after === 'string' && after !== '') {
    const key = decodeCursor(after);
    const index = key === null ? -1 : all.findIndex((item) => item.key === key);
    start = index === -1 ? 0 : index + 1;
  }
  const first = typeof args['first'] === 'number' ? Math.max(0, args['first']) : all.length;
  const slice = all.slice(start, start + first);
  const source: ConnSource = {
    items: slice.map((item) => ({ node: item.node, cursor: encodeCursor(item.key) })),
    hasNextPage: start + slice.length < all.length,
    totalCount: all.length,
  };
  return box(type, source);
}

function pageInfoBox(source: ConnSource): Box {
  return box('PageInfo', {
    hasNextPage: source.hasNextPage,
    hasPreviousPage: false,
    startCursor: source.items[0]?.cursor ?? null,
    endCursor: source.items[source.items.length - 1]?.cursor ?? null,
  });
}

const connectionResolvers: Record<string, (ctx: Ctx, source: ConnSource) => unknown> = {
  nodes: (_ctx, source) => source.items.map((item) => item.node),
  edges: (_ctx, source) => source.items.map((item) => box('Edge', { node: item.node, cursor: item.cursor })),
  pageInfo: (_ctx, source) => pageInfoBox(source),
  totalCount: (_ctx, source) => source.totalCount,
};

// ---------------------------------------------------------------- entity sources

interface IssueSource {
  repo: RepoRec;
  issue: IssueRec;
}
interface PullSource {
  repo: RepoRec;
  pull: PullRec;
}
interface CommentSource {
  repo: RepoRec;
  issueNumber: number;
  comment: { id: number; body: string; createdAt: string; updatedAt: string };
}

const viewerBox = (): Box => box('User', VIEWER);
const repoBox = (repo: RepoRec): Box => box('Repository', repo);
const issueBox = (repo: RepoRec, issue: IssueRec): Box => box('Issue', { repo, issue } satisfies IssueSource);
const pullBox = (repo: RepoRec, pull: PullRec): Box => box('PullRequest', { repo, pull } satisfies PullSource);

function findComment(forge: Forge, id: number): CommentSource | null {
  for (const repo of forge.reposById.values()) {
    for (const issue of repo.issues.values()) {
      const comment = issue.comments.find((candidate) => candidate.id === id);
      if (comment !== undefined) return { repo, issueNumber: issue.number, comment };
    }
    for (const pull of repo.pulls.values()) {
      const comment = pull.comments.find((candidate) => candidate.id === id);
      if (comment !== undefined) return { repo, issueNumber: pull.number, comment };
    }
  }
  return null;
}

function nodeById(forge: Forge, id: string): Box | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'R') {
    const repo = forge.reposById.get(decoded.parts[0] as number);
    return repo !== undefined && repo.owner === VIEWER.login ? repoBox(repo) : null;
  }
  if (decoded.kind === 'I') {
    const repo = forge.reposById.get(decoded.parts[0] as number);
    const issue = repo?.issues.get(decoded.parts[1] as number);
    return repo !== undefined && issue !== undefined ? issueBox(repo, issue) : null;
  }
  if (decoded.kind === 'P') {
    const repo = forge.reposById.get(decoded.parts[0] as number);
    const pull = repo?.pulls.get(decoded.parts[1] as number);
    return repo !== undefined && pull !== undefined ? pullBox(repo, pull) : null;
  }
  if (decoded.kind === 'C') {
    const found = findComment(forge, decoded.parts[0] as number);
    return found === null ? null : box('IssueComment', found);
  }
  if (decoded.kind === 'U') {
    return decoded.parts[0] === VIEWER.id ? viewerBox() : null;
  }
  return null;
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): Box {
  let list = [...repo.issues.values()];
  const states = args['states'];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args['orderBy'] as { direction?: string } | undefined;
  const desc = orderBy?.direction === 'DESC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  return makeConnection('IssueConnection', list.map((issue) => ({ node: issueBox(repo, issue), key: issue.number })), args);
}

function pullsConnection(repo: RepoRec, args: Record<string, unknown>): Box {
  let list = [...repo.pulls.values()];
  const states = args['states'];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(state);
    });
  }
  list.sort((a, b) => a.number - b.number);
  return makeConnection('PullRequestConnection', list.map((pull) => ({ node: pullBox(repo, pull), key: pull.number })), args);
}

type Resolver = (ctx: Ctx, source: never, args: Record<string, unknown>) => unknown;

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerBox(),
    repository: (ctx, _source, args) => {
      const repo = ctx.forge.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
      return repo !== undefined && repo.owner === VIEWER.login ? repoBox(repo) : null;
    },
    node: (ctx, _source, args) => nodeById(ctx.forge, String(args['id'] ?? '')),
    nodes: (ctx, _source, args) => {
      const ids = Array.isArray(args['ids']) ? args['ids'] : [];
      return ids.map((id) => nodeById(ctx.forge, String(id)));
    },
    user: (_ctx, _source, args) => (args['login'] === VIEWER.login ? viewerBox() : null),
    rateLimit: () => box('RateLimit', { limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: '2025-01-01T01:00:00Z', nodeCount: 0 }),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input['repositoryId'] ?? ''));
      const repo = decoded?.kind === 'R' ? ctx.forge.reposById.get(decoded.parts[0] as number) : undefined;
      if (repo === undefined) throw new DomainError(422, 'repositoryId does not identify a repository');
      const issue = createIssue(ctx.forge, repo, {
        title: String(input['title'] ?? ''),
        body: typeof input['body'] === 'string' ? input['body'] : '',
      });
      return box('CreateIssuePayload', { issue: issueBox(repo, issue), clientMutationId: input['clientMutationId'] ?? null });
    },
    closeIssue: (ctx, _source, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input['issueId'] ?? ''));
      const repo = decoded?.kind === 'I' ? ctx.forge.reposById.get(decoded.parts[0] as number) : undefined;
      const issue = repo?.issues.get(decoded?.parts[1] as number);
      if (repo === undefined || issue === undefined) throw new DomainError(422, 'issueId does not identify an issue');
      const now = ctx.forge.tick().iso;
      issue.state = 'closed';
      issue.closedAt = now;
      issue.updatedAt = now;
      return box('CloseIssuePayload', { issue: issueBox(repo, issue), clientMutationId: input['clientMutationId'] ?? null });
    },
    createPullRequest: (ctx, _source, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input['repositoryId'] ?? ''));
      const repo = decoded?.kind === 'R' ? ctx.forge.reposById.get(decoded.parts[0] as number) : undefined;
      if (repo === undefined) throw new DomainError(422, 'repositoryId does not identify a repository');
      const pull = createPull(ctx.forge, repo, {
        title: String(input['title'] ?? ''),
        body: typeof input['body'] === 'string' ? input['body'] : '',
        head: String(input['headRefName'] ?? ''),
        base: String(input['baseRefName'] ?? ''),
      });
      return box('CreatePullRequestPayload', { pullRequest: pullBox(repo, pull), clientMutationId: input['clientMutationId'] ?? null });
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input['pullRequestId'] ?? ''));
      const repo = decoded?.kind === 'P' ? ctx.forge.reposById.get(decoded.parts[0] as number) : undefined;
      const pull = repo?.pulls.get(decoded?.parts[1] as number);
      if (repo === undefined || pull === undefined) throw new DomainError(422, 'pullRequestId does not identify a pull request');
      const methodRaw = String(input['mergeMethod'] ?? 'SQUASH').toLowerCase();
      const method = methodRaw === 'merge' ? 'merge' : methodRaw === 'rebase' ? 'rebase' : 'squash';
      mergePull(ctx.forge, repo, pull, method);
      return box('MergePullRequestPayload', { pullRequest: pullBox(repo, pull), clientMutationId: input['clientMutationId'] ?? null });
    },
    addComment: (ctx, _source, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input['subjectId'] ?? ''));
      if (decoded === null || (decoded.kind !== 'I' && decoded.kind !== 'P')) throw new DomainError(422, 'subjectId does not identify an issue or pull request');
      const repo = ctx.forge.reposById.get(decoded.parts[0] as number);
      const target = repo === undefined ? undefined : decoded.kind === 'I' ? repo.issues.get(decoded.parts[1] as number) : repo.pulls.get(decoded.parts[1] as number);
      if (repo === undefined || target === undefined) throw new DomainError(422, 'subjectId does not identify an issue or pull request');
      const comment = addComment(ctx.forge, target, String(input['body'] ?? ''));
      const commentBox = box('IssueComment', { repo, issueNumber: target.number, comment } satisfies CommentSource);
      const subject = decoded.kind === 'I' ? issueBox(repo, target as IssueRec) : pullBox(repo, target as PullRec);
      return box('AddCommentPayload', {
        commentEdge: box('IssueCommentEdge', { node: commentBox, cursor: encodeCursor(comment.id) }),
        subject,
        clientMutationId: input['clientMutationId'] ?? null,
      });
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => userGlobalId(VIEWER.id),
    databaseId: () => VIEWER.id,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `https://forge.invalid/${VIEWER.login}`,
    avatarUrl: () => '',
    isViewer: () => true,
  },
  Repository: {
    id: (_ctx, repo: RepoRec) => repoGlobalId(repo.id),
    databaseId: (_ctx, repo: RepoRec) => repo.id,
    name: (_ctx, repo: RepoRec) => repo.name,
    nameWithOwner: (_ctx, repo: RepoRec) => repo.fullName,
    owner: () => viewerBox(),
    description: (_ctx, repo: RepoRec) => repo.description,
    isPrivate: (_ctx, repo: RepoRec) => repo.isPrivate,
    isFork: () => false,
    isArchived: () => false,
    isDisabled: () => false,
    isEmpty: (_ctx, repo: RepoRec) => repo.refs.size === 0,
    url: (_ctx, repo: RepoRec) => `https://forge.invalid/${repo.fullName}`,
    sshUrl: (_ctx, repo: RepoRec) => `git@forge.invalid:${repo.fullName}.git`,
    createdAt: (_ctx, repo: RepoRec) => repo.createdAt,
    updatedAt: (_ctx, repo: RepoRec) => repo.updatedAt,
    pushedAt: (_ctx, repo: RepoRec) => repo.updatedAt,
    viewerPermission: () => 'ADMIN',
    viewerCanAdminister: () => true,
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => true,
    hasWikiEnabled: () => true,
    hasDiscussionsEnabled: () => false,
    stargazerCount: () => 0,
    forkCount: () => 0,
    diskUsage: () => 0,
    visibility: (_ctx, repo: RepoRec) => (repo.isPrivate ? 'PRIVATE' : 'PUBLIC'),
    defaultBranchRef: (_ctx, repo: RepoRec) => {
      const tip = repo.tipOf(repo.defaultBranch);
      return tip === undefined ? null : box('Ref', { repo, name: repo.defaultBranch });
    },
    issue: (_ctx, repo: RepoRec, args) => {
      const issue = repo.issues.get(Number(args['number']));
      return issue === undefined ? null : issueBox(repo, issue);
    },
    issues: (_ctx, repo: RepoRec, args) => issuesConnection(repo, args),
    pullRequest: (_ctx, repo: RepoRec, args) => {
      const pull = repo.pulls.get(Number(args['number']));
      return pull === undefined ? null : pullBox(repo, pull);
    },
    pullRequests: (_ctx, repo: RepoRec, args) => pullsConnection(repo, args),
  },
  Issue: {
    id: (_ctx, source: IssueSource) => issueGlobalId(source.repo.id, source.issue.number),
    databaseId: (_ctx, source: IssueSource) => source.issue.dbId,
    number: (_ctx, source: IssueSource) => source.issue.number,
    title: (_ctx, source: IssueSource) => source.issue.title,
    body: (_ctx, source: IssueSource) => source.issue.body,
    bodyText: (_ctx, source: IssueSource) => source.issue.body,
    state: (_ctx, source: IssueSource) => (source.issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    author: () => viewerBox(),
    repository: (_ctx, source: IssueSource) => repoBox(source.repo),
    url: (_ctx, source: IssueSource) => `https://forge.invalid/${source.repo.fullName}/issues/${source.issue.number}`,
    createdAt: (_ctx, source: IssueSource) => source.issue.createdAt,
    updatedAt: (_ctx, source: IssueSource) => source.issue.updatedAt,
    closedAt: (_ctx, source: IssueSource) => source.issue.closedAt,
    locked: () => false,
    labels: (_ctx, source: IssueSource, args) => {
      const labels = source.issue.labels
        .map((name) => source.repo.labels.get(name))
        .filter((label) => label !== undefined)
        .map((label) => ({ node: box('Label', { repo: source.repo, label }), key: label.id }));
      return makeConnection('LabelConnection', labels, args);
    },
    comments: (_ctx, source: IssueSource, args) =>
      makeConnection(
        'IssueCommentConnection',
        source.issue.comments.map((comment) => ({
          node: box('IssueComment', { repo: source.repo, issueNumber: source.issue.number, comment } satisfies CommentSource),
          key: comment.id,
        })),
        args,
      ),
  },
  PullRequest: {
    id: (_ctx, source: PullSource) => pullGlobalId(source.repo.id, source.pull.number),
    databaseId: (_ctx, source: PullSource) => source.pull.dbId,
    number: (_ctx, source: PullSource) => source.pull.number,
    title: (_ctx, source: PullSource) => source.pull.title,
    body: (_ctx, source: PullSource) => source.pull.body,
    bodyText: (_ctx, source: PullSource) => source.pull.body,
    state: (_ctx, source: PullSource) => (source.pull.merged ? 'MERGED' : source.pull.state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: (_ctx, source: PullSource) => source.pull.merged,
    mergedAt: (_ctx, source: PullSource) => source.pull.mergedAt,
    mergeable: (_ctx, source: PullSource) => pullMergeable(source.repo, source.pull),
    headRefName: (_ctx, source: PullSource) => source.pull.headRef,
    baseRefName: (_ctx, source: PullSource) => source.pull.baseRef,
    headRefOid: (_ctx, source: PullSource) => pullHeadSha(source.repo, source.pull),
    baseRefOid: (_ctx, source: PullSource) => pullBaseSha(source.repo, source.pull),
    headRef: (_ctx, source: PullSource) => {
      const tip = source.repo.tipOf(source.pull.headRef);
      return tip === undefined ? null : box('Ref', { repo: source.repo, name: source.pull.headRef });
    },
    baseRef: (_ctx, source: PullSource) => {
      const tip = source.repo.tipOf(source.pull.baseRef);
      return tip === undefined ? null : box('Ref', { repo: source.repo, name: source.pull.baseRef });
    },
    author: () => viewerBox(),
    repository: (_ctx, source: PullSource) => repoBox(source.repo),
    url: (_ctx, source: PullSource) => `https://forge.invalid/${source.repo.fullName}/pull/${source.pull.number}`,
    createdAt: (_ctx, source: PullSource) => source.pull.createdAt,
    updatedAt: (_ctx, source: PullSource) => source.pull.updatedAt,
    closedAt: (_ctx, source: PullSource) => source.pull.closedAt,
    isDraft: () => false,
    locked: () => false,
    mergeCommit: (_ctx, source: PullSource) =>
      source.pull.mergeCommitSha === null ? null : box('Commit', { repo: source.repo, oid: source.pull.mergeCommitSha }),
    additions: (_ctx, source: PullSource) => pullFiles(source.repo, source.pull).reduce((sum, file) => sum + file.additions, 0),
    deletions: (_ctx, source: PullSource) => pullFiles(source.repo, source.pull).reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: (_ctx, source: PullSource) => pullFiles(source.repo, source.pull).length,
    files: (_ctx, source: PullSource, args) => {
      const files = pullFiles(source.repo, source.pull);
      const first = typeof args['first'] === 'number' ? args['first'] : files.length;
      const sourceConn: ConnSource = {
        items: files.slice(0, first).map((file, index) => ({
          node: box('PullRequestChangedFile', {
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }),
          cursor: encodeCursor(index),
        })),
        hasNextPage: files.length > first,
        totalCount: files.length,
      };
      return box('PullRequestChangedFileConnection', sourceConn);
    },
  },
  Ref: {
    name: (_ctx, source: { repo: RepoRec; name: string }) => source.name,
    prefix: () => 'refs/heads/',
    target: (_ctx, source: { repo: RepoRec; name: string }) => {
      const tip = source.repo.tipOf(source.name);
      return tip === undefined ? null : box('Commit', { repo: source.repo, oid: tip });
    },
    repository: (_ctx, source: { repo: RepoRec; name: string }) => repoBox(source.repo),
  },
  Commit: {
    oid: (_ctx, source: { repo: RepoRec; oid: string }) => source.oid,
    abbreviatedOid: (_ctx, source: { repo: RepoRec; oid: string }) => source.oid.slice(0, 7),
    message: (_ctx, source: { repo: RepoRec; oid: string }) => commitInfo(source).message,
    messageHeadline: (_ctx, source: { repo: RepoRec; oid: string }) => commitInfo(source).message.split('\n')[0] ?? '',
    committedDate: (_ctx, source: { repo: RepoRec; oid: string }) => new Date(commitInfo(source).committer.timestamp * 1000).toISOString(),
    authoredDate: (_ctx, source: { repo: RepoRec; oid: string }) => new Date(commitInfo(source).author.timestamp * 1000).toISOString(),
    author: (_ctx, source: { repo: RepoRec; oid: string }) => box('GitActor', commitInfo(source).author),
    committer: (_ctx, source: { repo: RepoRec; oid: string }) => box('GitActor', commitInfo(source).committer),
    tree: (_ctx, source: { repo: RepoRec; oid: string }) => box('Tree', { repo: source.repo, oid: commitInfo(source).tree }),
    url: (_ctx, source: { repo: RepoRec; oid: string }) => `https://forge.invalid/${source.repo.fullName}/commit/${source.oid}`,
    repository: (_ctx, source: { repo: RepoRec; oid: string }) => repoBox(source.repo),
  },
  GitActor: {
    name: (_ctx, source: { name: string }) => source.name,
    email: (_ctx, source: { email: string }) => source.email,
    date: (_ctx, source: { timestamp: number }) => new Date(source.timestamp * 1000).toISOString(),
    user: (_ctx, source: { email: string }) => (source.email === VIEWER.email ? viewerBox() : null),
    avatarUrl: () => '',
  },
  Tree: {
    oid: (_ctx, source: { oid: string }) => source.oid,
    abbreviatedOid: (_ctx, source: { oid: string }) => source.oid.slice(0, 7),
  },
  Label: {
    id: (_ctx, source: { label: { id: number } }) => Buffer.from(`L:${source.label.id}`, 'utf8').toString('base64'),
    name: (_ctx, source: { label: { name: string } }) => source.label.name,
    color: (_ctx, source: { label: { color: string } }) => source.label.color,
    description: (_ctx, source: { label: { description: string | null } }) => source.label.description,
    isDefault: () => false,
  },
  IssueComment: {
    id: (_ctx, source: CommentSource) => commentGlobalId(source.comment.id),
    databaseId: (_ctx, source: CommentSource) => source.comment.id,
    body: (_ctx, source: CommentSource) => source.comment.body,
    bodyText: (_ctx, source: CommentSource) => source.comment.body,
    author: () => viewerBox(),
    createdAt: (_ctx, source: CommentSource) => source.comment.createdAt,
    updatedAt: (_ctx, source: CommentSource) => source.comment.updatedAt,
    url: (_ctx, source: CommentSource) =>
      `https://forge.invalid/${source.repo.fullName}/issues/${source.issueNumber}#issuecomment-${source.comment.id}`,
    repository: (_ctx, source: CommentSource) => repoBox(source.repo),
    issue: (_ctx, source: CommentSource) => {
      const issue = source.repo.issues.get(source.issueNumber);
      return issue === undefined ? null : issueBox(source.repo, issue);
    },
  },
  PageInfo: {
    hasNextPage: (_ctx, source: { hasNextPage: boolean }) => source.hasNextPage,
    hasPreviousPage: (_ctx, source: { hasPreviousPage: boolean }) => source.hasPreviousPage,
    startCursor: (_ctx, source: { startCursor: string | null }) => source.startCursor,
    endCursor: (_ctx, source: { endCursor: string | null }) => source.endCursor,
  },
  CreateIssuePayload: {
    issue: (_ctx, source: { issue: Box }) => source.issue,
    clientMutationId: (_ctx, source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  CloseIssuePayload: {
    issue: (_ctx, source: { issue: Box }) => source.issue,
    clientMutationId: (_ctx, source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, source: { pullRequest: Box }) => source.pullRequest,
    clientMutationId: (_ctx, source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, source: { pullRequest: Box }) => source.pullRequest,
    clientMutationId: (_ctx, source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, source: { commentEdge: Box }) => source.commentEdge,
    subject: (_ctx, source: { subject: Box }) => source.subject,
    clientMutationId: (_ctx, source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  IssueCommentEdge: {
    node: (_ctx, source: { node: Box }) => source.node,
    cursor: (_ctx, source: { cursor: string }) => source.cursor,
  },
  Edge: {
    node: (_ctx, source: { node: Box }) => source.node,
    cursor: (_ctx, source: { cursor: string }) => source.cursor,
  },
  RateLimit: {
    limit: (_ctx, source: { limit: number }) => source.limit,
    cost: (_ctx, source: { cost: number }) => source.cost,
    remaining: (_ctx, source: { remaining: number }) => source.remaining,
    used: (_ctx, source: { used: number }) => source.used,
    resetAt: (_ctx, source: { resetAt: string }) => source.resetAt,
    nodeCount: (_ctx, source: { nodeCount: number }) => source.nodeCount,
  },
  __Type: {
    name: (_ctx, source: { name: string }) => source.name,
    kind: (_ctx, source: { name: string }) => typeKind(source.name),
    description: () => null,
    fields: (_ctx, source: { name: string }) => {
      const fields = TYPE_FIELDS[source.name];
      if (fields === undefined || typeKind(source.name) === 'ENUM' || typeKind(source.name) === 'SCALAR') return null;
      return fields.map((name) => box('__Field', { name }));
    },
    enumValues: (_ctx, source: { name: string }) => {
      const values = ENUM_VALUES[source.name];
      return values === undefined ? null : values.map((name) => box('__EnumValue', { name }));
    },
    possibleTypes: (_ctx, source: { name: string }) =>
      source.name === 'Node' ? [...NODE_TYPES].map((name) => box('__Type', { name })) : null,
    inputFields: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
    specifiedByUrl: () => null,
    isOneOf: () => false,
    interfaces: () => [],
  },
  __Field: {
    name: (_ctx, source: { name: string }) => source.name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, source: { name: string }) => source.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => [...KNOWN_TYPES].sort().map((name) => box('__Type', { name })),
    queryType: () => box('__Type', { name: 'Query' }),
    mutationType: () => box('__Type', { name: 'Mutation' }),
    subscriptionType: () => null,
    directives: () => [],
    description: () => null,
  },
};

for (const connectionType of ['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'CommitHistoryConnection', 'PullRequestChangedFileConnection']) {
  resolvers[connectionType] = connectionResolvers as Record<string, Resolver>;
}

function commitInfo(source: { repo: RepoRec; oid: string }): ReturnType<typeof parseCommit> {
  const object = source.repo.objects.get(source.oid);
  if (object === undefined || object.type !== 'commit') throw new DomainError(404, 'commit not found');
  return parseCommit(object.data);
}

// ---------------------------------------------------------------- execution engine

resolvers['PullRequestChangedFile'] = {
  path: (_ctx, source: { path: string }) => source.path,
  additions: (_ctx, source: { additions: number }) => source.additions,
  deletions: (_ctx, source: { deletions: number }) => source.deletions,
  changeType: (_ctx, source: { changeType: string }) => source.changeType,
  viewerViewedState: () => 'UNVIEWED',
} as Record<string, Resolver>;

function typeMatches(condition: string, typeName: string): boolean {
  return condition === typeName || (condition === 'Node' && NODE_TYPES.has(typeName));
}

function executeSelectionSet(
  ctx: Ctx,
  typeName: string,
  source: unknown,
  selections: readonly SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      out[key] = resolveField(ctx, typeName, source, selection, [...path, key]);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || typeMatches(selection.typeCondition, typeName)) {
        Object.assign(out, executeSelectionSet(ctx, typeName, source, selection.selection, path));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && typeMatches(fragment.typeCondition, typeName)) {
        Object.assign(out, executeSelectionSet(ctx, typeName, source, fragment.selection, path));
      }
    }
  }
  return out;
}

type FieldNode = Extract<SelectionNode, { kind: 'field' }>;

function resolveField(ctx: Ctx, typeName: string, source: unknown, field: FieldNode, path: (string | number)[]): unknown {
  const name = field.name;
  if (name === '__typename') return typeName;
  if (name === '__type' && (typeName === 'Query' || typeName === 'Mutation')) {
    const args = evaluateArgs(ctx, field);
    const typeName2 = String(args['name'] ?? '');
    const found = KNOWN_TYPES.has(typeName2) ? box('__Type', { name: typeName2 }) : null;
    return completeValue(ctx, found, field, path);
  }
  if (name === '__schema' && typeName === 'Query') return completeValue(ctx, box('__Schema', {}), field, path);
  const resolver = resolvers[typeName]?.[name];
  if (resolver === undefined) {
    const declared = TYPE_FIELDS[typeName]?.includes(name) ?? false;
    if (!declared) ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'`, path });
    return null;
  }
  let value: unknown;
  try {
    value = resolver(ctx, source as never, evaluateArgs(ctx, field));
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path });
    return null;
  }
  return completeValue(ctx, value, field, path);
}

function evaluateArgs(ctx: Ctx, field: FieldNode): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, valueNode] of field.args) args[key] = evaluate(valueNode, ctx.variables);
  return args;
}

function completeValue(ctx: Ctx, value: unknown, field: FieldNode, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => completeValue(ctx, item, field, [...path, index]));
  if (isBox(value)) {
    if (field.selection === null) return null;
    return executeSelectionSet(ctx, value.__type, value.value, field.selection, path);
  }
  return value;
}

// ---------------------------------------------------------------- entry point

export interface GraphQLReply {
  status: number;
  json: unknown;
}

function runOperation(forge: Forge, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'request body must be an object' }] };
  const record = entry as Record<string, unknown>;
  const query = record['query'];
  if (typeof query !== 'string') return { errors: [{ message: 'query must be a string' }] };
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof record['operationName'] === 'string' ? record['operationName'] : undefined;
  const operation =
    operationName === undefined
      ? document.operations[0]
      : document.operations.find((candidate) => candidate.name === operationName);
  if (operation === undefined) return { errors: [{ message: 'operation not found' }] };
  const variables: Record<string, unknown> = {};
  for (const [name, defaultNode] of operation.variableDefaults) variables[name] = evaluate(defaultNode, {});
  if (typeof record['variables'] === 'object' && record['variables'] !== null) {
    Object.assign(variables, record['variables'] as Record<string, unknown>);
  }
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, operation.selection, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result['errors'] = ctx.errors;
  return result;
}

/** Execute one GraphQL request body (single operation or a batch array). */
export function handleGraphQL(forge: Forge, body: unknown): GraphQLReply {
  if (Array.isArray(body)) return { status: 200, json: body.map((entry) => runOperation(forge, entry)) };
  if (typeof body === 'object' && body !== null) return { status: 200, json: runOperation(forge, body) };
  return { status: 400, json: { errors: [{ message: 'request body must be a JSON object or array' }] } };
}
