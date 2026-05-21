import * as vscode from 'vscode';
import { ExtensionMessage, WebviewMessage, QueryResult } from '../../core/types';

export class QueryResultsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tablepro.queryResultsView';
  private _view?: vscode.WebviewView;
  private _lastResult?: QueryResult;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onMessageCallback: (message: WebviewMessage) => void
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media')
      ]
    };

    webviewView.webview.html = this.getWebviewHTML(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        if (message.type === 'ready') {
          if (this._lastResult) {
            webviewView.webview.postMessage({ type: 'queryResult', data: this._lastResult });
          }
        }
        this.onMessageCallback(message);
      },
      undefined,
      this.context.subscriptions
    );

    // Send initial theme
    this.sendThemeInfo();
  }

  public postMessage(message: ExtensionMessage) {
    if (message.type === 'queryResult') {
      this._lastResult = message.data;
    }
    if (this._view) {
      this._view.show(true); // reveal/focus the panel view
      this._view.webview.postMessage(message);
    }
  }

  private sendThemeInfo(): void {
    if (!this._view) return;
    const kind = vscode.window.activeColorTheme.kind;
    let themeKind: 'light' | 'dark' | 'highContrast' = 'dark';
    if (kind === vscode.ColorThemeKind.Light) { themeKind = 'light'; }
    else if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) {
      themeKind = 'highContrast';
    }

    this._view.webview.postMessage({
      type: 'theme',
      data: { kind: themeKind },
    } as ExtensionMessage);
  }

  private getWebviewHTML(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.css')
    );

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    font-src ${webview.cspSource};
    img-src ${webview.cspSource} data: https:;
  ">
  <link rel="stylesheet" href="${styleUri}">
  <title>TablePro Query Results</title>
</head>
<body data-panel-type="dataGrid">
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__PANEL_TYPE__ = "dataGrid";
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
      nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
  }
}
