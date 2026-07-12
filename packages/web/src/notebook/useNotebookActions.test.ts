// 明示したセルだけを実行し、変数解決失敗時に書き込み文を開始しないことを検証する。
import type { Notebook } from '@hubble/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearCellBlock, useExecutionStore } from '../execution';
import { useNotebookStore } from './notebookStore';
import { runSqlCell } from './useNotebookActions';

const timestamp = '2026-07-12T00:00:00.000Z';
const originalRunUnit = useExecutionStore.getState().runUnit;
const originalRunUnits = useExecutionStore.getState().runUnits;

function openNotebook(notebook: Notebook): void {
  useNotebookStore.setState({
    open: {
      [notebook.id]: {
        notebook,
        dirty: false,
        draft: false,
        saving: false,
        conflict: false,
        editGeneration: 0,
        durableGeneration: 0,
        localPersistenceError: false,
      },
    },
    openIds: [notebook.id],
    activeId: notebook.id,
  });
}

function notebook(cells: Notebook['cells'], variables: Notebook['variables'] = []): Notebook {
  return {
    id: 'notebook-1',
    name: 'Safety test',
    description: '',
    cells,
    variables,
    context: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
}

describe('runSqlCell', () => {
  const runUnit = vi.fn();
  const runUnits = vi.fn(async () => undefined);

  beforeEach(() => {
    runUnit.mockReset();
    runUnits.mockReset();
    useExecutionStore.setState({ runUnit, runUnits });
    clearCellBlock('old-dml');
    clearCellBlock('history-cell');
  });

  afterEach(() => {
    useExecutionStore.setState({ runUnit: originalRunUnit, runUnits: originalRunUnits });
    useNotebookStore.setState({ open: {}, openIds: [], activeId: null });
  });

  test('履歴で追加したcellIdとstatementだけを実行し、既存DMLセルは実行しない', () => {
    openNotebook(
      notebook([
        { id: 'old-dml', kind: 'sql', source: 'DELETE FROM orders' },
        { id: 'history-cell', kind: 'sql', source: 'SELECT * FROM orders' },
      ]),
    );

    expect(runSqlCell('history-cell', 'SELECT * FROM orders', {}, 1000)).toBe(true);

    expect(runUnit).toHaveBeenCalledOnce();
    expect(runUnit).toHaveBeenCalledWith(
      'history-cell',
      expect.objectContaining({ text: 'SELECT * FROM orders' }),
      expect.objectContaining({ notebookId: 'notebook-1' }),
      { autoLimit: true, limit: 1000 },
    );
    expect(runUnit).not.toHaveBeenCalledWith(
      'old-dml',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test('cellIdとstatementが対応しなければ既存DMLセルを実行しない', () => {
    openNotebook(notebook([{ id: 'old-dml', kind: 'sql', source: 'DELETE FROM orders' }]));

    expect(runSqlCell('old-dml', 'SELECT * FROM orders', {}, 1000)).toBe(false);
    expect(runUnit).not.toHaveBeenCalled();
    expect(runUnits).not.toHaveBeenCalled();
  });

  test('複文の変数が1件でも未解決なら後続INSERTを含むbatchを開始しない', () => {
    const statement = 'SELECT ${missing}; INSERT INTO audit_log VALUES (1)';
    openNotebook(
      notebook(
        [{ id: 'history-cell', kind: 'sql', source: statement }],
        [{ name: 'missing', value: '', meta: { type: 'text' } }],
      ),
    );

    expect(runSqlCell('history-cell', statement, {}, 1000)).toBe(false);
    expect(runUnit).not.toHaveBeenCalled();
    expect(runUnits).not.toHaveBeenCalled();
  });

  test('後続unitの変数が未解決でも先頭DELETEを先行実行しない', () => {
    const statement = 'DELETE FROM orders; SELECT ${missing}';
    openNotebook(
      notebook(
        [{ id: 'history-cell', kind: 'sql', source: statement }],
        [{ name: 'missing', value: '', meta: { type: 'text' } }],
      ),
    );

    expect(runSqlCell('history-cell', statement, {}, 1000)).toBe(false);
    expect(runUnit).not.toHaveBeenCalled();
    expect(runUnits).not.toHaveBeenCalled();
  });
});
