import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { v4 as uuidv4 } from 'uuid';
import { ConnectionManager } from './core/connection/ConnectionManager';
import { ConnectionTreeProvider } from './views/sidebar/ConnectionTreeProvider';
import { DatabaseTreeProvider } from './views/sidebar/DatabaseTreeProvider';
import { SchemaTreeProvider } from './views/sidebar/SchemaTreeProvider';
import { Logger, LogEntry } from './core/utils/Logger';
import { WebviewManager } from './views/webview/WebviewManager';
import { QueryResultsViewProvider } from './views/webview/QueryResultsViewProvider';
import { SchemaProvider } from './core/schema/SchemaProvider';
import { QueryEngine } from './core/query/QueryEngine';
import { QueryHistory } from './core/query/QueryHistory';
import { SQLCompletionProvider } from './views/editor/SQLCompletionProvider';
import { SQLHoverProvider } from './views/editor/SQLHoverProvider';
import { SQLCodeLensProvider } from './views/editor/SQLCodeLensProvider';
import {
  ConnectionConfig,
  DatabaseType,
  DATABASE_TYPE_META,
  WebviewMessage,
  QueryResult,
  createDefaultConnectionConfig,
  SSLMode,
} from './core/types';
import { DriverFactory } from './core/drivers';
import type { DatabaseDriver } from './core/drivers/DatabaseDriver';
import { ProjectConnectionStorage } from './core/connection/ProjectConnectionStorage';
import { DatabaseDumpService } from './core/utils/DatabaseDumpService';
import { ImportExportService } from './core/utils/ImportExportService';

let connectionManager: ConnectionManager;
let databaseDumpService: DatabaseDumpService;
let webviewManager: WebviewManager;
let connectionTreeProvider: ConnectionTreeProvider;
let databaseTreeProvider: DatabaseTreeProvider;
let schemaTreeProvider: SchemaTreeProvider;
let schemaTreeView: vscode.TreeView<any>;
let schemaProvider: SchemaProvider;
let queryEngine: QueryEngine;
let queryHistory: QueryHistory;
let queryResultsViewProvider: QueryResultsViewProvider;
let queryDocContexts: Record<string, { connectionId: string, connectionName: string, database: string }> = {};
let queryContextStatusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let sqlCodeLensProvider: SQLCodeLensProvider | undefined;
let lastTableOpenClick: { key: string; timestamp: number } | undefined;

type ColumnFilterOperator = 'like' | 'startsWith' | 'endsWith' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty' | 'null' | 'notNull';
interface SqlColumnFilter {
  column: number;
  operator: ColumnFilterOperator;
  value?: string;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, match => `!${match}`);
}

function buildColumnFilterSql(driver: DatabaseDriver, columns: string[], filters?: SqlColumnFilter[]): string[] {
  if (!Array.isArray(filters)) return [];
  const clauses: string[] = [];

  for (const filter of filters) {
    const colName = columns[filter.column];
    if (!colName) continue;
    const col = driver.escapeIdentifier(colName);
    const op = filter.operator || 'like';
    const value = String(filter.value ?? '').trim();
    const like = (pattern: string) => `${col} LIKE ${driver.escapeValue(pattern)} ESCAPE ${driver.escapeValue('!')}`;

    if (op === 'null') clauses.push(`${col} IS NULL`);
    else if (op === 'notNull') clauses.push(`${col} IS NOT NULL`);
    else if (op === 'empty') clauses.push(`(${col} IS NULL OR ${col} = ${driver.escapeValue('')})`);
    else if (op === 'notEmpty') clauses.push(`(${col} IS NOT NULL AND ${col} <> ${driver.escapeValue('')})`);
    else {
      if (!value) continue;
      if (op === 'like') clauses.push(like(`%${escapeLikePattern(value)}%`));
      else if (op === 'startsWith') clauses.push(like(`${escapeLikePattern(value)}%`));
      else if (op === 'endsWith') clauses.push(like(`%${escapeLikePattern(value)}`));
      else if (op === 'eq') clauses.push(`${col} = ${driver.escapeValue(value)}`);
      else if (op === 'neq') clauses.push(`${col} <> ${driver.escapeValue(value)}`);
      else if (op === 'gt') clauses.push(`${col} > ${driver.escapeValue(value)}`);
      else if (op === 'gte') clauses.push(`${col} >= ${driver.escapeValue(value)}`);
      else if (op === 'lt') clauses.push(`${col} < ${driver.escapeValue(value)}`);
      else if (op === 'lte') clauses.push(`${col} <= ${driver.escapeValue(value)}`);
    }
  }

  return clauses;
}

function appendWhereClauses(sql: string, whereFilter: string | undefined, columnFilterClauses: string[]): string {
  const clauses: string[] = [];
  if (whereFilter && whereFilter.trim()) clauses.push(`(${whereFilter})`);
  clauses.push(...columnFilterClauses.map(clause => `(${clause})`));
  return clauses.length > 0 ? `${sql} WHERE ${clauses.join(' AND ')}` : sql;
}

async function getCurrentDatabaseName(connectionId: string): Promise<string> {
  const activeConn = connectionManager.getActiveConnection(connectionId);
  if (!activeConn) return '';
  try {
    return await activeConn.driver.getCurrentDatabase();
  } catch {
    return activeConn.config.database || '';
  }
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'database';
}

function defaultSqlDumpUri(name: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return vscode.Uri.file(path.join(workspaceFolder || os.homedir(), `${sanitizeFilenamePart(name)}_dump.sql`));
}

async function pickMysqlCharsetOptions(titlePrefix: string): Promise<{ charset: string; collation: string } | undefined> {
  const charsets = [
    { label: 'utf8mb4', description: 'Recommended: Full UTF-8 support' },
    { label: 'utf8', description: 'Standard UTF-8 (3-byte limit)' },
    { label: 'latin1', description: 'ISO 8859-1 West European' },
    { label: 'DEFAULT', description: 'Use server default character set' }
  ];

  const selectedCharset = await vscode.window.showQuickPick(charsets, {
    title: `${titlePrefix}: Character Set`,
    placeHolder: 'Choose character set'
  });
  if (!selectedCharset) { return undefined; }

  let collation = '';
  if (selectedCharset.label !== 'DEFAULT') {
    let collations: { label: string; description: string }[] = [];
    if (selectedCharset.label === 'utf8mb4') {
      collations = [
        { label: 'utf8mb4_0900_ai_ci', description: 'Modern Unicode 9.0 accent/case insensitive' },
        { label: 'utf8mb4_unicode_ci', description: 'Unicode accent/case insensitive' },
        { label: 'utf8mb4_general_ci', description: 'General comparison' }
      ];
    } else if (selectedCharset.label === 'utf8') {
      collations = [
        { label: 'utf8_general_ci', description: 'General collation' },
        { label: 'utf8_unicode_ci', description: 'Unicode collation' }
      ];
    } else if (selectedCharset.label === 'latin1') {
      collations = [
        { label: 'latin1_swedish_ci', description: 'Default latin1 collation' },
        { label: 'latin1_general_ci', description: 'General latin1 collation' }
      ];
    }

    if (collations.length > 0) {
      const selectedCollation = await vscode.window.showQuickPick(
        [{ label: 'DEFAULT', description: 'Use charset default collation' }, ...collations],
        {
          title: `${titlePrefix}: Collation`,
          placeHolder: 'Choose collation'
        }
      );
      if (!selectedCollation) { return undefined; }
      collation = selectedCollation.label === 'DEFAULT' ? '' : selectedCollation.label;
    }
  }

  return { charset: selectedCharset.label, collation };
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  console.log('TablePro extension activated');

  // Initialize core services
  connectionManager = new ConnectionManager(context);
  databaseDumpService = new DatabaseDumpService(context, connectionManager);
  webviewManager = new WebviewManager(context);
  queryHistory = new QueryHistory(context);
  queryEngine = new QueryEngine(connectionManager, queryHistory);
  queryResultsViewProvider = new QueryResultsViewProvider(context, async (message: WebviewMessage) => {
    if (message.type === 'openQuickView') {
      openQuickViewPanel(message.data.columns, message.data.rowData);
    }
    if (message.type === 'rowSelected') {
      webviewManager.postMessage('tablepro-quick-view', {
        type: 'rowSelected',
        data: message.data
      });
    }
    if ((message as any).type === 'openNewTab') {
      vscode.commands.executeCommand('tablepro.newQuery');
    }
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QueryResultsViewProvider.viewType,
      queryResultsViewProvider
    )
  );
  schemaProvider = new SchemaProvider(connectionManager);
  connectionTreeProvider = new ConnectionTreeProvider(connectionManager);

  // File watcher for .tablepro.json project configurations
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/.tablepro.json');
  fileWatcher.onDidChange(() => connectionTreeProvider.refresh());
  fileWatcher.onDidCreate(() => connectionTreeProvider.refresh());
  fileWatcher.onDidDelete(() => connectionTreeProvider.refresh());
  context.subscriptions.push(fileWatcher);
  databaseTreeProvider = new DatabaseTreeProvider(connectionManager);
  schemaTreeProvider = new SchemaTreeProvider(connectionManager);

  queryDocContexts = context.workspaceState.get<Record<string, { connectionId: string, connectionName: string, database: string }>>('queryDocContexts', {});
  queryContextStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(queryContextStatusBarItem);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
    connectionManager.onActiveConnectionChanged(() => updateStatusBar()),
    connectionManager.onConnectionChanged(() => updateStatusBar())
  );

  updateStatusBar();

  // ── Tree Views ──

  context.subscriptions.push(
    vscode.window.createTreeView('tablepro.connections', {
      treeDataProvider: connectionTreeProvider,
      showCollapseAll: true,
    }),
  );

  context.subscriptions.push(
    vscode.window.createTreeView('tablepro.databases', {
      treeDataProvider: databaseTreeProvider,
      showCollapseAll: true,
    }),
  );

  schemaTreeView = vscode.window.createTreeView('tablepro.schema', {
      treeDataProvider: schemaTreeProvider,
      showCollapseAll: true,
    });
  context.subscriptions.push(schemaTreeView);

  // ── Language Features (Phase 2) ──

  const sqlSelector: vscode.DocumentSelector = { language: 'sql' };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      sqlSelector,
      new SQLCompletionProvider(schemaProvider),
      '.', ' ', '\n',
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      sqlSelector,
      new SQLHoverProvider(schemaProvider),
    ),
  );

  const codeLensProvider = new SQLCodeLensProvider(getQueryContextTitle);
  sqlCodeLensProvider = codeLensProvider;
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(sqlSelector, codeLensProvider),
  );

  // ── Logging Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.clearLogs', () => {
      Logger.getInstance().clear();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.showLogsOutput', () => {
      Logger.getInstance().showOutput();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.showLogItem', async (log: LogEntry) => {
      if (log.type === 'sql') {
        const doc = await vscode.workspace.openTextDocument({
          content: log.message,
          language: 'sql'
        });
        await vscode.window.showTextDocument(doc);
      } else if (log.details) {
        const doc = await vscode.workspace.openTextDocument({
          content: `${log.message}\n\n${log.details}`,
          language: 'text'
        });
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showInformationMessage(log.message);
      }
    }),
  );

  // ── Connection Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.newConnection', async () => {
      const dbTypes = DriverFactory.getSupportedTypes();
      const items = dbTypes.map(type => ({
        label: DATABASE_TYPE_META[type]?.label || type,
        description: `Port ${DATABASE_TYPE_META[type]?.defaultPort || ''}`,
        type,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select database type',
        title: 'New Connection',
      });

      if (!selected) { return; }
      const config = createDefaultConnectionConfig(selected.type);
      openConnectionForm(config);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.saveConnectionToProject', async (item?: any) => {
      const id = item?.config?.id || item;
      let config: ConnectionConfig | undefined;
      const allConfigs = await connectionManager.getSavedConnections();

      if (id) {
        config = allConfigs.find(c => c.id === id);
      } else {
        const globalConfigs = allConfigs.filter(c => !c.options?.tableproProjectConfig && !c.tags?.includes('project-config'));
        if (globalConfigs.length === 0) {
          vscode.window.showInformationMessage('No global connections to save to project.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          globalConfigs.map(c => ({ label: c.name || 'Untitled', description: c.host, config: c })),
          { placeHolder: 'Select connection to save to project' }
        );
        if (pick) {
          config = pick.config;
        }
      }

      if (!config) { return; }

      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open. Cannot save project connection config.');
        return;
      }

      let selectedFolder = folders[0];
      if (folders.length > 1) {
        const folderPick = await vscode.window.showWorkspaceFolderPick({
          placeHolder: 'Select workspace folder to save connection config to',
        });
        if (!folderPick) { return; }
        selectedFolder = folderPick;
      }

      try {
        await connectionManager.saveConnectionToProject(config, selectedFolder);
        vscode.window.showInformationMessage(`Saved connection "${config.name}" to project in workspace folder "${selectedFolder.name}".`);
        connectionTreeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to save connection to project: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.openProjectConfig', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }

      let selectedFolder = folders[0];
      if (folders.length > 1) {
        const folderPick = await vscode.window.showWorkspaceFolderPick({
          placeHolder: 'Select workspace folder to open .tablepro.json from',
        });
        if (!folderPick) { return; }
        selectedFolder = folderPick;
      }

      const filePath = path.join(selectedFolder.uri.fsPath, '.tablepro.json');
      if (!fs.existsSync(filePath)) {
        const create = await vscode.window.showInformationMessage(
          `No .tablepro.json file found in "${selectedFolder.name}". Create one now?`,
          'Create'
        );
        if (create === 'Create') {
          const projectStorage = new ProjectConnectionStorage(context);
          await projectStorage.saveToProject(selectedFolder, []);
        } else {
          return;
        }
      }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.searchConnections', async () => {
      const allConfigs = await connectionManager.getSavedConnections();
      if (allConfigs.length === 0) {
        vscode.window.showInformationMessage('No saved connections found.');
        return;
      }

      const quickPick = vscode.window.createQuickPick();
      quickPick.title = 'Search Database Connections';
      quickPick.placeholder = 'Type to filter connections by name, host, database, type, or tags...';
      quickPick.ignoreFocusOut = true;

      const connectButton = {
        iconPath: new vscode.ThemeIcon('plug'),
        tooltip: 'Connect'
      };
      const disconnectButton = {
        iconPath: new vscode.ThemeIcon('debug-disconnect'),
        tooltip: 'Disconnect'
      };
      const editButton = {
        iconPath: new vscode.ThemeIcon('edit'),
        tooltip: 'Edit Connection'
      };
      const deleteButton = {
        iconPath: new vscode.ThemeIcon('trash'),
        tooltip: 'Delete Connection'
      };

      const mapConfigToItem = (c: ConnectionConfig) => {
        const isConnected = connectionManager.isConnected(c.id);
        const isProject = c.options?.tableproProjectConfig === true || c.tags?.includes('project-config');
        const prefix = isProject ? '$(project) ' : '$(database) ';
        const statusText = isConnected ? '🟢 Connected' : '⚫ Disconnected';

        let desc = '';
        if (c.type === DatabaseType.SQLite) {
          desc = c.filepath || c.database || '';
        } else {
          desc = `${c.host}:${c.port}${c.database ? '/' + c.database : ''}`;
        }

        const buttons: vscode.QuickInputButton[] = [];
        if (isConnected) {
          buttons.push(disconnectButton);
        } else {
          buttons.push(connectButton);
        }
        buttons.push(editButton, deleteButton);

        return {
          label: `${prefix}${c.name || 'Untitled'}`,
          description: `${desc} • ${statusText}`,
          detail: `Type: ${c.type} | Group: ${c.group || 'None'} | Tags: ${c.tags.join(', ') || 'None'}`,
          config: c,
          buttons
        };
      };

      quickPick.items = allConfigs.map(mapConfigToItem);

      quickPick.onDidAccept(async () => {
        const selectedItem = quickPick.selectedItems[0] as any;
        if (!selectedItem) { return; }
        quickPick.hide();

        const config = selectedItem.config;
        const isConnected = connectionManager.isConnected(config.id);

        if (isConnected) {
          try {
            await connectionManager.selectConnection(config.id);
            vscode.window.showInformationMessage(`Switched to active connection: ${config.name}`);
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to select connection: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: 'Connecting...', cancellable: false },
              () => connectionManager.connect(config.id)
            );
            vscode.window.showInformationMessage(`Connected to ${config.name}`);
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });

      quickPick.onDidTriggerItemButton(async (e) => {
        const item = e.item as any;
        const config = item.config;
        const button = e.button;

        quickPick.hide();

        if (button.tooltip === 'Connect') {
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: 'Connecting...', cancellable: false },
              () => connectionManager.connect(config.id)
            );
            vscode.window.showInformationMessage(`Connected to ${config.name}`);
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (button.tooltip === 'Disconnect') {
          try {
            await connectionManager.disconnect(config.id);
            vscode.window.showInformationMessage(`Disconnected from ${config.name}`);
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to disconnect: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (button.tooltip === 'Edit Connection') {
          vscode.commands.executeCommand('tablepro.editConnection', config.id);
        } else if (button.tooltip === 'Delete Connection') {
          vscode.commands.executeCommand('tablepro.deleteConnection', config.id);
        }
      });

      quickPick.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.editDatabase', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage('No active connection. Please connect to a database first.');
        return;
      }

      const activeConn = connectionManager.getActiveConnection(connectionId);
      if (!activeConn) {
        vscode.window.showErrorMessage('Connection not found or not connected.');
        return;
      }

      const dbName = item?.dbName || await getCurrentDatabaseName(connectionId);
      if (!dbName) {
        vscode.window.showErrorMessage('No database selected.');
        return;
      }

      if (activeConn.config.type !== DatabaseType.MySQL && activeConn.config.type !== DatabaseType.MariaDB) {
        vscode.window.showWarningMessage('Changing database charset is only supported for MySQL/MariaDB.');
        return;
      }

      const charsetOptions = await pickMysqlCharsetOptions(`Edit database "${dbName}"`);
      if (!charsetOptions || charsetOptions.charset === 'DEFAULT') { return; }

      const collationSql = charsetOptions.collation ? ` COLLATE ${charsetOptions.collation}` : '';
      const sql = `ALTER DATABASE ${activeConn.driver.escapeIdentifier(dbName)} CHARACTER SET ${charsetOptions.charset}${collationSql}`;

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Updating database "${dbName}"...`, cancellable: false },
          async () => {
            await connectionManager.query(connectionId!, sql);
          }
        );
        vscode.window.showInformationMessage(`Database "${dbName}" updated successfully.`);
        databaseTreeProvider.refresh();
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to edit database: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.createDatabase', async (item?: any) => {
      let connectionId = item?.config?.id || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage('No active connection. Please connect to a database first.');
        return;
      }

      const activeConn = connectionManager.getActiveConnection(connectionId);
      if (!activeConn) {
        vscode.window.showErrorMessage('Connection not found or not connected.');
        return;
      }

      const type = activeConn.config.type;

      if (type === DatabaseType.SQLite) {
        const fileUri = await vscode.window.showSaveDialog({
          filters: { 'SQLite Database': ['sqlite', 'db', 'sqlite3'] },
          title: 'Create New SQLite Database File',
        });
        if (!fileUri) { return; }

        const filepath = fileUri.fsPath;
        try {
          fs.writeFileSync(filepath, new Uint8Array(0));

          const newConfig = connectionManager.createConnectionConfig(DatabaseType.SQLite);
          newConfig.name = `SQLite - ${path.basename(filepath)}`;
          newConfig.filepath = filepath;
          newConfig.database = filepath;

          const newId = await connectionManager.saveConnection(newConfig);
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Connecting to new SQLite database...', cancellable: false },
            () => connectionManager.connect(newId)
          );
          vscode.window.showInformationMessage(`Created and connected to SQLite database: ${path.basename(filepath)}`);
          connectionTreeProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to create SQLite database: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }

      const dbName = await vscode.window.showInputBox({
        prompt: 'Enter the name of the new database',
        placeHolder: 'my_new_database',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Database name cannot be empty';
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
            return 'Database name can only contain alphanumeric characters, underscores, and hyphens';
          }
          return null;
        }
      });

      if (!dbName) { return; }

      let sql = '';

      if (type === DatabaseType.MySQL || type === DatabaseType.MariaDB) {
        const charsets = [
          { label: 'utf8mb4', description: 'Recommended: Full UTF-8 support (including emojis)' },
          { label: 'utf8', description: 'Standard UTF-8 (3-byte limit)' },
          { label: 'latin1', description: 'ISO 8859-1 West European' },
          { label: 'DEFAULT', description: 'Use server default character set' }
        ];
        const selectedCharset = await vscode.window.showQuickPick(charsets, {
          title: 'Select Character Set',
          placeHolder: 'Choose character set for the database'
        });
        if (!selectedCharset) { return; }

        let collation = '';
        if (selectedCharset.label !== 'DEFAULT') {
          let collations: { label: string; description: string }[] = [];
          if (selectedCharset.label === 'utf8mb4') {
            collations = [
              { label: 'utf8mb4_0900_ai_ci', description: 'Recommended: Modern Unicode 9.0 accent/case insensitive' },
              { label: 'utf8mb4_unicode_ci', description: 'Unicode accent/case insensitive' },
              { label: 'utf8mb4_general_ci', description: 'Faster but slightly less accurate general comparison' }
            ];
          } else if (selectedCharset.label === 'utf8') {
            collations = [
              { label: 'utf8_general_ci', description: 'Standard general collation' },
              { label: 'utf8_unicode_ci', description: 'Standard Unicode collation' }
            ];
          }

          if (collations.length > 0) {
            const selectedCollation = await vscode.window.showQuickPick(collations, {
              title: 'Select Collation',
              placeHolder: 'Choose collation'
            });
            if (!selectedCollation) { return; }
            collation = selectedCollation.label;
          }
        }

        sql = `CREATE DATABASE \`${dbName}\``;
        if (selectedCharset.label !== 'DEFAULT') {
          sql += ` CHARACTER SET ${selectedCharset.label}`;
          if (collation) {
            sql += ` COLLATE ${collation}`;
          }
        }

      } else if (type === DatabaseType.PostgreSQL) {
        const encodings = [
          { label: 'UTF8', description: 'Recommended: Unicode encoding' },
          { label: 'SQL_ASCII', description: 'Standard ASCII' },
          { label: 'LATIN1', description: 'ISO 8859-1 West European' },
          { label: 'DEFAULT', description: 'Use template default encoding' }
        ];
        const selectedEncoding = await vscode.window.showQuickPick(encodings, {
          title: 'Select Database Encoding',
          placeHolder: 'Choose encoding'
        });
        if (!selectedEncoding) { return; }

        const templates = [
          { label: 'DEFAULT', description: 'Use default template (usually template1)' },
          { label: 'template1', description: 'Standard PG template database' }
        ];
        const selectedTemplate = await vscode.window.showQuickPick(templates, {
          title: 'Select Base Template',
          placeHolder: 'Choose template database'
        });
        if (!selectedTemplate) { return; }

        sql = `CREATE DATABASE "${dbName}"`;
        if (selectedEncoding.label !== 'DEFAULT') {
          sql += ` ENCODING '${selectedEncoding.label}'`;
        }
        if (selectedTemplate.label !== 'DEFAULT') {
          sql += ` TEMPLATE ${selectedTemplate.label}`;
        }
      } else {
        vscode.window.showErrorMessage(`Database creation is not supported for driver type: ${type}`);
        return;
      }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Creating database "${dbName}"...`, cancellable: false },
          async () => {
            await connectionManager.query(connectionId, sql);
          }
        );
        vscode.window.showInformationMessage(`Database "${dbName}" created successfully.`);
        vscode.commands.executeCommand('tablepro.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to create database: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.dumpDatabase', async (item?: any) => {
      let connectionId = item?.connectionId || item?.config?.id || (typeof item === 'string' ? item : undefined) || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage('No active connection selected for dump.');
        return;
      }

      const activeConn = connectionManager.getActiveConnection(connectionId);
      if (!activeConn) {
        vscode.window.showErrorMessage('Connection is not active. Please connect first.');
        return;
      }

      const databaseName = item?.dbName || await getCurrentDatabaseName(connectionId);
      const dumpName = databaseName || activeConn.config.database || activeConn.config.name || 'database';

      const typeItems = [
        { label: 'Full Dump', value: 'full', description: 'Export both schema and data' },
        { label: 'Schema Only', value: 'schema-only', description: 'Export schema structure only' },
        { label: 'Data Only', value: 'data-only', description: 'Export records/data insert statements only' }
      ];

      const selectedType = await vscode.window.showQuickPick(typeItems, {
        placeHolder: 'Select dump type'
      });
      if (!selectedType) return;

      const fileUri = await vscode.window.showSaveDialog({
        defaultUri: defaultSqlDumpUri(dumpName),
        filters: {
          'SQL Dump File': ['sql']
        }
      });

      if (!fileUri) return;

      try {
        await databaseDumpService.dump(connectionId, {
          type: selectedType.value as any,
          outputPath: fileUri.fsPath,
          databaseName
        });
        vscode.window.showInformationMessage(`Database dumped successfully to ${path.basename(fileUri.fsPath)}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Database dump failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.importDatabase', async (item?: any) => {
      let connectionId = item?.connectionId || item?.config?.id || (typeof item === 'string' ? item : undefined) || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage('No active connection selected for import.');
        return;
      }

      const databaseName = item?.dbName || await getCurrentDatabaseName(connectionId);

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          'SQL File': ['sql']
        },
        openLabel: 'Import'
      });

      if (!fileUris || fileUris.length === 0) return;
      const fileUri = fileUris[0];

      try {
        await databaseDumpService.import(connectionId, {
          inputPath: fileUri.fsPath,
          databaseName
        });
        vscode.window.showInformationMessage(`Database imported successfully from ${path.basename(fileUri.fsPath)}`);
        vscode.commands.executeCommand('tablepro.refreshSchema');
      } catch (err) {
        vscode.window.showErrorMessage(`Database import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.editConnection', async (item?: any) => {
      const id = item?.config?.id || item;
      if (!id) { return; }
      const configs = await connectionManager.getSavedConnections();
      const config = configs.find(c => c.id === id);
      if (config) { openConnectionForm(config); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.deleteConnection', async (item?: any) => {
      const id = item?.config?.id || item;
      if (!id) { return; }
      const configs = await connectionManager.getSavedConnections();
      const config = configs.find(c => c.id === id);
      if (!config) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Delete connection "${config.name || 'Untitled'}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        await connectionManager.deleteConnection(id);
        vscode.window.showInformationMessage('Connection deleted.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.connect', async (idOrItem?: any) => {
      const id = typeof idOrItem === 'string' ? idOrItem : idOrItem?.config?.id;
      if (!id) { return; }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Connecting...', cancellable: false },
          () => connectionManager.connect(id),
        );

        const config = (await connectionManager.getSavedConnections()).find(c => c.id === id);
        vscode.window.showInformationMessage(`Connected to ${config?.name || 'database'}`);
        databaseTreeProvider.refresh();
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Connection failed: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.selectConnection', async (idOrItem?: any) => {
      const id = typeof idOrItem === 'string' ? idOrItem : idOrItem?.config?.id;
      if (!id) { return; }

      try {
        await connectionManager.selectConnection(id);
        databaseTreeProvider.refresh();
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
        updateStatusBar();
        codeLensProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to select connection: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.disconnect', async (item?: any) => {
      const id = item?.config?.id || connectionManager.activeConnectionId;
      if (!id) { return; }
      await connectionManager.disconnect(id);
      vscode.window.showInformationMessage('Disconnected.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.testConnection', async (config?: ConnectionConfig) => {
      if (!config) { return; }
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Testing connection...', cancellable: false },
        () => connectionManager.testConnection(config),
      );
      if (result.success) {
        vscode.window.showInformationMessage(`✅ ${result.message}`);
      } else {
        vscode.window.showErrorMessage(`❌ ${result.message}`);
      }
    }),
  );

  // ── Query Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.newQuery', async (item?: any) => {
      const requestedConnId = item?.config?.id || item?.id || item?.connectionId;
      const activeConnId = requestedConnId || connectionManager.activeConnectionId;
      if (!activeConnId) {
        vscode.window.showWarningMessage('No active connection. Connect to a database first.');
        return;
      }
      if (!connectionManager.isConnected(activeConnId)) {
        vscode.window.showWarningMessage('Selected connection is not active. Connect to a database first.');
        return;
      }

      if (connectionManager.activeConnectionId !== activeConnId) {
        connectionManager.setActiveConnection(activeConnId);
      }

      const conn = connectionManager.getActiveConnection(activeConnId);
      const connName = conn?.config.name || 'Connected';
      const requestedDb = typeof item?.database === 'string' ? item.database : undefined;
      const db = requestedDb || await getCurrentDatabaseName(activeConnId);

      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '-- New Query\n' });
      const uri = doc.uri.toString();

      queryDocContexts[uri] = {
        connectionId: activeConnId,
        connectionName: connName,
        database: db
      };
      await context.workspaceState.update('queryDocContexts', queryDocContexts);

      await vscode.window.showTextDocument(doc);
      updateStatusBar();
      codeLensProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        await applyQueryContext(editor.document);
      } catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
      }

      if (!connectionManager.activeConnectionId) {
        vscode.window.showWarningMessage('No active connection. Connect to a database first.');
        return;
      }

      const config = vscode.workspace.getConfiguration('tablepro');
      if (config.get<boolean>('autoSaveQueries', false) && editor.document.isDirty) {
        await editor.document.save();
      }

      let sql: string;
      if (!editor.selection.isEmpty) {
        sql = editor.document.getText(editor.selection);
      } else {
        sql = getCurrentStatement(editor);
      }

      sql = sql.trim();
      if (!sql) { return; }

      await executeAndShowResults(sql);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.runAllQueries', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        await applyQueryContext(editor.document);
      } catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
      }

      if (!connectionManager.activeConnectionId) { return; }

      const config = vscode.workspace.getConfiguration('tablepro');
      if (config.get<boolean>('autoSaveQueries', false) && editor.document.isDirty) {
        await editor.document.save();
      }

      const sql = editor.document.getText().trim();
      if (!sql) { return; }

      await executeAndShowResults(sql);
    }),
  );

  // Run a specific statement identified by character offset (from CodeLens)
  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.runStatementAt', async (startOffset: number, endOffset: number) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        await applyQueryContext(editor.document);
      } catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
      }

      if (!connectionManager.activeConnectionId) { return; }

      const config = vscode.workspace.getConfiguration('tablepro');
      if (config.get<boolean>('autoSaveQueries', false) && editor.document.isDirty) {
        await editor.document.save();
      }

      const sql = editor.document.getText().substring(startOffset, endOffset + 1).trim();
      if (!sql) { return; }

      // Remove trailing semicolon for execution
      const cleanSql = sql.endsWith(';') ? sql.slice(0, -1).trim() : sql;
      await executeAndShowResults(cleanSql);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.saveQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await editor.document.save();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.toggleQueryAutoSave', async () => {
      const config = vscode.workspace.getConfiguration('tablepro');
      const current = config.get<boolean>('autoSaveQueries', false);
      await config.update('autoSaveQueries', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`TablePro Auto Save Queries: ${!current ? 'Enabled' : 'Disabled'}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.changeQueryContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'sql') return;

      const uri = editor.document.uri.toString();
      const currentContext = queryDocContexts[uri];
      const savedConfigs = await connectionManager.getSavedConnections();
      const connectedIds = connectionManager.getConnectedIds();

      if (connectedIds.length === 0) {
        vscode.window.showWarningMessage('No active connections. Please connect to a database first.');
        return;
      }

      const connItems = savedConfigs
        .filter(c => connectedIds.includes(c.id))
        .sort((a, b) => {
          const currentId = currentContext?.connectionId || connectionManager.activeConnectionId;
          if (a.id === currentId) return -1;
          if (b.id === currentId) return 1;
          return 0;
        })
        .map(c => ({
          label: c.name || 'Untitled',
          description: c.id === (currentContext?.connectionId || connectionManager.activeConnectionId) ? 'current' : (c.host ? `${c.host}:${c.port}` : c.filepath),
          config: c
        }));

      if (connItems.length === 0) {
        vscode.window.showWarningMessage('No active connections found.');
        return;
      }

      const selectedConn = await vscode.window.showQuickPick(connItems, { placeHolder: 'Select Connection' });
      if (!selectedConn) return;

      const driver = connectionManager.getDriver(selectedConn.config.id);
      if (!driver) return;

      let dbName = '';
      if (selectedConn.config.type !== DatabaseType.SQLite) {
        try {
          const databases = await driver.getDatabases();
          const currentDb = selectedConn.config.id === currentContext?.connectionId
            ? currentContext.database
            : await getCurrentDatabaseName(selectedConn.config.id);
          const dbItems = databases
            .map(db => ({
              label: db.name,
              description: db.name === currentDb ? 'current' : undefined,
            }))
            .sort((a, b) => {
              if (a.label === currentDb) return -1;
              if (b.label === currentDb) return 1;
              return 0;
            });
          const selectedDb = await vscode.window.showQuickPick(dbItems, { placeHolder: `Select Database${currentDb ? ` (${currentDb})` : ''}` });
          if (!selectedDb) return;
          dbName = selectedDb.label;
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to load databases: ${err}`);
          return;
        }
      }

      // Update association
      queryDocContexts[uri] = {
        connectionId: selectedConn.config.id,
        connectionName: selectedConn.config.name || 'Connected',
        database: dbName
      };
      await context.workspaceState.update('queryDocContexts', queryDocContexts);

      // Switch context
      connectionManager.setActiveConnection(selectedConn.config.id);
      if (dbName) {
        try {
          await driver.switchDatabase(dbName);
        } catch (err) {
          // ignore SQLite unsupported errors
        }
      }

      schemaTreeProvider.clearCache();
      schemaTreeProvider.refresh();

      updateStatusBar();
      codeLensProvider.refresh();
      vscode.window.showInformationMessage(`Query associated with: ${selectedConn.config.name || 'Connected'} [${dbName || 'main'}]`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.cancelQuery', async () => {
      await queryEngine.cancel();
      vscode.window.showInformationMessage('Query cancelled.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.formatSQL', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      try {
        const { format } = require('sql-formatter');
        const text = editor.selection.isEmpty
          ? editor.document.getText()
          : editor.document.getText(editor.selection);

        const formatted = format(text, { language: 'sql', tabWidth: 2, keywordCase: 'upper' });

        const range = editor.selection.isEmpty
          ? new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length),
            )
          : editor.selection;

        await editor.edit(editBuilder => { editBuilder.replace(range, formatted); });
      } catch (err) {
        vscode.window.showErrorMessage(`Format failed: ${err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.queryHistory', async () => {
      const entry = await queryHistory.showQuickPick();
      if (entry) {
        // Open the selected query in a new editor
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: entry.sql + '\n' });
        await vscode.window.showTextDocument(doc);
      }
    }),
  );

  // ── Schema Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.openTable', async (connectionId?: string, tableInfo?: any, options?: { pinned?: boolean }) => {
      if (!connectionId || !tableInfo) { return; }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { vscode.window.showErrorMessage('Not connected.'); return; }

      let openedPanelId: string | undefined;
      let attemptedSql: string | undefined;
      try {
        const table = tableInfo.name;
        const schema = tableInfo.schema;
        const openKey = `${connectionId}:${schema || ''}:${table}`;
        const now = Date.now();
        const isDoubleClick = lastTableOpenClick?.key === openKey && now - lastTableOpenClick.timestamp < 650;
        lastTableOpenClick = { key: openKey, timestamp: now };
        const pinned = options?.pinned === true || isDoubleClick;
        const config = vscode.workspace.getConfiguration('tablepro');
        const pageSize = config.get<number>('defaultRowsPerPage', 100);
        const dbName = await getCurrentDatabaseName(connectionId);
        const panelId = pinned
          ? `data-grid-${connectionId}-${dbName || 'default'}-${schema || 'default'}-${table}-${Date.now()}`
          : 'data-grid-preview';
        openedPanelId = panelId;

        const escapedTable = schema
          ? `${driver.escapeIdentifier(schema)}.${driver.escapeIdentifier(table)}`
          : driver.escapeIdentifier(table);

        // Use limit+1 trick: fetch one extra row to know if there are more pages
        const sql = `SELECT * FROM ${escapedTable} ${driver.paginationSQL(pageSize + 1, 0)}`;
        attemptedSql = sql;

        const initialLoadingResult: QueryResult = {
          columns: [],
          rows: [],
          affectedRows: 0,
          executionTime: 0,
          truncated: false,
          messages: [],
        };

        showResultsInDataGrid(table, initialLoadingResult, table, schema, connectionId, dbName, pageSize, false, {
          pinned,
          panelId,
          querySql: sql,
          loadingRows: true,
        });

        let columnInfos: any[] = [];
        try {
          columnInfos = await driver.getColumns(table, schema);
        } catch {
          columnInfos = [];
        }

        const loadingResult: QueryResult = {
          columns: columnInfos.map(col => ({
            name: col.name,
            type: col.type,
            normalizedType: col.normalizedType,
            nullable: col.nullable,
            isPrimaryKey: col.isPrimaryKey,
            isAutoIncrement: col.isAutoIncrement,
            defaultValue: col.defaultValue ?? null,
            maxLength: col.maxLength,
            precision: col.precision,
            scale: col.scale,
            rawType: col.type,
            table,
            schema,
          })),
          rows: [],
          affectedRows: 0,
          executionTime: 0,
          truncated: false,
          messages: [],
        };

        if (columnInfos.length > 0) {
          showResultsInDataGrid(table, loadingResult, table, schema, connectionId, dbName, pageSize, false, {
            pinned,
            panelId,
            querySql: sql,
            loadingRows: true,
          });
        }

        const result = await driver.query(sql);

        // Enrich column types with schema info
        let enrichedResult = serializeQueryResult(result);
        if (columnInfos.length > 0) {
          const infoMap = new Map(columnInfos.map(ci => [ci.name, ci]));
          enrichedResult = {
            ...enrichedResult,
            columns: enrichedResult.columns.length > 0
              ? enrichedResult.columns.map(col => {
                  const info = infoMap.get(col.name);
                  if (!info) return col;
                  return {
                    ...col,
                    type: info.type,
                    rawType: info.type,
                    normalizedType: info.normalizedType,
                    maxLength: info.maxLength,
                    precision: info.precision,
                    scale: info.scale,
                    isPrimaryKey: info.isPrimaryKey,
                    isAutoIncrement: info.isAutoIncrement,
                    nullable: info.nullable,
                  };
                })
              : columnInfos.map(col => ({
                  name: col.name,
                  type: col.type,
                  normalizedType: col.normalizedType,
                  nullable: col.nullable,
                  isPrimaryKey: col.isPrimaryKey,
                  isAutoIncrement: col.isAutoIncrement,
                  defaultValue: col.defaultValue ?? null,
                  maxLength: col.maxLength,
                  precision: col.precision,
                  scale: col.scale,
                  rawType: col.type,
                  table,
                  schema,
                })),
          };
        }

        // If we got pageSize+1 rows, trim back to pageSize and note there are more
        const hasMore = enrichedResult.rows.length > pageSize;
        if (hasMore) enrichedResult = { ...enrichedResult, rows: enrichedResult.rows.slice(0, pageSize) };

        showResultsInDataGrid(table, enrichedResult, table, schema, connectionId, dbName, pageSize, hasMore, {
          pinned,
          panelId,
          querySql: sql,
          loadingRows: false,
        });
      } catch (err) {
        if (openedPanelId) {
          webviewManager.postMessage(openedPanelId, {
            type: 'error',
            data: { message: `Failed to open table: ${err instanceof Error ? err.message : String(err)}` },
            querySql: attemptedSql,
          } as any);
        }
        vscode.window.showErrorMessage(`Failed to open table: ${err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.openStructure', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage('No table selected.');
        return;
      }

      openTableStructure(connectionId, tableInfo);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.createTable', async (item?: any) => {
      let connectionId = item?.connectionId || item?.config?.id || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showErrorMessage('No active connection. Connect to a database first.');
        return;
      }
      openCreateTable(connectionId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.truncateTable', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage('No table selected.');
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        vscode.window.showErrorMessage('Not connected.');
        return;
      }

      const tableName = tableInfo.name;
      const schemaName = tableInfo.schema;
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to truncate table "${tableName}"? This will delete all rows.`,
        { modal: true },
        'Truncate'
      );

      if (confirm !== 'Truncate') { return; }

      try {
        const escapedTable = schemaName
          ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
          : driver.escapeIdentifier(tableName);

        if (driver.driverType === 'sqlite') {
          await driver.query(`DELETE FROM ${escapedTable}`);
          try {
            await driver.query(`DELETE FROM sqlite_sequence WHERE name = ${driver.escapeValue(tableName)}`);
          } catch {}
        } else {
          await driver.query(`TRUNCATE TABLE ${escapedTable}`);
        }

        vscode.window.showInformationMessage(`Table "${tableName}" truncated successfully.`);
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to truncate table: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.dropTable', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage('No table selected.');
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) {
        vscode.window.showErrorMessage('Not connected.');
        return;
      }

      const tableName = tableInfo.name;
      const schemaName = tableInfo.schema;
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to drop table "${tableName}"? This cannot be undone.`,
        { modal: true },
        'Drop'
      );

      if (confirm !== 'Drop') { return; }

      try {
        const escapedTable = schemaName
          ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
          : driver.escapeIdentifier(tableName);

        await driver.query(`DROP TABLE ${escapedTable}`);

        vscode.window.showInformationMessage(`Table "${tableName}" dropped successfully.`);
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to drop table: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.quickSwitcher', async () => {
      const connId = connectionManager.activeConnectionId;
      if (!connId) {
        vscode.window.showWarningMessage('No active connection. Connect to a database first.');
        return;
      }

      const driver = connectionManager.getDriver(connId);
      if (!driver) { return; }

      try {
        let tables: any[] = [];
        if (driver.driverType === 'postgresql') {
          const schemas = await driver.getSchemas();
          for (const s of schemas) {
            const schemaTables = await driver.getTables(s.name);
            tables.push(...schemaTables);
          }
        } else {
          tables = await driver.getTables();
        }

        const items = tables.map(t => ({
          label: t.name,
          description: t.schema ? `Schema: ${t.schema}` : '',
          detail: t.type === 'view' ? 'View' : 'Table',
          tableInfo: t
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Search table/view name...',
          title: 'Quick Table Switcher'
        });

        if (selected) {
          vscode.commands.executeCommand('tablepro.openTable', connId, selected.tableInfo);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Quick Switcher failed: ${err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.erDiagram', async (item?: any) => {
      const connId = item?.config?.id || connectionManager.activeConnectionId;
      if (!connId) {
        vscode.window.showWarningMessage('No active connection.');
        return;
      }

      const driver = connectionManager.getDriver(connId);
      if (!driver) { return; }

      const panelId = `er-diagram-${connId}`;
      const title = `🎨 ER Diagram`;

      webviewManager.showPanel(panelId, title, 'erDiagram', async (message: WebviewMessage) => {
        if (message.type === 'ready') {
          try {
            let tables: any[] = [];
            if (driver.driverType === 'postgresql') {
              const schemas = await driver.getSchemas();
              for (const s of schemas) {
                const schemaTables = await driver.getTables(s.name);
                tables.push(...schemaTables);
              }
            } else {
              tables = await driver.getTables();
            }

            const diagramData: any[] = [];
            for (const t of tables) {
              const cols = await driver.getColumns(t.name, t.schema);
              const fks = await driver.getForeignKeys(t.name, t.schema);
              diagramData.push({
                name: t.name,
                schema: t.schema,
                columns: cols,
                foreignKeys: fks
              });
            }

            webviewManager.postMessage(panelId, {
              type: 'erDiagramData',
              data: diagramData
            });
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to load ER Diagram: ${err}`);
          }
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.exportData', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage('No table selected for export.');
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { return; }

      const formatItems = [
        { label: 'CSV', value: 'csv', description: 'Comma Separated Values' },
        { label: 'JSON', value: 'json', description: 'Javascript Object Notation' },
        { label: 'SQL', value: 'sql', description: 'SQL Insert Statements Dump' }
      ];

      const selectedFormat = await vscode.window.showQuickPick(formatItems, {
        placeHolder: 'Select export format'
      });
      if (!selectedFormat) return;

      const fileUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${tableInfo.name}.${selectedFormat.value}`),
        filters: {
          [selectedFormat.label]: [selectedFormat.value]
        }
      });

      if (!fileUri) return;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Exporting ${tableInfo.name} to ${selectedFormat.value.toUpperCase()}...`,
        cancellable: false
      }, async () => {
        try {
          const escapedTable = tableInfo.schema
            ? `${driver.escapeIdentifier(tableInfo.schema)}.${driver.escapeIdentifier(tableInfo.name)}`
            : driver.escapeIdentifier(tableInfo.name);
          const sql = `SELECT * FROM ${escapedTable}`;

          await ImportExportService.exportData(
            driver,
            sql,
            selectedFormat.value as any,
            fileUri.fsPath,
            tableInfo.name
          );
          vscode.window.showInformationMessage(`Export completed: ${fileUri.fsPath}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.importData', async (item?: any) => {
      let connectionId = item?.connectionId || connectionManager.activeConnectionId;
      let tableInfo = item?.tableInfo;

      if (!connectionId || !tableInfo) {
        vscode.window.showErrorMessage('No table selected for import.');
        return;
      }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { return; }

      const formatItems = [
        { label: 'CSV', value: 'csv' },
        { label: 'JSON', value: 'json' }
      ];

      const selectedFormat = await vscode.window.showQuickPick(formatItems, {
        placeHolder: 'Select import file format'
      });
      if (!selectedFormat) return;

      const fileUris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          [selectedFormat.label]: [selectedFormat.value]
        }
      });

      if (!fileUris || fileUris.length === 0) return;
      const fileUri = fileUris[0];

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Importing data into ${tableInfo.name}...`,
        cancellable: false
      }, async () => {
        try {
          const result = await ImportExportService.importData(
            driver,
            tableInfo.name,
            tableInfo.schema,
            selectedFormat.value as any,
            fileUri.fsPath
          );

          if (result.errors.length > 0) {
            vscode.window.showWarningMessage(
              `Import completed with errors. Inserted: ${result.inserted} rows. First error: ${result.errors[0]}`
            );
          } else {
            vscode.window.showInformationMessage(`Import completed successfully: ${result.inserted} rows inserted.`);
          }

          schemaTreeProvider.clearCache();
          schemaTreeProvider.refresh();
          schemaProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : err}`);
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.explainPlan', async () => {
      const connId = connectionManager.activeConnectionId;
      if (!connId) {
        vscode.window.showWarningMessage('No active connection.');
        return;
      }

      const driver = connectionManager.getDriver(connId);
      if (!driver) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Open an SQL file and select a query first.');
        return;
      }

      const sql = editor.document.getText(editor.selection) || editor.document.getText();
      if (!sql.trim()) {
        vscode.window.showErrorMessage('No SQL query selected.');
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Running EXPLAIN query...',
        cancellable: false
      }, async () => {
        try {
          let planResult: any = null;
          if (driver.driverType === 'postgresql') {
            try {
              const res = await driver.query(`EXPLAIN (FORMAT JSON) ${sql}`);
              planResult = { format: 'json', raw: res.rows[0]?.[0] };
            } catch {
              const res = await driver.query(`EXPLAIN ${sql}`);
              planResult = { format: 'text', raw: res.rows.map(r => r[0]).join('\n') };
            }
          } else if (driver.driverType === 'mysql') {
            try {
              const res = await driver.query(`EXPLAIN FORMAT=JSON ${sql}`);
              planResult = { format: 'json', raw: res.rows[0]?.[0] || res.rows[0]?.[1] };
            } catch {
              const res = await driver.query(`EXPLAIN ${sql}`);
              planResult = { format: 'text', raw: res.rows.map(r => JSON.stringify(r)).join('\n') };
            }
          } else if (driver.driverType === 'sqlite') {
            try {
              const res = await driver.query(`EXPLAIN QUERY PLAN ${sql}`);
              planResult = { format: 'sqlite', raw: res.rows };
            } catch (err) {
              vscode.window.showErrorMessage(`EXPLAIN failed: ${err}`);
              return;
            }
          }

          const panelId = `query-plan-${Date.now()}`;
          webviewManager.showPanel(panelId, '🔍 Query Plan', 'queryPlan', async (message: WebviewMessage) => {
            if (message.type === 'ready') {
              webviewManager.postMessage(panelId, {
                type: 'planData',
                data: {
                  sql,
                  driverType: driver.driverType,
                  plan: planResult
                }
              });
            }
          });
        } catch (err) {
          vscode.window.showErrorMessage(`EXPLAIN failed: ${err instanceof Error ? err.message : err}`);
        }
      });
    }),
  );

  async function openTableStructure(connectionId: string, tableInfo: any) {
    const driver = connectionManager.getDriver(connectionId);
    if (!driver) {
      vscode.window.showErrorMessage('Not connected.');
      return;
    }

    let currentTableName = tableInfo.name;
    const schemaName = tableInfo.schema;
    const panelId = `table-structure-${connectionId}-${schemaName || 'default'}-${currentTableName}`;
    const title = `🔧 Structure: ${currentTableName}`;

    const panel = webviewManager.showPanel(panelId, title, 'structureView', async (message: WebviewMessage) => {
      if (message.type === 'ready') {
        try {
          const columns = await driver.getColumns(currentTableName, schemaName);
          const indexes = await driver.getIndexes(currentTableName, schemaName);
          const foreignKeys = await driver.getForeignKeys(currentTableName, schemaName);

          let ddl = '';
          if (driver.driverType === 'mysql') {
            const result = await driver.query(`SHOW CREATE TABLE ${driver.escapeIdentifier(currentTableName)}`);
            ddl = result.rows[0]?.[1] as string || '';
          } else if (driver.driverType === 'postgresql') {
            ddl = generateCreateTableDDL(currentTableName, columns, driver);
          } else if (driver.driverType === 'sqlite') {
            const result = await driver.query(
              `SELECT sql FROM sqlite_master WHERE type='table' AND name=${driver.escapeValue(currentTableName)}`
            );
            ddl = result.rows[0]?.[0] as string || '';
          }

          webviewManager.postMessage(panelId, {
            type: 'structureData',
            data: {
              tableName: currentTableName,
              schemaName,
              columns,
              indexes,
              foreignKeys,
              ddl
            }
          });
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to load structure: ${err}`);
        }
      }

      if (message.type === 'getDriverType') {
        webviewManager.postMessage(panelId, {
          type: 'driverType',
          data: { type: driver.driverType }
        });
      }

      if (message.type === 'getTableList') {
        try {
          const tables = await driver.getTables(message.data?.schemaName || schemaName);
          webviewManager.postMessage(panelId, {
            type: 'tableList',
            data: { tables }
          });
        } catch (err) {
          webviewManager.postMessage(panelId, {
            type: 'error',
            data: { message: `Failed to load table list: ${err instanceof Error ? err.message : String(err)}` }
          });
        }
      }

      if (message.type === 'executeDDL') {
        try {
          const sql = message.data.sql;
          await driver.queryMultiple(sql);

          if (message.data.renameTo) {
            currentTableName = message.data.renameTo;
            panel.title = `🔧 Structure: ${currentTableName}`;
          }

          vscode.window.showInformationMessage('Structure updated successfully.');
          webviewManager.postMessage(panelId, { type: 'reloadStructure' });
          schemaTreeProvider.clearCache();
          schemaTreeProvider.refresh();
          schemaProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to apply changes: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  async function openCreateTable(connectionId: string) {
    const driver = connectionManager.getDriver(connectionId);
    if (!driver) {
      vscode.window.showErrorMessage('Not connected.');
      return;
    }

    const panelId = `create-table-${connectionId}`;
    const title = `➕ Create Table`;

    webviewManager.showPanel(panelId, title, 'createTable', async (message: WebviewMessage) => {
      if (message.type === 'ready' || message.type === 'getDriverType') {
        webviewManager.postMessage(panelId, {
          type: 'driverType',
          data: { type: driver.driverType }
        });
      }

      if (message.type === 'ready' || message.type === 'getTableList') {
        try {
          const tables = await driver.getTables(message.type === 'getTableList' ? message.data?.schemaName : undefined);
          webviewManager.postMessage(panelId, {
            type: 'tableList',
            data: { tables }
          });
        } catch (err) {
          webviewManager.postMessage(panelId, {
            type: 'error',
            data: { message: `Failed to load table list: ${err instanceof Error ? err.message : String(err)}` }
          });
        }
      }

      if (message.type === 'executeCreateTable') {
        try {
          const sql = message.data.sql;
          await driver.queryMultiple(sql);
          vscode.window.showInformationMessage(`Table "${message.data.tableName}" created successfully.`);
          webviewManager.closePanel(panelId);
          schemaTreeProvider.clearCache();
          schemaTreeProvider.refresh();
          schemaProvider.refresh();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to create table: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.showDDL', async (item?: any) => {
      if (!item?.tableInfo) { return; }
      const connectionId = connectionManager.activeConnectionId;
      if (!connectionId) { return; }
      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { return; }

      try {
        let ddl = '';
        const table = item.tableInfo.name;

        if (driver.driverType === 'mysql') {
          const result = await driver.query(`SHOW CREATE TABLE ${driver.escapeIdentifier(table)}`);
          ddl = result.rows[0]?.[1] as string || '';
        } else if (driver.driverType === 'postgresql') {
          const cols = await driver.getColumns(table);
          ddl = generateCreateTableDDL(table, cols, driver);
        } else if (driver.driverType === 'sqlite') {
          const result = await driver.query(
            `SELECT sql FROM sqlite_master WHERE type='table' AND name=${driver.escapeValue(table)}`
          );
          ddl = result.rows[0]?.[0] as string || '';
        }

        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: ddl + ';\n' });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to get DDL: ${err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.switchDatabase', async (connectionId?: string, dbName?: string) => {
      if (!connectionId) { connectionId = connectionManager.activeConnectionId; }
      if (!connectionId) { return; }

      const driver = connectionManager.getDriver(connectionId);
      if (!driver) { return; }

      if (!dbName) {
        const databases = await driver.getDatabases();
        const selected = await vscode.window.showQuickPick(databases.map(db => db.name), { placeHolder: 'Select database' });
        if (!selected) { return; }
        dbName = selected;
      }

      try {
        if (connectionManager.activeConnectionId !== connectionId) {
          await connectionManager.selectConnection(connectionId);
        }

        const currentDb = await driver.getCurrentDatabase().catch(() => '');
        if (currentDb !== dbName) {
          await driver.switchDatabase(dbName);
        }
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'sql') {
          const uri = editor.document.uri.toString();
          const mapped = queryDocContexts[uri];
          if (mapped?.connectionId === connectionId) {
            queryDocContexts[uri] = { ...mapped, database: dbName };
            await context.workspaceState.update('queryDocContexts', queryDocContexts);
          }
        }
        databaseTreeProvider.refresh();
        schemaTreeProvider.clearCache();
        schemaTreeProvider.refresh();
        schemaProvider.refresh();
        updateStatusBar();
        codeLensProvider.refresh();
        vscode.window.showInformationMessage(`Switched to database: ${dbName}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to switch database: ${err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.openTerminal', async (item?: any) => {
      let connectionId = item?.id || item?.connectionId || connectionManager.activeConnectionId;
      if (!connectionId) {
        vscode.window.showWarningMessage('No connection selected.');
        return;
      }

      const activeConn = connectionManager.getActiveConnection(connectionId);
      if (!activeConn) {
        vscode.window.showErrorMessage('Connection is not active. Please connect first.');
        return;
      }

      const { config, driver, tunnel } = activeConn;
      let activeDb = config.database || '';
      if (driver && driver.isConnected) {
        try {
          activeDb = await driver.getCurrentDatabase();
        } catch {}
      }

      const connectHost = tunnel ? '127.0.0.1' : config.host;
      const connectPort = tunnel ? tunnel.localPort : config.port;

      let shellCommand = '';
      const terminalName = `TablePro CLI: ${config.name}`;

      if (config.type === 'mysql') {
        const portOption = connectPort ? `-P ${connectPort}` : '';
        const dbOption = activeDb ? (driver?.escapeIdentifier ? driver.escapeIdentifier(activeDb) : activeDb) : '';
        const passwordPart = config.password ? `-p"${config.password.replace(/"/g, '\\"')}"` : '';
        shellCommand = `mysql -h ${connectHost} ${portOption} -u ${config.username} ${passwordPart} ${dbOption}`;
      } else if (config.type === 'postgresql') {
        const portOption = connectPort ? `-p ${connectPort}` : '';
        const dbOption = activeDb ? `-d "${activeDb.replace(/"/g, '\\"')}"` : '';
        const envPart = config.password ? `PGPASSWORD="${config.password.replace(/"/g, '\\"')}" ` : '';
        shellCommand = `${envPart}psql -h ${connectHost} ${portOption} -U ${config.username} ${dbOption}`;
      } else if (config.type === 'sqlite') {
        const dbPath = config.database;
        if (!dbPath) {
          vscode.window.showErrorMessage('SQLite database file path is not set.');
          return;
        }
        shellCommand = `sqlite3 "${dbPath.replace(/"/g, '\\"')}"`;
      } else {
        vscode.window.showErrorMessage(`Terminal CLI integration is not supported for ${config.type}.`);
        return;
      }

      try {
        const terminal = vscode.window.createTerminal({ name: terminalName });
        terminal.show();
        terminal.sendText(shellCommand);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to open terminal CLI: ${err}`);
      }
    }),
  );

  // ── Refresh Commands ──

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.refreshConnections', () => connectionTreeProvider.refresh()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tablepro.refreshSchema', async () => {
      const selectedTable = schemaTreeView.selection
        .map((item: any) => item?.tableInfo ? {
          name: item.tableInfo.name as string,
          schema: item.tableInfo.schema as string | undefined,
          connectionId: item.connectionId as string,
        } : undefined)
        .find(Boolean);
      schemaTreeProvider.clearCache();
      schemaTreeProvider.refresh();
      schemaProvider.refresh();
      if (selectedTable) {
        setTimeout(() => {
          void schemaTreeProvider
            .findTableItem(selectedTable.name, selectedTable.connectionId, selectedTable.schema)
            .then(item => {
              if (item) {
                return schemaTreeView.reveal(item, { select: true, focus: false });
              }
              return undefined;
            });
        }, 150);
      }
    }),
  );

  // ── Status Bar ──

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'tablepro.switchDatabase';
  context.subscriptions.push(statusBar);

  connectionManager.onActiveConnectionChanged(async (id) => {
    if (id) {
      const configs = await connectionManager.getSavedConnections();
      const config = configs.find(c => c.id === id);
      const driver = connectionManager.getDriver(id);
      if (config && driver) {
        try {
          const db = await driver.getCurrentDatabase();
          const meta = DATABASE_TYPE_META[config.type];
          statusBar.text = `$(database) ${config.name}: ${db}`;
          statusBar.tooltip = `${meta?.label || config.type} — Click to switch database`;
          statusBar.show();
        } catch {
          statusBar.text = `$(database) ${config.name}`;
          statusBar.show();
        }
      }
    } else {
      statusBar.hide();
    }
  });

  // ── Helper Functions ──

  function serializeQueryResult(result: QueryResult): QueryResult {
    return {
      ...result,
      rows: result.rows.map(row =>
        row.map(v => {
          if (v === null || v === undefined) return null;
          if (Buffer.isBuffer(v)) return v.toString('utf8');
          if (typeof v === 'bigint') return v.toString();
          if (typeof v === 'object') {
            try { return JSON.stringify(v); } catch { return String(v); }
          }
          return v;
        })
      ),
    };
  }

  function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function tsvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  }

  function openConnectionForm(config: ConnectionConfig) {
    const panelId = `connection-form-${config.id || 'new'}`;
    const title = config.name ? `Edit: ${config.name}` : 'New Connection';

    webviewManager.showPanel(panelId, title, 'connectionForm', async (message: WebviewMessage) => {
      switch (message.type) {
        case 'saveConnection': {
          try {
            await connectionManager.saveConnection(message.data);
            webviewManager.postMessage(panelId, { type: 'saveResult', data: { success: true, message: 'Connection saved.' } });
            webviewManager.closePanel(panelId);
            vscode.window.showInformationMessage('Connection saved.');
          } catch (err) {
            webviewManager.postMessage(panelId, { type: 'saveResult', data: { success: false, message: `Failed: ${err}` } });
          }
          break;
        }
        case 'testConnection': {
          const result = await connectionManager.testConnection(message.data);
          if (result.success) { vscode.window.showInformationMessage(`✅ ${result.message}`); }
          else { vscode.window.showErrorMessage(`❌ ${result.message}`); }
          break;
        }
        case 'ready':
          webviewManager.postMessage(panelId, { type: 'connectionConfig', data: config });
          try {
            const sshHosts = parseSSHConfig();
            webviewManager.postMessage(panelId, { type: 'sshHosts', data: sshHosts });
          } catch (err) {
            Logger.getInstance().logError('Failed to send SSH hosts to connection form', err);
          }
          break;
      }
    });
  }

  async function executeAndShowResults(sql: string) {
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running query...', cancellable: true },
        async () => queryEngine.execute(sql),
      );
      const serializedResult = serializeQueryResult(result);

      if (serializedResult.columns.length > 0) {
        await vscode.commands.executeCommand('tablepro.queryResultsView.focus');
        queryResultsViewProvider.postMessage({
          type: 'queryResult',
          data: serializedResult,
          querySql: sql,
          pageSize: vscode.workspace.getConfiguration('tablepro').get<number>('defaultRowsPerPage', 1000),
        } as any);
      } else {
        vscode.window.showInformationMessage(
          `Query executed: ${result.affectedRows} rows affected (${result.executionTime}ms)`
        );
      }
    } catch (err) {
      queryResultsViewProvider.postMessage({
        type: 'error',
        data: { message: `Query error: ${err instanceof Error ? err.message : String(err)}` },
        querySql: sql,
      } as any);
      vscode.window.showErrorMessage(`Query error: ${err instanceof Error ? err.message : err}`);
    }
  }

  function showResultsInDataGrid(
    title: string,
    result: QueryResult,
    tableName?: string,
    schemaName?: string,
    connectionId?: string,
    database?: string,
    pageSizeOverride?: number,
    initialHasMore = false,
    options?: { pinned?: boolean; panelId?: string; querySql?: string; loadingRows?: boolean }
  ) {
    const panelId = options?.panelId || (options?.pinned
      ? `data-grid-${connectionId || 'active'}-${database || 'default'}-${schemaName || 'default'}-${tableName || Date.now()}-${Date.now()}`
      : 'data-grid-preview');
    const connId = connectionId || connectionManager.activeConnectionId;
    const pageSizeForGrid = pageSizeOverride || vscode.workspace.getConfiguration('tablepro').get<number>('defaultRowsPerPage', 1000);
    const messagePayload = { type: 'queryResult', data: result, tableName, schemaName, pageSize: pageSizeForGrid, hasMore: initialHasMore, querySql: options?.querySql, loadingRows: !!options?.loadingRows } as any;
    const panelExists = webviewManager.hasPanel(panelId);

    webviewManager.showPanel(panelId, options?.pinned ? `📊 ${title}` : `📊 Preview: ${title}`, 'dataGrid', async (message: WebviewMessage) => {
      if (message.type === 'ready') {
        webviewManager.postMessage(panelId, messagePayload);
      }

      if (message.type === 'rowSelected') {
        webviewManager.postMessage('tablepro-quick-view', {
          type: 'rowSelected',
          data: message.data
        });
      }

      if (message.type === 'countRows' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (driver) {
          try {
            const escapedTable = schemaName
              ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
              : driver.escapeIdentifier(tableName);
            const whereFilter = (message as any).data?.whereFilter as string | undefined;
            const columnFilters = (message as any).data?.columnFilters as SqlColumnFilter[] | undefined;
            const columnFilterClauses = buildColumnFilterSql(driver, result.columns.map(c => c.name), columnFilters);
            let countSql = `SELECT COUNT(*) AS total FROM ${escapedTable}`;
            countSql = appendWhereClauses(countSql, whereFilter, columnFilterClauses);
            const countResult = await driver.query(countSql);
            const firstRow = countResult.rows[0] as any;
            const total = Number(firstRow?.total ?? firstRow?.TOTAL ?? firstRow?.[0] ?? 0);
            webviewManager.postMessage(panelId, {
              type: 'totalRowsCount',
              data: { totalRows: total },
              querySql: countSql,
            } as any);
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to count table rows: ${err}`);
          }
        }
      }

      if (message.type === 'getDDL' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (driver) {
          try {
            const ddl = await getTableDDL(driver, tableName, schemaName);
            webviewManager.postMessage(panelId, { type: 'ddlData', data: { ddl } });
          } catch (err) {
            webviewManager.postMessage(panelId, {
              type: 'error',
              data: { message: `Failed to load DDL: ${err instanceof Error ? err.message : String(err)}` },
            });
          }
        }
      }

      if (message.type === 'fetchPage' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (driver) {
          let sql: string | undefined;
          try {
            const page = message.data.page;
            const sortStates: { column: number; direction: 'asc' | 'desc' }[] = (message as any).data.sortStates || [];
            const whereFilter: string | undefined = (message as any).data.whereFilter;
            const columnFilters = (message as any).data.columnFilters as SqlColumnFilter[] | undefined;

            const escapedTable = schemaName
              ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
              : driver.escapeIdentifier(tableName);

            sql = `SELECT * FROM ${escapedTable}`;
            const columnFilterClauses = buildColumnFilterSql(driver, result.columns.map(c => c.name), columnFilters);
            sql = appendWhereClauses(sql, whereFilter, columnFilterClauses);
            if (sortStates.length > 0) {
              const orderParts = sortStates.map(s => {
                const colName = result.columns[s.column]?.name;
                if (!colName) return null;
                return `${driver.escapeIdentifier(colName)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`;
              }).filter(Boolean).join(', ');
              if (orderParts) sql += ` ORDER BY ${orderParts}`;
            }

            const pageSize = vscode.workspace.getConfiguration('tablepro').get<number>('defaultRowsPerPage', 1000);
            const offset = page * pageSize;
            // Use limit+1 trick to detect if next page exists
            sql += ` ${driver.paginationSQL(pageSize + 1, offset)}`;

            const pageResult = serializeQueryResult(await driver.query(sql));

            const hasMore = pageResult.rows.length > pageSize;
            const trimmedRows = hasMore ? pageResult.rows.slice(0, pageSize) : pageResult.rows;

            webviewManager.postMessage(panelId, {
              type: 'pageData',
              page,
              data: { ...pageResult, columns: result.columns, rows: trimmedRows },
              sortStates: sortStates,
              hasMore,
              pageSize,
              totalRows: hasMore ? undefined : (offset + trimmedRows.length),
              querySql: sql,
            } as any);
          } catch (err) {
            webviewManager.postMessage(panelId, {
              type: 'error',
              data: { message: `Failed to fetch page data: ${err instanceof Error ? err.message : String(err)}` },
              querySql: sql,
            } as any);
            vscode.window.showErrorMessage(`Failed to fetch page data: ${err}`);
          }
        }
      }

      if ((message as any).type === 'copyTableData' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (driver) {
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Copying ${tableName} as ${(message as any).data?.format === 'tsv' ? 'TSV' : 'CSV'}...`, cancellable: false },
              async () => {
                const data = (message as any).data || {};
                const format: 'csv' | 'tsv' = data.format === 'tsv' ? 'tsv' : 'csv';
                const sortStates: { column: number; direction: 'asc' | 'desc' }[] = data.sortStates || [];
                const whereFilter: string | undefined = data.whereFilter;
                const columnFilters = data.columnFilters as SqlColumnFilter[] | undefined;
                const includeHeader = data.includeHeader !== false;
                const separator = format === 'tsv' ? '\t' : ',';
                const escapeCell = format === 'tsv' ? tsvEscape : csvEscape;
                const escapedTable = schemaName
                  ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
                  : driver.escapeIdentifier(tableName);

                let sql = `SELECT * FROM ${escapedTable}`;
                const columnFilterClauses = buildColumnFilterSql(driver, result.columns.map(c => c.name), columnFilters);
                sql = appendWhereClauses(sql, whereFilter, columnFilterClauses);
                if (sortStates.length > 0) {
                  const orderParts = sortStates.map(s => {
                    const colName = result.columns[s.column]?.name;
                    if (!colName) return null;
                    return `${driver.escapeIdentifier(colName)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`;
                  }).filter(Boolean).join(', ');
                  if (orderParts) sql += ` ORDER BY ${orderParts}`;
                }

                const copyResult = serializeQueryResult(await driver.query(sql));
                const header = result.columns.map(c => escapeCell(c.name)).join(separator);
                const body = copyResult.rows.map(row => row.map(escapeCell).join(separator)).join('\n');
                await vscode.env.clipboard.writeText(includeHeader ? `${header}\n${body}` : body);
                webviewManager.postMessage(panelId, {
                  type: 'copyResult',
                  success: true,
                  message: `Copied ${copyResult.rows.length.toLocaleString()} row${copyResult.rows.length === 1 ? '' : 's'} as ${format.toUpperCase()}`,
                } as any);
              }
            );
          } catch (err) {
            webviewManager.postMessage(panelId, {
              type: 'copyResult',
              success: false,
              message: `Copy failed: ${err instanceof Error ? err.message : String(err)}`,
            } as any);
          }
        }
      }

      if ((message as any).type === 'openNewTab') {
        vscode.commands.executeCommand('tablepro.newQuery', { connectionId: connId, database });
      }

      if (message.type === 'saveChanges' && connId && tableName) {
        const driver = connectionManager.getDriver(connId);
        if (!driver) { vscode.window.showErrorMessage('Not connected'); return; }

        try {
          const changedRows = message.data.rows as any[];
          const columns = result.columns.map(c => c.name);
          const pkCols = result.columns.filter(c => c.isPrimaryKey).map(c => c.name);
          const escapedTable = schemaName
            ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
            : driver.escapeIdentifier(tableName);

          const statements: string[] = [];
          for (const row of changedRows) {
            if (row.status === 'modified') {
              const sets = (row.changedCols as number[]).map(ci =>
                `${driver.escapeIdentifier(columns[ci])} = ${driver.escapeValue(row.data[ci])}`
              ).join(', ');
              const where = (pkCols.length > 0 ? pkCols : columns).map(col => {
                const ci = columns.indexOf(col);
                const val = row.original[ci];
                return val === null ? `${driver.escapeIdentifier(col)} IS NULL` : `${driver.escapeIdentifier(col)} = ${driver.escapeValue(val)}`;
              }).join(' AND ');
              statements.push(`UPDATE ${escapedTable} SET ${sets} WHERE ${where}`);
            } else if (row.status === 'added') {
              const nonNull = columns.map((col, i) => ({ col, val: row.data[i] })).filter(x => x.val !== null);
              if (nonNull.length > 0) {
                statements.push(`INSERT INTO ${escapedTable} (${nonNull.map(x => driver.escapeIdentifier(x.col)).join(', ')}) VALUES (${nonNull.map(x => driver.escapeValue(x.val)).join(', ')})`);
              }
            } else if (row.status === 'deleted') {
              const where = (pkCols.length > 0 ? pkCols : columns).map(col => {
                const ci = columns.indexOf(col);
                const val = row.original[ci];
                return val === null ? `${driver.escapeIdentifier(col)} IS NULL` : `${driver.escapeIdentifier(col)} = ${driver.escapeValue(val)}`;
              }).join(' AND ');
              statements.push(`DELETE FROM ${escapedTable} WHERE ${where}`);
            }
          }

          if (statements.length === 0) { return; }

          // Execute all statements
          for (const stmt of statements) { await driver.query(stmt); }
          vscode.window.showInformationMessage(`✅ ${statements.length} changes saved.`);

          // Refresh the grid
          const pageSize = vscode.workspace.getConfiguration('tablepro').get<number>('defaultRowsPerPage', 1000);
          const refreshSql = `SELECT * FROM ${escapedTable} ${driver.paginationSQL(pageSize + 1, 0)}`;
          const refreshResult = serializeQueryResult(await driver.query(refreshSql));
          const hasMore = refreshResult.rows.length > pageSize;
          const rows = hasMore ? refreshResult.rows.slice(0, pageSize) : refreshResult.rows;
          webviewManager.postMessage(panelId, {
            type: 'queryResult',
            data: { ...refreshResult, columns: result.columns, rows },
            tableName,
            schemaName,
            pageSize,
            hasMore,
            querySql: refreshSql,
          } as any);
        } catch (err) {
          vscode.window.showErrorMessage(`Save failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      if (message.type === 'previewSQL' && connId && tableName) {
        try {
          const driver = connectionManager.getDriver(connId);
          if (!driver) {
            webviewManager.postMessage(panelId, {
              type: 'previewSQLError',
              data: { message: 'Failed to preview SQL: not connected' },
            } as any);
            return;
          }
          const changedRows = message.data.rows as any[];
          const columns = result.columns.map(c => c.name);
          const pkCols = result.columns.filter(c => c.isPrimaryKey).map(c => c.name);
          const escapedTable = schemaName
            ? `${driver.escapeIdentifier(schemaName)}.${driver.escapeIdentifier(tableName)}`
            : driver.escapeIdentifier(tableName);

          const stmts: string[] = [];
          for (const row of changedRows) {
            if (row.status === 'modified') {
              const sets = (row.changedCols as number[]).map(ci => `${driver.escapeIdentifier(columns[ci])} = ${driver.escapeValue(row.data[ci])}`).join(', ');
              const where = (pkCols.length > 0 ? pkCols : columns).map(col => { const ci = columns.indexOf(col); const val = row.original[ci]; return val === null ? `${driver.escapeIdentifier(col)} IS NULL` : `${driver.escapeIdentifier(col)} = ${driver.escapeValue(val)}`; }).join(' AND ');
              stmts.push(`UPDATE ${escapedTable} SET ${sets} WHERE ${where};`);
            } else if (row.status === 'added') {
              const nonNull = columns.map((col, i) => ({ col, val: row.data[i] })).filter(x => x.val !== null);
              if (nonNull.length > 0) stmts.push(`INSERT INTO ${escapedTable} (${nonNull.map(x => driver.escapeIdentifier(x.col)).join(', ')}) VALUES (${nonNull.map(x => driver.escapeValue(x.val)).join(', ')});`);
            } else if (row.status === 'deleted') {
              const where = (pkCols.length > 0 ? pkCols : columns).map(col => { const ci = columns.indexOf(col); const val = row.original[ci]; return val === null ? `${driver.escapeIdentifier(col)} IS NULL` : `${driver.escapeIdentifier(col)} = ${driver.escapeValue(val)}`; }).join(' AND ');
              stmts.push(`DELETE FROM ${escapedTable} WHERE ${where};`);
            }
          }

          const sql = stmts.length > 0 ? `-- Preview: ${stmts.length} changes\n\n${stmts.join('\n\n')}\n` : '';
          webviewManager.postMessage(panelId, {
            type: 'previewSQLResult',
            data: { sql, count: stmts.length },
          } as any);
        } catch (err) {
          webviewManager.postMessage(panelId, {
            type: 'previewSQLError',
            data: { message: `Failed to preview SQL: ${err instanceof Error ? err.message : String(err)}` },
          } as any);
        }
      }

      if (message.type === 'openQuickView') {
        openQuickViewPanel(message.data.columns, message.data.rowData);
      }
    }, vscode.ViewColumn.Active);

    if (panelExists) {
      webviewManager.postMessage(panelId, messagePayload);
    }
  }

  function openQuickViewPanel(columns: any[], rowData: any[]) {
    const panelId = 'tablepro-quick-view';
    webviewManager.showPanel(
      panelId,
      '🔍 Row Quick View',
      'quickView',
      (message) => {
        if (message.type === 'ready') {
          webviewManager.postMessage(panelId, {
            type: 'quickViewData',
            data: { columns, rowData }
          });
        }
      },
      vscode.ViewColumn.Beside
    );
  }

  function getCurrentStatement(editor: vscode.TextEditor): string {
    const doc = editor.document;
    const cursorLine = editor.selection.active.line;
    let startLine = cursorLine;
    let endLine = cursorLine;

    while (startLine > 0) {
      const line = doc.lineAt(startLine - 1).text.trim();
      if (line === '' || line.endsWith(';')) { break; }
      startLine--;
    }
    while (endLine < doc.lineCount - 1) {
      const line = doc.lineAt(endLine).text.trim();
      if (line.endsWith(';')) { break; }
      endLine++;
    }

    const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    let text = doc.getText(range).trim();
    if (text.endsWith(';')) { text = text.slice(0, -1).trim(); }
    return text;
  }

  async function getTableDDL(driver: any, table: string, schema?: string): Promise<string> {
    const escapedTable = schema
      ? `${driver.escapeIdentifier(schema)}.${driver.escapeIdentifier(table)}`
      : driver.escapeIdentifier(table);

    if (driver.driverType === 'mysql') {
      const result = await driver.query(`SHOW CREATE TABLE ${escapedTable}`);
      return result.rows[0]?.[1] as string || '';
    }
    if (driver.driverType === 'postgresql') {
      const columns = await driver.getColumns(table, schema);
      return generateCreateTableDDL(table, columns, driver, schema);
    }
    if (driver.driverType === 'sqlite') {
      const result = await driver.query(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=${driver.escapeValue(table)}`
      );
      return result.rows[0]?.[0] as string || '';
    }
    return '';
  }

  function generateCreateTableDDL(table: string, columns: any[], driver: any, schema?: string): string {
    const lines = columns.map((col: any) => {
      let line = `  ${driver.escapeIdentifier(col.name)} ${col.type}`;
      if (!col.nullable) { line += ' NOT NULL'; }
      if (col.defaultValue !== null && col.defaultValue !== undefined) { line += ` DEFAULT ${col.defaultValue}`; }
      return line;
    });
    const pkCols = columns.filter((c: any) => c.isPrimaryKey).map((c: any) => driver.escapeIdentifier(c.name));
    if (pkCols.length > 0) { lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`); }
    const escapedTable = schema
      ? `${driver.escapeIdentifier(schema)}.${driver.escapeIdentifier(table)}`
      : driver.escapeIdentifier(table);
    return `CREATE TABLE ${escapedTable} (\n${lines.join(',\n')}\n)`;
  }

  // Register SQLite custom editor provider
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'tablepro.sqliteViewer',
      new SqliteCustomEditorProvider(openSQLiteFile)
    )
  );

  // Trigger .env auto-import on startup
  scanWorkspaceForDatabaseConfigs();

  // Watch for workspace folder changes to re-trigger scan
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scanWorkspaceForDatabaseConfigs();
    })
  );
}

// ── SQLite Custom Editor Provider ──

class SqliteCustomEditorProvider implements vscode.CustomEditorProvider {
  constructor(private openSQLiteFn: (uri: vscode.Uri) => Promise<void>) {}

  readonly onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<vscode.CustomDocument>>().event;

  async saveCustomDocument(document: vscode.CustomDocument, cancellation: vscode.CancellationToken): Promise<void> {}
  async saveCustomDocumentAs(document: vscode.CustomDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {}
  async revertCustomDocument(document: vscode.CustomDocument, cancellation: vscode.CancellationToken): Promise<void> {}
  async backupCustomDocument(document: vscode.CustomDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    return {
      id: '',
      delete: () => {}
    };
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return {
      uri,
      dispose: () => {}
    };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: false };
    webviewPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; }
    .box { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px; max-width: 520px; }
    h2 { font-size: 14px; margin: 0 0 8px; }
    p { color: var(--vscode-descriptionForeground); margin: 0; font-size: 12px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Opening SQLite database in TablePro...</h2>
    <p>This tab can be closed after the database appears in the TablePro sidebar.</p>
  </div>
</body>
</html>`;

    await this.openSQLiteFn(document.uri);
  }
}

// ── SSH Config Parser ──

export interface SSHConfigHost {
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export function parseSSHConfig(customPath?: string): SSHConfigHost[] {
  const sshConfigPath = customPath || path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(sshConfigPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(sshConfigPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const hosts: SSHConfigHost[] = [];
    let currentHost: SSHConfigHost | null = null;

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const match = line.match(/^(\S+)\s+(.+)$/);
      if (!match) {
        continue;
      }

      const key = match[1].toLowerCase();
      const value = match[2].trim().replace(/^"(.*)"$/, '$1');

      if (key === 'host') {
        if (value === '*') {
          continue;
        }
        const aliases = value.split(/\s+/);
        for (const alias of aliases) {
          currentHost = { host: alias };
          hosts.push(currentHost);
        }
      } else if (currentHost) {
        if (key === 'hostname') {
          currentHost.hostName = value;
        } else if (key === 'user') {
          currentHost.user = value;
        } else if (key === 'port') {
          currentHost.port = parseInt(value, 10);
        } else if (key === 'identityfile') {
          let keyPath = value;
          if (keyPath.startsWith('~/')) {
            keyPath = path.join(os.homedir(), keyPath.slice(2));
          }
          currentHost.identityFile = keyPath;
        }
      }
    }
    return hosts;
  } catch (err) {
    Logger.getInstance().logError('Failed to parse SSH config file', err);
    return [];
  }
}

// ── SQLite Opener Function ──

async function openSQLiteFile(uri: vscode.Uri) {
  const filePath = uri.fsPath;
  const fileName = path.basename(filePath);

  try {
    const savedConnections = await connectionManager.getSavedConnections();
    let conn = savedConnections.find(
      c => c.type === 'sqlite' && (c.filepath === filePath || c.database === filePath)
    );

    let id: string;
    if (conn) {
      id = conn.id;
    } else {
      const newConfig: ConnectionConfig = {
        id: uuidv4(),
        name: `${fileName} (SQLite)`,
        type: DatabaseType.SQLite,
        host: '',
        port: 0,
        username: '',
        password: '',
        database: filePath,
        filepath: filePath,
        ssl: { mode: SSLMode.Disabled },
        ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
        options: {},
        group: 'SQLite Files',
        tags: ['sqlite', 'local'],
        color: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      id = await connectionManager.saveConnection(newConfig);
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Opening SQLite database ${fileName}...`, cancellable: false },
      () => connectionManager.connect(id)
    );

    vscode.window.showInformationMessage(`Connected to SQLite database: ${fileName}`);
    connectionTreeProvider.refresh();
    schemaTreeProvider.clearCache();
    schemaTreeProvider.refresh();
    schemaProvider.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to open SQLite database: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Workspace .env Scanner & DB Importer ──

export function parseDatabaseUrl(urlStr: string, env: Record<string, string>): Partial<ConnectionConfig> | null {
  urlStr = urlStr.replace(/\${([^}]+)}/g, (_, name) => env[name] || '');

  try {
    if (urlStr.startsWith('sqlite:') || urlStr.startsWith('file:')) {
      const filePath = urlStr.replace(/^(sqlite|file):(?:\/\/)?/, '');
      return {
        type: 'sqlite',
        database: filePath,
        filepath: filePath,
      } as any;
    }

    const parsed = new URL(urlStr);
    let type: string | null = null;
    let defaultPort = 0;

    const protocol = parsed.protocol.replace(':', '');
    if (protocol.startsWith('mysql')) {
      type = 'mysql';
      defaultPort = 3306;
    } else if (protocol.startsWith('postgres') || protocol === 'pgsql') {
      type = 'postgresql';
      defaultPort = 5432;
    } else if (protocol === 'sqlite' || protocol === 'sqlite3') {
      type = 'sqlite';
    }

    if (!type) {
      return null;
    }

    if (type === 'sqlite') {
      const filePath = parsed.pathname || parsed.hostname;
      return {
        type: 'sqlite',
        database: filePath,
        filepath: filePath,
      } as any;
    }

    const host = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, '') || '');

    return {
      type,
      host,
      port,
      username,
      password,
      database,
    } as any;
  } catch (err) {
    return null;
  }
}

export async function detectDatabaseConfigsInFile(filePath: string, workspaceName: string): Promise<Partial<ConnectionConfig>[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const env: Record<string, string> = {};

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        let val = parts.slice(1).join('=').trim();
        val = val.replace(/^["'](.*)["']$/, '$1');
        env[key] = val;
      }
    }

    const configs: Partial<ConnectionConfig>[] = [];

    // 1. Check for DATABASE_URL or similar URL variables
    const urlVars = ['DATABASE_URL', 'DB_URL', 'SPRING_DATASOURCE_URL', 'JAWSDB_URL', 'CLEARDB_DATABASE_URL', 'DATABASE_PRIVATE_URL'];
    for (const key of Object.keys(env)) {
      if (urlVars.includes(key) || key.endsWith('_DATABASE_URL') || key.endsWith('_DB_URL')) {
        let urlStr = env[key];
        if (urlStr.startsWith('jdbc:')) {
          urlStr = urlStr.substring(5);
        }
        const parsed = parseDatabaseUrl(urlStr, env);
        if (parsed) {
          if (parsed.type === DatabaseType.SQLite) {
            const sqlitePath = parsed.filepath || parsed.database;
            if (sqlitePath && !path.isAbsolute(sqlitePath)) {
              const resolved = path.resolve(path.dirname(filePath), sqlitePath);
              parsed.database = resolved;
              parsed.filepath = resolved;
            }
          }
          if (!parsed.username && (env.DB_USERNAME || env.DB_USER || env.SPRING_DATASOURCE_USERNAME)) {
            parsed.username = env.DB_USERNAME || env.DB_USER || env.SPRING_DATASOURCE_USERNAME;
          }
          if (!parsed.password && (env.DB_PASSWORD || env.DB_PASS || env.SPRING_DATASOURCE_PASSWORD)) {
            parsed.password = env.DB_PASSWORD || env.DB_PASS || env.SPRING_DATASOURCE_PASSWORD;
          }
          configs.push(parsed);
        }
      }
    }

    // 2. Check for Laravel style DB_* variables
    if (env.DB_CONNECTION || env.DB_HOST || env.DB_DATABASE) {
      let type = env.DB_CONNECTION || 'mysql';
      if (type === 'pgsql') { type = 'postgresql'; }

      if (['mysql', 'mariadb', 'postgresql', 'sqlite'].includes(type)) {
        if (type === 'sqlite') {
          let fp = env.DB_DATABASE || env.DB_FILEPATH || 'database.sqlite';
          if (!path.isAbsolute(fp)) {
            fp = path.resolve(path.dirname(filePath), fp);
          }
          configs.push({
            type: DatabaseType.SQLite,
            database: fp,
            filepath: fp,
          });
        } else {
          configs.push({
            type: type as DatabaseType,
            host: env.DB_HOST || '127.0.0.1',
            port: parseInt(env.DB_PORT || '', 10) || (type === 'postgresql' ? 5432 : 3306),
            username: env.DB_USERNAME || env.DB_USER || 'root',
            password: env.DB_PASSWORD || env.DB_PASS || '',
            database: env.DB_DATABASE || env.DB_NAME || '',
          });
        }
      }
    }

    // 3. Check for Django database variables if present
    if (env.DB_ENGINE || env.DB_NAME) {
      let engine = env.DB_ENGINE || '';
      let type: string | null = null;
      if (engine.includes('mysql')) { type = 'mysql'; }
      else if (engine.includes('postgresql') || engine.includes('postgis')) { type = 'postgresql'; }
      else if (engine.includes('sqlite')) { type = 'sqlite'; }

      if (type) {
        if (type === 'sqlite') {
          let fp = env.DB_NAME || 'db.sqlite3';
          if (!path.isAbsolute(fp)) {
            fp = path.resolve(path.dirname(filePath), fp);
          }
          configs.push({
            type: DatabaseType.SQLite,
            database: fp,
            filepath: fp,
          });
        } else {
          configs.push({
            type: type as DatabaseType,
            host: env.DB_HOST || 'localhost',
            port: parseInt(env.DB_PORT || '', 10) || (type === 'postgresql' ? 5432 : 3306),
            username: env.DB_USER || 'root',
            password: env.DB_PASSWORD || '',
            database: env.DB_NAME || '',
          });
        }
      }
    }

    // Deduplicate configs found within this file
    const uniqueConfigs: Partial<ConnectionConfig>[] = [];
    for (const c of configs) {
      const exists = uniqueConfigs.some(
        uc => uc.type === c.type &&
              (uc.type === 'sqlite'
                ? uc.filepath === c.filepath
                : uc.host === c.host && uc.port === c.port && uc.database === c.database && uc.username === c.username)
      );
      if (!exists) {
        uniqueConfigs.push(c);
      }
    }

    return uniqueConfigs;
  } catch (err) {
    Logger.getInstance().logError(`Failed to detect configs in ${filePath}`, err);
    return [];
  }
}

async function scanWorkspaceForDatabaseConfigs() {
  if (!vscode.workspace.workspaceFolders) {
    return;
  }

  const savedConnections = await connectionManager.getSavedConnections();
  let importedCount = 0;
  const knownSqlitePaths = new Set(
    savedConnections
      .filter(c => c.type === DatabaseType.SQLite)
      .map(c => c.filepath || c.database || '')
      .filter(Boolean)
      .map(p => path.resolve(p))
  );

  for (const folder of vscode.workspace.workspaceFolders) {
    const rootPath = folder.uri.fsPath;
    const workspaceName = folder.name;

    try {
      const files = await glob('**/.env{,.local,.development,.production,.test}', {
        cwd: rootPath,
        absolute: true,
        ignore: ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**'],
      });

      for (const filePath of files) {
        const detected = await detectDatabaseConfigsInFile(filePath, workspaceName);
        for (const config of detected) {
          // Check if this config already exists
          const exists = savedConnections.some(
            sc => sc.type === config.type &&
                  (config.type === 'sqlite'
                    ? sc.filepath === config.filepath
                    : sc.host === config.host && sc.port === config.port && sc.database === config.database && sc.username === config.username)
          );

          if (!exists) {
            const fileName = path.basename(filePath);
            const dirName = path.basename(path.dirname(filePath));
            const locationLabel = dirName === workspaceName ? fileName : `${dirName}/${fileName}`;

            const newConfig: ConnectionConfig = {
              id: uuidv4(),
              name: `${workspaceName} - ${config.database ? path.basename(config.database) : 'db'} (${config.type})`,
              type: config.type as DatabaseType,
              host: config.host || '',
              port: config.port || 0,
              username: config.username || '',
              password: config.password || '',
              database: config.database || '',
              filepath: config.filepath || '',
              ssl: { mode: SSLMode.Disabled },
              ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
              options: {
                ...(config.options || {}),
                tableproAutoImported: true,
                tableproWorkspaceRoot: rootPath,
                tableproSourceFile: filePath,
              },
              group: `Imported (${workspaceName})`,
              tags: ['auto-imported', workspaceName],
              color: '',
              createdAt: Date.now(),
              updatedAt: Date.now()
            };

            await connectionManager.saveConnection(newConfig);
            const sqliteConfigPath = newConfig.filepath || newConfig.database;
            if (newConfig.type === DatabaseType.SQLite && sqliteConfigPath) {
              knownSqlitePaths.add(path.resolve(sqliteConfigPath));
            }
            importedCount++;
            Logger.getInstance().logInfo(`Auto-imported connection '${newConfig.name}' from ${locationLabel}`);
          }
        }
      }

      const sqliteFiles = await glob('**/*.{sqlite,sqlite3,db}', {
        cwd: rootPath,
        absolute: true,
        ignore: ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.vscode-test/**'],
      });

      for (const sqlitePath of sqliteFiles) {
        const resolvedPath = path.resolve(sqlitePath);
        if (knownSqlitePaths.has(resolvedPath)) {
          continue;
        }

        const fileName = path.basename(sqlitePath);
        const newConfig: ConnectionConfig = {
          id: uuidv4(),
          name: `${workspaceName} - ${fileName} (sqlite)`,
          type: DatabaseType.SQLite,
          host: '',
          port: 0,
          username: '',
          password: '',
          database: resolvedPath,
          filepath: resolvedPath,
          ssl: { mode: SSLMode.Disabled },
          ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
          options: {
            tableproAutoImported: true,
            tableproWorkspaceRoot: rootPath,
            tableproSourceFile: resolvedPath,
          },
          group: `Imported (${workspaceName})`,
          tags: ['auto-imported', workspaceName, 'sqlite-file'],
          color: '',
          createdAt: Date.now(),
          updatedAt: Date.now()
        };

        await connectionManager.saveConnection(newConfig);
        knownSqlitePaths.add(resolvedPath);
        importedCount++;
        Logger.getInstance().logInfo(`Auto-imported SQLite file '${newConfig.name}' from workspace scan`);
      }
    } catch (err) {
      Logger.getInstance().logError(`Failed to scan workspace folder ${rootPath} for DB configs`, err);
    }
  }

  if (importedCount > 0) {
    vscode.window.showInformationMessage(`TablePro: Auto-imported ${importedCount} database connection(s) for this workspace.`);
  }

  connectionTreeProvider.refresh();
}

  function getQueryContextTitle(document: vscode.TextDocument): string | undefined {
    if (document.languageId !== 'sql') return undefined;
    const mapped = queryDocContexts[document.uri.toString()];
    if (mapped) {
      return `$(database) ${mapped.connectionName} [${mapped.database || 'main'}]`;
    }
    const activeConnId = connectionManager.activeConnectionId;
    if (activeConnId) {
      const conn = connectionManager.activeConnection;
      return `$(database) ${conn?.config.name || 'Connected'} [${conn?.config.database || 'main'}]`;
    }
    return 'Select a connection';
  }

  async function updateStatusBar() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'sql') {
      const uri = editor.document.uri.toString();
      const mapped = queryDocContexts[uri];

      let text = 'TablePro: Select DB';
      if (mapped) {
        text = `TablePro: ${mapped.connectionName} [${mapped.database || 'main'}]`;
      } else {
        const activeConnId = connectionManager.activeConnectionId;
        if (activeConnId) {
          const conn = connectionManager.activeConnection;
          const connName = conn?.config.name || 'Connected';
          const db = await getCurrentDatabaseName(activeConnId);
          text = `TablePro: ${connName} [${db || 'main'}]`;

          queryDocContexts[uri] = {
            connectionId: activeConnId,
            connectionName: connName,
            database: db
          };
          await extensionContext.workspaceState.update('queryDocContexts', queryDocContexts);
        }
      }
      queryContextStatusBarItem.text = text;
      queryContextStatusBarItem.command = 'tablepro.changeQueryContext';
      queryContextStatusBarItem.show();
      sqlCodeLensProvider?.refresh();
    } else {
      queryContextStatusBarItem.hide();
    }
  }

  async function applyQueryContext(doc: vscode.TextDocument): Promise<void> {
    const uri = doc.uri.toString();
    const mapped = queryDocContexts[uri];
    if (mapped) {
      if (!connectionManager.isConnected(mapped.connectionId)) {
        try {
          await connectionManager.connect(mapped.connectionId);
        } catch (err) {
          throw new Error(`TablePro: Connection "${mapped.connectionName}" is not active. Please connect first.`);
        }
      }
      if (connectionManager.activeConnectionId !== mapped.connectionId) {
        connectionManager.setActiveConnection(mapped.connectionId);
      }
      const driver = connectionManager.getDriver(mapped.connectionId);
      const currentDb = driver ? await getCurrentDatabaseName(mapped.connectionId) : '';
      if (driver && mapped.database && currentDb !== mapped.database) {
        try {
          await driver.switchDatabase(mapped.database);
        } catch (err) {
          // ignore SQLite unsupported errors
        }
      }
      updateStatusBar();
    } else {
      const activeConnId = connectionManager.activeConnectionId;
      if (activeConnId) {
        const conn = connectionManager.activeConnection;
        const connName = conn?.config.name || 'Connected';
        const db = await getCurrentDatabaseName(activeConnId);
        queryDocContexts[uri] = {
          connectionId: activeConnId,
          connectionName: connName,
          database: db
        };
        await extensionContext.workspaceState.update('queryDocContexts', queryDocContexts);
        updateStatusBar();
      }
    }
  }

export function deactivate() {
  connectionManager?.dispose();
  webviewManager?.disposeAll();
  queryHistory?.dispose();
}
