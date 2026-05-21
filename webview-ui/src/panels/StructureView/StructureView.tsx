import React, { useState, useEffect, useCallback } from 'react';
import { postMessage, onMessage } from '../../hooks/useVsCode';
import './StructureView.css';

interface ColumnInfo {
  name: string;
  type: string;
  normalizedType: string;
  nullable: boolean;
  defaultValue: unknown;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  comment?: string;
}

interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
  comment?: string;
}

interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedSchema?: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
}

interface StructureData {
  tableName: string;
  schemaName?: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  ddl: string;
}

type TabType = 'columns' | 'indexes' | 'foreignKeys' | 'ddl';

export default function StructureView() {
  const [data, setData] = useState<StructureData | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('columns');
  
  // Visual Alter builder state
  const [editingColumn, setEditingColumn] = useState<number | null>(null);
  const [colName, setColName] = useState('');
  const [colType, setColType] = useState('VARCHAR(255)');
  const [colNullable, setColNullable] = useState(true);
  const [colDefault, setColDefault] = useState('');
  const [generatedSQL, setGeneratedSQL] = useState('');

  // Add Index / Add FK forms
  const [newIdxName, setNewIdxName] = useState('');
  const [newIdxCols, setNewIdxCols] = useState<string[]>([]);
  const [newIdxUnique, setNewIdxUnique] = useState(false);
  const [newIdxType, setNewIdxType] = useState('BTREE');

  useEffect(() => {
    postMessage({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg.type === 'structureData') {
        setData(msg.data);
        setGeneratedSQL('');
        setEditingColumn(null);
      } else if (msg.type === 'reloadStructure') {
        postMessage({ type: 'ready' });
      }
    });
    return unsub;
  }, []);

  const handleApplySQL = useCallback(() => {
    if (!generatedSQL.trim()) return;
    postMessage({ type: 'executeDDL', data: { sql: generatedSQL } });
  }, [generatedSQL]);

  // Helper to escape identifiers
  const escapeId = (name: string) => `"${name.replace(/"/g, '""')}"`;

  const getEscapedTable = () => {
    if (!data) return '';
    return data.schemaName ? `${escapeId(data.schemaName)}.${escapeId(data.tableName)}` : escapeId(data.tableName);
  };

  // Column Actions
  const handleAddColumn = () => {
    if (!data) return;
    const name = `new_column_${data.columns.length + 1}`;
    const sql = `ALTER TABLE ${getEscapedTable()} ADD COLUMN ${escapeId(name)} VARCHAR(255) NULL;`;
    setGeneratedSQL(sql);
    setEditingColumn(-1);
    setColName(name);
    setColType('VARCHAR(255)');
    setColNullable(true);
    setColDefault('');
  };

  const handleEditColumn = (idx: number) => {
    const col = data?.columns[idx];
    if (!col) return;
    setEditingColumn(idx);
    setColName(col.name);
    setColType(col.type);
    setColNullable(col.nullable);
    setColDefault(col.defaultValue === null || col.defaultValue === undefined ? '' : String(col.defaultValue));
    setGeneratedSQL('-- Edit column details below and click "Generate"');
  };

  const generateColumnAlter = () => {
    if (!data || editingColumn === null) return;
    const isNew = editingColumn === -1;
    let sql = '';
    
    if (isNew) {
      sql = `ALTER TABLE ${getEscapedTable()} ADD COLUMN ${escapeId(colName)} ${colType}${colNullable ? ' NULL' : ' NOT NULL'}${colDefault ? ` DEFAULT ${colDefault}` : ''};`;
    } else {
      const origCol = data.columns[editingColumn];
      // Note: ALTER COLUMN syntax varies. We generate standard SQL that users can customize in the text box.
      sql = `-- Update column ${origCol.name}\n`;
      if (origCol.name !== colName) {
        sql += `ALTER TABLE ${getEscapedTable()} RENAME COLUMN ${escapeId(origCol.name)} TO ${escapeId(colName)};\n`;
      }
      sql += `ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(colName)} TYPE ${colType};\n`;
      sql += `ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(colName)} ${colNullable ? 'DROP NOT NULL' : 'SET NOT NULL'};\n`;
      if (colDefault) {
        sql += `ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(colName)} SET DEFAULT ${colDefault};\n`;
      } else {
        sql += `ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(colName)} DROP DEFAULT;\n`;
      }
    }
    setGeneratedSQL(sql);
  };

  const handleDropColumn = (name: string) => {
    const sql = `ALTER TABLE ${getEscapedTable()} DROP COLUMN ${escapeId(name)};`;
    setGeneratedSQL(sql);
  };

  // Index Actions
  const handleAddIndex = () => {
    if (!data || !newIdxName || newIdxCols.length === 0) return;
    const typePart = newIdxType && newIdxType !== 'BTREE' ? ` USING ${newIdxType}` : '';
    const sql = `CREATE ${newIdxUnique ? 'UNIQUE ' : ''}INDEX ${escapeId(newIdxName)} ON ${getEscapedTable()}${typePart} (${newIdxCols.map(escapeId).join(', ')});`;
    setGeneratedSQL(sql);
  };

  const handleDropIndex = (idxName: string) => {
    // Standard SQL (supports PostgreSQL/SQLite). MySQL uses: DROP INDEX name ON table
    const sql = `DROP INDEX ${escapeId(idxName)};`;
    setGeneratedSQL(sql);
  };

  if (!data) {
    return (
      <div className="structure-loading">
        <div className="spinner"></div>
        <h3>Loading structure...</h3>
      </div>
    );
  }

  return (
    <div className="structure-view">
      {/* Header */}
      <header className="structure-header">
        <div className="title-area">
          <span className="icon">🔧</span>
          <div className="info">
            <h2>{data.tableName}</h2>
            <span className="sub-info">
              {data.schemaName ? `Schema: ${data.schemaName}` : 'Default Schema'}
            </span>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <nav className="structure-tabs">
        <button className={activeTab === 'columns' ? 'active' : ''} onClick={() => setActiveTab('columns')}>Columns ({data.columns.length})</button>
        <button className={activeTab === 'indexes' ? 'active' : ''} onClick={() => setActiveTab('indexes')}>Indexes ({data.indexes.length})</button>
        <button className={activeTab === 'foreignKeys' ? 'active' : ''} onClick={() => setActiveTab('foreignKeys')}>Foreign Keys ({data.foreignKeys.length})</button>
        <button className={activeTab === 'ddl' ? 'active' : ''} onClick={() => setActiveTab('ddl')}>DDL</button>
      </nav>

      {/* Tab Contents */}
      <div className="structure-content">
        {activeTab === 'columns' && (
          <div className="columns-tab">
            <div className="table-wrapper">
              <table className="structure-table">
                <thead>
                  <tr>
                    <th>PK</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Nullable</th>
                    <th>Default</th>
                    <th>Comment</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.columns.map((col, idx) => (
                    <tr key={idx} className={col.isPrimaryKey ? 'pk-row' : ''}>
                      <td>{col.isPrimaryKey ? '🔑' : ''}</td>
                      <td className="bold">{col.name}</td>
                      <td className="type-badge">{col.type}</td>
                      <td>{col.nullable ? '✓' : '✗'}</td>
                      <td>{col.defaultValue === null || col.defaultValue === undefined ? <span className="null-text">NULL</span> : String(col.defaultValue)}</td>
                      <td className="comment-cell">{col.comment || ''}</td>
                      <td>
                        <button className="btn-icon" onClick={() => handleEditColumn(idx)} title="Edit column">✏️</button>
                        <button className="btn-icon btn-danger" onClick={() => handleDropColumn(col.name)} title="Drop column">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn-primary add-col-btn" onClick={handleAddColumn}>＋ Add Column</button>
          </div>
        )}

        {activeTab === 'indexes' && (
          <div className="indexes-tab">
            <div className="table-wrapper">
              <table className="structure-table">
                <thead>
                  <tr>
                    <th>Index Name</th>
                    <th>Columns</th>
                    <th>Unique</th>
                    <th>Type</th>
                    <th>Comment</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.indexes.map((idx, index) => (
                    <tr key={index}>
                      <td className="bold">{idx.name}</td>
                      <td>{idx.columns.join(', ')}</td>
                      <td>{idx.unique ? '✓' : '✗'}</td>
                      <td><span className="type-badge">{idx.type}</span></td>
                      <td>{idx.comment || ''}</td>
                      <td>
                        <button className="btn-icon btn-danger" onClick={() => handleDropIndex(idx.name)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Visual Add Index Form */}
            <div className="visual-form">
              <h3>＋ Add Index</h3>
              <div className="form-row">
                <input type="text" placeholder="Index name" value={newIdxName} onChange={e => setNewIdxName(e.target.value)} />
                <select value={newIdxType} onChange={e => setNewIdxType(e.target.value)}>
                  <option value="BTREE">BTREE</option>
                  <option value="HASH">HASH</option>
                  <option value="GIN">GIN</option>
                  <option value="GIST">GIST</option>
                </select>
                <label className="checkbox-label">
                  <input type="checkbox" checked={newIdxUnique} onChange={e => setNewIdxUnique(e.target.checked)} />
                  Unique
                </label>
              </div>
              <div className="form-columns-list">
                <h4>Index Columns:</h4>
                {data.columns.map(c => (
                  <label key={c.name} className="checkbox-label">
                    <input type="checkbox" checked={newIdxCols.includes(c.name)}
                      onChange={e => {
                        if (e.target.checked) setNewIdxCols(prev => [...prev, c.name]);
                        else setNewIdxCols(prev => prev.filter(x => x !== c.name));
                      }} />
                    {c.name}
                  </label>
                ))}
              </div>
              <button className="btn-primary" onClick={handleAddIndex} disabled={!newIdxName || newIdxCols.length === 0}>Generate CREATE INDEX DDL</button>
            </div>
          </div>
        )}

        {activeTab === 'foreignKeys' && (
          <div className="fks-tab">
            <div className="table-wrapper">
              <table className="structure-table">
                <thead>
                  <tr>
                    <th>Constraint Name</th>
                    <th>Columns</th>
                    <th>Referenced Table</th>
                    <th>Referenced Columns</th>
                    <th>On Update</th>
                    <th>On Delete</th>
                  </tr>
                </thead>
                <tbody>
                  {data.foreignKeys.map((fk, idx) => (
                    <tr key={idx}>
                      <td className="bold">{fk.name}</td>
                      <td>{fk.columns.join(', ')}</td>
                      <td>{fk.referencedSchema ? `${fk.referencedSchema}.${fk.referencedTable}` : fk.referencedTable}</td>
                      <td>{fk.referencedColumns.join(', ')}</td>
                      <td><span className="type-badge">{fk.onUpdate}</span></td>
                      <td><span className="type-badge">{fk.onDelete}</span></td>
                    </tr>
                  ))}
                  {data.foreignKeys.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', opacity: 0.5, padding: 20 }}>No foreign keys defined.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'ddl' && (
          <div className="ddl-tab">
            <div className="ddl-header">
              <h3>CREATE TABLE DDL</h3>
              <button className="btn-secondary" onClick={() => { navigator.clipboard.writeText(data.ddl); alert('DDL Copied!'); }}>📋 Copy DDL</button>
            </div>
            <pre className="ddl-code">
              <code>{data.ddl}</code>
            </pre>
          </div>
        )}
      </div>

      {/* Visual Alter Panel Editor */}
      {editingColumn !== null && (
        <div className="alter-overlay">
          <div className="alter-modal">
            <h3>{editingColumn === -1 ? 'Add Column' : 'Edit Column'}</h3>
            <div className="form-group">
              <label>Name</label>
              <input type="text" value={colName} onChange={e => setColName(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Data Type</label>
              <input type="text" value={colType} onChange={e => setColType(e.target.value)} />
            </div>
            <div className="form-group-row">
              <label className="checkbox-label">
                <input type="checkbox" checked={colNullable} onChange={e => setColNullable(e.target.checked)} />
                Nullable
              </label>
            </div>
            <div className="form-group">
              <label>Default Value</label>
              <input type="text" value={colDefault} onChange={e => setColDefault(e.target.value)} placeholder="e.g. NULL, 'hello', 42" />
            </div>
            <div className="actions">
              <button className="btn-secondary" onClick={() => setEditingColumn(null)}>Cancel</button>
              <button className="btn-primary" onClick={generateColumnAlter}>Generate Alter SQL</button>
            </div>
          </div>
        </div>
      )}

      {/* Generated SQL preview and executor */}
      {generatedSQL && (
        <div className="sql-preview-panel">
          <div className="preview-header">
            <h4>Generated ALTER TABLE DDL Preview</h4>
            <button className="close-btn" onClick={() => setGeneratedSQL('')}>✕</button>
          </div>
          <p className="description">Review the generated statements. You can edit them before applying.</p>
          <textarea className="sql-textarea" value={generatedSQL} onChange={e => setGeneratedSQL(e.target.value)} rows={6} />
          <div className="preview-actions">
            <button className="btn-secondary" onClick={() => setGeneratedSQL('')}>Discard</button>
            <button className="btn-primary btn-save" onClick={handleApplySQL}>🚀 Execute ALTER SQL</button>
          </div>
        </div>
      )}
    </div>
  );
}
