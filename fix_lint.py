import re

# Fix unused imports in src/providers/whatsapp.ts
with open('src/providers/whatsapp.ts', 'r') as f:
    content = f.read()

content = content.replace("import { randomUUID } from 'crypto';\n", "")
content = content.replace("import { join } from 'path';\n", "")
content = content.replace("import { writeFile } from 'fs/promises';\n", "")
content = content.replace("import { fileTypeFromBuffer } from 'file-type';\n", "")
content = content.replace("} catch (e) {", "} catch (e: any) {") # fix unused e but I can just use `} catch { /* ignore */ }`

# Instead of changing everything, maybe `eslint` is just warning and doesn't fail the build?
# The user wants to fix linting. I will fix the unused e in whatsapp.ts
content = content.replace("} catch (e) {\n              // Some types don't have senderId (e.g., protocol messages)\n            }", "} catch { /* ignore */\n              // Some types don't have senderId (e.g., protocol messages)\n            }")

with open('src/providers/whatsapp.ts', 'w') as f:
    f.write(content)

with open('src/tools/RoleTool.ts', 'r') as f:
    content = f.read()

content = content.replace("async execute(args: any, ctx: MessageContext)", "async execute(args: Record<string, unknown>, ctx: MessageContext)")

with open('src/tools/RoleTool.ts', 'w') as f:
    f.write(content)
