# makefun-forge

A GitHub-compatible git forge that runs as a single Node.js process with no
dependencies beyond the standard library. It implements four surfaces over
one shared in-memory store:

- **Git smart HTTP** — upload-pack protocol v2 (`ls-refs`, `fetch` with
  shallow/deepen support) and receive-pack v0 pushes, with pkt-line framing,
  packfile reading/writing (including delta resolution) and the object store
  all implemented in-process. No git binary is ever invoked.
- **REST v3** under `/api/v3` — repositories, branches, git refs, commits,
  the contents API, labels, issues, comments and pull requests (including
  squash/merge/rebase merges computed as three-way tree merges).
- **GraphQL** at `/api/graphql` — a small hand-written parser and executor
  covering viewer/repository/issue/pull-request queries, connections with
  cursor pagination, the create/close/merge mutations, batched operations,
  and the `__type` introspection those tools rely on.
- **MCP** at `/mcp` — Streamable HTTP JSON-RPC with the modern
  `server/discover` handshake (plus legacy `initialize`) and tools for
  repositories, issues and pull requests that act on the same store as REST,
  so identifiers agree across surfaces.

State is held in memory with deterministic ids and a logical clock, so a
replayed request sequence reproduces identical results. Authentication is a
single bearer token (`MAKEFUN_SHOP_TOKEN`) checked on every surface except
the `/healthz` probe.

## Running

The harness entry point is `main.ts`:

```
node main.ts
```

With `MAKEFUN_ENV_URL` set, the process binds an ephemeral port, registers
it with the environment, serves until the environment signals the trial is
done, and exits 0. Without it, the forge serves on `$PORT` (or an ephemeral
port) until killed, which is convenient for local development and for the
conformance runner in the bounty kit.

## Layout

- `main.ts` — process lifecycle (bind, register, wait, exit).
- `app.ts` — HTTP routing, auth, and the git smart-HTTP transport.
- `git.ts` — object model, packfiles, pkt-lines, reachability, tree merges.
- `store.ts` — the shared store, domain operations and JSON serializers.
- `rest.ts` — the REST v3 handlers.
- `graphql.ts` — the GraphQL lexer, parser, schema and executor.
- `mcp.ts` — the MCP endpoint and its tools.
