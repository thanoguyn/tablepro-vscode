import * as vscode from 'vscode';
import { Logger, LogEntry } from '../../core/utils/Logger';

class LogTreeItem extends vscode.TreeItem {
  constructor(public readonly log: LogEntry) {
    super(
      log.message.replace(/\s+/g, ' ').substring(0, 60) + (log.message.length > 60 ? '...' : ''),
      vscode.TreeItemCollapsibleState.None
    );

    this.description = log.timestamp.toLocaleTimeString();
    if (log.executionTime !== undefined) {
      this.description += ` (${log.executionTime}ms)`;
    }

    // Set tooltip with Markdown
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Time:** ${log.timestamp.toLocaleTimeString()}\n\n`);
    tooltip.appendMarkdown(`**Type:** ${log.type.toUpperCase()}\n\n`);
    
    if (log.type === 'sql') {
      tooltip.appendCodeblock(log.message, 'sql');
    } else {
      tooltip.appendMarkdown(`**Message:** ${log.message}\n\n`);
    }

    if (log.details) {
      tooltip.appendMarkdown(`\n**Details/Error:**\n`);
      tooltip.appendCodeblock(log.details, 'text');
    }
    this.tooltip = tooltip;

    // Set icons
    switch (log.type) {
      case 'sql':
        this.iconPath = new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.blue'));
        break;
      case 'error':
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        break;
      default:
        this.iconPath = new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.foreground'));
        break;
    }

    this.contextValue = 'log-item';
    this.command = {
      command: 'tablepro.showLogItem',
      title: 'Show Log Details',
      arguments: [log],
    };
  }
}

export class LogTreeProvider implements vscode.TreeDataProvider<LogTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<LogTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor() {
    Logger.getInstance().onDidAddLog(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: LogTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: LogTreeItem): Promise<LogTreeItem[]> {
    if (element) return [];
    return Logger.getInstance().getLogs().map(log => new LogTreeItem(log));
  }
}
