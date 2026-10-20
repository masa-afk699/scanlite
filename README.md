# ScanLite

本と書類を取り込む、一人用のAndroid／Chromeスキャナーです。

## Chrome版（PWA）

`web/` を静的サイトとして配信します。Pixel 10 のChromeでURLを開き、「ホーム画面に追加」するとアプリのように起動できます。

- 本／書類モードの切り替え
- カメラ撮影、写真の追加、ページ一覧と削除
- 日本語OCR（初回のOCR利用時にライブラリと言語データを取得）
- 印刷画面から複数ページをPDFに保存
- ページ画像はブラウザーのIndexedDBに保存し、サーバーへ送信しません

### 非公開で使う

GitHubリポジトリは非公開にします。GitHub PagesはサイトURLが一般公開されるため、このアプリの公開先には使いません。Chromeから自分だけが利用するには、Cloudflare Pagesなどに配信し、Cloudflare Accessで自分のメールアドレスだけを許可してください。PagesはGitHubの非公開リポジトリからもデプロイできます。

## Android版

Kotlin版の初期ソースも含みます。GitHub ActionsがAPKをビルドします。GitHubの「Actions」→「Android APK」→最新の実行→「Artifacts」から `scanlite-debug-apk` をダウンロードし、Pixel 10でAPKを開いてインストールします。Android版にはカメラ撮影、複数ページPDF、日本語OCRの土台があります。

初回インストール時は、Pixelの設定画面でダウンロードに使ったアプリ（Chromeなど）に「不明なアプリのインストール」を一時的に許可してください。

## 今後の候補

ページ端の自動検出と切り抜き、本の見開き分割、湾曲補正、PDFへのOCRテキスト埋め込み。
