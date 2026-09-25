import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DATABASE_RELATIVE_PATH = 'data/bot.db';

export function getProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

export function resolveDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = getProjectRoot(),
): string {
  const configured = env.ELASTRAX_DB_PATH?.trim();
  if (!configured || configured === ':memory:') {
    return configured || resolve(projectRoot, DEFAULT_DATABASE_RELATIVE_PATH);
  }

  return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
}

export function resolveDatabaseDirectory(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = getProjectRoot(),
): string {
  const databasePath = resolveDatabasePath(env, projectRoot);
  return databasePath === ':memory:' ? projectRoot : dirname(databasePath);
}
