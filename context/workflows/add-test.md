---
description: Create and run unit tests for the project
---

# Add a New Unit Test

This project leverages the native `bun:test` framework for maximum speed.

1. Create a corresponding test file in the `test/` directory. For example, if you are testing `src/tools/MyTool.ts`, create `test/MyTool.test.ts`.
2. Import testing utilities:
```typescript
import { expect, test, describe } from 'bun:test';
```
3. Use a mocked `MessageContext` to supply necessary methods depending on what you are testing (e.g., mock `reply`, `react`, `downloadMedia`).
4. Run the suite to ensure they pass:
```bash
bun test test/
```
