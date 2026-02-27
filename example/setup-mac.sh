#!/bin/bash
# Mac setup + build + launch script for capacitor-lancedb iOS E2E tests.
#
# Usage (from the Linux dev machine):
#   ssh rogelioruizgatica@10.61.192.207 'bash -s' < example/setup-mac.sh
#
# Or copy the project first and run locally on the Mac:
#   ssh rogelioruizgatica@10.61.192.207 'bash ~/capacitor-lancedb/example/setup-mac.sh'
#
# After the app is installed and running, execute the test runner:
#   ssh rogelioruizgatica@10.61.192.207 'cd ~/capacitor-lancedb/example && node test-e2e-ios.mjs'
set -euo pipefail

LINUX_HOST="10.36.190.12"
LINUX_USER="rruiz"
PROJECT_SRC="/home/rruiz/dev/t6x-claude-code/capacitor-lancedb"
PROJECT_DST="$HOME/capacitor-lancedb"
EXAMPLE_DIR="$PROJECT_DST/example"
BUNDLE_ID="io.t6x.lancedb.test"
SIM_NAME="iPhone 16e"
BUILD_ONLY="${1:-}"

log() { echo "==> $*"; }

# ─── Step 1: Verify Apple Silicon ───────────────────────────────────────────
log "Checking architecture..."
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
  echo "WARNING: This Mac is $ARCH (not arm64 / Apple Silicon)."
  echo "The prebuilt xcframework only has arm64 simulator support."
  echo "You may need to rebuild with scripts/build-ios.sh. Continuing anyway..."
fi
echo "  arch: $ARCH"

# ─── Step 2: Install prerequisites ──────────────────────────────────────────
log "Checking prerequisites..."

# Homebrew
if ! command -v brew &>/dev/null; then
  log "Installing Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null || true
fi
eval "$(brew shellenv 2>/dev/null || echo '')"

# Node.js
if ! command -v node &>/dev/null; then
  log "Installing Node.js..."
  brew install node
fi
echo "  node: $(node --version)"
echo "  npm:  $(npm --version)"

# CocoaPods
if ! command -v pod &>/dev/null; then
  log "Installing CocoaPods..."
  sudo gem install cocoapods
fi
echo "  pod:  $(pod --version)"

# Xcode CLI tools check
if ! xcode-select -p &>/dev/null; then
  log "Installing Xcode CLI tools..."
  xcode-select --install
  echo "Please complete the Xcode CLI tools installation and re-run this script."
  exit 1
fi
echo "  xcode-select: $(xcode-select -p)"

# ─── Step 3: Sync project from Linux ────────────────────────────────────────
log "Syncing project from $LINUX_USER@$LINUX_HOST..."
mkdir -p "$PROJECT_DST"
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'target' \
  --exclude '*.a' \
  --exclude 'build' \
  "$LINUX_USER@$LINUX_HOST:$PROJECT_SRC/" \
  "$PROJECT_DST/"
echo "  synced to $PROJECT_DST"

# ─── Step 4: Install npm deps ────────────────────────────────────────────────
log "Installing npm dependencies in example/..."
cd "$EXAMPLE_DIR"
npm install

# ─── Step 5: Cap add ios (if ios/ doesn't exist) ────────────────────────────
if [ ! -d "$EXAMPLE_DIR/ios" ]; then
  log "Adding iOS platform (cap add ios --package-manager CocoaPods)..."
  npx cap add ios --package-manager CocoaPods
else
  log "iOS platform already exists, skipping cap add ios"
fi

# ─── Step 6: Copy web assets directly (reliable alternative to cap sync) ────
log "Copying web assets to Xcode project..."
# cap sync ios can fail with CLEAN FAILED on the build/ directory.
# Copying directly is always reliable.
mkdir -p "$EXAMPLE_DIR/ios/App/App/public"
cp -r "$EXAMPLE_DIR/www/." "$EXAMPLE_DIR/ios/App/App/public/"
echo "  web assets copied"

# Run pod install to ensure Swift Package / CocoaPods deps are up to date
log "Running pod install..."
cd "$EXAMPLE_DIR/ios/App"
pod install --repo-update 2>&1 | tail -5
cd "$EXAMPLE_DIR"

# ─── Step 7: Find simulator UDID ────────────────────────────────────────────
log "Looking for simulator: $SIM_NAME..."
SIM_UDID=$(xcrun simctl list devices -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data['devices'].items():
    for d in devices:
        if d.get('name') == '$SIM_NAME' and d.get('isAvailable', True):
            print(d['udid'])
            sys.exit(0)
" 2>/dev/null || echo "")

if [ -z "$SIM_UDID" ]; then
  echo "ERROR: Simulator '$SIM_NAME' not found. Available simulators:"
  xcrun simctl list devices available | grep iPhone | head -10
  exit 1
fi
echo "  UDID: $SIM_UDID"

# ─── Step 8: Boot simulator ──────────────────────────────────────────────────
log "Booting simulator: $SIM_NAME..."
xcrun simctl boot "$SIM_UDID" 2>/dev/null || true
sleep 3

# ─── Step 9: Clean DerivedData + build for simulator ────────────────────────
log "Cleaning old DerivedData..."
rm -rf ~/Library/Developer/Xcode/DerivedData/App-*/
echo "  DerivedData cleaned"

log "Building for iOS simulator ($SIM_NAME)..."
cd "$EXAMPLE_DIR/ios/App"

# NOTE: Do NOT pass CONFIGURATION_BUILD_DIR — it breaks the xcframework copy
# phase. Let Xcode place the build output in DerivedData (the default).
xcodebuild \
  -workspace App.xcworkspace \
  -scheme App \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -configuration Debug \
  build 2>&1 | tail -30

# Find the App.app Xcode placed in DerivedData
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData/App-* \
  -name "App.app" \
  -path "*/Debug-iphonesimulator/*" \
  -not -path "*/PlugIns/*" \
  2>/dev/null | head -1)

if [ -z "$APP_PATH" ]; then
  echo "ERROR: Build failed — App.app not found in DerivedData"
  exit 1
fi
log "Build succeeded: $APP_PATH"

if [ "$BUILD_ONLY" = "--build-only" ]; then
  log "Build-only mode. Skipping launch and tests."
  exit 0
fi

# ─── Step 10: Uninstall + install app ────────────────────────────────────────
log "Installing app on simulator..."
xcrun simctl uninstall "$SIM_UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$SIM_UDID" "$APP_PATH"

# ─── Step 11: Launch app ──────────────────────────────────────────────────────
log "Launching app (tests run automatically on page load)..."
xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" 2>/dev/null || true
sleep 1
xcrun simctl launch "$SIM_UDID" "$BUNDLE_ID"
sleep 2

# ─── Step 12: Run E2E tests ──────────────────────────────────────────────────
log "Running E2E test runner..."
cd "$EXAMPLE_DIR"
node test-e2e-ios.mjs
