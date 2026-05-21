# Installing TablePro from a VSIX File

This guide explains how to install TablePro from a local `.vsix` package.

## Requirements

- Visual Studio Code `1.95.0` or newer.
- A TablePro VSIX file, for example:

```text
tablepro-0.1.0.vsix
```

## Option 1: Install from the VS Code UI

1. Open VS Code.
2. Open the Extensions view.
3. Click the `...` menu in the top-right of the Extensions view.
4. Select **Install from VSIX...**.
5. Choose the TablePro `.vsix` file.
6. Reload VS Code if prompted.

After installation, the TablePro icon should appear in the Activity Bar.

## Option 2: Install from the Command Line

Run:

```bash
code --install-extension tablepro-0.1.0.vsix
```

If the VSIX file is in another folder, pass the full path:

```bash
code --install-extension /path/to/tablepro-0.1.0.vsix
```

Then restart or reload VS Code if needed.

## Building the VSIX Locally

From the project root:

```bash
npm install
cd webview-ui
npm install
cd ..
npm run build
npm run package
```

The package command creates a `.vsix` file in the project root.

## Updating an Existing VSIX Installation

Install the newer VSIX with the same command:

```bash
code --install-extension tablepro-0.1.0.vsix --force
```

Reload VS Code after the installation completes.

## Uninstalling

From the VS Code UI:

1. Open the Extensions view.
2. Search for **TablePro**.
3. Click **Uninstall**.
4. Reload VS Code if prompted.

From the command line:

```bash
code --uninstall-extension tablepro.tablepro
```

## Troubleshooting

If the `code` command is not found:

1. Open VS Code.
2. Open the Command Palette.
3. Run **Shell Command: Install 'code' command in PATH**.
4. Open a new terminal and try again.

If SQLite files do not open with TablePro:

1. Confirm the file extension is `.db`, `.sqlite`, or `.sqlite3`.
2. Right-click the file in VS Code.
3. Choose **Open With...**.
4. Select **TablePro SQLite Viewer**.

If the extension does not appear:

1. Open the Extensions view.
2. Search for `TablePro`.
3. Confirm it is enabled.
4. Run **Developer: Reload Window** from the Command Palette.
