# Change Log

All notable changes to the "config-editor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.8] - 2025-11-21

- Rebuilt and republished to include runtime dependencies in the VSIX.

## [0.1.7] - 2025-11-21

- Fixed packaged VSIX missing runtime dependencies by including `node_modules`, preventing `config-editor.openVisualEditor` from failing to register.

## [0.1.6] - 2025-11-21

- Added schema-aware array item management (Add/Remove) with inline index/type/value inputs; selecting an element preselects its index and shows Remove.
- Inline editor supports JSONC configs, schema enum/options, object/array JSON inputs, and clears validation warnings on type change.
- UI polish: inline hints for array values, display/icon updates integrated.

## [0.1.5] - 2025-11-20

- Replaced extension icon with updated artwork for Marketplace and VS Code.

## [0.1.4] - 2025-11-20

- Updated display name to "JSON Value Editor" to avoid Marketplace naming conflicts.

## [0.1.3] - 2025-11-20

- Updated display name to "Json Editor" for clarity in VS Code and Marketplace listings.

## [0.1.2] - 2025-11-20

- Renamed extension package name to `json-value-editor` for Marketplace uniqueness.

## [0.1.1] - 2025-11-20

- Added extension icon so the Marketplace listing and VS Code show branded artwork.
- Usage (quick start):
  1. In VS Code, run `Config Editor: Open Config (Tree)` from the Command Palette.
  2. Choose a JSON/JSONC file to open in the tree.
  3. If a schema with the `_Schema` suffix exists nearby it is detected automatically; otherwise run `Config Editor: Select Schema File` to pick one.
  4. Expand the tree, select a node, and use `Config Editor: Edit Value` (or the pencil in the panel) to update values; save writes back to disk with the configured indent.
  5. Use `Config Editor: Reload Config Tree` after external edits to refresh the view.

## [0.1.0] - 2025-11-14

- 初回リリース: JSON ツリービュー、スキーマ対応、値編集コマンドを追加
