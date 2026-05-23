import React, { useState, useEffect, useCallback } from 'react';
import { postMessage, onMessage } from '../../hooks/useVsCode';
import './StructureView.css';

interface DataTypeAutocompleteProps {
  value: string;
  onChange: (val: string) => void;
  driverType: string;
}

const COMMON_TYPES: Record<string, string[]> = {
  mysql: [
    'INT', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'DECIMAL(10,2)', 'FLOAT', 'DOUBLE',
    'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'JSON', 'BLOB', 'CHAR(36)', 'BINARY', 'VARBINARY'
  ],
  postgresql: [
    'integer', 'bigint', 'character varying(255)', 'text', 'boolean', 'smallint', 'numeric(10,2)', 'real', 'double precision',
    'date', 'time without time zone', 'timestamp without time zone', 'jsonb', 'bytea', 'uuid', 'json', 'interval'
  ],
  sqlite: [
    'INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'INT', 'VARCHAR(255)', 'DATETIME', 'BOOLEAN'
  ]
};

function DataTypeAutocomplete({ value, onChange, driverType }: DataTypeAutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const types = COMMON_TYPES[driverType] || COMMON_TYPES.mysql;
  const filteredTypes = types.filter(t => t.toLowerCase().includes(value.toLowerCase()));

  return (
    <div className="autocomplete-container">
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 200)}
        placeholder="e.g. VARCHAR(255)"
      />
      {isOpen && filteredTypes.length > 0 && (
        <ul className="autocomplete-suggestions">
          {filteredTypes.map(t => (
            <li key={t} onMouseDown={() => onChange(t)}>
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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

interface TableInfo {
  name: string;
  schema?: string;
  type: string;
}

interface StructureData {
  tableName: string;
  schemaName?: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  ddl: string;
}

type TabType = 'columns' | 'indexes' | 'foreignKeys' | 'options' | 'ddl';

const MYSQL_CHARSETS = [
  { label: 'DEFAULT', collations: [] },
  { label: 'utf8mb4', collations: ['utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci', 'utf8mb4_general_ci'] },
  { label: 'utf8', collations: ['utf8_general_ci', 'utf8_unicode_ci'] },
  { label: 'latin1', collations: ['latin1_swedish_ci', 'latin1_general_ci'] },
];

function sanitizeIdentifierPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

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

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [editingFk, setEditingFk] = useState<number | null>(null);
  const [fkName, setFkName] = useState('');
  const [fkColumns, setFkColumns] = useState<string[]>([]);
  const [fkRefTable, setFkRefTable] = useState('');
  const [fkRefColumns, setFkRefColumns] = useState('');
  const [fkOnUpdate, setFkOnUpdate] = useState('NO ACTION');
  const [fkOnDelete, setFkOnDelete] = useState('NO ACTION');

  const [driverType, setDriverType] = useState<string>('mysql');
  const [renaming, setRenaming] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [tableCharset, setTableCharset] = useState('DEFAULT');
  const [tableCollation, setTableCollation] = useState('');

  useEffect(() => {
    postMessage({ type: 'ready' });
    postMessage({ type: 'getDriverType' });
    postMessage({ type: 'getTableList' });
    const unsub = onMessage((msg: any) => {
      if (msg.type === 'structureData') {
        setData(msg.data);
        setGeneratedSQL('');
        setEditingColumn(null);
      } else if (msg.type === 'reloadStructure') {
        postMessage({ type: 'ready' });
      } else if (msg.type === 'driverType') {
        setDriverType(msg.data.type);
      } else if (msg.type === 'tableList') {
        setTables(msg.data.tables || []);
      }
    });
    return unsub;
  }, []);

  const handleApplySQL = useCallback(() => {
    if (!generatedSQL.trim()) return;
    postMessage({ type: 'executeDDL', data: { sql: generatedSQL, renameTo } });
    setRenameTo(null);
  }, [generatedSQL, renameTo]);

  const appendGeneratedSQL = useCallback((sql: string) => {
    const next = sql.trim();
    if (!next) return;
    setGeneratedSQL(prev => {
      const current = prev.trim();
      if (!current || current.startsWith('-- Edit column details')) {
        return next;
      }
      return `${current}\n\n${next}`;
    });
  }, []);

  // Helper to escape identifiers
  const escapeId = (name: string) => {
    if (driverType === 'mysql') {
      return `\`${name.replace(/`/g, '``')}\``;
    }
    return `"${name.replace(/"/g, '""')}"`;
  };

  const getEscapedTable = () => {
    if (!data) return '';
    return data.schemaName ? `${escapeId(data.schemaName)}.${escapeId(data.tableName)}` : escapeId(data.tableName);
  };

  // Column Actions
  const handleAddColumn = () => {
    if (!data) return;
    const name = `new_column_${data.columns.length + 1}`;
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
  };

  const generateColumnAlter = () => {
    if (!data || editingColumn === null) return;
    const isNew = editingColumn === -1;
    const statements: string[] = [];
    
    if (isNew) {
      statements.push(`ALTER TABLE ${getEscapedTable()} ADD COLUMN ${escapeId(colName)} ${colType}${colNullable ? ' NULL' : ' NOT NULL'}${colDefault ? ` DEFAULT ${colDefault}` : ''};`);
    } else {
      const origCol = data.columns[editingColumn];
      const effectiveName = colName || origCol.name;
      const origDefault = origCol.defaultValue === null || origCol.defaultValue === undefined ? '' : String(origCol.defaultValue);
      const nameChanged = origCol.name !== effectiveName;
      const typeChanged = origCol.type !== colType;
      const nullabilityChanged = origCol.nullable !== colNullable;
      const defaultChanged = origDefault !== colDefault;

      if (nameChanged) {
        if (driverType === 'mysql') {
          const columnDefinition = `${escapeId(effectiveName)} ${colType}${colNullable ? ' NULL' : ' NOT NULL'}${colDefault ? ` DEFAULT ${colDefault}` : ''}`;
          statements.push(`ALTER TABLE ${getEscapedTable()} CHANGE COLUMN ${escapeId(origCol.name)} ${columnDefinition};`);
        } else {
          statements.push(`ALTER TABLE ${getEscapedTable()} RENAME COLUMN ${escapeId(origCol.name)} TO ${escapeId(effectiveName)};`);
        }
      }

      if (driverType === 'mysql') {
        if (!nameChanged && (typeChanged || nullabilityChanged)) {
          const defaultSql = colDefault ? ` DEFAULT ${colDefault}` : (origDefault ? ` DEFAULT ${origDefault}` : '');
          statements.push(`ALTER TABLE ${getEscapedTable()} MODIFY COLUMN ${escapeId(effectiveName)} ${colType}${colNullable ? ' NULL' : ' NOT NULL'}${defaultSql};`);
        }
        if (!nameChanged && !typeChanged && !nullabilityChanged && defaultChanged) {
          statements.push(colDefault
            ? `ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(effectiveName)} SET DEFAULT ${colDefault};`
            : `ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(effectiveName)} DROP DEFAULT;`
          );
        }
      } else if (driverType === 'sqlite') {
        if (typeChanged || nullabilityChanged || defaultChanged) {
          statements.push(`-- SQLite cannot directly alter column definition for ${escapeId(effectiveName)}. Rebuild the table to apply type/null/default changes.`);
        }
      } else {
        if (typeChanged) {
          statements.push(`ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(effectiveName)} TYPE ${colType};`);
        }
        if (nullabilityChanged) {
          statements.push(`ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(effectiveName)} ${colNullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
        }
        if (defaultChanged) {
          statements.push(colDefault
            ? `ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(effectiveName)} SET DEFAULT ${colDefault};`
            : `ALTER TABLE ${getEscapedTable()} ALTER COLUMN ${escapeId(effectiveName)} DROP DEFAULT;`
          );
        }
      }
    }

    appendGeneratedSQL(statements.join('\n'));
  };

  const handleDropColumn = (name: string) => {
    const sql = `ALTER TABLE ${getEscapedTable()} DROP COLUMN ${escapeId(name)};`;
    appendGeneratedSQL(sql);
  };

  // Index Actions
  const handleAddIndex = () => {
    if (!data || !newIdxName || newIdxCols.length === 0) return;
    const typePart = newIdxType && newIdxType !== 'BTREE' ? ` USING ${newIdxType}` : '';
    const sql = `CREATE ${newIdxUnique ? 'UNIQUE ' : ''}INDEX ${escapeId(newIdxName)} ON ${getEscapedTable()}${typePart} (${newIdxCols.map(escapeId).join(', ')});`;
    appendGeneratedSQL(sql);
  };

  const handleDropIndex = (idxName: string) => {
    // Standard SQL (supports PostgreSQL/SQLite). MySQL uses: DROP INDEX name ON table
    const sql = driverType === 'mysql'
      ? `DROP INDEX ${escapeId(idxName)} ON ${getEscapedTable()};`
      : `DROP INDEX ${escapeId(idxName)};`;
    appendGeneratedSQL(sql);
  };

  const resetFkForm = () => {
    setEditingFk(null);
    setFkName('');
    setFkColumns([]);
    setFkRefTable('');
    setFkRefColumns('');
    setFkOnUpdate('NO ACTION');
    setFkOnDelete('NO ACTION');
  };

  const handleAddFk = () => {
    resetFkForm();
    setEditingFk(-1);
  };

  const handleEditFk = (idx: number) => {
    const fk = data?.foreignKeys[idx];
    if (!fk) return;
    setEditingFk(idx);
    setFkName(fk.name);
    setFkColumns(fk.columns);
    setFkRefTable(fk.referencedSchema ? `${fk.referencedSchema}.${fk.referencedTable}` : fk.referencedTable);
    setFkRefColumns(fk.referencedColumns.join(', '));
    setFkOnUpdate(fk.onUpdate || 'NO ACTION');
    setFkOnDelete(fk.onDelete || 'NO ACTION');
  };

  const generateDropFkSQL = (fk: ForeignKeyInfo) => {
    if (driverType === 'mysql') {
      return `ALTER TABLE ${getEscapedTable()} DROP FOREIGN KEY ${escapeId(fk.name)};`;
    }
    return `ALTER TABLE ${getEscapedTable()} DROP CONSTRAINT ${escapeId(fk.name)};`;
  };

  const generateForeignKeyName = () => {
    if (!data) return 'fk_table_col_ref_id';
    const localTable = sanitizeIdentifierPart(data.tableName || 'table') || 'table';
    const localCols = fkColumns.map(sanitizeIdentifierPart).filter(Boolean).join('_') || 'col';
    const refTable = sanitizeIdentifierPart(fkRefTable.split('.').pop() || 'ref') || 'ref';
    const refCols = fkRefColumns.split(',').map(sanitizeIdentifierPart).filter(Boolean).join('_') || 'id';
    return `fk_${localTable}_${localCols}_${refTable}_${refCols}`.slice(0, 64);
  };

  const generateFkAlter = () => {
    if (!data || editingFk === null || fkColumns.length === 0 || !fkRefTable || !fkRefColumns.trim()) return;
    const constraintName = fkName.trim() || generateForeignKeyName();
    const refParts = fkRefTable.split('.').map(part => part.trim()).filter(Boolean);
    const refIdentifier = refParts.length === 2
      ? `${escapeId(refParts[0])}.${escapeId(refParts[1])}`
      : escapeId(refParts[0] || fkRefTable);
    const refCols = fkRefColumns.split(',').map(col => col.trim()).filter(Boolean);
    const addSql = `ALTER TABLE ${getEscapedTable()} ADD CONSTRAINT ${escapeId(constraintName)} FOREIGN KEY (${fkColumns.map(escapeId).join(', ')}) REFERENCES ${refIdentifier} (${refCols.map(escapeId).join(', ')}) ON UPDATE ${fkOnUpdate} ON DELETE ${fkOnDelete};`;

    if (editingFk >= 0 && data.foreignKeys[editingFk]) {
      appendGeneratedSQL(`${generateDropFkSQL(data.foreignKeys[editingFk])}\n${addSql}`);
    } else {
      appendGeneratedSQL(addSql);
    }
  };

  const generateCharsetAlter = () => {
    if (!data || driverType !== 'mysql' || tableCharset === 'DEFAULT') return;
    const collationSql = tableCollation ? ` COLLATE ${tableCollation}` : '';
    appendGeneratedSQL(`ALTER TABLE ${getEscapedTable()} DEFAULT CHARACTER SET ${tableCharset}${collationSql};`);
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
        <button className="btn-secondary rename-btn" onClick={() => { setNewTableName(data.tableName); setRenaming(true); }}>✏️ Rename Table</button>
      </header>

      {/* Tabs */}
      <nav className="structure-tabs">
        <button className={activeTab === 'columns' ? 'active' : ''} onClick={() => setActiveTab('columns')}>Columns ({data.columns.length})</button>
        <button className={activeTab === 'indexes' ? 'active' : ''} onClick={() => setActiveTab('indexes')}>Indexes ({data.indexes.length})</button>
        <button className={activeTab === 'foreignKeys' ? 'active' : ''} onClick={() => setActiveTab('foreignKeys')}>Foreign Keys ({data.foreignKeys.length})</button>
        <button className={activeTab === 'options' ? 'active' : ''} onClick={() => setActiveTab('options')}>Options</button>
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
                    <th>Actions</th>
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
                      <td>
                        <button className="btn-icon" onClick={() => handleEditFk(idx)} title="Edit foreign key">✏️</button>
                        <button className="btn-icon btn-danger" onClick={() => appendGeneratedSQL(generateDropFkSQL(fk))} title="Drop foreign key">✕</button>
                      </td>
                    </tr>
                  ))}
                  {data.foreignKeys.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', opacity: 0.5, padding: 20 }}>No foreign keys defined.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <button className="btn-primary add-col-btn" onClick={handleAddFk}>＋ Add Foreign Key</button>
          </div>
        )}

        {activeTab === 'options' && (
          <div className="options-tab">
            {driverType === 'mysql' ? (
              <div className="visual-form">
                <h3>Table Charset</h3>
                <div className="form-row">
                  <div className="form-group">
                    <label>Character Set</label>
                    <select value={tableCharset} onChange={e => {
                      setTableCharset(e.target.value);
                      setTableCollation('');
                    }}>
                      {MYSQL_CHARSETS.map(charset => (
                        <option key={charset.label} value={charset.label}>{charset.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Collation</label>
                    <select value={tableCollation} onChange={e => setTableCollation(e.target.value)} disabled={tableCharset === 'DEFAULT'}>
                      <option value="">DEFAULT</option>
                      {(MYSQL_CHARSETS.find(charset => charset.label === tableCharset)?.collations || []).map(collation => (
                        <option key={collation} value={collation}>{collation}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button className="btn-primary" onClick={generateCharsetAlter} disabled={tableCharset === 'DEFAULT'}>Generate Charset SQL</button>
              </div>
            ) : (
              <div className="visual-form">
                <h3>Table Options</h3>
                <p className="description">Changing table charset is only supported for MySQL/MariaDB tables.</p>
              </div>
            )}
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
              <DataTypeAutocomplete value={colType} onChange={setColType} driverType={driverType} />
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

      {/* Foreign Key Editor */}
      {editingFk !== null && (
        <div className="alter-overlay">
          <div className="alter-modal">
            <h3>{editingFk === -1 ? 'Add Foreign Key' : 'Edit Foreign Key'}</h3>
            <div className="form-group">
              <label>Constraint Name</label>
              <input type="text" value={fkName} onChange={e => setFkName(e.target.value)} placeholder="Leave blank to auto-generate" />
            </div>
            <div className="form-columns-list">
              <h4>Local Columns:</h4>
              {data.columns.map(c => (
                <label key={c.name} className="checkbox-label">
                  <input type="checkbox" checked={fkColumns.includes(c.name)}
                    onChange={e => {
                      if (e.target.checked) setFkColumns(prev => [...prev, c.name]);
                      else setFkColumns(prev => prev.filter(x => x !== c.name));
                    }} />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="form-group">
              <label>Referenced Table</label>
              <input list="structure-reference-tables" type="text" value={fkRefTable} onChange={e => setFkRefTable(e.target.value)} placeholder="schema.table or table" />
              <datalist id="structure-reference-tables">
                {tables.filter(t => t.type === 'table').map(t => (
                  <option key={`${t.schema || ''}.${t.name}`} value={t.schema ? `${t.schema}.${t.name}` : t.name} />
                ))}
              </datalist>
            </div>
            <div className="form-group">
              <label>Referenced Columns</label>
              <input type="text" value={fkRefColumns} onChange={e => setFkRefColumns(e.target.value)} placeholder="id, other_id" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>On Update</label>
                <select value={fkOnUpdate} onChange={e => setFkOnUpdate(e.target.value)}>
                  <option value="NO ACTION">NO ACTION</option>
                  <option value="CASCADE">CASCADE</option>
                  <option value="RESTRICT">RESTRICT</option>
                  <option value="SET NULL">SET NULL</option>
                  <option value="SET DEFAULT">SET DEFAULT</option>
                </select>
              </div>
              <div className="form-group">
                <label>On Delete</label>
                <select value={fkOnDelete} onChange={e => setFkOnDelete(e.target.value)}>
                  <option value="NO ACTION">NO ACTION</option>
                  <option value="CASCADE">CASCADE</option>
                  <option value="RESTRICT">RESTRICT</option>
                  <option value="SET NULL">SET NULL</option>
                  <option value="SET DEFAULT">SET DEFAULT</option>
                </select>
              </div>
            </div>
            <div className="actions">
              <button className="btn-secondary" onClick={resetFkForm}>Cancel</button>
              <button className="btn-primary" onClick={generateFkAlter} disabled={fkColumns.length === 0 || !fkRefTable || !fkRefColumns.trim()}>Generate Foreign Key SQL</button>
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

      {/* Rename Table Modal */}
      {renaming && (
        <div className="alter-overlay">
          <div className="alter-modal">
            <h3>Rename Table</h3>
            <div className="form-group">
              <label>New Table Name</label>
              <input type="text" value={newTableName} onChange={e => setNewTableName(e.target.value)} />
            </div>
            <div className="actions">
              <button className="btn-secondary" onClick={() => setRenaming(false)}>Cancel</button>
              <button className="btn-primary" onClick={() => {
                if (newTableName && newTableName !== data?.tableName) {
                  setRenameTo(newTableName);
                  const sql = `ALTER TABLE ${getEscapedTable()} RENAME TO ${escapeId(newTableName)};`;
                  appendGeneratedSQL(sql);
                }
                setRenaming(false);
              }} disabled={!newTableName || newTableName === data?.tableName}>Generate Rename SQL</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
