#!/bin/bash
# Build the LanceDB FFI library for iOS (device + simulator)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUST_DIR="$SCRIPT_DIR/../rust/lancedb-ffi"
PLUGIN_DIR="$SCRIPT_DIR/.."
XCFRAMEWORK_DIR="$PLUGIN_DIR/ios/Frameworks/LanceDBFFI.xcframework"

cd "$RUST_DIR"

echo "==> Building for aarch64-apple-ios (device)..."
cargo build --release --target aarch64-apple-ios --no-default-features

echo "==> Building for aarch64-apple-ios-sim (Apple Silicon simulator)..."
cargo build --release --target aarch64-apple-ios-sim --no-default-features

echo "==> Generating Swift bindings (UniFFI)..."
# Need debug build for binding generation (release strip removes metadata)
cargo build --no-default-features
cargo run --bin uniffi-bindgen -- generate \
  --library "$RUST_DIR/target/debug/liblancedb_ffi.dylib" \
  --language swift \
  --out-dir "$PLUGIN_DIR/ios/Sources/LanceDBPlugin/Generated/"

# Copy generated headers for xcframework
HEADERS_TMP="$RUST_DIR/target/xcframework-headers"
rm -rf "$HEADERS_TMP"
mkdir -p "$HEADERS_TMP"
cp "$PLUGIN_DIR/ios/Sources/LanceDBPlugin/Generated/lancedb_ffiFFI.h" "$HEADERS_TMP/"
cp "$PLUGIN_DIR/ios/Sources/LanceDBPlugin/Generated/lancedb_ffiFFI.modulemap" "$HEADERS_TMP/"
# Add module.modulemap for SPM compatibility (Xcode 15+ explicit module builds)
cat > "$HEADERS_TMP/module.modulemap" << 'EOF'
module lancedb_ffiFFI {
    header "lancedb_ffiFFI.h"
    export *
}
EOF

echo "==> Creating xcframework..."
rm -rf "$XCFRAMEWORK_DIR"
xcodebuild -create-xcframework \
  -library "$RUST_DIR/target/aarch64-apple-ios/release/liblancedb_ffi.a" \
  -headers "$HEADERS_TMP" \
  -library "$RUST_DIR/target/aarch64-apple-ios-sim/release/liblancedb_ffi.a" \
  -headers "$HEADERS_TMP" \
  -output "$XCFRAMEWORK_DIR"

# Copy the Swift binding into each slice's Headers directory (for documentation/IDE use)
for SLICE in ios-arm64 ios-arm64-simulator; do
  if [ -d "$XCFRAMEWORK_DIR/$SLICE/Headers" ]; then
    cp "$PLUGIN_DIR/ios/Sources/LanceDBPlugin/Generated/lancedb_ffi.swift" \
      "$XCFRAMEWORK_DIR/$SLICE/Headers/"
  fi
done

rm -rf "$HEADERS_TMP"

echo "==> Done!"
ls -lh "$XCFRAMEWORK_DIR/"
