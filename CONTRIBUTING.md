# Contributing to capacitor-lancedb

Thanks for your interest in contributing! This guide will help you get set up and understand our development workflow.

## Prerequisites

- **Node.js** >= 20
- **npm** (comes with Node.js)
- **Git**

For building native binaries (optional — prebuilt binaries are included):

- **Rust** with targets: `aarch64-linux-android`, `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`
- **cargo-ndk** v4+ (Android)
- **Android NDK** (Android)
- **Xcode** 15+ with command-line tools (iOS)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/rogelioRuiz/capacitor-lancedb.git
cd capacitor-lancedb

# Install dependencies
npm install

# Build
npm run build
```

## Project Structure

```
src/
  index.ts              # Package entry point — re-exports plugin, types, tools
  plugin.ts             # Capacitor plugin registration (Web stub)
  definitions.ts        # TypeScript interfaces (LanceDBPlugin, SearchResult)
  tools/
    memory.tools.ts     # Low-level raw memory tools (5 tools)
  memory/
    manager.ts          # High-level MemoryManager class
    types.ts            # Shared type definitions
    security.ts         # Prompt injection detection, escaping
    indexer.ts          # File chunking & workspace indexing
rust/
  lancedb-ffi/          # Rust FFI library (UniFFI 0.28, LanceDB 0.26)
  lance-linalg-patched/ # Patched lance-linalg crate (Android NEON fix)
android/
  src/main/java/        # Kotlin Capacitor plugin
  src/main/jniLibs/     # Prebuilt .so binaries (arm64-v8a)
ios/
  Sources/              # Swift Capacitor plugin + UniFFI bindings
  Frameworks/           # Prebuilt xcframework
scripts/
  build-android.sh      # Android native build script
  build-ios.sh          # iOS native build script
```

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/esm/` |
| `npm run build:watch` | Compile in watch mode |
| `npm run lint` | Check code with Biome |
| `npm run lint:fix` | Auto-fix lint and format issues |
| `npm run typecheck` | Type-check without emitting |

## Running E2E Tests

The `example/` directory contains a dedicated test app covering all plugin methods. Tests run automatically on app launch and report results via HTTP to a local Node.js server.

### Android

Requires an Android device connected via USB (or an emulator).

```bash
cd example

# Run the full suite — builds APK, installs, launches, collects results
node test-e2e-android.mjs
```

The runner:
1. Builds the debug APK (`./gradlew assembleDebug`)
2. Sets up `adb reverse tcp:8099 tcp:8099` so the device can POST to the host
3. Installs and launches the app
4. Starts an HTTP server and waits for the app to POST all 11 test results

Expected output: **16/16 passed** (4 setup + 1 handshake + 11 plugin tests).

Set `ADB_PATH` or `ANDROID_SERIAL` environment variables to select a specific device:
```bash
ANDROID_SERIAL=emulator-5554 node test-e2e-android.mjs
```

### iOS Simulator

Requires macOS with Xcode and an Apple Silicon Mac (arm64) — the prebuilt xcframework targets arm64 simulator.

```bash
# On the Mac — automated: sync from Linux, build, install, run tests
bash example/setup-mac.sh

# Or, if the app is already installed on the simulator:
cd example && node test-e2e-ios.mjs
```

The runner:
1. Syncs the project from the Linux host via rsync
2. Copies web assets directly to the Xcode project
3. Cleans DerivedData, builds for simulator with xcodebuild
4. Uninstalls + installs the fresh build
5. Starts an HTTP server (`localhost:8099`) and launches the app
6. The iOS Simulator shares the Mac's loopback — the app POSTs results to `http://127.0.0.1:8099`

Expected output: **16/16 passed** (4 setup + 1 handshake + 11 plugin tests).

> **Note:** `ios_webkit_debug_proxy` is not required and is not used. The HTTP server approach works on all modern iOS versions.

## Building Native Binaries

Prebuilt binaries are included in the repo. You only need to rebuild if you modify the Rust FFI code.

### Android

```bash
./scripts/build-android.sh
```

Requires `cargo-ndk` and Android NDK. Produces `android/src/main/jniLibs/arm64-v8a/liblancedb_ffi.so`.

### iOS

```bash
./scripts/build-ios.sh
```

Requires Xcode. Produces `ios/Frameworks/LanceDBFFI.xcframework` for device + simulator.

## Making Changes

### 1. Create a branch

```bash
git checkout -b feat/my-feature
```

### 2. Make your changes

- Follow existing code conventions (TypeScript strict, ESM, single quotes, no semicolons)
- Biome handles formatting — run `npm run lint:fix` before committing

### 3. Add a changeset

If your change affects the published npm package, add a changeset:

```bash
npx changeset
```

This will prompt you to describe the change and select a semver bump (patch, minor, major). The changeset file is committed with your PR and used to generate changelog entries on release.

Skip this step for docs-only or CI-only changes.

### 4. Commit with a conventional message

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(plugin): add batch insert method
fix(memory): handle empty embedding vector
docs: update API reference in README
chore(deps): update lancedb to 0.27
```

Scopes: `plugin`, `memory`, `rust`, `android`, `ios`, `docs`, `ci`, `deps`

### 5. Open a pull request

Push your branch and open a PR against `main`. The CI pipeline will run lint, typecheck, and build automatically.

## Code Style

We use [Biome](https://biomejs.dev/) for both linting and formatting. The config lives in `biome.json`. Key rules:
- 2 spaces, no tabs
- Single quotes
- No semicolons
- 120 character line width
- Trailing commas

Run `npm run lint:fix` to auto-fix most issues.

## Reporting Issues

- **Bugs**: Use the [bug report template](https://github.com/rogelioRuiz/capacitor-lancedb/issues/new?template=bug_report.yml)
- **Features**: Use the [feature request template](https://github.com/rogelioRuiz/capacitor-lancedb/issues/new?template=feature_request.yml)
- **Security**: See [SECURITY.md](SECURITY.md) — do NOT use public issues for vulnerabilities

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Please be respectful and constructive.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
