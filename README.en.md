# JSON Value Editor

A VS Code extension that edits JSON/JSONC config files with a "tree + form" experience. It reads an optional JSON schema to validate types and restrict choices.

## Features

1. **Tree view**: Browse and edit values directly from a hierarchical tree.
2. **Keys stay untouched**: Only values are edited; keys remain exactly as in the source file.
3. **Schema-aware**:
   - Auto-detects a JSON schema with the `_Schema` suffix next to the target file (e.g., `config.json` <-> `config_Schema.json`).
   - You can manually select/clear a schema via the "Select Schema File" command.
   - If no schema is found, the file is treated as plain JSON.
4. **What a schema can define**:
   - Show/hide nodes (`visible`).
   - Label (`label`) and description (`description`).
   - Value ranges or allowed options (`range.min/max` or array `range`).
   - Type hints (`string` / `enum` / `integer` / `number` / `boolean`).

## Getting Started

### Explorer tree view
1. After installation, open the **Config Editor** view in the Explorer sidebar.
2. Run **Open Config (Tree)** from the Command Palette or the view title, then choose the active JSON file or pick one via dialog.
3. Select a node in the tree and update its value via **Edit Value** (context menu) or the inline edit button.
   - Number/boolean fields are validated according to their types.
   - If the schema defines choices, a QuickPick list is shown.
4. Use **Reload Config Tree** to refresh after external edits.
5. Use **Select Schema File** to manually set or clear the schema.

### Webview panel (main UI)
Run `Config Editor: Open Config Editor Panel` to open the full editor panel.
- Left: searchable tree; right: detail form. Edit values with "tree + form".
- Selecting a node shows key/description/type; input controls follow schema type/options/range.
- "Reload" and "Select Schema" buttons let you refresh or switch schema. Saving writes the formatted JSON back to disk.

## Schema Format

Schemas are JSON objects whose `fields` map paths to settings. Paths use dot and `[index]` syntax, e.g. `foo.bar[0].baz`.

```jsonc
{
  "fields": {
    "server.port": {
      "label": "Server Port",
      "description": "Connection port",
      "type": "integer",
      "range": { "min": 1024, "max": 65535 }
    },
    "mode": {
      "type": "enum",
      "enum": ["development", "production"],
      "description": "Mode"
    },
    "features[0]": {
      "label": "First feature",
      "visible": false
    },
    "log.level": {
      "label": "Log Level",
      "range": ["debug", "info", "warn", "error"]
    }
  }
}
```

### Key properties

| Property | Description |
| --- | --- |
| `visible` | Hide the node from the tree when `false`. |
| `label` | Display name in the tree. |
| `description` | Tooltip/help text. |
| `type` | `string` / `enum` / `integer` / `number` / `boolean`. |
| `enum` | Choice list; use with `type: "enum"`. |
| `range` | `{ "min": number, "max": number }` for numeric bounds, or an array like `["A","B"]` for dropdown choices. |

## Commands

| Command | Description |
| --- | --- |
| `Config Editor: Open Config (Tree)` | Load a JSON file into the tree |
| `Config Editor: Reload Config Tree` | Refresh the tree |
| `Config Editor: Edit Value` | Edit the selected node |
| `Config Editor: Select Schema File` | Manually set/clear the schema file |
| `Config Editor: Open Config Editor Panel` | Open the main Webview panel |

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `configEditor.schemaSuffix` | `_Schema` | Suffix appended to the base file name when auto-detecting schemas |
| `configEditor.schemaSearchPaths` | `[]` | Extra schema search paths (folders; relative paths supported) |
| `configEditor.indentSize` | `2` | Indent size used when writing JSON |

## Known Issues

| Issue | Notes |
| --- | --- |
| Format support | Only JSON/JSONC are supported; other formats will fail to load. |
| Non-primitive edits | Objects/arrays cannot be rewritten as a whole—edit their child nodes instead. |

## Release Notes

See `CHANGELOG.md` for version history.

---

Made with love for JSON config editing workflows.
