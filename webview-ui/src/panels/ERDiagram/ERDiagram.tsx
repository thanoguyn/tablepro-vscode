import React, { useState, useEffect, useRef } from 'react';
import { postMessage, onMessage } from '../../hooks/useVsCode';
import './ERDiagram.css';

interface ColumnInfo {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  foreignKey?: boolean;
}

interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

interface ERTableData {
  name: string;
  schema?: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

interface Position {
  x: number;
  y: number;
}

export default function ERDiagram() {
  const [tables, setTables] = useState<ERTableData[]>([]);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [draggingTable, setDraggingTable] = useState<string | null>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const tableStartPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    postMessage({ type: 'ready' });
    const unsub = onMessage((msg: any) => {
      if (msg.type === 'erDiagramData') {
        const data = msg.data as ERTableData[];
        setTables(data);
        
        // Auto-arrange tables in a grid layout
        const newPositions: Record<string, Position> = {};
        const cols = Math.ceil(Math.sqrt(data.length));
        data.forEach((table, index) => {
          const row = Math.floor(index / cols);
          const col = index % cols;
          newPositions[table.name] = {
            x: 50 + col * 320,
            y: 50 + row * 260
          };
        });
        setPositions(newPositions);
      }
    });
    return unsub;
  }, []);

  const handleMouseDown = (e: React.MouseEvent, tableName: string) => {
    e.preventDefault();
    setDraggingTable(tableName);
    dragStart.current = { x: e.clientX, y: e.clientY };
    tableStartPos.current = { ...positions[tableName] };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggingTable) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPositions(prev => ({
      ...prev,
      [draggingTable]: {
        x: Math.max(0, tableStartPos.current.x + dx),
        y: Math.max(0, tableStartPos.current.y + dy)
      }
    }));
  };

  const handleMouseUp = () => {
    setDraggingTable(null);
  };

  // Generate connection paths
  const connections = React.useMemo(() => {
    const list: { id: string; path: string; label: string }[] = [];
    tables.forEach(table => {
      const startPos = positions[table.name];
      if (!startPos) return;

      table.foreignKeys.forEach((fk, fkIdx) => {
        const targetTable = fk.referencedTable;
        const endPos = positions[targetTable];
        if (!endPos) return;

        // Approximate connector attachment points
        // Width of table box is 220px, height is roughly 35 + (col_count * 20)px
        const startHeight = 35 + (table.columns.length * 20);
        const endHeight = 35 + ((tables.find(t => t.name === targetTable)?.columns.length || 5) * 20);

        // Connect from left/right edges depending on relative positions
        const fromRight = startPos.x + 220 < endPos.x;
        const fromLeft = startPos.x > endPos.x + 220;

        let x1 = startPos.x + 110;
        let y1 = startPos.y + (startHeight / 2);
        let x2 = endPos.x + 110;
        let y2 = endPos.y + (endHeight / 2);

        if (fromRight) {
          x1 = startPos.x + 220;
          x2 = endPos.x;
        } else if (fromLeft) {
          x1 = startPos.x;
          x2 = endPos.x + 220;
        }

        // Draw cubic bezier curve for smooth link
        const dx = Math.abs(x2 - x1) * 0.5;
        const controlX1 = x1 + (fromRight ? dx : fromLeft ? -dx : 0);
        const controlX2 = x2 + (fromRight ? -dx : fromLeft ? dx : 0);

        const path = `M ${x1} ${y1} C ${controlX1} ${y1}, ${controlX2} ${y2}, ${x2} ${y2}`;
        list.push({
          id: `${table.name}-${targetTable}-${fkIdx}`,
          path,
          label: fk.columns.join(', ')
        });
      });
    });
    return list;
  }, [tables, positions]);

  if (tables.length === 0) {
    return (
      <div className="diagram-loading">
        <div className="spinner"></div>
        <h3>Generating ER Diagram...</h3>
      </div>
    );
  }

  return (
    <div className="er-diagram" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <header className="diagram-header">
        <div className="header-info">
          <h2>🎨 Entity Relationship Diagram</h2>
          <span className="subtitle">Drag tables to rearrange. Lines indicate foreign key relationships.</span>
        </div>
      </header>

      <div className="canvas">
        <svg className="svg-overlay">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--vscode-charts-blue, #007acc)" />
            </marker>
          </defs>
          {connections.map(conn => (
            <g key={conn.id}>
              <path d={conn.path} className="relationship-line" markerEnd="url(#arrow)" />
            </g>
          ))}
        </svg>

        {tables.map(table => {
          const pos = positions[table.name] || { x: 0, y: 0 };
          return (
            <div key={table.name} className="table-box" style={{ left: pos.x, top: pos.y }} onMouseDown={e => {
              // Only initiate drag on header
              if ((e.target as HTMLElement).closest('.table-box-header')) {
                handleMouseDown(e, table.name);
              }
            }}>
              <div className="table-box-header">
                <span className="icon">📊</span>
                <span className="name" title={table.name}>{table.name}</span>
              </div>
              <div className="table-box-columns">
                {table.columns.map(col => (
                  <div key={col.name} className={`column-row ${col.isPrimaryKey ? 'pk' : ''} ${col.foreignKey ? 'fk' : ''}`}>
                    <span className="key-indicator">
                      {col.isPrimaryKey ? '🔑' : col.foreignKey ? '🔗' : ''}
                    </span>
                    <span className="col-name" title={col.name}>{col.name}</span>
                    <span className="col-type" title={col.type}>{col.type}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
