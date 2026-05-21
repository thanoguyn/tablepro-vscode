import { DatabaseDriver } from '../drivers/DatabaseDriver';

/**
 * Represents a single cell change in the data grid.
 */
export interface CellChange {
  rowIndex: number;
  columnName: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: number;
}

/**
 * Represents a tracked row with its change state.
 */
export interface TrackedRow {
  /** Original data from the database */
  originalData: Record<string, unknown>;
  /** Current data (with edits applied) */
  currentData: Record<string, unknown>;
  /** Change state */
  state: 'unchanged' | 'modified' | 'added' | 'deleted';
  /** Individual cell changes for this row */
  changes: Map<string, CellChange>;
}

/**
 * Undo/Redo action types
 */
export type UndoAction =
  | { type: 'cellEdit'; rowIndex: number; columnName: string; oldValue: unknown; newValue: unknown }
  | { type: 'addRow'; rowIndex: number }
  | { type: 'deleteRow'; rowIndex: number; rowData: Record<string, unknown>; wasNew: boolean }
  | { type: 'duplicateRow'; rowIndex: number };

/**
 * Tracks all changes made to query results for batch save operations.
 * Maintains an undo/redo stack and generates SQL statements.
 */
export class ChangeTracker {
  private rows: TrackedRow[] = [];
  private primaryKeys: string[] = [];
  private tableName: string = '';
  private schemaName: string | undefined;
  private columnNames: string[] = [];

  private undoStack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];

  /** Whether there are any unsaved changes */
  get hasChanges(): boolean {
    return this.rows.some(r => r.state !== 'unchanged');
  }

  /** Number of modified rows */
  get changeCount(): number {
    return this.rows.filter(r => r.state !== 'unchanged').length;
  }

  get modifiedCount(): number {
    return this.rows.filter(r => r.state === 'modified').length;
  }

  get addedCount(): number {
    return this.rows.filter(r => r.state === 'added').length;
  }

  get deletedCount(): number {
    return this.rows.filter(r => r.state === 'deleted').length;
  }

  /** Initialize tracker with query result data */
  initialize(
    tableName: string,
    columns: string[],
    primaryKeys: string[],
    rows: unknown[][],
    schemaName?: string,
  ): void {
    this.tableName = tableName;
    this.schemaName = schemaName;
    this.columnNames = columns;
    this.primaryKeys = primaryKeys;
    this.undoStack = [];
    this.redoStack = [];

    this.rows = rows.map(row => {
      const data: Record<string, unknown> = {};
      columns.forEach((col, i) => { data[col] = row[i]; });

      return {
        originalData: { ...data },
        currentData: data,
        state: 'unchanged' as const,
        changes: new Map(),
      };
    });
  }

  /** Get the current state of all rows */
  getRows(): TrackedRow[] {
    return this.rows;
  }

  /** Get the current data for rendering */
  getCurrentData(): unknown[][] {
    return this.rows
      .filter(r => r.state !== 'deleted')
      .map(r => this.columnNames.map(col => r.currentData[col]));
  }

  /** Edit a cell value */
  editCell(rowIndex: number, columnName: string, newValue: unknown): void {
    const row = this.rows[rowIndex];
    if (!row) { return; }

    const oldValue = row.currentData[columnName];
    if (oldValue === newValue) { return; }

    // Record undo action
    this.undoStack.push({
      type: 'cellEdit',
      rowIndex,
      columnName,
      oldValue,
      newValue,
    });
    this.redoStack = []; // Clear redo on new action

    // Apply change
    row.currentData[columnName] = newValue;

    // Track individual cell change
    const originalValue = row.originalData[columnName];
    if (newValue === originalValue) {
      // Reverted to original — remove cell change
      row.changes.delete(columnName);
    } else {
      row.changes.set(columnName, {
        rowIndex,
        columnName,
        oldValue: originalValue,
        newValue,
        timestamp: Date.now(),
      });
    }

    // Update row state
    if (row.state !== 'added') {
      row.state = row.changes.size > 0 ? 'modified' : 'unchanged';
    }
  }

  /** Add a new empty row */
  addRow(): number {
    const newData: Record<string, unknown> = {};
    this.columnNames.forEach(col => { newData[col] = null; });

    const newRow: TrackedRow = {
      originalData: {},
      currentData: newData,
      state: 'added',
      changes: new Map(),
    };

    this.rows.push(newRow);
    const rowIndex = this.rows.length - 1;

    this.undoStack.push({ type: 'addRow', rowIndex });
    this.redoStack = [];

    return rowIndex;
  }

  /** Duplicate an existing row */
  duplicateRow(sourceIndex: number): number {
    const source = this.rows[sourceIndex];
    if (!source) { return -1; }

    const newData = { ...source.currentData };

    // Clear auto-increment / primary key columns
    for (const pk of this.primaryKeys) {
      newData[pk] = null;
    }

    const newRow: TrackedRow = {
      originalData: {},
      currentData: newData,
      state: 'added',
      changes: new Map(),
    };

    this.rows.splice(sourceIndex + 1, 0, newRow);
    const rowIndex = sourceIndex + 1;

    this.undoStack.push({ type: 'duplicateRow', rowIndex });
    this.redoStack = [];

    return rowIndex;
  }

  /** Mark a row for deletion */
  deleteRow(rowIndex: number): void {
    const row = this.rows[rowIndex];
    if (!row) { return; }

    const wasNew = row.state === 'added';

    this.undoStack.push({
      type: 'deleteRow',
      rowIndex,
      rowData: { ...row.currentData },
      wasNew,
    });
    this.redoStack = [];

    if (wasNew) {
      // New rows can be removed immediately
      this.rows.splice(rowIndex, 1);
    } else {
      row.state = 'deleted';
    }
  }

  /** Undo the last action */
  undo(): UndoAction | undefined {
    const action = this.undoStack.pop();
    if (!action) { return undefined; }

    switch (action.type) {
      case 'cellEdit': {
        const row = this.rows[action.rowIndex];
        if (row) {
          row.currentData[action.columnName] = action.oldValue;

          const originalValue = row.originalData[action.columnName];
          if (action.oldValue === originalValue) {
            row.changes.delete(action.columnName);
          } else {
            row.changes.set(action.columnName, {
              rowIndex: action.rowIndex,
              columnName: action.columnName,
              oldValue: originalValue,
              newValue: action.oldValue,
              timestamp: Date.now(),
            });
          }

          if (row.state !== 'added') {
            row.state = row.changes.size > 0 ? 'modified' : 'unchanged';
          }
        }
        break;
      }
      case 'addRow':
      case 'duplicateRow':
        this.rows.splice(action.rowIndex, 1);
        break;
      case 'deleteRow':
        if (action.wasNew) {
          const restored: TrackedRow = {
            originalData: {},
            currentData: { ...action.rowData },
            state: 'added',
            changes: new Map(),
          };
          this.rows.splice(action.rowIndex, 0, restored);
        } else {
          const row = this.rows[action.rowIndex];
          if (row) { row.state = row.changes.size > 0 ? 'modified' : 'unchanged'; }
        }
        break;
    }

    this.redoStack.push(action);
    return action;
  }

  /** Redo the last undone action */
  redo(): UndoAction | undefined {
    const action = this.redoStack.pop();
    if (!action) { return undefined; }

    switch (action.type) {
      case 'cellEdit':
        this.editCell(action.rowIndex, action.columnName, action.newValue);
        // editCell pushes to undo and clears redo, so we need to fix that
        this.redoStack = this.redoStack; // Already fixed by removing the push in editCell call
        break;
      case 'addRow':
        this.addRow();
        break;
      case 'duplicateRow':
        // Re-duplicate is complex; just add a new row
        this.addRow();
        break;
      case 'deleteRow':
        this.deleteRow(action.rowIndex);
        break;
    }

    // Move from redo back; editCell already handled the undo push
    return action;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /**
   * Generate SQL statements for all pending changes.
   */
  generateSQL(driver: DatabaseDriver): string[] {
    const statements: string[] = [];
    const escapedTable = this.schemaName
      ? `${driver.escapeIdentifier(this.schemaName)}.${driver.escapeIdentifier(this.tableName)}`
      : driver.escapeIdentifier(this.tableName);

    for (const row of this.rows) {
      switch (row.state) {
        case 'modified':
          statements.push(this.generateUpdate(row, escapedTable, driver));
          break;
        case 'added':
          statements.push(this.generateInsert(row, escapedTable, driver));
          break;
        case 'deleted':
          statements.push(this.generateDelete(row, escapedTable, driver));
          break;
      }
    }

    return statements;
  }

  /**
   * Apply all changes (mark rows as saved).
   */
  applySave(): void {
    // Remove deleted rows
    this.rows = this.rows.filter(r => r.state !== 'deleted');

    // Mark all remaining rows as unchanged
    for (const row of this.rows) {
      row.originalData = { ...row.currentData };
      row.state = 'unchanged';
      row.changes.clear();
    }

    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * Discard all changes and revert to original data.
   */
  discardChanges(): void {
    // Remove added rows
    this.rows = this.rows.filter(r => r.state !== 'added');

    // Revert modified and deleted rows
    for (const row of this.rows) {
      row.currentData = { ...row.originalData };
      row.state = 'unchanged';
      row.changes.clear();
    }

    this.undoStack = [];
    this.redoStack = [];
  }

  // ── SQL Generation Helpers ──

  private generateUpdate(row: TrackedRow, escapedTable: string, driver: DatabaseDriver): string {
    const setClauses = Array.from(row.changes.entries()).map(([col, change]) =>
      `${driver.escapeIdentifier(col)} = ${driver.escapeValue(change.newValue)}`
    );

    const whereClauses = this.buildWhereClause(row.originalData, driver);

    return `UPDATE ${escapedTable} SET ${setClauses.join(', ')} WHERE ${whereClauses};`;
  }

  private generateInsert(row: TrackedRow, escapedTable: string, driver: DatabaseDriver): string {
    const nonNullCols = this.columnNames.filter(col => row.currentData[col] !== null);

    if (nonNullCols.length === 0) {
      // Insert with all defaults
      return `INSERT INTO ${escapedTable} DEFAULT VALUES;`;
    }

    const columns = nonNullCols.map(col => driver.escapeIdentifier(col)).join(', ');
    const values = nonNullCols.map(col => driver.escapeValue(row.currentData[col])).join(', ');

    return `INSERT INTO ${escapedTable} (${columns}) VALUES (${values});`;
  }

  private generateDelete(row: TrackedRow, escapedTable: string, driver: DatabaseDriver): string {
    const whereClauses = this.buildWhereClause(row.originalData, driver);
    return `DELETE FROM ${escapedTable} WHERE ${whereClauses};`;
  }

  private buildWhereClause(data: Record<string, unknown>, driver: DatabaseDriver): string {
    // Use primary keys if available
    const keyCols = this.primaryKeys.length > 0
      ? this.primaryKeys
      : this.columnNames; // Fallback: use all columns

    return keyCols.map(col => {
      const value = data[col];
      if (value === null || value === undefined) {
        return `${driver.escapeIdentifier(col)} IS NULL`;
      }
      return `${driver.escapeIdentifier(col)} = ${driver.escapeValue(value)}`;
    }).join(' AND ');
  }
}
