# Cloudflareデプロイ手順

更新日: 2026-10-30

この手順はクライアントWASM版を対象とする。Cloudflare Workersの静的アセット配信を使い、解析・切り出し・ノーマライズは利用者のブラウザで実行する。Workers Freeで配信でき、Workers Paid、R2、Rustサーバー、Tunnel、音声アップロード用APIの準備は不要。

## 1. GitHub連携で公開する

### リポジトリを接続

1. Cloudflareダッシュボードの **Workers & Pages** からWorkerの作成を開き、GitHubリポジトリをインポートする。PagesではなくWorkersを選ぶ。
2. GitHub連携を認可し、`nenrinyear/auto-music-clipper` を選択する。リポジトリが表示されない場合は、GitHub側の **Cloudflare Workers and Pages** アプリのリポジトリアクセスへ追加する。
3. 本番ブランチを `main` にする。
4. Worker名を `web` にする。現在の `web/wrangler.jsonc` の `name` と一致させる。別名を使う場合は同ファイルの `name` も変更してコミットする。

既存のWorkerに接続する場合は、そのWorkerの **Settings > Build** でGitリポジトリと次のビルド設定を確認する。画面上の表記は更新によって異なる場合がある。

### ビルド設定

| 項目 | 設定値 |
| --- | --- |
| Root directory | `web` |
| Build command | `npm run build:wasm` |
| Deploy command | `npx wrangler deploy` |
| Build variable | `NODE_VERSION` = `22` |
| 依存パッケージの自動インストール | 有効のまま |
| Build watch paths | 初回は絞らず全体を対象にする |

`web` はコマンドを実行するディレクトリ。ビルドにはルートの `Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml` と `crates/` も必要なため、リポジトリ全体をチェックアウトする。

あとでwatch pathsを絞る場合は、`web/**` だけでなく `crates/**`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml` の変更もビルド対象にする。

WASMビルドは次を自動実行する。

1. Linuxのビルド環境にrustupがなければ `.build-tools/` へ導入する。
2. `rust-toolchain.toml` で指定したRustとWASMターゲットを用意する。
3. `Cargo.lock` と同じバージョンの `wasm-bindgen-cli` を用意する。
4. Rustをコンパイルし、ブラウザ用のJSローダーとWASMを `web/public/wasm/` へ生成する。

初回はRustツール類の取得・コンパイルがあるため時間がかかる。Linux/Cloudflare上の初回ビルドはまだ実測していない。

Deploy commandは `npx wrangler deploy` を使う。`npm run deploy` だと `predeploy` がWASM生成をもう一度実行する。プレビューを有効にする場合も、本番と同じWASMビルド工程を通す。

Git連携のデプロイ認証にはCloudflare側が用意するAPIトークンを使用できる。この構成のためにGitHub ActionsへCloudflareのシークレットを追加する必要はない。

### 初回デプロイと更新

1. 上記設定でビルド・デプロイを開始する。
2. ビルドログでWASM生成が成功し、その後のWranglerデプロイも成功したことを確認する。
3. Cloudflareに表示された `https://…workers.dev` の公開URLを開く。URLはダッシュボードに表示された実際のものを使う。
4. 次節の公開後確認を行う。

以後は接続した `main` へのpushでCloudflare側のビルド・デプロイが起動する。GitHub Actionsのワークフローはテスト担当であり、それ自体はデプロイしない。CloudflareのデプロイがActions完了を待つ設定にはしていないため、公開するコミットの検証結果も確認する。

## 2. 公開後に確認する

1. ページに「録音はこの端末内で処理します」と表示される。
2. 48 kHz・32-bit floatの短いWAVを選び、解析を開始する。
3. 既存の波形と開始・終了の入力欄が表示され、指定した区間をWAVとして保存できる。
4. 範囲を変更して、同じ録音からもう一度書き出せる。
5. ブラウザの開発者ツールのNetworkで、`/wasm/audio_wasm_bg.wasm` の取得が成功し、音声を送るPOST/PUTや `/api/jobs` の通信がない。

ブラウザのWeb Workerも通信の確認対象に含める。OPFS対応環境では出力を端末内の一時領域へ書く。非対応環境のBlob保存は出力256 MiB以下。試聴と長時間録音の利用条件は [web/README.md](../web/README.md) を参照。

## 3. ローカルから手動で公開する場合

GitHub連携を使わず公開する場合の代替手順。リポジトリのルートから実行する。Node.js 22以降とrustupを事前に導入しておく。

```sh
cd web
npm ci
npx wrangler login
npm run deploy
```

`npm run deploy` の `predeploy` でWASMを生成してから公開する。公開せず配布内容だけを確認する場合は次を実行する。

```sh
npm run build:wasm
npm run check:deploy
```

## 4. 困った場合

| 症状 | 確認する内容 |
| --- | --- |
| npm/Nodeのバージョンエラー | Build variableの `NODE_VERSION=22` とRoot directoryを確認する |
| Cargo.tomlやaudio-coreが見つからない | `web` だけのアップロードではなく、リポジトリ全体からビルドする |
| wasm-bindgenのバージョン不一致 | 固定版を使う `npm run build:wasm` を実行しているか確認する |
| Worker名の不一致 | Cloudflareで選んだ名前と `web/wrangler.jsonc` の `name` を合わせる |
| WASMが404、またはHTMLを返す | ビルドログと `public/wasm/` の生成物、`assets.directory=./public` を確認する |
| 以前のR2やCPU設定を要求される | デプロイ対象が最新の `main` と `web/wrangler.jsonc` か確認する |
| ブラウザ内の保存容量が足りない | 端末の空き容量を確保するか、短い区間で書き出す |

移行前タグ `worker-wasm-before-client` はサーバー側で音声処理する旧構成。このタグをそのままデプロイすると、現在の無料静的配信の構成にはならない。

## 公式資料

- [Workers BuildsのGitHub連携](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [ビルド設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [ビルド環境](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)
- [静的アセットの配信](https://developers.cloudflare.com/workers/static-assets/get-started/)
- [静的配信の料金と制限](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
