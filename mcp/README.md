# labbook-mcp

A stdio [MCP](https://modelcontextprotocol.io) server that exposes the labbook API to agents: one tool per
operation of the live OpenAPI spec (`$LABBOOK_URL/api/docs/json`), fetched at startup. After a labbook
upgrade, call the `refresh_spec` tool (or restart) to pick up new operations.

## Install

```sh
cd mcp && npm ci
```

Node >= 22. The OS trust store is used for TLS, so the kw cluster CA works as-is; `NODE_EXTRA_CA_CERTS`
adds any other CA.

## Register in Claude Code

```sh
claude mcp add labbook --scope user -e LABBOOK_URL=https://labbook.kw.watteel.lab \
  -- node /abs/path/labbook/mcp/labbook-mcp.mjs
```

## Token

Create a token in the labbook GUI under Admin → API tokens, then:

```sh
mkdir -p ~/.config/labbook && (umask 077 && pbpaste > ~/.config/labbook/token)
```

The token is the first found of `--token-file <file>`, `$LABBOOK_TOKEN_FILE`, `$LABBOOK_TOKEN`,
`~/.config/labbook/token` (the same as `client/labbook-submit.mjs`). It is read on every call, so no
restart is needed after creating it. Without one the tools are still listed, and each call explains how to
provide it.

## Tools

- Named after the operation's `operationId` in snake_case (`listRuns` → `list_runs`); without one, method
  plus path without `/api/v1`, with `{x}` as `by_x` (`GET /api/v1/runs/{id}` → `get_runs_by_id`).
- Arguments: path and query parameters by name, the JSON request body under `body`. The runs query and
  export take `params: {"model": "llama"}`, sent as `param.model=llama`.
- Attachments are uploaded with `put_runs_by_id_attachments_by_filename` (or its operationId name) using
  `content` (text) or `contentBase64`, plus an optional `contentType`. The multipart upload and the
  session-cookie login/logout are not exposed.
- Credential management stays with humans in the GUI: operations tagged `users` or `tokens` and the
  password change are not exposed. Everything else (test types, runs, attachments, sets, export,
  compare, dashboard, admin deletes) is.

## Test

```sh
cd mcp && npm test
```
