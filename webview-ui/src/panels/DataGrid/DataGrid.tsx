import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { postMessage, onMessage } from '../../hooks/useVsCode';
import './DataGrid.css';

interface ColumnHeader {
  name: string;
  type: string;
  normalizedType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  rawType?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

interface QueryResult {
  columns: ColumnHeader[];
  rows: unknown[][];
  affectedRows: number;
  executionTime: number;
  truncated: boolean;
  messages: string[];
}

type CopyFormat = 'csv' | 'csv-noheader' | 'tsv' | 'tsv-noheader' | 'json' | 'xml' | 'insert' | 'update';

interface CellEdit {
  rowIndex: number;
  colIndex: number;
  oldValue: unknown;
  newValue: unknown;
}

interface RowState {
  status: 'unchanged' | 'modified' | 'added' | 'deleted';
  data: unknown[];
  original: unknown[];
  changedCols: Set<number>;
}

interface SortState { column: number; direction: 'asc' | 'desc'; }

type UndoAction =
  | { type: 'edit'; rowIndex: number; colIndex: number; oldValue: unknown; newValue: unknown }
  | { type: 'addRow'; rowIndex: number }
  | { type: 'deleteRow'; rowIndex: number; row: RowState }
  | { type: 'duplicateRow'; rowIndex: number };

interface ContextMenu {
  x: number;
  y: number;
  visIdx: number;
}

interface GridLogEntry {
  id: number;
  time: string;
  level: 'info' | 'success' | 'error';
  message: string;
}

const DEFAULT_PAGE_SIZE = 1000;

function formatColumnType(col: ColumnHeader): string {
  if (!col) return '';
  // Use rawType for accurate display, fallback to type
  const base = (col.rawType || col.type || '').toLowerCase();
  if (base.includes('(')) {
    return base;
  }
  if (col.maxLength && col.maxLength > 0 && col.maxLength < 65535) {
    return `${base}(${col.maxLength})`;
  }
  if (col.precision && col.scale !== undefined && col.scale !== null) {
    return `${base}(${col.precision},${col.scale})`;
  }
  if (col.precision && col.precision > 0) {
    return `${base}(${col.precision})`;
  }
  return base;
}

export default function DataGrid() {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [sortStates, setSortStates] = useState<SortState[]>([]);
  const [filterText, setFilterText] = useState('');
  const [whereFilter, setWhereFilter] = useState('');
  const [showWhereInput, setShowWhereInput] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false); // limit+1 trick: server says there are more rows
  const [selectedRow, setSelectedRow] = useState(-1);
  const [selectedCol, setSelectedCol] = useState(-1);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [selectionStart, setSelectionStart] = useState<{ row: number; col: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ row: number; col: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoAction[]>([]);
  const [tableName, setTableName] = useState<string>('');
  const [filterInput, setFilterInput] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [csvMenuOpen, setCsvMenuOpen] = useState(false);
  const [logEntries, setLogEntries] = useState<GridLogEntry[]>([]);
  const [showLogDrawer, setShowLogDrawer] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const csvMenuRef = useRef<HTMLDivElement>(null);
  const hasDeletedRef = useRef(false);
  const quickViewOpenRef = useRef(false);

  function addLog(level: GridLogEntry['level'], message: string) {
    const entry: GridLogEntry = {
      id: Date.now() + Math.random(),
      time: new Date().toLocaleTimeString(),
      level,
      message,
    };
    setLogEntries(prev => [entry, ...prev].slice(0, 100));
  }

  function showStatus(kind: 'success' | 'error' | 'info', text: string) {
    setCopyStatus({ kind, text });
    addLog(kind === 'info' ? 'info' : kind, text);
    setTimeout(() => setCopyStatus(null), 1800);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilterText(filterInput);
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [filterInput]);

  useEffect(() => {
    postMessage({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg.type === 'queryResult') {
        const r = msg.data as QueryResult;
        setResult(r);
        setTableName(msg.tableName || '');
        const nextPageSize = msg.pageSize || DEFAULT_PAGE_SIZE;
        const nextHasMore = !!msg.hasMore;
        setPageSize(nextPageSize);
        setRows(r.rows.map(row => ({
          status: 'unchanged', data: [...row], original: [...row], changedCols: new Set(),
        })));
        setPage(0);
        setSortStates([]);
        setSelectedRow(-1);
        setSelectedCol(-1);
        setSelectedRows(new Set());
        setSelectionStart(null);
        setSelectionEnd(null);
        setTotalRows(msg.tableName && !nextHasMore ? r.rows.length : null);
        setHasMore(nextHasMore);
        setFilterText('');
        setFilterInput('');
        hasDeletedRef.current = false;
        setUndoStack([]);
        setRedoStack([]);
        addLog('success', `Loaded ${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'} in ${r.executionTime}ms`);
      } else if (msg.type === 'pageData') {
        const r = msg.data as QueryResult;
        const nextPageSize = msg.pageSize || pageSize || DEFAULT_PAGE_SIZE;
        const nextHasMore = !!msg.hasMore;
        setResult(r);
        setPageSize(nextPageSize);
        setRows(r.rows.map(row => ({
          status: 'unchanged', data: [...row], original: [...row], changedCols: new Set(),
        })));
        setPage(msg.page);
        setHasMore(nextHasMore);
        if (msg.totalRows !== undefined) {
          setTotalRows(msg.totalRows);
        } else if (!nextHasMore) {
          setTotalRows((msg.page * nextPageSize) + r.rows.length);
        }
        if (msg.sortStates !== undefined) {
          setSortStates(msg.sortStates || []);
        }
        setSelectedRow(-1);
        setSelectedCol(-1);
        setSelectedRows(new Set());
        setSelectionStart(null);
        setSelectionEnd(null);
        addLog('success', `Loaded page ${msg.page + 1}: ${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'} in ${r.executionTime}ms`);
      } else if (msg.type === 'totalRowsCount') {
        setTotalRows(msg.data.totalRows);
        addLog('info', `Counted ${Number(msg.data.totalRows).toLocaleString()} total row${msg.data.totalRows === 1 ? '' : 's'}`);
      } else if (msg.type === 'rowSelected') {
        // Quick View auto-updated by extension, no local state change needed
      } else if (msg.type === 'copyResult') {
        showStatus(msg.success ? 'success' : 'error', msg.message || (msg.success ? 'Copied' : 'Copy failed'));
      }
    });
    return unsub;
  }, [pageSize]);

  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingCell]);

  // Close menus on outside pointer interactions, even when table cells stop click bubbling.
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.context-menu')) {
        setContextMenu(null);
      }
      if (csvMenuRef.current && !csvMenuRef.current.contains(event.target as Node)) {
        setCsvMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, []);

  const hasChanges = rows.some(r => r.status !== 'unchanged');
  const changeStats = useMemo(() => ({
    modified: rows.filter(r => r.status === 'modified').length,
    added: rows.filter(r => r.status === 'added').length,
    deleted: rows.filter(r => r.status === 'deleted').length,
  }), [rows]);

  // Sort state for primary sort column (for backward compat)
  const sortState = sortStates.length > 0 ? sortStates[0] : null;

  const filteredSortedIndices = useMemo(() => {
    const hasDeleted = hasDeletedRef.current;
    if (!filterText && (!sortStates.length || tableName) && !hasDeleted) {
      return null;
    }

    let indices: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].status !== 'deleted') {
        indices.push(i);
      }
    }

    if (filterText) {
      const lower = filterText.toLowerCase();
      indices = indices.filter(idx =>
        rows[idx].data.some(c => c !== null && String(c).toLowerCase().includes(lower))
      );
    }

    if (sortStates.length > 0 && !tableName) {
      indices.sort((a, b) => {
        for (const { column, direction } of sortStates) {
          const va = rows[a].data[column], vb = rows[b].data[column];
          if (va === null && vb === null) continue;
          if (va === null) return 1;
          if (vb === null) return -1;
          const cmp = typeof va === 'number' && typeof vb === 'number'
            ? va - vb
            : String(va).localeCompare(String(vb), undefined, { numeric: true });
          if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }

    return indices;
  }, [rows, filterText, sortStates, tableName]);

  const visibleRowsCount = useMemo(() => {
    if (filteredSortedIndices !== null) {
      return filteredSortedIndices.length;
    }
    return rows.filter(r => r.status !== 'deleted').length;
  }, [rows, filteredSortedIndices]);

  const totalPages = tableName
    ? (totalRows !== null ? Math.max(1, Math.ceil(totalRows / pageSize)) : null)
    : Math.max(1, Math.ceil(visibleRowsCount / pageSize));

  const pageRows = useMemo(() => {
    if (tableName) {
      return rows.map((row, idx) => ({ row, origIdx: idx }));
    }
    const start = page * pageSize;
    const end = Math.min(start + pageSize, visibleRowsCount);
    const resultList: { row: RowState; origIdx: number }[] = [];

    if (filteredSortedIndices !== null) {
      for (let i = start; i < end; i++) {
        const origIdx = filteredSortedIndices[i];
        resultList.push({ row: rows[origIdx], origIdx });
      }
    } else {
      // Skip deleted rows inline
      let count = 0;
      let absIdx = 0;
      const target_start = start;
      const target_end = end;
      for (let i = 0; i < rows.length && count < target_end; i++) {
        if (rows[i].status === 'deleted') continue;
        if (count >= target_start) {
          resultList.push({ row: rows[i], origIdx: i });
        }
        count++;
      }
    }
    return resultList;
  }, [rows, page, filteredSortedIndices, visibleRowsCount, tableName, pageSize]);

  const pushUndo = useCallback((action: UndoAction) => {
    setUndoStack(prev => [...prev, action]);
    setRedoStack([]);
  }, []);

  // ── Cell Editing ──
  const startEdit = useCallback((visIdx: number, colIdx: number) => {
    const item = pageRows[visIdx];
    if (!item || !result) return;
    const val = item.row.data[colIdx];
    setEditingCell({ row: visIdx, col: colIdx });
    setEditValue(val === null ? '' : String(val));
  }, [pageRows, result]);

  const commitEdit = useCallback(() => {
    if (!editingCell || !result) return;
    const item = pageRows[editingCell.row];
    if (!item) { setEditingCell(null); return; }
    const colIdx = editingCell.col;
    const oldValue = item.row.data[colIdx];
    let newValue: unknown = editValue === '' && result.columns[colIdx]?.nullable ? null : editValue;

    const ntype = result.columns[colIdx]?.normalizedType;
    if (newValue !== null && (ntype === 'integer' || ntype === 'float' || ntype === 'decimal')) {
      const num = Number(newValue);
      if (!isNaN(num)) newValue = num;
    }
    if (ntype === 'boolean') {
      newValue = newValue === 'true' || newValue === '1' || newValue === true;
    }

    if (oldValue !== newValue) {
      const origIdx = item.origIdx;
      pushUndo({ type: 'edit', rowIndex: origIdx, colIndex: colIdx, oldValue, newValue });
      setRows(prev => {
        const next = [...prev];
        const r = { ...next[origIdx], data: [...next[origIdx].data], changedCols: new Set(next[origIdx].changedCols) };
        r.data[colIdx] = newValue;
        if (r.status !== 'added') {
          if (newValue === r.original[colIdx]) r.changedCols.delete(colIdx);
          else r.changedCols.add(colIdx);
          r.status = r.changedCols.size > 0 ? 'modified' : 'unchanged';
        }
        next[origIdx] = r;
        return next;
      });
    }
    setEditingCell(null);
  }, [editingCell, editValue, pageRows, result, pushUndo]);

  const cancelEdit = useCallback(() => setEditingCell(null), []);

  // ── Row Operations ──
  const addRow = useCallback(() => {
    if (!result) return;
    const newData = result.columns.map(() => null);
    const newRow: RowState = { status: 'added', data: newData, original: [], changedCols: new Set() };

    let insertIdx = 0;
    if (tableName) {
      insertIdx = 0;
    } else if (filteredSortedIndices !== null) {
      const pageStart = page * pageSize;
      if (pageStart < filteredSortedIndices.length) {
        insertIdx = filteredSortedIndices[pageStart];
      } else {
        insertIdx = rows.length;
      }
    } else {
      insertIdx = page * pageSize;
    }

    setRows(prev => {
      pushUndo({ type: 'addRow', rowIndex: insertIdx });
      const next = [...prev];
      next.splice(insertIdx, 0, newRow);
      return next;
    });
    setSelectedRow(0);
  }, [result, page, pageSize, rows, filteredSortedIndices, tableName, pushUndo]);

  const deleteRow = useCallback((visIdx: number) => {
    const item = pageRows[visIdx];
    if (!item) return;
    const origIdx = item.origIdx;
    setRows(prev => {
      const next = [...prev];
      pushUndo({ type: 'deleteRow', rowIndex: origIdx, row: { ...next[origIdx] } });
      if (next[origIdx].status === 'added') {
        next.splice(origIdx, 1);
      } else {
        next[origIdx] = { ...next[origIdx], status: 'deleted' };
        hasDeletedRef.current = true;
      }
      return next;
    });
  }, [pageRows, pushUndo]);

  const duplicateRow = useCallback((visIdx: number) => {
    const item = pageRows[visIdx];
    if (!item || !result) return;
    const newData = [...item.row.data];
    result.columns.forEach((col, i) => { if (col.isPrimaryKey || col.isAutoIncrement) newData[i] = null; });
    const newRow: RowState = { status: 'added', data: newData, original: [], changedCols: new Set() };
    setRows(prev => {
      const insertAt = item.origIdx + 1;
      pushUndo({ type: 'duplicateRow', rowIndex: insertAt });
      const next = [...prev]; next.splice(insertAt, 0, newRow); return next;
    });
  }, [pageRows, result, pushUndo]);

  // ── Undo / Redo ──
  const undo = useCallback(() => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const action = prev[prev.length - 1];
      const next = prev.slice(0, -1);
      setRedoStack(r => [...r, action]);
      setRows(rw => {
        const nr = [...rw];
        switch (action.type) {
          case 'edit': {
            const r = { ...nr[action.rowIndex], data: [...nr[action.rowIndex].data], changedCols: new Set(nr[action.rowIndex].changedCols) };
            r.data[action.colIndex] = action.oldValue;
            if (r.status !== 'added') {
              if (action.oldValue === r.original[action.colIndex]) r.changedCols.delete(action.colIndex);
              else r.changedCols.add(action.colIndex);
              r.status = r.changedCols.size > 0 ? 'modified' : 'unchanged';
            }
            nr[action.rowIndex] = r;
            break;
          }
          case 'addRow': case 'duplicateRow':
            nr.splice(action.rowIndex, 1);
            break;
          case 'deleteRow':
            if (action.row.status === 'added') nr.splice(action.rowIndex, 0, action.row);
            else { nr[action.rowIndex] = { ...action.row }; }
            break;
        }
        return nr;
      });
      return next;
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack(prev => {
      if (prev.length === 0) return prev;
      const action = prev[prev.length - 1];
      const next = prev.slice(0, -1);
      setUndoStack(u => [...u, action]);
      setRows(rw => {
        const nr = [...rw];
        switch (action.type) {
          case 'edit': {
            const r = { ...nr[action.rowIndex], data: [...nr[action.rowIndex].data], changedCols: new Set(nr[action.rowIndex].changedCols) };
            r.data[action.colIndex] = action.newValue;
            if (r.status !== 'added') {
              if (action.newValue === r.original[action.colIndex]) r.changedCols.delete(action.colIndex);
              else r.changedCols.add(action.colIndex);
              r.status = r.changedCols.size > 0 ? 'modified' : 'unchanged';
            }
            nr[action.rowIndex] = r;
            break;
          }
          case 'addRow': {
            const newData = result?.columns.map(() => null) || [];
            nr.splice(action.rowIndex, 0, { status: 'added', data: newData, original: [], changedCols: new Set() });
            break;
          }
          case 'duplicateRow':
            nr.splice(action.rowIndex, 0, { status: 'added', data: [...(nr[action.rowIndex - 1]?.data || [])], original: [], changedCols: new Set() });
            break;
          case 'deleteRow':
            if (nr[action.rowIndex]?.status === 'added') nr.splice(action.rowIndex, 1);
            else if (nr[action.rowIndex]) {
              nr[action.rowIndex] = { ...nr[action.rowIndex], status: 'deleted' };
              hasDeletedRef.current = true;
            }
            break;
        }
        return nr;
      });
      return next;
    });
  }, [result]);

  // ── Save / Discard ──
  const handleSave = useCallback(() => {
    postMessage({ type: 'saveChanges', data: { rows: rows.map(r => ({ status: r.status, data: r.data, original: r.original, changedCols: Array.from(r.changedCols) })) } });
  }, [rows]);

  const handleDiscard = useCallback(() => {
    setRows(prev => prev.filter(r => r.status !== 'added').map(r => ({
      status: 'unchanged' as const, data: [...r.original], original: [...r.original], changedCols: new Set<number>(),
    })));
    hasDeletedRef.current = false;
    setUndoStack([]); setRedoStack([]);
  }, []);

  const handlePreviewSQL = useCallback(() => {
    postMessage({ type: 'previewSQL', data: { rows: rows.map(r => ({ status: r.status, data: r.data, original: r.original, changedCols: Array.from(r.changedCols) })) } });
  }, [rows]);

  // ── Reload ──
  const handleReload = useCallback(() => {
    if (tableName) {
      postMessage({ type: 'fetchPage', data: { page: 0, sortStates, whereFilter: whereFilter || undefined } });
    } else {
      postMessage({ type: 'reload' });
    }
  }, [tableName, sortStates, whereFilter]);

  // ── Where Filter ──
  const handleApplyWhere = useCallback(() => {
    if (tableName) {
      postMessage({ type: 'fetchPage', data: { page: 0, sortStates, whereFilter: whereFilter || undefined } });
    }
    setPage(0);
  }, [tableName, sortStates, whereFilter]);

  // ── Range Selection ──
  const isCellInRange = useCallback((row: number, col: number) => {
    if (!selectionStart || !selectionEnd) return false;
    const minRow = Math.min(selectionStart.row, selectionEnd.row);
    const maxRow = Math.max(selectionStart.row, selectionEnd.row);
    const minCol = Math.min(selectionStart.col, selectionEnd.col);
    const maxCol = Math.max(selectionStart.col, selectionEnd.col);
    return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
  }, [selectionStart, selectionEnd]);

  const selectColumn = useCallback((colIdx: number) => {
    if (!result) return;
    setSelectionStart({ row: 0, col: colIdx });
    setSelectionEnd({ row: pageRows.length - 1, col: colIdx });
    setSelectedRow(0);
    setSelectedCol(colIdx);
    setSelectedRows(new Set());
  }, [result, pageRows.length]);

  const selectRowAllColumns = useCallback((rowIdx: number, e: React.MouseEvent) => {
    if (!result) return;
    if (e.ctrlKey || e.metaKey) {
      // Toggle row in multi-selection
      setSelectedRows(prev => {
        const next = new Set(prev);
        if (next.has(rowIdx)) next.delete(rowIdx);
        else next.add(rowIdx);
        return next;
      });
    } else if (e.shiftKey && selectedRow >= 0) {
      // Shift-click: select range of rows
      const minR = Math.min(selectedRow, rowIdx);
      const maxR = Math.max(selectedRow, rowIdx);
      const newSet = new Set<number>();
      for (let r = minR; r <= maxR; r++) newSet.add(r);
      setSelectedRows(newSet);
    } else {
      setSelectedRows(new Set([rowIdx]));
      setSelectionStart({ row: rowIdx, col: 0 });
      setSelectionEnd({ row: rowIdx, col: result.columns.length - 1 });
    }
    setSelectedRow(rowIdx);
    setSelectedCol(0);
  }, [result, selectedRow]);

  const handleRowClick = useCallback((visIdx: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedRows(prev => {
        const next = new Set(prev);
        if (next.has(visIdx)) next.delete(visIdx);
        else next.add(visIdx);
        return next;
      });
    } else if (e.shiftKey && selectedRow >= 0) {
      const minR = Math.min(selectedRow, visIdx);
      const maxR = Math.max(selectedRow, visIdx);
      const newSet = new Set<number>();
      for (let r = minR; r <= maxR; r++) newSet.add(r);
      setSelectedRows(newSet);
    } else {
      setSelectedRows(new Set([visIdx]));
    }
    setSelectedRow(visIdx);
  }, [selectedRow]);

  const handleCellMouseDown = useCallback((row: number, col: number, e: React.MouseEvent) => {
    if (editingCell) return;
    if (e.button !== 0) return;
    // Prevent browser text selection during drag
    e.preventDefault();

    if (e.shiftKey && selectionStart) {
      // Extend selection from anchor
      setSelectionEnd({ row, col });
      setSelectedRow(row);
      setSelectedCol(col);
      setSelectedRows(new Set());
    } else {
      // Start fresh selection
      setSelectionStart({ row, col });
      setSelectionEnd({ row, col });
      setSelectedRow(row);
      setSelectedCol(col);
      setSelectedRows(new Set());
      setIsSelecting(true);
    }
  }, [editingCell, selectionStart]);

  const handleCellMouseEnter = useCallback((row: number, col: number) => {
    if (isSelecting) {
      setSelectionEnd({ row, col });
    }
  }, [isSelecting]);

  useEffect(() => {
    const handleMouseUpGlobal = () => setIsSelecting(false);
    window.addEventListener('mouseup', handleMouseUpGlobal);
    return () => window.removeEventListener('mouseup', handleMouseUpGlobal);
  }, []);

  // ── Quick View real-time update ──
  useEffect(() => {
    if (selectedRow >= 0 && selectedRow < pageRows.length) {
      const item = pageRows[selectedRow];
      if (item && result) {
        postMessage({
          type: 'rowSelected',
          data: { columns: result.columns, rowData: item.row.data }
        });
      }
    }
  }, [selectedRow, pageRows, result]);

  // ── Pagination ──
  const handleCountRows = useCallback(() => {
    if (tableName) postMessage({ type: 'countRows', data: { whereFilter: whereFilter || undefined } });
  }, [tableName, whereFilter]);

  const handlePageChange = useCallback((nextPage: number) => {
    if (tableName) {
      postMessage({ type: 'fetchPage', data: { page: nextPage, sortStates, whereFilter: whereFilter || undefined } });
    } else {
      setPage(nextPage);
    }
  }, [tableName, sortStates, whereFilter]);

  // ── Multi-Sort ──
  const toggleSort = useCallback((colIdx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const useMulti = e.ctrlKey || e.metaKey;

    setSortStates(prev => {
      let next: SortState[];
      const existingIdx = prev.findIndex(s => s.column === colIdx);

      if (useMulti) {
        if (existingIdx >= 0) {
          const existing = prev[existingIdx];
          if (existing.direction === 'asc') {
            next = [...prev];
            next[existingIdx] = { column: colIdx, direction: 'desc' };
          } else {
            next = prev.filter((_, i) => i !== existingIdx);
          }
        } else {
          next = [...prev, { column: colIdx, direction: 'asc' }];
        }
      } else {
        if (existingIdx >= 0) {
          const existing = prev[existingIdx];
          if (existing.direction === 'asc') {
            next = [{ column: colIdx, direction: 'desc' }];
          } else {
            next = [];
          }
        } else {
          next = [{ column: colIdx, direction: 'asc' }];
        }
      }

      if (tableName) {
        postMessage({ type: 'fetchPage', data: { page: 0, sortStates: next, whereFilter: whereFilter || undefined } });
      }
      return next;
    });
    setPage(0);
  }, [tableName, whereFilter]);

  // ── Paste ──
  const pasteData = useCallback((text: string) => {
    if (!result || selectedRow < 0 || selectedCol < 0) return;
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const gridData = lines.map(line => line.split('\t'));

    setRows(prev => {
      const next = [...prev];
      for (let r = 0; r < gridData.length; r++) {
        const visRowIdx = selectedRow + r;
        if (visRowIdx >= pageRows.length) break;
        const item = pageRows[visRowIdx];
        const origIdx = item.origIdx;
        const rState = { ...next[origIdx], data: [...next[origIdx].data], changedCols: new Set(next[origIdx].changedCols) };
        for (let c = 0; c < gridData[r].length; c++) {
          const colIdx = selectedCol + c;
          if (colIdx >= result.columns.length) break;
          const valStr = gridData[r][c];
          let newValue: any = valStr === 'NULL' || (valStr === '' && result.columns[colIdx]?.nullable) ? null : valStr;
          const ntype = result.columns[colIdx]?.normalizedType;
          if (newValue !== null && (ntype === 'integer' || ntype === 'float' || ntype === 'decimal')) {
            const num = Number(newValue); if (!isNaN(num)) newValue = num;
          }
          if (ntype === 'boolean') newValue = newValue === 'true' || newValue === '1';
          const oldValue = rState.data[colIdx];
          if (oldValue !== newValue) {
            pushUndo({ type: 'edit', rowIndex: origIdx, colIndex: colIdx, oldValue, newValue });
            rState.data[colIdx] = newValue;
            if (rState.status !== 'added') {
              if (newValue === rState.original[colIdx]) rState.changedCols.delete(colIdx);
              else rState.changedCols.add(colIdx);
              rState.status = rState.changedCols.size > 0 ? 'modified' : 'unchanged';
            }
          }
        }
        next[origIdx] = rState;
      }
      return next;
    });
  }, [result, pageRows, selectedRow, selectedCol, pushUndo]);

  // ── Context Menu ──
  const handleContextMenu = useCallback((e: React.MouseEvent, visIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, visIdx });
  }, []);

  const formatDelimitedCell = useCallback((value: unknown, separator: ',' | '\t') => {
    if (value === null || value === undefined) return separator === '\t' ? 'NULL' : '';
    const s = String(value);
    if (separator === '\t') return s.replace(/\t/g, ' ');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  }, []);

  const writeClipboard = useCallback(async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showStatus('success', successText);
      return true;
    } catch (err) {
      showStatus('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }, []);

  const getAllClientRowsForCopy = useCallback(() => {
    if (filteredSortedIndices !== null) {
      return filteredSortedIndices
        .map(origIdx => rows[origIdx])
        .filter(row => row && row.status !== 'deleted')
        .map((row, origIdx) => ({ row, origIdx }));
    }
    return rows
      .map((row, origIdx) => ({ row, origIdx }))
      .filter(item => item.row.status !== 'deleted');
  }, [filteredSortedIndices, rows]);

  const buildCsv = useCallback((items: { row: RowState; origIdx: number }[], includeHeader: boolean) => {
    if (!result) return '';
    const header = result.columns.map(c => formatDelimitedCell(c.name, ',')).join(',');
    const body = items.map(x => x.row.data.map(v => formatDelimitedCell(v, ',')).join(',')).join('\n');
    return includeHeader ? `${header}\n${body}` : body;
  }, [result, formatDelimitedCell]);

  const copyRowAs = useCallback((format: CopyFormat, visIdx: number) => {
    if (!result) return;
    const item = pageRows[visIdx];
    if (!item) return;
    const row = item.row.data;
    const cols = result.columns;
    let output = '';
    if (format === 'csv' || format === 'csv-noheader') {
      const line = row.map(v => formatDelimitedCell(v, ',')).join(',');
      output = format === 'csv' ? `${cols.map(c => formatDelimitedCell(c.name, ',')).join(',')}\n${line}` : line;
    } else if (format === 'tsv' || format === 'tsv-noheader') {
      const line = row.map(v => formatDelimitedCell(v, '\t')).join('\t');
      output = format === 'tsv' ? `${cols.map(c => c.name).join('\t')}\n${line}` : line;
    } else if (format === 'json') {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => { obj[col.name] = row[i]; });
      output = JSON.stringify(obj, null, 2);
    } else if (format === 'xml') {
      const inner = cols.map((col, i) => {
        const val = row[i];
        const escaped = val === null ? '' : String(val).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `  <${col.name}>${escaped}</${col.name}>`;
      }).join('\n');
      output = `<row>\n${inner}\n</row>`;
    } else if (format === 'insert') {
      const colList = cols.map(c => `\`${c.name}\``).join(', ');
      const valList = row.map(v => {
        if (v === null) return 'NULL';
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return `'${String(v).replace(/'/g, "''")}'`;
      }).join(', ');
      output = `INSERT INTO ${tableName} (${colList}) VALUES (${valList});`;
    } else if (format === 'update') {
      const pkCols = cols.filter(c => c.isPrimaryKey);
      const sets = cols.map((col, i) => {
        const val = row[i];
        const valStr = val === null ? 'NULL' : (typeof val === 'number' || typeof val === 'boolean' ? String(val) : `'${String(val).replace(/'/g, "''")}'`);
        return `\`${col.name}\` = ${valStr}`;
      }).join(', ');
      const where = (pkCols.length > 0 ? pkCols : cols).map(col => {
        const i = cols.indexOf(col); const val = row[i];
        return `\`${col.name}\` = ${val === null ? 'NULL' : typeof val === 'number' ? val : `'${String(val).replace(/'/g, "''")}'`}`;
      }).join(' AND ');
      output = `UPDATE ${tableName} SET ${sets} WHERE ${where};`;
    }
    void writeClipboard(output, `Copied ${format.toUpperCase()}`);
  }, [result, pageRows, tableName, formatDelimitedCell, writeClipboard]);

  const handleCopyCSV = useCallback((includeHeader = true, scope: 'page' | 'all' = 'page') => {
    if (!result) return;
    setCsvMenuOpen(false);
    if (scope === 'all' && tableName) {
      showStatus('info', 'Copy all CSV started...');
      postMessage({
        type: 'copyTableData',
        data: {
          format: 'csv',
          includeHeader,
          sortStates,
          whereFilter: whereFilter || undefined,
        },
      });
      return;
    }

    const items = scope === 'all' ? getAllClientRowsForCopy() : pageRows;
    const text = buildCsv(items, includeHeader);
    void writeClipboard(text, scope === 'all' ? 'Copied all rows as CSV' : 'Copied current page as CSV');
  }, [result, tableName, sortStates, whereFilter, getAllClientRowsForCopy, pageRows, buildCsv, writeClipboard]);

  // ── Quick View ──
  const handleQuickView = useCallback((visIdx: number) => {
    if (!result) return;
    const item = pageRows[visIdx];
    if (item) {
      quickViewOpenRef.current = true;
      postMessage({ type: 'openQuickView', data: { columns: result.columns, rowData: item.row.data } });
    }
  }, [result, pageRows]);

  // ── Keyboard Navigation ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editingCell) {
      if (e.key === 'Escape') cancelEdit();
      else if (e.key === 'Enter') commitEdit();
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); }
      return;
    }
    if (!result) return;
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const nextR = Math.min(selectedRow + 1, pageRows.length - 1);
        setSelectedRow(nextR);
        if (e.shiftKey) {
          setSelectionEnd(prev => ({ row: nextR, col: prev ? prev.col : selectedCol }));
        } else {
          setSelectionStart({ row: nextR, col: selectedCol });
          setSelectionEnd({ row: nextR, col: selectedCol });
          setSelectedRows(new Set());
        }
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const nextR = Math.max(selectedRow - 1, 0);
        setSelectedRow(nextR);
        if (e.shiftKey) {
          setSelectionEnd(prev => ({ row: nextR, col: prev ? prev.col : selectedCol }));
        } else {
          setSelectionStart({ row: nextR, col: selectedCol });
          setSelectionEnd({ row: nextR, col: selectedCol });
          setSelectedRows(new Set());
        }
        break;
      }
      case 'ArrowRight': {
        e.preventDefault();
        const nextC = Math.min(selectedCol + 1, result.columns.length - 1);
        setSelectedCol(nextC);
        if (e.shiftKey) {
          setSelectionEnd(prev => ({ row: prev ? prev.row : selectedRow, col: nextC }));
        } else {
          setSelectionStart({ row: selectedRow, col: nextC });
          setSelectionEnd({ row: selectedRow, col: nextC });
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const nextC = Math.max(selectedCol - 1, 0);
        setSelectedCol(nextC);
        if (e.shiftKey) {
          setSelectionEnd(prev => ({ row: prev ? prev.row : selectedRow, col: nextC }));
        } else {
          setSelectionStart({ row: selectedRow, col: nextC });
          setSelectionEnd({ row: selectedRow, col: nextC });
        }
        break;
      }
      case 'Enter': case 'F2': if (selectedRow >= 0 && selectedCol >= 0) startEdit(selectedRow, selectedCol); break;
      case 'Delete': case 'Backspace':
        if (selectedRow >= 0 && selectedCol >= 0 && !editingCell) {
          const item = pageRows[selectedRow];
          if (item && result.columns[selectedCol]?.nullable) {
            pushUndo({ type: 'edit', rowIndex: item.origIdx, colIndex: selectedCol, oldValue: item.row.data[selectedCol], newValue: null });
            setRows(prev => {
              const n = [...prev]; const r = { ...n[item.origIdx], data: [...n[item.origIdx].data], changedCols: new Set(n[item.origIdx].changedCols) };
              r.data[selectedCol] = null;
              if (r.status !== 'added') { r.changedCols.add(selectedCol); r.status = 'modified'; }
              n[item.origIdx] = r; return n;
            });
          }
        }
        break;
      case 'z': if (e.metaKey || e.ctrlKey) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); } break;
      case 'r': if (e.metaKey || e.ctrlKey) { e.preventDefault(); handleReload(); } break;
      case 'c':
        if (e.metaKey || e.ctrlKey) {
          if (selectedRow >= 0 && selectedCol >= 0) {
            if (selectionStart && selectionEnd) {
              const minRow = Math.min(selectionStart.row, selectionEnd.row);
              const maxRow = Math.max(selectionStart.row, selectionEnd.row);
              const minCol = Math.min(selectionStart.col, selectionEnd.col);
              const maxCol = Math.max(selectionStart.col, selectionEnd.col);
              const lines: string[] = [];
              for (let r = minRow; r <= maxRow; r++) {
                const rowCells: string[] = [];
                for (let c = minCol; c <= maxCol; c++) {
                  const cellVal = pageRows[r]?.row.data[c];
                  rowCells.push(cellVal === null ? '' : String(cellVal));
                }
                lines.push(rowCells.join('\t'));
              }
              void writeClipboard(lines.join('\n'), 'Copied selection');
            } else {
              const v = pageRows[selectedRow]?.row.data[selectedCol];
              void writeClipboard(v === null ? '' : String(v), 'Copied cell');
            }
            e.preventDefault();
          }
        }
        break;
      case 'v':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          navigator.clipboard.readText().then(pasteData).catch(console.error);
        }
        break;
    }
  }, [editingCell, result, selectedRow, selectedCol, pageRows, startEdit, commitEdit, cancelEdit, undo, redo, pushUndo, selectionStart, selectionEnd, pasteData, handleReload, writeClipboard]);

  if (!result) return <div className="datagrid-empty"><div className="empty-icon">📊</div><h3>No Results</h3><p className="text-muted">Run a query to see results here</p></div>;
  if (result.columns.length === 0) return <div className="datagrid-message"><div className="message-icon">✅</div><h3>{result.affectedRows} rows affected</h3><p className="text-muted">{result.executionTime}ms</p></div>;

  const latestLog = logEntries[0];

  return (
    <div className="datagrid" onKeyDown={handleKeyDown} tabIndex={0}>
      {/* Toolbar */}
      <div className="datagrid-toolbar">
        <div className="toolbar-left">
          <input type="text" className="filter-input" placeholder="🔍 Filter rows..." value={filterInput} onChange={e => setFilterInput(e.target.value)} />
          {showWhereInput && (
            <div className="where-filter-group">
              <span className="where-label">WHERE</span>
              <input
                type="text"
                className="where-input"
                placeholder="e.g. id > 100 AND status = 'active'"
                value={whereFilter}
                onChange={e => setWhereFilter(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleApplyWhere(); if (e.key === 'Escape') setShowWhereInput(false); }}
              />
              <button className="toolbar-btn" onClick={handleApplyWhere}>Apply</button>
              <button className="toolbar-btn" onClick={() => { setWhereFilter(''); setShowWhereInput(false); handleApplyWhere(); }}>✕</button>
            </div>
          )}
          <span className="row-count">{visibleRowsCount.toLocaleString()} rows</span>
        </div>
        <div className="toolbar-right">
          {hasChanges && (
            <div className="change-indicator">
              {changeStats.modified > 0 && <span className="badge badge-modified">{changeStats.modified} modified</span>}
              {changeStats.added > 0 && <span className="badge badge-added">{changeStats.added} added</span>}
              {changeStats.deleted > 0 && <span className="badge badge-deleted">{changeStats.deleted} deleted</span>}
            </div>
          )}
          <button className="toolbar-btn" onClick={handleReload} title="Reload (Ctrl+R)">⟳ Reload</button>
          <button className={`toolbar-btn ${showWhereInput ? 'btn-active' : ''}`} onClick={() => setShowWhereInput(v => !v)} title="Filter with WHERE SQL">⊿ Filter</button>
          {selectedRow >= 0 && (
            <button className="toolbar-btn btn-quickview" onClick={() => handleQuickView(selectedRow)} title="Quick View Row">👁 Quick View</button>
          )}
          <button className="toolbar-btn" onClick={addRow} title="Add Row">＋ Row</button>
          <div className="csv-copy-group" ref={csvMenuRef}>
            <button className="toolbar-btn csv-main-btn" onClick={() => handleCopyCSV(true, 'page')} title="Copy current page as CSV with header">📋 CSV</button>
            <button className="toolbar-btn csv-menu-btn" onClick={() => setCsvMenuOpen(v => !v)} title="More CSV copy options">▾</button>
            {csvMenuOpen && (
              <div className="csv-copy-menu">
                <button onClick={() => handleCopyCSV(false, 'page')}>Current page, no header</button>
                <button onClick={() => handleCopyCSV(true, 'all')}>All rows with header</button>
                <button onClick={() => handleCopyCSV(false, 'all')}>All rows, no header</button>
              </div>
            )}
          </div>
          <button className="toolbar-btn" onClick={() => postMessage({ type: 'openNewTab' })} title="Open New Query Tab">＋ Tab</button>
          <button className="toolbar-btn" onClick={undo} disabled={undoStack.length === 0} title="Undo (Ctrl+Z)">↩</button>
          <button className="toolbar-btn" onClick={redo} disabled={redoStack.length === 0} title="Redo (Ctrl+Shift+Z)">↪</button>
          {hasChanges && <>
            <button className="toolbar-btn btn-preview" onClick={handlePreviewSQL}>👁 SQL</button>
            <button className="toolbar-btn btn-discard" onClick={handleDiscard}>✕ Discard</button>
            <button className="toolbar-btn btn-save" onClick={handleSave}>💾 Save</button>
          </>}
          <span className="execution-time">{result.executionTime}ms</span>
        </div>
      </div>

      {/* Table */}
      <div className="datagrid-table-wrapper">
        <table className="datagrid-table">
          <thead>
            <tr>
              <th className="row-num-header">#</th>
              {result.columns.map((col, i) => {
                const colSort = sortStates.find(s => s.column === i);
                const sortOrder = sortStates.findIndex(s => s.column === i) + 1;
                return (
                  <th key={i} className={`column-header-th ${colSort ? `sorted-${colSort.direction}` : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => selectColumn(i)}
                    title={`${col.name} (${col.type}) — Click to select column, Ctrl+click sort to multi-sort`}>
                    <div className="header-content-wrapper">
                      <span className="col-name">{col.isPrimaryKey && <span className="pk-icon">🔑</span>}{col.name}</span>
                      <button className="sort-action-btn" onClick={(e) => toggleSort(i, e)} title="Sort (hold Ctrl for multi-sort)">
                        {colSort ? (colSort.direction === 'asc' ? '▲' : '▼') : '↕'}
                        {sortStates.length > 1 && colSort && <sup className="sort-order">{sortOrder}</sup>}
                      </button>
                    </div>
                    <span className="col-type">{formatColumnType(col)}</span>
                  </th>
                );
              })}
              <th className="row-actions-header">⋯</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((item, visIdx) => {
              const absIdx = page * pageSize + visIdx;
              const isRowSelected = selectedRows.has(visIdx);
              const rowClass = `row-${item.row.status}${isRowSelected ? ' selected' : ''}${selectedRows.size > 1 && selectedRows.has(visIdx) ? ' multi-selected' : ''}`;
              return (
                <tr key={item.origIdx} className={rowClass}
                  onClick={(e) => handleRowClick(visIdx, e)}
                  onContextMenu={(e) => handleContextMenu(e, visIdx)}>
                  <td className="row-num" onClick={(e) => { e.stopPropagation(); selectRowAllColumns(visIdx, e); }}>
                    {item.row.status === 'added' ? '✦' : absIdx + 1}
                  </td>
                  {item.row.data.map((cell, ci) => {
                    const isEditing = editingCell?.row === visIdx && editingCell?.col === ci;
                    const isChanged = item.row.changedCols.has(ci);
                    const isInSelection = isCellInRange(visIdx, ci);
                    const isFocused = selectedRow === visIdx && selectedCol === ci;
                    const cellClass = `cell${isFocused ? ' cell-selected' : ''}${isInSelection ? ' cell-selected-range' : ''}${cell === null ? ' cell-null' : ''}${isChanged ? ' cell-changed' : ''}${isEditing ? ' cell-editing' : ''} cell-type-${result.columns[ci]?.normalizedType || 'unknown'}`;
                    return (
                      <td key={ci} className={cellClass}
                        onMouseDown={(e) => { if (!e.shiftKey) { setSelectedCol(ci); } handleCellMouseDown(visIdx, ci, e); }}
                        onMouseEnter={() => handleCellMouseEnter(visIdx, ci)}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={() => startEdit(visIdx, ci)}
                        title={cell === null ? 'NULL' : String(cell)}>
                        {isEditing ? (
                          <input ref={editInputRef} className="cell-editor" value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={e => {
                              if (e.key === 'Escape') cancelEdit();
                              else if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                            }} />
                        ) : renderCell(cell, result.columns[ci])}
                      </td>
                    );
                  })}
                  <td className="row-actions">
                    <button className="row-action-btn" onClick={e => { e.stopPropagation(); handleQuickView(visIdx); }} title="Quick View">👁</button>
                    <button className="row-action-btn" onClick={e => { e.stopPropagation(); duplicateRow(visIdx); }} title="Duplicate">⧉</button>
                    <button className="row-action-btn row-action-delete" onClick={e => { e.stopPropagation(); deleteRow(visIdx); }} title="Delete">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={e => e.stopPropagation()}>
          <div className="context-menu-item" onClick={() => { copyRowAs('csv', contextMenu.visIdx); setContextMenu(null); }}>📋 Copy as CSV (with header)</div>
          <div className="context-menu-item" onClick={() => { copyRowAs('csv-noheader', contextMenu.visIdx); setContextMenu(null); }}>📋 Copy as CSV (no header)</div>
          <div className="context-menu-item" onClick={() => { copyRowAs('tsv', contextMenu.visIdx); setContextMenu(null); }}>📋 Copy as TSV (with header)</div>
          <div className="context-menu-item" onClick={() => { copyRowAs('tsv-noheader', contextMenu.visIdx); setContextMenu(null); }}>📋 Copy as TSV (no header)</div>
          <div className="context-menu-item" onClick={() => { copyRowAs('json', contextMenu.visIdx); setContextMenu(null); }}>📋 Copy as JSON</div>
          <div className="context-menu-item" onClick={() => { copyRowAs('xml', contextMenu.visIdx); setContextMenu(null); }}>📋 Copy as XML</div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { copyRowAs('insert', contextMenu.visIdx); setContextMenu(null); }}>📋 Copy as SQL INSERT</div>
          <div className="context-menu-item" onClick={() => { copyRowAs('update', contextMenu.visIdx); setContextMenu(null); }}>📋 Copy as SQL UPDATE</div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { handleQuickView(contextMenu.visIdx); setContextMenu(null); }}>👁 Quick View</div>
          <div className="context-menu-item" onClick={() => { duplicateRow(contextMenu.visIdx); setContextMenu(null); }}>⧉ Duplicate Row</div>
          <div className="context-menu-item context-menu-danger" onClick={() => { deleteRow(contextMenu.visIdx); setContextMenu(null); }}>✕ Delete Row</div>
        </div>
      )}

      {/* Pagination */}
      {(page > 0 || hasMore || pageRows.length === pageSize || tableName) && (
        <div className="datagrid-pagination">
          <button className="page-btn" disabled={page === 0} onClick={() => handlePageChange(0)}>⟨⟨</button>
          <button className="page-btn" disabled={page === 0} onClick={() => handlePageChange(page - 1)}>⟨</button>
          <span className="page-info">
            Page {page + 1}{totalRows !== null ? ` / ${Math.max(1, Math.ceil(totalRows / pageSize))}` : (tableName ? '' : ` / ${totalPages}`)}
            {totalRows !== null
              ? ` (${totalRows.toLocaleString()} rows)`
              : tableName
                ? <> (<span style={{ cursor: 'pointer', textDecoration: 'underline dotted', color: 'var(--vscode-textLink-foreground)' }} onClick={handleCountRows} title="Click to count all records">count?</span>)</>  
                : ` (${visibleRowsCount.toLocaleString()} rows)`}
          </span>
          <button className="page-btn"
            disabled={tableName ? !hasMore : (page + 1) * pageSize >= visibleRowsCount}
            onClick={() => handlePageChange(page + 1)}>⟩</button>
        </div>
      )}
      <button className={`datagrid-log-strip ${latestLog?.level || 'info'}`} onClick={() => setShowLogDrawer(v => !v)} title="Toggle logs">
        <span className="log-toggle">{showLogDrawer ? '▾' : '▸'}</span>
        <span className="log-time">{latestLog?.time || '--:--:--'}</span>
        <span className="log-message">{latestLog?.message || 'No logs yet'}</span>
      </button>
      {showLogDrawer && (
        <div className="datagrid-log-drawer">
          {logEntries.length === 0 ? (
            <div className="log-empty">No logs yet</div>
          ) : logEntries.map(entry => (
            <div key={entry.id} className={`log-entry ${entry.level}`}>
              <span className="log-time">{entry.time}</span>
              <span className="log-level">{entry.level}</span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
      {copyStatus && <div className={`datagrid-toast ${copyStatus.kind}`}>{copyStatus.text}</div>}
    </div>
  );
}

function renderCell(value: unknown, col?: ColumnHeader): React.ReactNode {
  if (value === null || value === undefined) return <span className="null-value">NULL</span>;
  if (typeof value === 'boolean') return <span className="bool-value">{value ? '✓' : '✗'}</span>;
  // Handle objects that weren't serialized yet (fallback)
  if (typeof value === 'object') {
    try { const s = JSON.stringify(value); return <span className="json-value" title={s}>{s.length > 120 ? s.substring(0, 120) + '…' : s}</span>; } catch { return <span>[object]</span>; }
  }
  const str = String(value);
  // Detect JSON strings (objects and arrays)
  const isJsonCol = col?.normalizedType === 'json';
  const looksLikeJson = (str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'));
  if (isJsonCol || looksLikeJson) {
    try {
      JSON.parse(str);
      const display = str.length > 120 ? str.substring(0, 120) + '…' : str;
      return <span className="json-value" title={str}>{display}</span>;
    } catch {}
  }
  return str.length > 200 ? <span title={str}>{str.substring(0, 200)}…</span> : str;
}
