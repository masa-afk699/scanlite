# 同梱しているOCRモデルと実行環境

- `det.onnx` / `rec.onnx` / `dict.txt`: PaddleOCR PP-OCRv6 small（文字の検出・認識。日本語対応）。Apache License 2.0。
  https://github.com/PaddlePaddle/PaddleOCR （ONNX版は PyPI の onnxocr 4.0.0 に同梱のものを使用）
- `ort.wasm.min.mjs` / `ort-wasm-simd-threaded.*`: ONNX Runtime Web 1.22.0。MIT License。
  https://github.com/microsoft/onnxruntime

すべて自サイトから読み込み、端末内（Web Worker）で動きます。外部への通信はしません。
