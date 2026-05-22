import * as vscode from 'vscode';
import { ConnectionConfig } from '../types';

const CONNECTIONS_KEY = 'tablepro.connections';

/**
 * Persistent storage for connection configurations.
 * Uses VSCode globalState for connection metadata and SecretStorage for passwords.
 */
export class ConnectionStorage {
  constructor(private context: vscode.ExtensionContext) {}

  async getAll(): Promise<ConnectionConfig[]> {
    const connections = this.filterForCurrentWorkspace(
      this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, [])
    );

    // Restore passwords from secret storage
    for (const conn of connections) {
      conn.password = await this.getPassword(conn.id);
      if (conn.ssh.enabled && conn.ssh.authMethod === 'password') {
        conn.ssh.password = await this.getSSHPassword(conn.id);
      }
    }
    return connections;
  }

  async get(id: string): Promise<ConnectionConfig | undefined> {
    const connections = this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
    for (const conn of connections) {
      if (conn.id !== id) { continue; }
      conn.password = await this.getPassword(conn.id);
      if (conn.ssh.enabled && conn.ssh.authMethod === 'password') {
        conn.ssh.password = await this.getSSHPassword(conn.id);
      }
      return conn;
    }
    return undefined;
  }

  async save(config: ConnectionConfig): Promise<void> {
    const connections = await this.getAllWithoutPasswords();

    const index = connections.findIndex(c => c.id === config.id);
    const sanitized = { ...config, password: undefined, ssh: { ...config.ssh, password: undefined, passphrase: undefined } };

    if (index >= 0) {
      connections[index] = sanitized;
    } else {
      connections.push(sanitized);
    }

    await this.context.globalState.update(CONNECTIONS_KEY, connections);

    // Store passwords separately in secure storage
    if (config.password) {
      await this.context.secrets.store(`tablepro.pwd.${config.id}`, config.password);
    }
    if (config.ssh.password) {
      await this.context.secrets.store(`tablepro.ssh.pwd.${config.id}`, config.ssh.password);
    }
    if (config.ssh.passphrase) {
      await this.context.secrets.store(`tablepro.ssh.pp.${config.id}`, config.ssh.passphrase);
    }
  }

  async delete(id: string): Promise<void> {
    const connections = await this.getAllWithoutPasswords();
    const filtered = connections.filter(c => c.id !== id);
    await this.context.globalState.update(CONNECTIONS_KEY, filtered);

    // Clean up secrets
    await this.context.secrets.delete(`tablepro.pwd.${id}`);
    await this.context.secrets.delete(`tablepro.ssh.pwd.${id}`);
    await this.context.secrets.delete(`tablepro.ssh.pp.${id}`);
  }

  async reorder(ids: string[]): Promise<void> {
    const connections = await this.getAllWithoutPasswords();
    const ordered = ids
      .map(id => connections.find(c => c.id === id))
      .filter((c): c is ConnectionConfig => c !== undefined);

    // Add any connections not in the ids list at the end
    const remaining = connections.filter(c => !ids.includes(c.id));
    await this.context.globalState.update(CONNECTIONS_KEY, [...ordered, ...remaining]);
  }

  private async getAllWithoutPasswords(): Promise<ConnectionConfig[]> {
    return this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
  }

  private filterForCurrentWorkspace(connections: ConnectionConfig[]): ConnectionConfig[] {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    if (workspaceFolders.length === 0) {
      return connections.filter(c => !this.isAutoImported(c));
    }

    const roots = workspaceFolders.map(f => this.normalizePath(f.uri.fsPath));
    const names = new Set(workspaceFolders.map(f => f.name));

    return connections.filter(conn => {
      if (!this.isAutoImported(conn)) {
        return true;
      }

      const options = conn.options || {};
      const workspaceRoot = typeof options.tableproWorkspaceRoot === 'string'
        ? this.normalizePath(options.tableproWorkspaceRoot)
        : '';
      if (workspaceRoot && roots.includes(workspaceRoot)) {
        return true;
      }

      const sourceFile = typeof options.tableproSourceFile === 'string'
        ? this.normalizePath(options.tableproSourceFile)
        : '';
      if (sourceFile && roots.some(root => this.isPathInside(sourceFile, root))) {
        return true;
      }

      const dbPath = conn.filepath || (conn.type === 'sqlite' ? conn.database : '');
      if (dbPath) {
        const normalizedDbPath = this.normalizePath(dbPath);
        if (roots.some(root => this.isPathInside(normalizedDbPath, root))) {
          return true;
        }
      }

      const legacyWorkspaceTag = conn.tags?.find(tag => names.has(tag));
      return !!legacyWorkspaceTag;
    });
  }

  private isAutoImported(conn: ConnectionConfig): boolean {
    return conn.tags?.includes('auto-imported') || /^Imported \(.+\)$/.test(conn.group || '');
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  private isPathInside(filePath: string, root: string): boolean {
    return filePath === root || filePath.startsWith(`${root}/`);
  }

  private async getPassword(id: string): Promise<string | undefined> {
    return await this.context.secrets.get(`tablepro.pwd.${id}`);
  }

  private async getSSHPassword(id: string): Promise<string | undefined> {
    return await this.context.secrets.get(`tablepro.ssh.pwd.${id}`);
  }
}
