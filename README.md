# 🚀 Cogent: AI搭載 VS Code コーディングアシスタント

> 「ラバーダックデバッグは、話しかけてくれるダックがいるともっと良い！」

![Cogent デモ](assets/cogent.gif)

Cogentは、GitHub Copilot Chatと連携するVS Code拡張機能です。ファイル操作・コマンド実行・安全な差分更新などを、ユーザーの承認を得ながら自律的に行います。

## 🎯 必要条件

- 💳 GitHub Copilot サブスクリプション
- 📦 VS Code 1.95.0以上
- 🤖 GitHub Copilot Chat拡張

## ✨ 主な機能

- 🤖 自律型エージェント：最小限の監督で安全に動作
- 📝 ファイル操作：作成・読み取り・更新・差分適用（大きなファイルも安全に処理）
- 🎮 コマンド実行：チャットからターミナルコマンドを実行
- 🧠 ワークスペース認識：.gitignoreや.cogentrules対応
- 🔒 すべての変更・コマンド実行時に必ず承認を要求
- 📚 ワークスペース読込：全体/オンデマンドで切替可能
- 📜 独自ルール：.cogentrulesでプロジェクト固有のポリシー設定

## 🚀 インストール方法

### 開発用

1. リポジトリをクローン
2. 依存関係をインストール
   ```bash
   npm install
   ```
3. 拡張機能をコンパイル
   ```bash
   npm run compile
   ```
4. VS CodeでF5キーを押してデバッグ開始

### 配布用

1. vsceをグローバルインストール
   ```bash
   npm install -g @vscode/vsce
   ```
2. 拡張機能をパッケージ化
   ```bash
   vsce package
   ```
   `.vsix`ファイルが作成されます。

## ⚙️ 設定

- `cogent.use_full_workspace`：起動時に全ファイル読込（デフォルト: false）
- `cogent.autoConfirmTools`：各操作の自動承認設定（詳細はpackage.json参照）
- `.cogentrules`：プロジェクト独自ルールを追加

## 🎮 使い方

1. VS CodeでCopilot Chatを開く
2. `@Cogent`と要望を入力
3. Cogentが計画を提示し、承認後に安全に実行

> すべてのファイル操作・コマンド実行・重要な変更は必ず承認が必要です。

## 💬 会話例

```
あなた: "@Cogent src/oldFile.tsを削除して"
Cogent: "計画: src/oldFile.tsを削除します。よろしいですか？"
```

```
あなた: "@Cogent src/index.tsにロガーを追加して"
Cogent: "計画: src/index.tsにロガーを追加します。差分適用前に確認します。"
```

## 🐛 バグ報告・貢献

- バグ発見時はGitHubでIssueを作成してください。
- 貢献歓迎！Fork→ブランチ作成→PRでどうぞ。

## 📜 ライセンス

MITライセンス

---

開発者の皆さんに、愛とコーヒーを込めて作りました！

## 🆕 v1からの主な更新点

- 独自ツールは「cogent_removeFile」のみ。他の操作はVS Code/Copilot組み込みツールを利用
- すべての操作・コマンド実行時に必ずユーザー承認を要求
- `cogent.autoConfirmTools`で自動承認の細かい制御が可能
- 200行超のファイルは一括編集禁止。差分適用方式（apply-diff）を推奨
- .gitignoreや.cogentrulesを自動認識し、不要ファイルや独自ルールを反映
- 設定項目の追加・拡充（全ファイル読込ON/OFF、コマンドタイムアウト等）
- チャットで「@Cogent」と要望を入力するだけで、計画提示→承認→安全な実行まで自動化
- 変更履歴やツール呼び出し結果の説明を明確化