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
    const connections = this.context.globalState.get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
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
    const connections = await this.getAll();
    return connections.find(c => c.id === id);
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

  private async getPassword(id: string): Promise<string | undefined> {
    return await this.context.secrets.get(`tablepro.pwd.${id}`);
  }

  private async getSSHPassword(id: string): Promise<string | undefined> {
    return await this.context.secrets.get(`tablepro.ssh.pwd.${id}`);
  }
}
