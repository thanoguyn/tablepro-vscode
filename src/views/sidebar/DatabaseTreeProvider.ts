import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connection/ConnectionManager';

class DatabaseTreeItem extends vscode.TreeItem {
  constructor(
    public readonly dbName: string,
    public readonly connectionId: string,
    public readonly isActive: boolean,
  ) {
    super(dbName, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(isActive ? 'database' : 'circle-outline');
    this.contextValue = isActive ? 'database-active' : 'database';
    this.description = isActive ? 'active' : '';
    this.command = isActive
      ? undefined
      : {
          command: 'tablepro.switchDatabase',
          title: 'Switch Database',
          arguments: [connectionId, dbName],
        };
  }
}

/**
 * Tree data provider for the Databases sidebar view.
 * Shows databases for the active connection, with the active/default database first.
 */
export class DatabaseTreeProvider implements vscode.TreeDataProvider<DatabaseTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DatabaseTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private connectionManager: ConnectionManager) {
    connectionManager.onActiveConnectionChanged(() => this.refresh());
    connectionManager.onConnectionChanged(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: DatabaseTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
    if (element) { return []; }

    const connectionId = this.connectionManager.activeConnectionId;
    if (!connectionId) { return []; }

    const conn = this.connectionManager.activeConnection;
    const driver = this.connectionManager.getDriver(connectionId);
    if (!conn || !driver) { return []; }

    try {
      const databases = await driver.getDatabases();
      if (databases.length === 0) { return []; }

      const currentDb = await driver.getCurrentDatabase().catch(() => '');
      const activeDb = currentDb || conn.config.database || databases[0].name;

      return databases
        .map(db => new DatabaseTreeItem(db.name, connectionId, db.name === activeDb))
        .sort((a, b) => {
          if (a.isActive) { return -1; }
          if (b.isActive) { return 1; }
          return a.dbName.localeCompare(b.dbName);
        });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to load databases: ${err}`);
      return [];
    }
  }
}
