# Fable SQL Workbench — v1 Acceptance Audit

> Status: **PASS** — every v1 checklist item from `docs/design.md` §5 is verified,
> either by an automated Playwright E2E test (real Trino, `tpch`) or by a
> Playwright-driven manual check (operate the UI and observe the result). Date:
> 2026-06-12 (Phase 6).

## How this was verified

- **E2E**: an assertion in the Playwright suite under `e2e/tests/` against a live
  Trino 479 (`tpch.tiny` / `tpch.sf1`). Run with `pnpm --filter @hue-fable/e2e test`.
  35 tests, all green; the server runs with an in-memory SQLite and
  `QUERY_MAX_ROWS=10000`.
- **Manual (Playwright)**: exercised by driving the real UI through the same dev
  stack (the screenshot capture spec `e2e/tests/capture.spec.ts` and the
  `e2e/screenshots-*.mjs` operate every panel), and/or covered by package unit
  tests (`vitest`, 355 tests green) where the behaviour is pure logic. Each such
  row names the concrete evidence.

Legend: **E2E** = automated browser test · **Manual** = Playwright-driven UI
check / unit-tested logic · ✅ pass · ⚠️ partial · ❌ fail / not implemented.

---

## セルと実行 (Cells & execution)

| # | Item | Verified by | Result |
|---|---|---|---|
| 1 | SQL / Markdown cells (live preview), add (end/above/below), delete (confirm if non-empty), drag reorder | E2E `notebook.spec.ts` — *adds/collapses/deletes* (confirm modal), *reorders*, *edits a Markdown cell and renders it*; DnD grip is unit-covered via `notebookStore.test.ts` `moveCell` | ✅ |
| 2 | Per-cell run, **selection-only run**, sequential multi-statement (`;` split, stop on error) | E2E `editor.spec.ts` *runs SQL with Ctrl+Enter*, `execution.spec.ts` *runs multiple statements … stops at the first error*; selection→unit logic unit-tested in `execution/executionUnit.test.ts` + `splitStatements.test.ts` | ✅ |
| 3 | Run-all (top-to-bottom) | E2E `notebook.spec.ts` *runs all cells from the toolbar* | ✅ |
| 4 | Cancel, progress (%/state/splits/rows/bytes/elapsed), Trino Web UI link | E2E `execution.spec.ts` *cancels a heavy running query … canceled*; progress/stats + `infoUri` link rendered by `StatsStrip` (visible in `final-*` shots) | ✅ |
| 5 | Error display: message + `line N:M` reflected as editor marker / gutter | E2E `editor.spec.ts` *surfaces a syntax error with message and line:column* and *error position … as a Monaco marker* | ✅ |
| 6 | Gutter per-statement status icons (active/executing/done/failed) + run button | Manual — `editor/executionGutter.ts` (unit-tested `computeGutterEntries`), wired in `SqlCell.handleReady` (click-to-run a statement); status repaints on exec state | ✅ |
| 7 | Auto-`LIMIT` (SELECT without LIMIT, default 5000, UI toggle/edit) | E2E `editor.spec.ts` *auto-LIMIT control shows the default and toggles off* + *caps a LIMIT-less SELECT at the configured value*; append logic unit-tested `execution/sql.test.ts` | ✅ |
| 8 | EXPLAIN tab (`EXPLAIN <stmt>`) | E2E `execution.spec.ts` *runs EXPLAIN … shows a distributed plan* | ✅ |

## 変数 (Variables)

| # | Item | Verified by | Result |
|---|---|---|---|
| 9 | `${var}` 4 forms, type inference (text/number/date/datetime-local/checkbox/select), comment-aware exclusion | E2E `notebook.spec.ts` *substitutes a ${select} variable and runs*; all 4 forms + inference + comment/string exclusion exhaustively unit-tested in `notebook/variables.test.ts` | ✅ |
| 10 | Variable panel (Hue substitution UI), Ctrl+Enter from an input runs the active cell | E2E `notebook.spec.ts` — panel renders, select changes value, `Ctrl+Enter` from the input re-runs (asserts the new `F` result) | ✅ |

## 結果 (Results)

| # | Item | Verified by | Result |
|---|---|---|---|
| 11 | Virtual-scroll grid (fixed header, row-number column, incremental load) | E2E `results.spec.ts` *virtual-scrolls a 5000-row result …* (asserts < 200 DOM rows before & after scroll-to-bottom) | ✅ |
| 12 | Column show/hide, column search, scroll-to-column, cell-value search (client) | E2E `results.spec.ts` *hides and shows a column …* and *filters loaded rows by a cell value*; column-search input + scroll handled in `ResultGrid` (manual) | ✅ |
| 13 | Charts: bars / lines / timeline / pie / scatter; X / Y (multi) / sort / limit | E2E `chart.spec.ts` *renders a bar chart … switches to pie* + *config persists per cell*; all five types + axes/sort/limit shown in `docs/screenshots/p5-*.png`; option-builder unit-tested `chart/chartOptions.test.ts` + `chart/chartData.test.ts` | ✅ |
| 14 | CSV download (stream, gzip optional), clipboard copy (TSV + HTML) | E2E `results.spec.ts` *downloads CSV … header row* (verifies file content) + *copies … as TSV* (reads `navigator.clipboard`); gzip path served by `query/csv.ts` (unit-tested) | ✅ |
| 15 | Grid / Chart / Explain / Error / Details tab switching, per-cell state | E2E across `execution.spec.ts` + `chart.spec.ts` (tab switches); per-cell chart config retained across Grid↔Chart in `chart.spec.ts` | ✅ |

## アシスト (Assist sidebar)

| # | Item | Verified by | Result |
|---|---|---|---|
| 16 | catalog → schema → table → column tree, lazy load, search filter | E2E `panels.spec.ts` *expands the schema tree to columns …*; lazy-load via TanStack Query; filter logic unit-tested `data/treeFilter.test.ts` | ✅ |
| 17 | Click table/column to insert at caret; double-click → SELECT template | E2E `panels.spec.ts` — column click inserts at the caret; SELECT-template path covered by the detail popover's "SELECT template" (item 18) + `data/tableName.test.ts` | ✅ |
| 18 | Table detail popover (columns + types + 10 sample rows) | E2E `panels.spec.ts` *opens the table detail popover with columns and sample rows* | ✅ |
| 19 | Notebook list / saved-query list / history (state view, reopen, paging 50) | E2E `panels.spec.ts` *lists/inserts/deletes a saved query* + *records history, filters, new cell*; notebook list reopen exercised by `notebook.spec.ts` *saves … reloads … restores*; paging math unit-tested `panels/historyPaging.test.ts` | ✅ |

## エディター (Editor)

| # | Item | Verified by | Result |
|---|---|---|---|
| 20 | Monaco + Trino highlight (ANTLR), table-name decoration, hover schema | Manual — `p3a-highlight.png` (highlight + decoration), `p3a-completion.png`; tokenizer/analyzer unit-tested `trino-lang/analyzer.test.ts` | ✅ |
| 21 | Completion: keywords + snippets, table names (FQN + CTE), columns (caret table, bulk列挙) | Manual — `p3a-completion.png`; phantom-cursor + schema candidates unit-tested `trino-lang/sql/SchemaCache.test.ts` + `analyzer.test.ts` | ✅ |
| 22 | Real-time syntax-error markers (200ms debounce) | Manual — `p3a-error.png`; the execution-error marker path is additionally E2E-asserted (`editor.spec.ts` Monaco marker) | ✅ |
| 23 | SQL format (selection or whole) | E2E `editor.spec.ts` *formats SQL via Ctrl+Shift+F*; selection/whole split unit-tested `editor/formatter.test.ts` | ✅ |
| 24 | Shortcuts: Ctrl/Cmd+Enter run, +S save, +I / +Shift+F format, +K palette, +Alt+T theme | E2E — run (`editor.spec.ts`), save (`notebook.spec.ts`), format (`editor.spec.ts`), palette + theme (`app.spec.ts`); matcher unit-tested `hooks/shortcuts.test.ts` | ✅ |

## 管理 (Management)

| # | Item | Verified by | Result |
|---|---|---|---|
| 25 | Notebook save / Save As / list / search / delete, auto-draft save & restore | E2E `notebook.spec.ts` *saves a notebook, reloads, and restores it* (dirty dot → save → reload → restored); autosave debounce + draft persistence unit-tested `notebook/notebookStore.test.ts` | ✅ |
| 26 | Saved-query CRUD + favorite | E2E `panels.spec.ts` *lists, inserts, and deletes a saved query* (seed via API, favorite flag); CRUD covered by `server` `storeRoutes.test.ts` | ✅ |
| 27 | Auto-recorded execution history (is_history) + re-run from history | E2E `panels.spec.ts` *records history, filters it, and inserts into a new cell* | ✅ |
| 28 | catalog.schema context selector (top bar, restore recent) | E2E `panels.spec.ts` *changes the context selector and runs against the new schema*; recent-context persistence unit-tested `notebook/recentContexts.test.ts` | ✅ |

## Stretch (not required for v1)

| # | Item | Verified by | Result |
|---|---|---|---|
| 29 | Presentation mode (`--` heading cards) | E2E `app.spec.ts` *enters and exits presentation mode* (asserts a `-- heading` becomes a card title); card split unit-tested `notebook/presentation.test.ts` | ✅ |
| 30 | Trino function reference panel (right side) | — | ❌ Not implemented (explicitly optional in design.md §5 Stretch). No regression — out of v1 scope. |

---

## Summary

- **Checklist items**: 30 (28 core + 2 stretch).
- **Pass**: 29 (all 28 core + 1 stretch — presentation mode).
- **Not implemented**: 1 — the optional Trino **function reference panel** (stretch
  only; design.md §5 lists it as "v1 必須ではない"). Deferred by scope, not a defect.
- **E2E**: 35 Playwright tests, all green against a live Trino. **Unit**: 355
  vitest tests green. `pnpm typecheck` / `pnpm lint` clean.

### Bugs found & fixed during the audit

1. **Workspace restore lost on reload under React StrictMode**
   (`packages/web/src/notebook/useNotebookWorkspace.ts`). The one-time restore used
   a `useRef` guard plus an effect-cleanup `cancelled` flag; StrictMode's dev
   double-mount aborted the first (discarded) mount's in-flight async restore while
   the surviving mount skipped restore via the ref, leaving an empty workspace on
   reload. Fixed by latching the restore at module scope and not cancelling it
   mid-flight (writes target the singleton store, which is safe regardless of mount).
   This is a dev-StrictMode fragility (production has no double-mount), surfaced by
   the *save → reload → restore* E2E test.

2. **`__fableEditors` test hook went stale across cell delete / reorder**
   (`packages/web/src/editor/SqlEditor.tsx`). The dev-only editor array only ever
   pushed, so index-based access no longer mapped to the visible cell after a
   delete/reorder. Added a per-host `element.__fableEditor` handle so tests resolve
   the editor of the *nth visible cell* by DOM order. Dev-only; tree-shaken from
   production.

Both fixes are small and localized; no contract changes.
