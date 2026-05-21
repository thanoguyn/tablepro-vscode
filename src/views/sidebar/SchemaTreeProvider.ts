import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connection/ConnectionManager';
import { TableInfo, ColumnInfo, DatabaseType } from '../../core/types';

type SchemaTreeItem = DatabaseItem | SchemaGroupItem | TableGroupItem | TableItem | ColumnItem;

class DatabaseItem extends vscode.TreeItem {
  constructor(
    public readonly dbName: string,
    public readonly connectionId: string,
    public readonly isActive: boolean,
  ) {
    super(dbName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(isActive ? 'database' : 'circle-outline');
    this.contextValue = 'database';
    this.description = isActive ? '(active)' : '';

    if (!isActive) {
      this.command = {
        command: 'tablepro.switchDatabase',
        title: 'Switch Database',
        arguments: [connectionId, dbName],
      };
    }
  }
}

class SchemaGroupItem extends vscode.TreeItem {
  constructor(
    public readonly schemaName: string,
    public readonly connectionId: string,
  ) {
    super(schemaName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    this.contextValue = 'schema';
  }
}

class TableGroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly groupType: 'tables' | 'views',
    public readonly connectionId: string,
    public readonly tables: TableInfo[],
    public readonly schema?: string,
  ) {
    super(label, tables.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(groupType === 'tables' ? 'list-tree' : 'eye');
    this.description = `${tables.length}`;
    this.contextValue = 'tableGroup';
  }
}

class TableItem extends vscode.TreeItem {
  constructor(
    public readonly tableInfo: TableInfo,
    public readonly connectionId: string,
  ) {
    super(tableInfo.name, vscode.TreeItemCollapsibleState.Collapsed);

    const isView = tableInfo.type === 'view' || tableInfo.type === 'materializedView';
    this.iconPath = new vscode.ThemeIcon(isView ? 'eye' : 'table');
    this.contextValue = 'table';

    const parts: string[] = [];
    if (tableInfo.rowCount !== undefined) {
      parts.push(`~${this.formatNumber(tableInfo.rowCount)} rows`);
    }
    if (tableInfo.engine) {
      parts.push(tableInfo.engine);
    }
    this.description = parts.join(' • ');

    this.tooltip = this.buildTooltip();

    this.command = {
      command: 'tablepro.openTable',
      title: 'Open Table',
      arguments: [connectionId, tableInfo],
    };
  }

  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.tableInfo.name}**\n\n`);
    if (this.tableInfo.type !== 'table') {
      md.appendMarkdown(`Type: ${this.tableInfo.type}\n\n`);
    }
    if (this.tableInfo.rowCount !== undefined) {
      md.appendMarkdown(`Rows: ~${this.formatNumber(this.tableInfo.rowCount)}\n\n`);
    }
    if (this.tableInfo.dataSize) {
      md.appendMarkdown(`Size: ${this.formatBytes(this.tableInfo.dataSize)}\n\n`);
    }
    if (this.tableInfo.comment) {
      md.appendMarkdown(`Comment: ${this.tableInfo.comment}`);
    }
    return md;
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
    if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
    return String(n);
  }

  private formatBytes(bytes: number): string {
    if (bytes >= 1_073_741_824) { return `${(bytes / 1_073_741_824).toFixed(1)} GB`; }
    if (bytes >= 1_048_576) { return `${(bytes / 1_048_576).toFixed(1)} MB`; }
    if (bytes >= 1_024) { return `${(bytes / 1_024).toFixed(1)} KB`; }
    return `${bytes} B`;
  }
}

class ColumnItem extends vscode.TreeItem {
  constructor(public readonly column: ColumnInfo) {
    super(column.name, vscode.TreeItemCollapsibleState.None);

    let icon = 'symbol-field';
    let color: vscode.ThemeColor | undefined;

    if (column.isPrimaryKey) {
      icon = 'key';
      color = new vscode.ThemeColor('charts.yellow');
    } else if (column.foreignKey) {
      icon = 'link';
      color = new vscode.ThemeColor('charts.blue');
    } else if (column.isUnique) {
      icon = 'star';
    }

    this.iconPath = new vscode.ThemeIcon(icon, color);
    this.contextValue = 'column';

    const parts = [column.type];
    if (!column.nullable) { parts.push('NOT NULL'); }
    if (column.isAutoIncrement) { parts.push('AUTO_INCREMENT'); }
    this.description = parts.join(' ');
  }
}

/**
 * Tree data provider for the Schema sidebar view.
 * Shows database objects (tables, views, columns) for the active connection.
 */
export class SchemaTreeProvider implements vscode.TreeDataProvider<SchemaTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SchemaTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedTables = new Map<string, TableInfo[]>();
  private cachedColumns = new Map<string, ColumnInfo[]>();

  constructor(private connectionManager: ConnectionManager) {
    connectionManager.onActiveConnectionChanged(() => {
      this.clearCache();
      this.refresh();
    });
    connectionManager.onConnectionChanged(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  clearCache(): void {
    this.cachedTables.clear();
    this.cachedColumns.clear();
  }

  getTreeItem(element: SchemaTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SchemaTreeItem): Promise<SchemaTreeItem[]> {
    const conn = this.connectionManager.activeConnection;
    if (!conn) { return []; }

    const connectionId = this.connectionManager.activeConnectionId!;
    const driver = conn.driver;

    // Column level
    if (element instanceof TableItem) {
      return this.getColumnsForTable(element.tableInfo.name, connectionId, element.tableInfo.schema);
    }

    // Table group level - return table items
    if (element instanceof TableGroupItem) {
      return element.tables.map(t => new TableItem(t, element.connectionId));
    }

    // Schema level - return table groups
    if (element instanceof SchemaGroupItem) {
      return this.getTableGroups(element.connectionId, element.schemaName);
    }

    // Database level
    if (element instanceof DatabaseItem) {
      // For databases that support schemas (PostgreSQL), show schema groups
      if (conn.config.type === DatabaseType.PostgreSQL) {
        try {
          const schemas = await driver.getSchemas();
          return schemas.map(s => new SchemaGroupItem(s.name, element.connectionId));
        } catch {
          return this.getTableGroups(element.connectionId);
        }
      }
      return this.getTableGroups(element.connectionId);
    }

    // Root level
    if (!element) {
      // For SQLite, go directly to table groups
      if (conn.config.type === DatabaseType.SQLite) {
        return this.getTableGroups(connectionId);
      }

      // For other databases, show database list
      try {
        const currentDb = await driver.getCurrentDatabase();
        const databases = await driver.getDatabases();

        return databases.map(db =>
          new DatabaseItem(db.name, connectionId, db.name === currentDb)
        );
      } catch {
        // Fallback: just show tables
        return this.getTableGroups(connectionId);
      }
    }

    return [];
  }

  private async getTableGroups(connectionId: string, schema?: string): Promise<SchemaTreeItem[]> {
    const driver = this.connectionManager.getDriver(connectionId);
    if (!driver) { return []; }

    const cacheKey = `${connectionId}:${schema || ''}`;
    let tables = this.cachedTables.get(cacheKey);

    if (!tables) {
      try {
        tables = await driver.getTables(schema);
        this.cachedTables.set(cacheKey, tables);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load tables: ${err}`);
        return [];
      }
    }

    const regularTables = tables.filter(t => t.type === 'table');
    const views = tables.filter(t => t.type === 'view' || t.type === 'materializedView');

    const groups: SchemaTreeItem[] = [];
    groups.push(new TableGroupItem(`Tables`, 'tables', connectionId, regularTables, schema));
    if (views.length > 0) {
      groups.push(new TableGroupItem(`Views`, 'views', connectionId, views, schema));
    }
    return groups;
  }

  private async getColumnsForTable(table: string, connectionId: string, schema?: string): Promise<ColumnItem[]> {
    const driver = this.connectionManager.getDriver(connectionId);
    if (!driver) { return []; }

    const cacheKey = `${connectionId}:${schema || ''}:${table}`;
    let columns = this.cachedColumns.get(cacheKey);

    if (!columns) {
      try {
        columns = await driver.getColumns(table, schema);
        this.cachedColumns.set(cacheKey, columns);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to load columns for ${table}: ${err}`);
        return [];
      }
    }

    return columns.map(c => new ColumnItem(c));
  }
}
