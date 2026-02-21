---
description: How to setup the ElastraGPBOT-v7 project environment
---

# Setup ElastraGPBOT-v7

This workflow installs all dependencies and initializes the database.

// turbo-all
1. Install Bun dependencies:
```bash
bun install
```

2. Ensure SQLite data directory exists:
```bash
mkdir -p data
```

3. Generate SQLite Drizzle migrations:
```bash
bun run db:generate
```

4. Push migrations to the local database file:
```bash
bun run db:push
```

5. Commit the generated migrations to keep the working tree clean for Jules:
```bash
git add drizzle/
git commit -m "chore: setup database migrations" || true
```

6. Create a `.env` file if it doesn't exist, copying from `.env.example` or setting the necessary AI keys.
