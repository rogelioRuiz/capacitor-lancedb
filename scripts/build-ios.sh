#!/bin/bash
# Build the LanceDB FFI library for iOS (device + simulator)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUST_DIR="$SCRIPT_DIR/../rust/lancedb-ffi"
PLUGIN_DIR="$SCRIPT_DIR/.."

cd "$RUST_DIR"

echo "==> Building for aarch64-apple-ios (device)..."
cargo build --release --target aarch64-apple-ios --no-default-features

echo "==> Building for aarch64-apple-ios-sim (Apple Silicon simulator)..."
cargo build --release --target aarch64-apple-ios-sim --no-default-features

echo "==> Building for x86_64-apple-ios (Intel simulator)..."
cargo build --release --target x86_64-apple-ios --no-default-features

echo "==> Creating universal simulator library..."
mkdir -p "$RUST_DIR/target/sim-universal"
lipo -create \
  "$RUST_DIR/target/aarch64-apple-ios-sim/release/liblancedb_ffi.a" \
  "$RUST_DIR/target/x86_64-apple-ios/release/liblancedb_ffi.a" \
  -output "$RUST_DIR/target/sim-universal/liblancedb_ffi.a"

echo "==> Creating xcframework..."
rm -rf "$PLUGIN_DIR/ios/LanceDBCore.xcframework"
xcodebuild -create-xcframework \
  -library "$RUST_DIR/target/aarch64-apple-ios/release/liblancedb_ffi.a" \
  -library "$RUST_DIR/target/sim-universal/liblancedb_ffi.a" \
  -output "$PLUGIN_DIR/ios/LanceDBCore.xcframework"

echo "==> Generating Swift bindings (UniFFI)..."
# Need debug build for binding generation (release strip removes metadata)
cargo build --no-default-features
cargo run --bin uniffi-bindgen -- generate \
  --library "$RUST_DIR/target/debug/liblancedb_ffi.dylib" \
  --language swift \
  --out-dir "$PLUGIN_DIR/ios/Sources/LanceDBPlugin/Generated/"

echo "==> Done!"
ls -lh "$PLUGIN_DIR/ios/LanceDBCore.xcframework/"
