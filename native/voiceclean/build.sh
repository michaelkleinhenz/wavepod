#!/bin/sh
# Builds voiceclean.wasm (needs Rust with the wasm32-unknown-unknown target).
set -e
cd "$(dirname "$0")"
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/wavepod_voiceclean.wasm voiceclean.wasm
