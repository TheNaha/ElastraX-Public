import type { Config } from 'drizzle-kit';
import { resolveDatabasePath } from './src/config/database';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolveDatabasePath(),
  },
} satisfies Config;
