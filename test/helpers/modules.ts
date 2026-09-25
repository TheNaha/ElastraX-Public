import { randomUUID } from 'node:crypto';
import { mock } from 'bun:test';

export interface FreshModule<T> {
  module: T;
  cacheKey: string;
}

export async function importFreshModule<T>(specifier: string, label = 'module'): Promise<T> {
  const separator = specifier.includes('?') ? '&' : '?';
  const cacheKey = `${label.replace(/[^a-zA-Z0-9_-]/g, '-')}-${randomUUID()}`;
  return import(`${specifier}${separator}__elastrax_harness=${encodeURIComponent(cacheKey)}`) as Promise<T>;
}

export async function withFreshModule<T>(
  specifier: string,
  callback: (module: T) => T | Promise<T>,
  label = 'module',
): Promise<T> {
  return importFreshModule<T>(specifier, label).then(callback);
}

export function installModuleMock(specifier: string, factory: () => unknown): () => void {
  mock.module(specifier, factory);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    mock.restore();
  };
}

export async function withModuleMock<T>(
  specifier: string,
  factory: () => unknown,
  callback: () => T | Promise<T>,
): Promise<T> {
  const restore = installModuleMock(specifier, factory);
  try {
    return await callback();
  } finally {
    restore();
  }
}
