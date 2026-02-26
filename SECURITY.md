# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, **please do NOT open a public issue**.

Instead, use [GitHub's private vulnerability reporting](https://github.com/rogelioRuiz/capacitor-lancedb/security/advisories/new) to report it. Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to provide a fix within 90 days.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

## Security Model

This package provides a native LanceDB vector database via Rust FFI on mobile devices. Key security properties:

- **On-device execution** — All vector operations run directly on the mobile device through Capacitor's native bridge. No data is sent to external servers.
- **Rust memory safety** — The native library is written in Rust, providing memory safety guarantees without garbage collection overhead.
- **Plugin sandboxing** — The plugin operates within Capacitor's native bridge, subject to the platform's permission model (Android permissions, iOS entitlements).
- **Prompt injection detection** — The MemoryManager includes built-in heuristics to detect and filter prompt injection attempts in stored memories.
