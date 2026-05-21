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
  if (col.maxLength && col.maxLength > 0 && col.maxLength < 65535) return `${base}(${col.maxLength})`;
  if (col.precision && col.scale !== undefined && col.scale !== null) return `${base}(${col.precision},${col.scale})`;
  if (col.precision && col.precision > 0) return `${base}(${col.precision})`;
  return base;
}

export default function QuickView() {
  const [columns, setColumns] = useState<ColumnHeader[]>([]);
  const [rowData, setRowData] = useState<unknown[]>([]);
  const [filterText, setFilterText] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

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

  const handleCopy = (value: unknown, index: number) => {
    const text = value === null ? 'NULL' : String(value);
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  const handleCopyAll = (format: 'json' | 'csv' | 'tsv') => {
    const cols = columns;
    if (format === 'json') {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => { obj[col.name] = rowData[i]; });
      navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
    } else if (format === 'csv') {
      const header = cols.map(c => c.name).join(',');
      const vals = rowData.map(v => {
        if (v === null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',');
      navigator.clipboard.writeText(`${header}\n${vals}`);
    } else if (format === 'tsv') {
      navigator.clipboard.writeText(rowData.map(v => v === null ? 'NULL' : String(v)).join('\t'));
    }
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
                      <span className="val-text" title={String(val)}>{String(val)}</span>
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
    </div>
  );
}
