# JSON Value Editor

JSON/JSONC の設定ファイルを「ツリー＋フォーム」で編集する VS Code 拡張です。スキーマ(JSON)を参照し、型チェックや選択肢の制限をサポートします。

## Features

1. **Tree 表示**: JSON を階層表示し、ノードを辿りながら値を編集できます。
2. **キー名は保持**: 値のみを編集し、キー名は常に元ファイルのまま維持します。
3. **スキーマ連携**:
   - 同名ファイルに `_Schema` サフィックスを付けた JSON を自動検出（例: `config.json` ↔ `config_Schema.json`）。
   - コマンド「Select Schema File」から任意のスキーマを手動指定／解除。
   - スキーマが無い場合は通常の JSON として扱います。
4. **スキーマで定義できるもの**:
   - ノード単位の表示/非表示（`visible`）。
   - ラベル表示名（`label`）と説明（`description`）。
   - 値の範囲／選択肢（`range.min/max` または 配列 `range`）。
   - 型ヒント（`string` / `enum` / `integer` / `number` / `boolean`）。

## Getting Started

### Explorer ツリービュー
1. 拡張をインストール後、エクスプローラーに表示される **Config Editor** ビューを開きます。
2. コマンドパレット or ビュータイトルの **Open Config (Tree)** を実行し、アクティブな JSON ファイルまたはダイアログで選んだファイルを読み込みます。
3. ツリーでノードを選択し、右クリックの **Edit Value** またはインラインの編集ボタンで値を更新します。
   - 数値／ブールなどは型に応じたバリデーションを実行します。
   - スキーマで選択肢を定義している場合は QuickPick が表示されます。
4. **Reload Config Tree** で外部変更を再読込できます。
5. **Select Schema File** でスキーマを手動指定／解除できます。

### Webview パネル（メイン画面）
`Config Editor: Open Config Editor Panel` を実行すると、エディターエリアに専用パネルが開きます。
- 左が検索可能なツリー、右が詳細フォーム。「ツリー + 入力フォーム」で値を編集できます。
- ノード選択でキー名・説明・型などを表示し、スキーマの型/選択肢/範囲に従って入力 UI が変わります。
- パネル上部の「Reload」「Select Schema」で再読込／スキーマ切替。保存すると JSON が整形されて書き戻されます。

## Schema Format

スキーマは JSON で、`fields` に「パス → 設定」形式で記述します。パスは `foo.bar[0].baz` のように `.` 区切りと `[index]` で表現します。

```jsonc
{
  "fields": {
    "server.port": {
      "label": "Server Port",
      "description": "接続ポート",
      "type": "integer",
      "range": { "min": 1024, "max": 65535 }
    },
    "mode": {
      "type": "enum",
      "enum": ["development", "production"],
      "description": "稼働モード"
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

### 主なプロパティ

| プロパティ | 説明 |
| --- | --- |
| `visible` | `false` の場合、そのノードをツリーから隠します。 |
| `label` | ツリー上での表示名。 |
| `description` | ツールチップに表示する説明。 |
| `type` | `string` / `enum` / `integer` / `number` / `boolean`。 |
| `enum` | 選択肢リスト。`type: "enum"` と組み合わせます。 |
| `range` | `{ "min": number, "max": number }` で数値範囲、または `["A","B"]` のように配列を渡すとドロップダウン選択になります。 |

## Commands

| Command | 説明 |
| --- | --- |
| `Config Editor: Open Config (Tree)` | JSON ファイルを選択しツリーに読み込む |
| `Config Editor: Reload Config Tree` | 表示内容を再読込 |
| `Config Editor: Edit Value` | 選択ノードの値を編集 |
| `Config Editor: Select Schema File` | スキーマファイルの手動指定／解除 |
| `Config Editor: Open Config Editor Panel` | Webview ベースのメイン画面パネルを開く |

## Extension Settings

| Setting | デフォルト | 説明 |
| --- | --- | --- |
| `configEditor.schemaSuffix` | `_Schema` | 自動検出時に元ファイル名へ付加するサフィックス |
| `configEditor.schemaSearchPaths` | `[]` | 追加のスキーマ検索パス（フォルダー／相対パス対応） |
| `configEditor.indentSize` | `2` | 値更新時に JSON を整形するインデント幅 |

## Known Issues

- JSON/JSONC のみ対応。他形式を開くと読み込みに失敗します。
- 非プリミティブ値（オブジェクトや配列全体）を直接書き換えることはできません。子要素を編集してください。

## Release Notes

詳細は `CHANGELOG.md` を参照してください。

---

Made with ❤︎ for JSON config editing workflows.
