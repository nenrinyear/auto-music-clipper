# フロントエンドのスタイルガイド

デジタル庁デザインシステムβ版のMarkdown配布資料（2026年9月9日版）を参考に、余韻の画面へ適用した判断を記録します。DADSの公式コンポーネントを導入したものではなく、このアプリ向けにHTML/CSSを実装しています。アクセシビリティ規格への適合認証を示すものではありません。

## 参照した指針と適用

| 参照資料（配布資料内のパス） | 余韻への適用 |
| --- | --- |
| `foundations/typography/index.md` | 本文・ラベル・補足説明は標準16px、行高1.75。見出しは22〜40px。外部フォントの取得をやめ、端末内の日本語フォントを使用。 |
| `foundations/color/index.md` | 明るい背景に濃い文字、主要操作は緑。通常の文字は4.5:1以上、入力の境界線は3:1以上を目標に選色。波形は暗い背景を独立させ、既存の候補色と保存境界を保持。 |
| `foundations/spacing/index.md`、`foundations/layout/index.md` | 4pxを基準に8/12/16/24/32/48pxの余白を使用。幅1040pxまでの一列構成と、狭い画面での折り返し。 |
| `components/button/index.md` | 主要・副次・テキストの3種。ボタンは最小幅44px・高さ48px。黒の外周線と黄色のフォーカス表示。 |
| `components/file-upload/index.md` | ドロップと標準buttonによる選択を併設し、対応形式・長さ・端末内処理を近くに表示。 |
| `components/input-text/index.md`、`components/checkbox/index.md` | 開始・終了に秒単位を明記。標準入力と左側のチェックボックスを使い、ラベル・補足説明を関連付け。 |
| `components/progress-indicator/index.md`、`components/notification-banner/index.md` | 処理状況は`role=status`、エラーは`role=alert`で通知。ダウンロード開始も文字で表示。 |

資料の概要・利用条件は[デジタル庁デザインシステム](https://design.digital.go.jp/dads/)を参照してください。ここでの判断の基準は指定された配布版です。

## 構成と保守

- `web/public/style.css`：色・角丸・余白のトークン、共通コントロール、画面レイアウト、波形周辺、レスポンシブ表示。
- `web/public/worker-flow.css`：解析開始前の案内と処理中表示。
- `web/public/index.html`：読み込み・範囲確認・音量調整・書き出しの見出し、入力ラベル、補足説明。
- `web/public/app.js`：音声処理との接続、ファイル選択後と解析後のフォーカス移動、結果の通知。

画面全体に必要な情報を4段階の見出しで示し、解析前には後続操作を非表示にします。音声処理・検出ロジックは変更していません。波形上のドラッグ操作には、開始・終了の数値入力と再生位置スライダーによるキーボード操作を用意しています。無効な停止・範囲リセット操作には、利用可能になる条件を近くに表示しています。

動きを抑える設定ではスピナーを停止し、処理状況のテキストを残します。波形や音声再生など内容の理解・操作に必要な更新は継続します。

## 検証

`web/browser-test/accessibility.spec.ts`で、キーボードによるファイル選択から書き出し、入力エラーからの復帰、ドロップによる選択、実際のボタン領域、320/390/768px幅の横はみ出し、文字サイズ拡大、動きを抑える設定を検証します。PC・モバイルのスクリーンショットは`web/test-results/editor-desktop.png`と`editor-mobile.png`に出力します。

既存のブラウザテストも併用し、WASM解析・試聴・範囲編集・EQ・書き出しの回帰を確認します。

```sh
npm --prefix web run typecheck
npm --prefix web run test:ci
npm --prefix web run test:browser
```

Node.js 22以上が必要です。インストール済みEdgeを使う場合は`PLAYWRIGHT_CHANNEL=msedge`を指定できます。

今後の確認事項：スクリーンリーダーでの実機読み上げ、OSのハイコントラスト表示、複数ブラウザでの確認。自動テストだけではこれらの利用体験を保証できません。
