import React, { useState, useEffect } from 'react';
import { postMessage, onMessage } from '../../hooks/useVsCode';
import './QuickView.css';

interface ColumnHeader {
  name: string;
  type: string;
  normalizedType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  rawType?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

function formatColumnType(col: ColumnHeader): string {
  const base = (col.rawType || col.type || '').toLowerCase();
  if (base.includes('(')) return base;
  if (col.maxLength && col.maxLength > 0 && col.maxLength < 65535) return `${base}(${col.maxLength})`;
  if (col.precision && col.scale !== undefined && col.scale !== null) return `${base}(${col.precision},${col.scale})`;
  if (col.precision && col.precision > 0) return `${base}(${col.precision})`;
  return base;
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  const text = String(value);
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
  }
  return text;
}

export default function QuickView() {
  const [columns, setColumns] = useState<ColumnHeader[]>([]);
  const [rowData, setRowData] = useState<unknown[]>([]);
  const [filterText, setFilterText] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [expandedField, setExpandedField] = useState<{ name: string; type: string; value: string } | null>(null);

  useEffect(() => {
    postMessage({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg.type === 'quickViewData') {
        setColumns(msg.data.columns || []);
        setRowData(msg.data.rowData || []);
      } else if (msg.type === 'rowSelected') {
        // Real-time update when user selects a different row
        setColumns(msg.data.columns || []);
        setRowData(msg.data.rowData || []);
      }
    });
    return unsub;
  }, []);

  const showToast = (kind: 'success' | 'error', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 1800);
  };

  const writeClipboard = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('success', successText);
      return true;
    } catch (err) {
      showToast('error', `Copy failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const handleCopy = async (value: unknown, index: number) => {
    const copied = await writeClipboard(valueToText(value), 'Copied value');
    if (copied) {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    }
  };

  const handleCopyAll = async (format: 'json' | 'csv' | 'tsv') => {
    const cols = columns;
    let text = '';
    if (format === 'json') {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => { obj[col.name] = rowData[i]; });
      text = JSON.stringify(obj, null, 2);
    } else if (format === 'csv') {
      const header = cols.map(c => c.name).join(',');
      const vals = rowData.map(v => {
        if (v === null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',');
      text = `${header}\n${vals}`;
    } else if (format === 'tsv') {
      text = rowData.map(v => v === null ? 'NULL' : String(v)).join('\t');
    }
    await writeClipboard(text, `Copied ${format.toUpperCase()}`);
  };

  const filteredFields = columns
    .map((col, idx) => ({ col, val: rowData[idx], idx }))
    .filter(item => item.col.name.toLowerCase().includes(filterText.toLowerCase()));

  return (
    <div className="quickview-panel">
      <div className="quickview-header">
        <h2>Quick View</h2>
        <div className="quickview-copy-btns">
          <button className="qv-copy-btn" onClick={() => handleCopyAll('json')} title="Copy all as JSON">JSON</button>
          <button className="qv-copy-btn" onClick={() => handleCopyAll('csv')} title="Copy all as CSV">CSV</button>
          <button className="qv-copy-btn" onClick={() => handleCopyAll('tsv')} title="Copy all as TSV">TSV</button>
        </div>
      </div>
      <div className="quickview-search">
        <input
          type="text"
          placeholder="🔍 Filter fields..."
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
        />
      </div>
      <div className="quickview-content">
        {filteredFields.length === 0 ? (
          <div className="quickview-empty">No matching fields</div>
        ) : (
          <table className="quickview-table">
            <thead>
              <tr>
                <th className="col-header">Column</th>
                <th className="type-header">Type</th>
                <th className="val-header">Value</th>
                <th className="copy-header"></th>
              </tr>
            </thead>
            <tbody>
              {filteredFields.map(({ col, val, idx }) => (
                <tr key={idx} className={col.isPrimaryKey ? 'pk-row' : ''}>
                  <td className="col-cell">
                    {col.isPrimaryKey && <span className="pk-badge">🔑</span>}
                    <span className="col-name">{col.name}</span>
                  </td>
                  <td className="type-cell">
                    <span className="col-type-badge">{formatColumnType(col)}</span>
                  </td>
                  <td className="val-cell">
                    {val === null ? (
                      <span className="val-null">NULL</span>
                    ) : (
                      <button
                        className="val-text"
                        onClick={() => setExpandedField({ name: col.name, type: formatColumnType(col), value: valueToText(val) })}
                        title="Click to view full value"
                      >
                        {valueToText(val)}
                      </button>
                    )}
                  </td>
                  <td className="copy-cell">
                    <button
                      className={`copy-btn ${copiedIndex === idx ? 'copied' : ''}`}
                      onClick={() => handleCopy(val, idx)}
                      title="Copy value"
                    >
                      {copiedIndex === idx ? '✓' : '📋'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {toast && <div className={`quickview-toast ${toast.kind}`}>{toast.text}</div>}
      {expandedField && (
        <div className="quickview-modal-backdrop" onClick={() => setExpandedField(null)}>
          <div className="quickview-modal" onClick={e => e.stopPropagation()}>
            <div className="quickview-modal-header">
              <div>
                <strong>{expandedField.name}</strong>
                <span>{expandedField.type}</span>
              </div>
              <button onClick={() => setExpandedField(null)} title="Close">x</button>
            </div>
            <pre className="quickview-modal-content">{expandedField.value}</pre>
            <div className="quickview-modal-actions">
              <button onClick={() => writeClipboard(expandedField.value, 'Copied full value')}>Copy</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
