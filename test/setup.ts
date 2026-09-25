import { afterAll, afterEach, beforeEach, mock } from 'bun:test';
import {
  assertHarnessEnvironment,
  assertRepositoryDataUnchanged,
  captureRepositoryDataSnapshot,
  cleanupTestWorkerPaths,
  configureTestEnvironment,
  ensureTempDatabaseSchema,
  getTestWorkerPaths,
  installFilesystemSpies,
  installProcessEnvironmentGuard,
} from './helpers/index';
import { libsignal } from './helpers/libsignalFixture';
import * as whatsappRustBridge from './helpers/whatsappRustBridgeFixture';

const paths = getTestWorkerPaths();
const repositoryDataSnapshot = captureRepositoryDataSnapshot();
const cleanupHandles: {
  restoreEnvironmentGuard?: () => void;
  fetchHandle?: ReturnType<typeof installBlockedFetch>;
} = {};

process.once('exit', () => {
  cleanupWorker();
  cleanupHandles.fetchHandle?.restore();
  cleanupHandles.restoreEnvironmentGuard?.();
});

configureTestEnvironment(paths);
ensureTempDatabaseSchema(paths.dbPath);
installFilesystemSpies(paths);
try {
  beforeEach(() => installFilesystemSpies(paths));
  afterEach(() => installFilesystemSpies(paths));
  afterAll(() => cleanupWorker());
} catch (error) {
  void error;
}
cleanupHandles.restoreEnvironmentGuard = installProcessEnvironmentGuard();
cleanupHandles.fetchHandle = installBlockedFetch();

mock.module('libsignal', () => ({ ...libsignal, default: libsignal }));
mock.module('libsignal/src/curve.js', () => ({ ...libsignal.curve, default: libsignal.curve }));
mock.module('libsignal/src/crypto.js', () => ({ ...libsignal.crypto, default: libsignal.crypto }));
mock.module('libsignal/src/keyhelper.js', () => ({ ...libsignal.keyhelper, default: libsignal.keyhelper }));
mock.module('libsignal/src/protobufs.js', () => ({ PreKeyWhisperMessage: libsignal.PreKeyWhisperMessage, default: { PreKeyWhisperMessage: libsignal.PreKeyWhisperMessage } }));
mock.module('whatsapp-rust-bridge', () => ({ ...whatsappRustBridge }));

assertHarnessEnvironment();

function cleanupWorker(): void {
  try {
    assertRepositoryDataUnchanged(repositoryDataSnapshot);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  try {
    cleanupTestWorkerPaths(paths);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

function installBlockedFetch() {
  const original = globalThis.fetch;
  const blocked = async (): Promise<Response> => {
    throw new Error('Network access is disabled in the hermetic test harness.');
  };
  globalThis.fetch = blocked as unknown as typeof globalThis.fetch;
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
}
