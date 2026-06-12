# Hubble SQL Workbench

[日本語](README.md) | **English**

A Trino-focused query editor that preserves the **Notebook** experience of
[cloudera/hue](https://github.com/cloudera/hue) — multiple cells, per-cell
execution and results, variable substitution, schema browsing, history and
charts — rebuilt as a modern, single-language TypeScript app.

![Hubble SQL Workbench — light theme, a join result in the grid](docs/screenshots/final-light.png)

| Dark theme | GROUP BY → bar chart |
|---|---|
| ![Dark theme](docs/screenshots/final-dark.png) | ![Bar chart of a result](docs/screenshots/final-chart.png) |

| Variables + execution |
|---|
| ![Variable panel driving a parameterised query](docs/screenshots/final-variables.png) |

> Trino-only by design. Authentication, multi-engine support, and Hue's document
> sharing / scheduling are explicit non-goals for v1 (see `docs/design.md`).

## Highlights

- **Notebook model** — SQL + Markdown cells, drag-reorder, per-cell run, run-all,
  selection / statement-at-caret execution, cancel, live progress.
- **Monaco editor** with a Trino grammar (ANTLR): syntax highlighting, schema-aware
  completion (FQN + columns + CTEs), hover, real-time error markers, formatting.
- **Live results** — virtualized grid (fixed header, 28px rows), column show/hide +
  search, client-side filter/sort, CSV download (gzip optional), TSV/HTML copy.
- **Charts** (ECharts) — bars / lines / timeline / pie / scatter, with X/Y (multi-Y),
  sort, row-limit and scatter group/size controls. Theme + palette derived from the
  design tokens, so charts follow the light/dark switch.
- **Variables** — `${name}` / `${name=default}` / `${name=a,b}` / `${name=label(value)}`,
  type-inferred inputs, comment-aware, resolved at run time.
- **Assist sidebar** — catalog → schema → table → column tree (lazy), table detail
  popover with sample rows, notebook / saved-query / history panels.
- **Command palette** (Ctrl/Cmd+K), full keyboard shortcuts, and a read-only
  **presentation mode** that splits SQL on `--` headings into cards.

## Architecture

A pnpm-workspace monorepo, TypeScript throughout:

```
packages/
  contracts/   # zod schemas + types — the API/type contract; server & web depend on it
  server/      # Hono BFF: Trino /v1/statement proxy, SSE, CSV stream, SQLite persistence
  web/         # React 19 + Vite + Tailwind v4; Monaco editor; ECharts; zustand + TanStack Query
e2e/           # Playwright E2E suites (editor / execution / results / notebook / panels / chart / app) against a live Trino (tpch)
```

- **Contract-first**: the zod definitions in `packages/contracts` are the source of
  truth; server and web are re-generatable implementation layers around them.
- **State**: zustand stores (`ui`, `notebook`, `execution`, chart config) + TanStack
  Query for server state. Components stay presentational.
- **Results stay in memory**: rows live in server memory + SSE; SQLite persists only
  summaries (notebooks, saved queries, history, per-cell `resultMeta`).
- **Design tokens are a contract**: all color/spacing/typography live in
  `packages/web/src/theme/tokens.css`; raw hex in components is blocked by an
  ast-grep lint rule. The Monaco and ECharts themes are derived from these tokens at
  runtime via `getComputedStyle`, so both follow the theme switch.

See `docs/design.md` for the full design, data model and API contract.

## Getting started

Prerequisites: **Node ≥ 24**, **pnpm 11**, and a reachable **Trino** (the e2e suite
and screenshots assume the `tpch` catalog, e.g. a local Trino on `:30080`).

```bash
pnpm install

# Terminal 1 — the BFF (Hono) on :8080
PORT=8080 TRINO_BASE_URL=http://localhost:30080 \
  pnpm --filter @hue-fable/server dev

# Terminal 2 — the web app (Vite) on :5173, proxying /api → :8080
pnpm --filter @hue-fable/web dev
```

Then open <http://localhost:5173>. (`pnpm dev` runs both in parallel.)

### Environment variables (server)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port for the BFF |
| `DB_PATH` | `./data/hue_fable.db` | SQLite database file |
| `STATIC_DIR` | — | Built web app dir (e.g. `packages/web/dist`); serves it + SPA fallback |
| `TRINO_BASE_URL` | `http://127.0.0.1:30080` | Trino coordinator base URL |
| `TRINO_USER` | `admin` | Value sent as `X-Trino-User` |
| `TRINO_USERNAME` | `admin` | Basic-auth username |
| `TRINO_PASSWORD` | `` (empty) | Basic-auth password |
| `TRINO_SOURCE` | `hubble` | `X-Trino-Source` for user queries |
| `TRINO_METADATA_SOURCE` | `hubble-metadata` | `X-Trino-Source` for metadata queries |
| `DEFAULT_CATALOG` | — | Initial catalog for new notebooks |
| `DEFAULT_SCHEMA` | — | Initial schema for new notebooks |
| `DEFAULT_LIMIT` | `5000` | Auto-`LIMIT` appended to `SELECT`s without one |
| `QUERY_MAX_ROWS` | `100000` | Cap on rows buffered server-side per query |
| `QUERY_CONCURRENCY` | `5` | Max concurrently-tracked queries |
| `QUERY_TTL_MINUTES` | `30` | Retention of a finished query before sweep |
| `QUERY_OVERFLOW_MODE` | `truncate` | `truncate` or `cancel` when over `QUERY_MAX_ROWS` |
| `METADATA_TTL_SECONDS` | `300` | Metadata cache TTL |
| `APP_VERSION` | `0.1.0` | Reported by `GET /api/config` |

## Documentation

- **[User guide](docs/user-guide.md)** (Japanese) — for analysts: the UI, running queries, notebooks, variables, results, charts, download/copy, shortcuts.
- **[Operations guide](docs/operations.md)** (Japanese) — for operators: single-process deploy with `STATIC_DIR`, env vars, oauth2-proxy + Trino impersonation / resource groups, backups, tuning.
- **[Deployment guide](docs/deployment.md)** (Japanese) — for operators: Docker image, Docker Compose (with a demo Trino), and Kubernetes (kustomize) deployment.

## Quality gates

```bash
pnpm typecheck   # tsc across contracts / server / web / e2e
pnpm lint        # eslint + ast-grep (no raw hex, etc.)
pnpm test        # vitest across contracts / server / web
pnpm --filter web build

# End-to-end against a live Trino (tpch). Starts the server (in-memory DB) + web
# automatically; needs a reachable Trino on :30080.
pnpm --filter @hue-fable/e2e test
```

The E2E suite (35 tests across editor / execution / results / notebook / panels /
chart / app) runs against a real Trino with deterministic `tpch.tiny` / `tpch.sf1`
data. It uses an in-memory SQLite (`DB_PATH=:memory:`) so it never touches your own
notebooks, and `QUERY_MAX_ROWS=10000` to exercise the truncation path. The
acceptance audit of every v1 checklist item is in
[`docs/acceptance-v1.md`](docs/acceptance-v1.md).

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Run the active cell | Ctrl/Cmd + Enter |
| Save notebook | Ctrl/Cmd + S |
| Format SQL | Ctrl/Cmd + I · Ctrl/Cmd + Shift + F |
| Command palette | Ctrl/Cmd + K |
| Toggle light / dark theme | Ctrl + Alt + T |
| Toggle presentation mode | Ctrl/Cmd + Shift + P |

(Also available from the command palette → "Keyboard shortcuts".)

## Licensing

This project is built on assets forked from the
[trino-query-ui](https://github.com/) project, which are **Apache-2.0** licensed
(the Trino SQL grammar and the ANTLR-generated lexer/parser under
`packages/web/src/trino-lang/`). Those files retain their original license and carry
inline provenance comments; the full attribution and list of modifications is in
[`NOTICE`](NOTICE).

The name and logo ("Hubble") are original; Hue, Cloudera and Trino trademarks and
logos are not used.
