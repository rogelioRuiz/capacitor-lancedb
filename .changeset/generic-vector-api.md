---
"capacitor-lancedb": minor
---

Add generic vector DB API (store, search, delete, list, clear) alongside deprecated memory-prefixed aliases for backward compatibility. Internal code migrated to use generic names. E2E tests cover both legacy and generic APIs (16/16 on Android and iOS).
