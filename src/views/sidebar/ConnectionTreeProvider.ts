import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connection/ConnectionManager';
import { ConnectionConfig, DATABASE_TYPE_META, DatabaseType } from '../../core/types';

type TreeItem = ConnectionGroupItem | ConnectionItem;

class ConnectionGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    public readonly children: ConnectionItem[],
  ) {
    super(groupName, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'group';
  }
}

class ConnectionItem extends vscode.TreeItem {
  constructor(
    public readonly config: ConnectionConfig,
    public readonly connected: boolean,
  ) {
    super(config.name || 'Untitled', vscode.TreeItemCollapsibleState.None);

    const meta = DATABASE_TYPE_META[config.type] || { label: config.type, icon: '$(database)' };

    this.description = connected
      ? `${meta.label} • Connected`
      : meta.label;

    this.tooltip = this.buildTooltip(config, connected, meta.label);

    this.iconPath = this.getIcon(config.type, connected);
    this.contextValue = connected ? 'connection-connected' : 'connection-disconnected';

    this.command = {
      command: connected ? 'tablepro.selectConnection' : 'tablepro.connect',
      title: connected ? 'Select Connection' : 'Connect',
      arguments: [config.id],
    };
  }

  private buildTooltip(config: ConnectionConfig, connected: boolean, typeLabel: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${config.name || 'Untitled'}**\n\n`);
    md.appendMarkdown(`Type: ${typeLabel}\n\n`);

    if (config.type === DatabaseType.SQLite) {
      md.appendMarkdown(`File: ${config.filepath || config.database}\n\n`);
    } else {
      md.appendMarkdown(`Host: ${config.host}:${config.port}\n\n`);
      if (config.username) {
        md.appendMarkdown(`User: ${config.username}\n\n`);
      }
      if (config.database) {
        md.appendMarkdown(`Database: ${config.database}\n\n`);
      }
    }

    if (config.ssh.enabled) {
      md.appendMarkdown(`SSH: ${config.ssh.username}@${config.ssh.host}:${config.ssh.port}\n\n`);
    }

    md.appendMarkdown(`Status: ${connected ? '🟢 Connected' : '⚫ Disconnected'}`);
    return md;
  }

  private getIcon(type: DatabaseType, connected: boolean): vscode.ThemeIcon {
    if (connected) {
      return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'));
    }

    switch (type) {
      case DatabaseType.MySQL:
      case DatabaseType.MariaDB:
        return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
      case DatabaseType.PostgreSQL:
        return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.purple'));
      case DatabaseType.SQLite:
        return new vscode.ThemeIcon('file', new vscode.ThemeColor('charts.yellow'));
      default:
        return new vscode.ThemeIcon('database');
    }
  }
}

/**
 * Tree data provider for the Connections sidebar view.
 * Shows saved connections grouped by their group property, with connect/disconnect status.
 */
export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private connectionManager: ConnectionManager) {
    connectionManager.onConnectionChanged(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (element instanceof ConnectionGroupItem) {
      return element.children;
    }

    if (element) {
      return [];
    }

    // Root level: get all connections
    const configs = await this.connectionManager.getSavedConnections();
    const grouped = new Map<string, ConnectionConfig[]>();
    const ungrouped: ConnectionConfig[] = [];

    for (const config of configs) {
      if (config.group) {
        if (!grouped.has(config.group)) {
          grouped.set(config.group, []);
        }
        grouped.get(config.group)!.push(config);
      } else {
        ungrouped.push(config);
      }
    }

    const items: TreeItem[] = [];

    // Add groups
    for (const [groupName, groupConfigs] of grouped) {
      const children = groupConfigs.map(
        c => new ConnectionItem(c, this.connectionManager.isConnected(c.id))
      );
      items.push(new ConnectionGroupItem(groupName, children));
    }

    // Add ungrouped connections
    for (const config of ungrouped) {
      items.push(new ConnectionItem(config, this.connectionManager.isConnected(config.id)));
    }

    return items;
  }

  /** Get the connection ID from a tree item (used by commands) */
  static getConnectionId(item: TreeItem): string | undefined {
    if (item instanceof ConnectionItem) {
      return item.config.id;
    }
    return undefined;
  }
}
