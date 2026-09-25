import { mock } from 'bun:test';

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type FetchMock = ReturnType<typeof mock<FetchImplementation>>;

export interface FetchMockHandle {
  fetch: FetchMock;
  restore(): void;
}

const blockedFetch: FetchImplementation = async () => {
  throw new Error('Network access is disabled in the hermetic test harness.');
};

export function installFetchMock(implementation: FetchImplementation = blockedFetch): FetchMockHandle {
  const original = globalThis.fetch;
  const fetchMock = mock(implementation);
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return {
    fetch: fetchMock,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export const installFetchStub = installFetchMock;

export async function withFetchMock<T>(
  implementation: FetchImplementation = blockedFetch,
  callback: (fetchMock: FetchMock) => T | Promise<T>,
): Promise<T> {
  const handle = installFetchMock(implementation);
  try {
    return await callback(handle.fetch);
  } finally {
    handle.restore();
  }
}
