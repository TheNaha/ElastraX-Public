import re

with open('src/tools/RoleTool.ts', 'r') as f:
    content = f.read()

content = content.replace("async execute(args: any, ctx: MessageContext)", "async execute(args: Record<string, unknown>, ctx: MessageContext)")

with open('src/tools/RoleTool.ts', 'w') as f:
    f.write(content)
