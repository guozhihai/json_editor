# Config Editor

JSONフォーマットのコンフィグファイルをツリービューで編集するための VS Code 拡張機能です。拡張機能はスキーマファイルを参照しながら値の編集や選択肢の制限をサポートします。

## Features

1. **Tree表示** – JSON を展開した状態で表示し、階層を辿りながら編集箇所を探せます。
2. **キー(タグ)編集不可** – 値のみを編集し、キー名は常に JSON 原本の状態を維持します。
3. **スキーマをサポート**  
   1. 同名ファイルにポストフィックス「_Schema」を付けた JSON を自動で読み込みます（例: `config.json` → `config_Schema.json`）。  
   2. メニューの「Select Schema File」コマンドから任意のスキーマを指定可能です。  
   3. スキーマファイルが存在しない場合は通常の JSON として表示します。
4. **スキーマで定義できること**  
   1. 個々の項目について表示/非表示を切り替え（デフォルト：表示）。  
   2. 任意の表示名（label）を設定（デフォルト：タグ名）。  
   3. 説明文（description）を追加（デフォルト：なし）。  
   4. 値の範囲を指定可能。`range.min/max` で数値範囲、配列（`range: ["low","medium","high"]`）を指定するとドロップダウン選択になります（デフォルト：制限なし）。  
   5. タイプ（`string` / `enum` / `integer` / `number` / `boolean`）を指定して入力支援を行います（デフォルト：`string`）。

## Getting Started

### Explorer ツリービュー

1. 拡張機能をインストールし、VS Code のエクスプローラー下部に表示される **Config Editor** ビューを表示します。
2. コマンドパレットまたはビュータイトルの **Open Config (Tree)** を実行すると、アクティブな JSON ファイルまたはファイルダイアログで選んだファイルが読み込まれます。
3. ツリー内の値ノードを右クリックして **Edit Value** を実行するか、インラインの編集ボタンを押して値を更新します。  
   - 数値やブール値は型に応じたバリデーションが行われます。  
   - スキーマで選択肢を定義している場合は QuickPick が表示されます。
4. **Reload Config Tree** でファイルを再読込できます。  
5. **Select Schema File** から現在の設定ファイルに紐づくスキーマを手動で指定／解除できます。

### Webview パネル（メイン画面）

`Config Editor: Open Config Editor Panel` コマンド（またはエクスプローラーで JSON を右クリック）を実行すると、メインエディターエリアに専用パネルが開きます。

- 左側が検索可能なツリー、右側が詳細フォームとなり、Python 版ツールと同等の「ツリー + 入力フォーム」UI を VS Code 内で再現します。
- ツリーでノードを選択するとキー／説明／型などが表示され、スキーマの選択肢や値域情報に従ってドロップダウン／数値入力が切り替わります。
- パネル上部の「Reload」「Select Schema」ボタンで再読込やスキーマ切り替えができます。保存すると即座に JSON が整形されて書き戻されます。

## Schema Format

スキーマファイルは JSON で、`fields` プロパティまたはトップレベルに「パス → 設定」形式で記述します。パスは `foo.bar[0].baz` のように `.` 区切りと `[index]` で配列要素を表現します。

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
| `visible` | `false` の場合、その項目をツリーから隠します。 |
| `label` | ツリー上で表示される名前。 |
| `description` | ツールチップに表示される説明。 |
| `type` | `string` / `enum` / `integer` / `number` / `boolean`。 |
| `enum` | 選択肢リスト。`type: "enum"` と組み合わせます。 |
| `range` | `{ "min": number, "max": number }` で数値範囲、または `["A","B"]` のように配列を指定するとドロップダウン選択になります。 |

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

- 現在は JSON/JSONC のみを対象にしています。他形式を開くと読み込みに失敗します。
- 非プリミティブ値（オブジェクトや配列）を直接書き換えることはできません。子要素を編集してください。

## Release Notes

### 0.1.0

- ツリービューによる JSON 編集とスキーマ連携を実装。
- 値の型バリデーションと選択肢の制約を追加。

---

Made with ❤️ for JSON config editing workflows.
