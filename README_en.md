# Hubble SQL Workbench

[日本語](README.md) | **English**

A multi-datasource SQL workbench for **Trino** (first-class), **MySQL**, and
**PostgreSQL** that preserves the **Notebook** experience of
[cloudera/hue](https://github.com/cloudera/hue): multiple cells, per-cell
execution and results, variable substitution, schema browsing, history and
charts. SQL completion (ANTLR) and Query Guard pre-execution estimates are
Trino-only. Rebuilt as a modern, single-language TypeScript app.

![Hubble SQL Workbench — light theme, a join result in the grid](docs/screenshots/final-light.png)

| Dark theme                                     | GROUP BY → bar chart                                       |
| ---------------------------------------------- | ---------------------------------------------------------- |
| ![Dark theme](docs/screenshots/final-dark.png) | ![Bar chart of a result](docs/screenshots/final-chart.png) |

| Variables + execution                                                                 |
| ------------------------------------------------------------------------------------- |
| ![Variable panel driving a parameterised query](docs/screenshots/final-variables.png) |

| Workflow (stage execution)                                     |
| -------------------------------------------------------------- |
| ![Query workflow canvas](docs/screenshots/workflow-canvas.png) |

| Dashboard                                                                                  | Alerts (threshold monitoring)                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| ![Saved-query results and charts on a dashboard grid](docs/screenshots/dashboard-grid.png) | ![Alert list panel with state badges](docs/screenshots/alerts-panel.png) |

> Multi-datasource support (Trino, MySQL, PostgreSQL) and RBAC are available
> (see the "Datasource configuration" and "RBAC" sections below). Saved queries
> and notebooks can be shared between users (`docs/user-guide.md` §10.3).
> Authentication (SSO via oauth2-proxy + impersonation) and scheduled runs are
> supported (`docs/operations.md` §7 / §12).

## Highlights

- **Notebook model** — SQL + Markdown cells, drag-reorder, per-cell run, run-all,
  selection / statement-at-caret execution, cancel, live progress.
- **Monaco editor** with a Trino grammar (ANTLR): syntax highlighting, schema-aware
  completion (FQN + columns + CTEs), hover, real-time error markers, formatting.
- **Live results** — virtualized grid (fixed header, 28px rows), column show/hide +
  search, client-side filter/sort, CSV/XLSX download, S3 and Google Sheets export,
  TSV/HTML copy.
- **Optional result persistence** — set `RESULT_STORE=s3` to store completed
  query results as zstd-compressed JSONL in S3 and reopen them from history without
  re-running the query. The default is `RESULT_STORE=none`, which keeps only the
  in-memory result.
- **Charts** (ECharts) — bars / lines / timeline / pie / scatter, with X/Y (multi-Y),
  sort, row-limit and scatter group/size controls. Theme + palette derived from the
  design tokens, so charts follow the light/dark switch.
- **Variables** — `${name}` / `${name=default}` / `${name=a,b}` / `${name=label(value)}`,
  type-inferred inputs, comment-aware, resolved at run time.
- **Assist sidebar** — catalog → schema → table → column tree (lazy), table detail
  popover with sample rows, notebook / saved-query / history panels.
- **Command palette** (Ctrl/Cmd+K), full keyboard shortcuts, and a read-only
  **presentation mode** that splits SQL on `--` headings into cards.
- **Query Guard** — estimates scan cost via `EXPLAIN (TYPE IO)` before execution
  and warns or blocks queries that exceed admin-configured limits.
- **Query Scheduler** — runs saved SQL on a cron schedule. Validates syntax and
  semantics with Trino's `EXPLAIN (TYPE VALIDATE)` at registration and before each
  run; retries on connection failures with geometric back-off.
- **Query workflows** — run multiple SQL statements as an ordered stage pipeline
  (parallel within a stage). Manual and cron triggers, per-step failure policy
  (`stop` / `continue`) and retries, optional result persistence.
- **Audit log** — records query execution, CSV/XLSX downloads, S3 and Google
  Sheets exports, admin kills, and scheduled runs in `audit_log`, including
  denied or failed outcomes.
- **Document sharing** — share saved queries and notebooks with users, SSO
  groups, or RBAC roles at view or edit level. Query execution still uses the
  runner's own RBAC; sharing does not delegate data access.
- **GitHub integration** — push saved queries (`.sql`), notebooks (`.yaml`), and
  workflows (`.yaml`) to an operator-configured GitHub repository from the UI,
  open pull requests, and track approval status (unlinked / in review / approved /
  modified). No local git required (`docs/user-guide.md` §13, `docs/operations.md`
  §13).

## Architecture

A pnpm-workspace monorepo, TypeScript throughout:

```
packages/
  contracts/   # zod schemas + types — the API/type contract; server & web depend on it
  server/      # Hono BFF: multi-datasource query proxy (Trino / MySQL / PostgreSQL), SSE, CSV stream, PostgreSQL/SQLite persistence
  web/         # React 19 + Vite + Tailwind v4; Monaco editor; ECharts; zustand + TanStack Query
e2e/           # Playwright E2E suites (editor / execution / results / notebook / panels / chart / app) against a live Trino (tpch)
```

- **Contract-first**: the zod definitions in `packages/contracts` are the source of
  truth; server and web are re-generatable implementation layers around them.
- **State**: zustand stores (`ui`, `notebook`, `execution`, chart config) + TanStack
  Query for server state. Components stay presentational.
- **Results stay in memory by default**: with `RESULT_STORE=none`, rows live in
  server memory + SSE; PostgreSQL (or SQLite) persists only summaries
  (notebooks, saved queries, history, per-cell `resultMeta`). With
  `RESULT_STORE=s3`, completed results are stored in S3 and the DB records only
  the object key and expiry timestamp.
- **Design tokens are a contract**: all color/spacing/typography live in
  `packages/web/src/theme/tokens.css`; raw hex in components is blocked by an
  ast-grep lint rule. The Monaco and ECharts themes are derived from these tokens at
  runtime via `getComputedStyle`, so both follow the theme switch.

## Getting started

Prerequisites: **Node ≥ 24**, **pnpm 11**, a reachable SQL engine (the default
dev setup uses **Trino**; the e2e suite and screenshots assume the `tpch`
catalog, e.g. a local Trino on `:30080`), and **PostgreSQL** for the app's own
persistence (the 1st/production-recommended backend; Docker Compose brings up
the bundled `postgres` service by default). MySQL and PostgreSQL datasources
can be added per the instructions in the "Datasource configuration" section
below.

The fastest way to try it is Docker Compose (brings up the Trino demo and
PostgreSQL persistence together):

```bash
docker compose up --build
# → open http://localhost:8080
```

To run server/web individually against your own Node, prepare
`datasources.yaml` and PostgreSQL (or SQLite) first.

```bash
pnpm install

# datasources.yaml is required (see "Datasource configuration" below). Minimal single-entry example:
cat > datasources.yaml <<'EOF'
datasources:
  - id: trino-default
    type: trino
    displayName: Trino
    username: admin
    baseUrl: http://localhost:30080
EOF

# Terminal 1 — the BFF (Hono) on :8080 (falls back to SQLite if DATABASE_URL is unset)
PORT=8080 DATABASE_URL=postgres://hubble:hubble@localhost:5432/hubble \
  pnpm --filter @hubble/server dev

# Terminal 2 — the web app (Vite) on :5173, proxying /api → :8080
pnpm --filter @hubble/web dev
```

Then open <http://localhost:5173>. (`pnpm dev` runs both in parallel.)

### Datasource configuration (declarative YAML)

`datasources.yaml` is **required**. Declare your datasources (Trino / MySQL /
PostgreSQL, any number) here (see `datasources.yaml.example`). `DATASOURCES_PATH`
sets the file path; if unset, `./datasources.yaml` in the current directory is
used. If neither path has a file, startup fails with an error (automatic
synthesis from `TRINO_*` environment variables has been removed). The list is
available via `GET /api/datasources` (connection details and credentials are
not included).

#### Hot reload

`datasources.yaml` and `rbac.yaml` can be reloaded without restarting the
process. `rbac.yaml` is watched even if the file doesn't exist at startup —
placing it later and letting it reload activates the roles.

- **Polling**: every `CONFIG_RELOAD_INTERVAL_SECONDS` (default 30, `0` disables)
  seconds, checks the files' modification times and reloads on changes.
- **SIGHUP**: reloads immediately on receipt of the signal (works even with the
  polling interval set to 0).
- **On error**: if a reload hits invalid YAML or a validation error, the current
  config is kept, the error is logged, and the process moves on to the next poll
  (a failure during the initial startup load remains a startup error as before).
- **On deletion**: if a watched file is deleted, the current config is kept
  without reloading, and a single warning is logged.

Kubernetes ConfigMap updates are subject to kubelet's sync delay (up to ~1
minute by default) in addition to the polling interval above — note that the
total propagation delay is the sum of both.

#### Fields by type

| Field                          | trino    | mysql    | postgresql   | Description                                                       |
| ------------------------------ | -------- | -------- | ------------ | ----------------------------------------------------------------- |
| `id`                           | required | required | required     | Immutable identifier (`^[a-z][a-z0-9-]{0,62}$`)                   |
| `type`                         | `trino`  | `mysql`  | `postgresql` | Type                                                              |
| `displayName`                  | optional | optional | optional     | Name shown in the UI (defaults to `id`)                           |
| `username`                     | required | required | required     | Connection user                                                   |
| `passwordEnv` / `passwordFile` | optional | optional | optional     | Password reference (see below)                                    |
| `baseUrl`                      | required | —        | —            | Trino coordinator URL                                             |
| `source`                       | optional | —        | —            | `X-Trino-Source` for user queries (default `hubble`)              |
| `metadataSource`               | optional | —        | —            | `X-Trino-Source` for metadata fetches (default `hubble-metadata`) |
| `scheduledSource`              | optional | —        | —            | `X-Trino-Source` for scheduled runs (default `hubble-scheduled`)  |
| `host`                         | —        | required | required     | DB host                                                           |
| `port`                         | —        | optional | optional     | Defaults to 3306 / 5432                                           |
| `database`                     | —        | required | required     | Database name                                                     |
| `readOnly`                     | —        | optional | optional     | Defaults to `true` (see below)                                    |
| `tls`                          | —        | optional | optional     | Defaults to `false`                                               |
| `tlsCaFile`                    | —        | optional | optional     | CA file (requires `tls: true`)                                    |
| `maxConnections`               | —        | optional | optional     | Pool size cap (default 5)                                         |
| `roleCredentials`              | —        | optional | optional     | Connection credentials per RBAC role (see below)                  |

#### Password reference

Passwords are never written directly into the YAML.

- `passwordEnv`: an environment variable name. In Docker Compose, putting it in
  the `environment` block is the natural choice.
- `passwordFile`: a file path. On Kubernetes, mounting a Secret as a volume and
  referencing it as `passwordFile: /etc/hubble/secrets/mysql-password` is
  typical.
- The two cannot be specified together.
- Plaintext password fields such as `password` are not allowed on the
  datasource itself or inside `roleCredentials`.

#### MySQL/PostgreSQL roleCredentials

For MySQL/PostgreSQL, `roleCredentials` can specify a DB connection user per
RBAC role. If the role resolved at runtime matches a key under
`roleCredentials`, queries, CSV re-runs, metadata fetches, and scheduled runs
use that credential. If there is no match, Hubble falls back to the
datasource-level `username` and `passwordEnv` / `passwordFile`. Connection
pools are separated by datasource and role; old pools are discarded when
`datasources.yaml` hot-reloads.

```yaml
datasources:
  - id: mysql-analytics
    type: mysql
    username: hubble_default
    passwordEnv: MYSQL_DEFAULT_PASSWORD
    host: mysql.internal
    database: analytics
    roleCredentials:
      analyst:
        username: hubble_analyst
        passwordEnv: MYSQL_ANALYST_PASSWORD
      operator:
        username: hubble_operator
        passwordFile: /etc/hubble/secrets/mysql-operator-password
```

Configure the required `GRANT`s for DB users such as `hubble_analyst` and
`hubble_operator` on the DB side. Trino continues to use principal
impersonation, so this field is only for MySQL/PostgreSQL.

#### readOnly and Query Guard

- `readOnly` (mysql/postgresql, default `true`) is a guardrail that sets a
  read-only session on connect (MySQL: `SET SESSION TRANSACTION READ ONLY`;
  PostgreSQL: `SET default_transaction_read_only = on`). Because a user could
  lift this with `SET`, production write prevention should rely on DB-side
  privileges instead.
- mysql / postgresql do not support EXPLAIN-based scan-cost estimation (Query
  Guard). The UI's estimate strip is disabled, and `POST /api/queries/estimate`
  returns `ESTIMATE_NOT_SUPPORTED`. Even in `enforce` mode, query execution
  itself is not blocked.

#### Docker Compose demo (Trino + MySQL + PostgreSQL)

The default `docker compose up` still brings up Trino only. To try all three
datasources, use the demo overlay and the `demo` profile.

```bash
# build and start (Hubble + Trino + demo-mysql + demo-postgres)
docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo up --build

# open http://localhost:8080 and switch datasources via the TopBar selector
# demo-postgres is a separate service from the app's own DATABASE_URL persistence
```

The definition file is `deploy/compose/datasources.demo.yaml`. When connecting
to the databases directly from the host, `127.0.0.1:3307` (MySQL) and
`127.0.0.1:5434` (PostgreSQL) are published.

### RBAC (role definitions)

Roles and permissions are declared in `rbac.yaml` (see `rbac.yaml.example`).
`RBAC_PATH` sets the file path; if unset, `./rbac.yaml` in the current
directory is used. If the file is absent, the built-in `unrestricted` role
(`query.write` only) is assigned to everyone, so every user can write, as
before. Whether `query.write` is granted determines whether write statements
are rejected, and each role can override the Query Guard limits. An assignment
key is exactly one of `email` / `user` / `emailDomain` / `group`. `group` is
matched against membership in the `X-Forwarded-Groups` header
(`AUTH_SSO_HEADER_GROUPS`, default `x-forwarded-groups`) supplied by
oauth2-proxy or similar. To use Google Workspace groups, group resolution must
be enabled in oauth2-proxy's Google provider.
Role resolution for scheduled runs uses the principal snapshot (`user`,
`email`, `groups`) saved when the schedule is created or updated. If `email`
or `groups` were resolved at save time, email-based assignments and `group`
assignments also apply to scheduled runs. Legacy records without
`principal_snapshot` keep the previous owner-string fallback
(`{ user: owner, email: owner when it contains '@' }`), so an email-localpart
owner still won't match email-based assignments, and `group` assignments don't
apply. When the owner saves the schedule again, the snapshot is refreshed from
the current principal.
Configuration changes take effect after a process restart.

#### Operations view

Only users with the `queries.viewAll` permission see the Operations view in
the sidebar. It lists every user's running queries (including finished
queries retained within the TTL), refreshing owner, datasource, statement
head, state, and elapsed time every 5 seconds. Users with `query.killAny` can
kill any user's query via a confirmation dialog; a kill logs a single
server-log line (actor, target owner, queryId). Under an `unrestricted`
deployment without `rbac.yaml`, these permissions are not granted and the UI
behaves as before.

#### Restricting datasource exposure (`role.datasources`)

Each role in `rbac.yaml` can set an optional `datasources` field to allowlist
which datasource ids are usable for queries, estimates, metadata, and
schedules. When unset, all datasources remain allowed, as before.
`GET /api/datasources` is also filtered per role, so users can't select a
datasource they can't see in the UI. To also enforce DB-side `GRANT`s for
MySQL/PostgreSQL, combine this with datasource-level `roleCredentials`.

#### Known limitations (MySQL/PostgreSQL)

MySQL/PostgreSQL `roleCredentials` switch credentials by RBAC role. Users who
belong to the same role share the same DB user, so if DB-side per-user auditing
is required, consider connecting through Trino or adding DB-side design for
that requirement.

### Environment variables (server)

| Variable                          | Default              | Description                                                                                                                                               |
| --------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATASOURCES_PATH`                | —                    | Path to the datasource definition YAML (effectively required). If unset, looks for `./datasources.yaml`; if neither exists, this is a startup error       |
| `RBAC_PATH`                       | —                    | Path to the RBAC definition YAML. If unset, looks for `./rbac.yaml`; if absent, falls back to the `unrestricted` role for backward compatibility          |
| `CONFIG_RELOAD_INTERVAL_SECONDS`  | `30`                 | Polling interval (seconds) for hot-reloading `datasources.yaml` / `rbac.yaml`. `0` disables polling (SIGHUP only)                                         |
| `PORT`                            | `8080`               | HTTP port the BFF listens on                                                                                                                              |
| `DATABASE_URL`                    | —                    | `postgres://` / `postgresql://` connection string (1st/production-recommended). When set, persistence uses PostgreSQL and takes precedence over `DB_PATH` |
| `DB_PATH`                         | `./data/hubble.db`   | SQLite database file (for non-production use; used only when `DATABASE_URL` is unset)                                                                     |
| `STATIC_DIR`                      | —                    | Built web app dir (e.g. `packages/web/dist`); serves it + SPA fallback                                                                                    |
| `TRINO_USER`                      | `admin`              | `X-Trino-User` shared by all Trino datasources (impersonation user). Also the initial value for the `AUTH_MODE=none` principal / owner backfill           |
| `DEFAULT_CATALOG`                 | —                    | Initial catalog for new notebooks                                                                                                                         |
| `DEFAULT_SCHEMA`                  | —                    | Initial schema for new notebooks                                                                                                                          |
| `DEFAULT_LIMIT`                   | `5000`               | Auto-`LIMIT` appended to `SELECT`s without one                                                                                                            |
| `QUERY_MAX_ROWS`                  | `100000`             | Cap on rows buffered server-side per query                                                                                                                |
| `QUERY_CONCURRENCY`               | `5`                  | Max concurrently-tracked queries                                                                                                                          |
| `QUERY_TTL_MINUTES`               | `30`                 | Retention of a finished query before sweep                                                                                                                |
| `QUERY_OVERFLOW_MODE`             | `truncate`           | Behavior when `QUERY_MAX_ROWS` is exceeded (`truncate` or `cancel`)                                                                                       |
| `METADATA_TTL_SECONDS`            | `300`                | Metadata cache TTL                                                                                                                                        |
| `EXPORT_S3_BUCKET`                | —                    | Bucket name for result-pane S3 export. When unset, the S3 export API rejects requests with HTTP 501                                                       |
| `EXPORT_S3_PREFIX`                | `hubble-exports/`    | Object key prefix for S3 export. The final key is `<prefix>/<owner>/<queryId>-<timestamp>.<ext>`                                                          |
| `EXPORT_S3_REGION`                | —                    | Region for the S3 export client                                                                                                                           |
| `EXPORT_S3_ENDPOINT`              | —                    | S3-compatible endpoint. When set, path-style requests are used                                                                                            |
| `EXPORT_SHEETS_CREDENTIALS_FILE`  | —                    | Path to the service-account JSON used for Google Sheets export. When unset, the Google Sheets export API rejects requests with HTTP 501                   |
| `APP_VERSION`                     | `0.1.0`              | Version returned by `GET /api/config`                                                                                                                     |
| `QUERY_GUARD_MODE`                | `warn`               | Query Guard mode (`off` disables / `warn` shows the estimate only / `enforce` rejects over-limit queries with HTTP 422)                                   |
| `QUERY_GUARD_MAX_SCAN_BYTES`      | `0` (unlimited)      | Scan-bytes limit (0 = no limit)                                                                                                                           |
| `QUERY_GUARD_MAX_SCAN_ROWS`       | `0` (unlimited)      | Scan-rows limit (0 = no limit)                                                                                                                            |
| `QUERY_GUARD_ON_UNKNOWN`          | `warn`               | Behavior when scan cost can't be estimated due to missing statistics (`allow` / `warn` / `block`)                                                         |
| `QUERY_GUARD_ESTIMATE_TIMEOUT_MS` | `3000`               | EXPLAIN timeout in ms                                                                                                                                     |
| `QUERY_GUARD_CACHE_TTL_SECONDS`   | `30`                 | Estimate-result cache TTL in seconds                                                                                                                      |
| `QUERY_GUARD_BYTES_PER_SECOND`    | `0` (no hint)        | Cluster throughput estimate (bytes/s); when > 0 the UI shows an estimated duration                                                                        |
| `SCHEDULER_ENABLED`               | `true`               | Set to `false` to stop the scheduler tick loop (API stays live)                                                                                           |
| `SCHEDULER_TICK_SECONDS`          | `15`                 | Interval in seconds between due-schedule scans                                                                                                            |
| `SCHEDULER_MAX_CONCURRENT`        | `2`                  | Max schedules running concurrently across the scheduler                                                                                                   |
| `SCHEDULER_RUNS_RETENTION`        | `50`                 | Per-schedule cap on retained run-history rows (older rows are auto-pruned)                                                                                |
| `NOTIFY_SLACK_WEBHOOK_URL`        | —                    | Slack incoming webhook URL for final schedule-failure notifications                                                                                       |
| `NOTIFY_SMTP_HOST`                | —                    | SMTP host for final schedule-failure notifications                                                                                                        |
| `NOTIFY_SMTP_PORT`                | `587`                | SMTP port. `465` uses implicit TLS; other ports use STARTTLS when available                                                                               |
| `NOTIFY_SMTP_USER`                | —                    | SMTP auth user                                                                                                                                            |
| `NOTIFY_SMTP_PASSWORD_ENV`        | —                    | Environment variable name that contains the SMTP password                                                                                                 |
| `NOTIFY_SMTP_FROM`                | —                    | SMTP From address                                                                                                                                         |
| `AUTH_SSO_HEADER_GROUPS`          | `x-forwarded-groups` | SSO group-membership header name (used by `rbac.yaml`'s `group` assignment)                                                                               |

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
pnpm --filter @hubble/e2e test

# Multi-datasource E2E (optional; does not run in the default command above)
# Start demo DBs: docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo up -d demo-mysql demo-postgres
MULTI_DS_E2E=1 pnpm --filter @hubble/e2e test tests/datasources.spec.ts
```

The E2E suite (35 tests across editor / execution / results / notebook / panels /
chart / app) runs against a real Trino with deterministic `tpch.tiny` / `tpch.sf1`
data. It uses an in-memory SQLite (`DB_PATH=:memory:`) so it never touches your own
notebooks, and `QUERY_MAX_ROWS=10000` to exercise the truncation path.

## Keyboard shortcuts

| Action                    | Shortcut                            |
| ------------------------- | ----------------------------------- |
| Run the active cell       | Ctrl/Cmd + Enter                    |
| Save notebook             | Ctrl/Cmd + S                        |
| Format SQL                | Ctrl/Cmd + I · Ctrl/Cmd + Shift + F |
| Command palette           | Ctrl/Cmd + K                        |
| Toggle light / dark theme | Ctrl + Alt + T                      |
| Toggle presentation mode  | Ctrl/Cmd + Shift + P                |

(Also available from the command palette → "Keyboard shortcuts".)

## Licensing

The Trino SQL grammar and the ANTLR-generated lexer/parser under
`packages/web/src/trino-lang/` derive from the
[Trino](https://github.com/trinodb/trino) project and are licensed under
**Apache-2.0**; those files retain inline provenance comments, and the full
attribution is in [`NOTICE`](NOTICE).

The name and logo ("Hubble") are original; Hue, Cloudera and Trino trademarks and
logos are not used.
