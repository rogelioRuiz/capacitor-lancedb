#!/bin/bash
# Build the LanceDB FFI library for Android arm64-v8a
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUST_DIR="$SCRIPT_DIR/../rust/lancedb-ffi"
PLUGIN_DIR="$SCRIPT_DIR/.."

# Ensure Android NDK is available
: "${ANDROID_NDK_HOME:=$HOME/Android/Sdk/ndk/27.0.12077973}"
export ANDROID_NDK_HOME

echo "==> Building for aarch64-linux-android (release, no default features)..."
cd "$RUST_DIR"
cargo ndk -t arm64-v8a build --release --no-default-features

echo "==> Copying .so to jniLibs..."
mkdir -p "$PLUGIN_DIR/android/src/main/jniLibs/arm64-v8a"
cp "$RUST_DIR/target/aarch64-linux-android/release/liblancedb_ffi.so" \
   "$PLUGIN_DIR/android/src/main/jniLibs/arm64-v8a/"

echo "==> Generating Kotlin bindings (UniFFI)..."
# Need debug build for binding generation (release strip removes metadata)
cargo build --no-default-features
cargo run --bin uniffi-bindgen -- generate \
  --library "$RUST_DIR/target/debug/liblancedb_ffi.so" \
  --language kotlin \
  --out-dir "$PLUGIN_DIR/android/src/main/java/"

SO_SIZE=$(du -h "$PLUGIN_DIR/android/src/main/jniLibs/arm64-v8a/liblancedb_ffi.so" | cut -f1)
echo "==> Done! .so size: $SO_SIZE"
