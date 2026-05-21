import * as vscode from 'vscode';

/**
 * Provides CodeLens actions (Run Query, Run All) above SQL statements.
 * Detects statement boundaries and adds clickable lens items.
 */
export class SQLCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private enabled: boolean;

  constructor() {
    this.enabled = vscode.workspace.getConfiguration('tablepro').get('codeLens', true);

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tablepro.codeLens')) {
        this.enabled = vscode.workspace.getConfiguration('tablepro').get('codeLens', true);
        this._onDidChangeCodeLenses.fire();
      }
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled) { return []; }

    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const statements = this.findStatements(text);

    // Add "Run All" at the top if there are multiple statements
    if (statements.length > 1) {
      lenses.push(new vscode.CodeLens(
        new vscode.Range(0, 0, 0, 0),
        {
          title: '▶ Run All Statements',
          command: 'tablepro.runAllQueries',
          tooltip: 'Execute all SQL statements in this file',
        },
      ));
    }

    // Add "Run" above each statement
    for (const stmt of statements) {
      const position = document.positionAt(stmt.start);
      const range = new vscode.Range(position, position);

      lenses.push(new vscode.CodeLens(range, {
        title: '▶ Run',
        command: 'tablepro.runStatementAt',
        arguments: [stmt.start, stmt.end],
        tooltip: 'Execute this statement (Cmd+Enter)',
      }));
    }

    return lenses;
  }

  /**
   * Find SQL statement boundaries in the text.
   * Respects string literals, comments, and semicolons.
   */
  private findStatements(text: string): Array<{ start: number; end: number }> {
    const statements: Array<{ start: number; end: number }> = [];
    let currentStart = -1;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;
    let hasContent = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];

      // Track start of content (skip leading whitespace)
      if (currentStart === -1 && !inLineComment && !inBlockComment) {
        if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') {
          // Skip comment-only lines
          if (char === '-' && next === '-') {
            inLineComment = true;
            continue;
          }
          if (char === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
          }
          currentStart = i;
          hasContent = true;
        }
        continue;
      }

      if (inLineComment) {
        if (char === '\n') { inLineComment = false; }
        continue;
      }

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          i++;
        }
        continue;
      }

      if (inSingleQuote) {
        if (char === "'" && next === "'") { i++; } // Escaped quote
        else if (char === "'") { inSingleQuote = false; }
        continue;
      }

      if (inDoubleQuote) {
        if (char === '"') { inDoubleQuote = false; }
        continue;
      }

      if (char === '-' && next === '-') { inLineComment = true; i++; continue; }
      if (char === '/' && next === '*') { inBlockComment = true; i++; continue; }
      if (char === "'") { inSingleQuote = true; continue; }
      if (char === '"') { inDoubleQuote = true; continue; }

      if (!hasContent && char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') {
        hasContent = true;
      }

      if (char === ';' && hasContent && currentStart >= 0) {
        statements.push({ start: currentStart, end: i });
        currentStart = -1;
        hasContent = false;
      }
    }

    // Handle final statement without semicolon
    if (currentStart >= 0 && hasContent) {
      statements.push({ start: currentStart, end: text.length - 1 });
    }

    return statements;
  }
}
