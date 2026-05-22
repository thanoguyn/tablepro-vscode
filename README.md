# TablePro - Database Client for VS Code

TablePro is a VS Code extension for browsing databases, running SQL, viewing table data, and working with local SQLite files directly inside the editor.

It is currently an early release (`0.1.1`) focused on MySQL, PostgreSQL, and SQLite workflows.

## Features

- Manage database connections from the TablePro activity bar.
- Connect to MySQL, PostgreSQL, and SQLite databases.
- Open `.db`, `.sqlite`, and `.sqlite3` files with the TablePro SQLite viewer.
- Browse schemas, tables, views, columns, indexes, and foreign keys.
- Open table data in an editable data grid.
- Run SQL queries from `.sql` files with CodeLens actions.
- Associate each query editor with a connection and database context.
- Create new query tabs with the active database preselected.
- Sort, filter, paginate, copy, and inspect result data.
- Copy rows or visible pages as CSV, TSV, JSON, XML, SQL `INSERT`, or SQL `UPDATE`.
- Use an embedded Quick View sidebar for row details and long values.
- View recent grid activity in the embedded bottom log panel.
- Preview and save table edits.
- Generate table structure and DDL views.
- Export and import table data.
- Open ER diagrams and query execution plans.
- Use SSH tunneling for supported connection types.
- Auto-detect database configuration from project `.env` files and SQLite files.

## Supported Databases

| Database | Status |
| --- | --- |
| MySQL / MariaDB-compatible | Supported |
| PostgreSQL | Supported |
| SQLite | Supported via `sql.js` |
| Redis, MongoDB, MSSQL | Listed for future expansion |

## Getting Started

1. Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=thanoguyn.tablepro-vscode).
2. Open the TablePro activity bar item.
3. Click **New Connection**.
4. Choose a database type and enter connection details.
5. Click **Connect**.
6. Browse the schema tree or create a new SQL query.

Marketplace install:

```bash
code --install-extension thanoguyn.tablepro-vscode
```

You can also install it from VS Code:

1. Open **Extensions**.
2. Search for **TablePro Vscode - Database Client**.
3. Click **Install**.

For manual VSIX installation instructions, see [INSTALL_VSIX.md](./INSTALL_VSIX.md).

Quick install from GitHub:

```bash
curl -L -o /tmp/tablepro-vscode.vsix https://github.com/thanoguyn/tablepro-vscode/raw/main/tablepro-vscode.vsix && code --install-extension /tmp/tablepro-vscode.vsix --force
```

For Agy IDE: 

```bash
curl -L -o /tmp/tablepro-vscode.vsix https://github.com/thanoguyn/tablepro-vscode/raw/main/tablepro-vscode.vsix && agy-ide --install-extension /tmp/tablepro-vscode.vsix --force
```

## SQLite Files

TablePro registers a custom editor for:

- `*.db`
- `*.sqlite`
- `*.sqlite3`

Double-clicking one of these files opens it through TablePro and adds it as a local SQLite connection. Workspace scans also auto-import SQLite files found in the project, excluding common generated folders such as `node_modules`, `.git`, `dist`, and `build`.

## Query Workflow

Open or create a `.sql` file, then use:

- **Run** CodeLens above a SQL statement.
- **Run All Statements** when multiple statements are present.
- **Change Query Database Context** to choose the target connection/database.
- **New Query** to create a new SQL document using the active connection.

Query documents keep their selected TablePro connection context in VS Code workspace state.

## Data Grid

The data grid supports:

- Server-side pagination for opened tables.
- Sorting and WHERE filters.
- Cell and range selection.
- Copying selected cells, rows, visible pages, or full table data.
- Inline editing for supported table views.
- Add, duplicate, delete, preview SQL, save, and discard changes.
- Embedded right-side Quick View for selected rows.
- Embedded bottom activity log with a list/detail layout.

## Keyboard Shortcuts

| Shortcut | Command |
| --- | --- |
| `Cmd/Ctrl+Enter` | Run current query |
| `Cmd/Ctrl+Shift+Enter` | Run all statements |
| `Cmd/Ctrl+.` | Cancel running query |
| `Cmd/Ctrl+Shift+L` | Format SQL |
| `Cmd/Ctrl+Shift+H` | Query history |
| `Ctrl+T` | New query for the active connection |
| `Cmd/Ctrl+Option+T` | Quick table switcher |

Note: exact key behavior may vary by operating system and existing VS Code keybindings.

## Settings

TablePro contributes these settings:

| Setting | Default | Description |
| --- | --- | --- |
| `tablepro.defaultRowsPerPage` | `1000` | Default rows per page in the data grid |
| `tablepro.autoSaveQueries` | `false` | Auto-save SQL documents before running |
| `tablepro.queryTimeout` | `30` | Query timeout in seconds (`0` disables timeout) |
| `tablepro.autoUppercaseKeywords` | `false` | Auto-uppercase SQL keywords while typing |
| `tablepro.safeMode` | `true` | Confirm before executing write queries |
| `tablepro.maxReconnectAttempts` | `3` | Maximum reconnect attempts |
| `tablepro.idleTimeout` | `300` | Idle connection timeout in seconds (`0` disables timeout) |
| `tablepro.codeLens` | `true` | Show SQL Run CodeLens actions |

## Development

Install dependencies:

```bash
npm install
cd webview-ui
npm install
cd ..
```

Build the extension and webview:

```bash
npm run build
```

Run TypeScript checks/tests compilation:

```bash
npm run compile:tests
```

Package a VSIX:

```bash
npm run package
```

The generated `.vsix` can be installed with the instructions in [INSTALL_VSIX.md](./INSTALL_VSIX.md).

## Project Structure

```text
src/
  core/          Connection, query, schema, driver, and utility logic
  views/         VS Code tree views, webview managers, and editor providers
  test/          Extension tests
webview-ui/
  src/panels/    React webview panels for grids, forms, diagrams, quick views
media/           Extension icons and static assets
dist/            Build output
```

## Security Notes

- Credentials are stored through the extension's connection storage flow.
- Safe mode is enabled by default for write queries.
- Review SQL before running write operations, especially generated edit statements.
- SSH tunneling depends on your local SSH configuration and supplied credentials.

## License

MIT
