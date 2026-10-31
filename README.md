# ScanLite

本と書類を取り込む、一人用のAndroid／Chromeスキャナーです。

## Chrome版（PWA）

`web/` を静的サイトとして配信します。スマホのChromeでURLを開き、「ホーム画面に追加」（またはアプリをインストール）するとアプリのように起動できます。一度開けば、以降は機内モードでも動きます。

- 本／書類モードの切り替え
- カメラ撮影、写真の追加、ページ一覧・並べ替え・回転・削除
- 影や明るさのムラを補正（カラー補正／白黒／補正なしをページごとに選択）
- 複数ページを1つのPDFに書き出し（ブラウザー内で生成し、スマホに保存）
- 日本語OCR（tesseract.jsと日本語データを `web/vendor/` に同梱し、端末内で実行）

### 撮影データをスマホから出さない仕組み

- 画像の補正、PDF作成、OCRはすべてブラウザー内（JavaScript／WebAssembly）で処理します。サーバー側の処理はありません。
- 撮影画像はブラウザーのIndexedDBにだけ保存します。
- `index.html` のContent-Security-Policyで、通信先を配信元サイト自身に限定しています。外部CDN、解析ツール、フォントの読み込みはありません。配信元サイトへの通信もアプリのファイル取得だけで、画像を送る処理はありません。
- Service Workerがアプリ一式（OCRデータ含む約10MB）をキャッシュするため、初回以降は通信なしで使えます。
- PDFの「他のアプリで開く」を選んだ場合だけ、選んだアプリにPDFが渡ります。

配信先にはアプリのプログラムしか置かれないため、どこで配信しても撮影データは外に出ません。アプリ自体も非公開にしたい場合は、Cloudflare Pagesなどに配信し、Cloudflare Accessで自分のメールアドレスだけを許可してください。PagesはGitHubの非公開リポジトリからもデプロイできます。

ローカルで試すには `web/` で `python3 -m http.server` を実行し、`http://localhost:8000/` を開きます（カメラとService WorkerはHTTPSかlocalhostでのみ動作します）。

### 同梱ライブラリ

- tesseract.js 6.0.1、tesseract.js-core 6.1.2（Apache-2.0）
- 日本語学習データ `jpn.traineddata`（tessdata 4.0.0 best_int、Apache-2.0）

## Android版

Kotlin版の初期ソースも含みます。GitHub ActionsがAPKをビルドします。GitHubの「Actions」→「Android APK」→最新の実行→「Artifacts」から `scanlite-debug-apk` をダウンロードし、Pixel 10でAPKを開いてインストールします。Android版にはカメラ撮影、複数ページPDF、日本語OCRの土台があります。インターネット権限を外し、クラウドバックアップの対象からも除外しているため、撮影データは端末外に出ません（OCRは端末内のML Kitモデルで動作）。

初回インストール時は、Pixelの設定画面でダウンロードに使ったアプリ（Chromeなど）に「不明なアプリのインストール」を一時的に許可してください。

## 今後の候補

本の見開き分割、湾曲（ページの反り）補正、PDFへのOCRテキスト埋め込み、補正処理のWeb Worker化。
