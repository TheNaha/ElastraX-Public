import { validateEnv } from './config/env';
import { logger } from './utils/logger';
import { cancelActiveProcesses } from './providers/process';

const log = logger.child({ module: 'Bootstrap' });

export type BootstrapHandle = {
  runtime: import('./runtime/AppRuntime').AppRuntime;
  shutdown(reason?: string): Promise<void>;
};

/**
 * Terminate tracked child processes and, if anything still holds the loop open,
 * exit anyway.
 *
 * `cancelActiveProcesses` is exported for tests; `activeProcessCount` is
 * exported but unused outside tests. A short grace period is allowed for clean
 * teardown; after that the process exits rather than hanging until the
 * orchestrator's SIGKILL.
 */
function forceExit(code: number): void {
  const remaining = cancelActiveProcesses();
  if (remaining === 0) {
    process.exit(code);
    return;
  }
  log.warn({ remaining }, 'Forcing exit: child processes still running');
  setTimeout(() => process.exit(code), 2_000).unref?.();
}

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<BootstrapHandle> {
  validateEnv(env);

  const database = await import('./db') as typeof import('./db') & {
    closeDatabase?: () => void | Promise<void>;
  };
  await database.ensureDatabaseSchema();

  const [{ FlowHandler }, { AppRuntime }, { runStartupCoverageScan }] = await Promise.all([
    import('./core/FlowHandler'),
    import('./runtime/AppRuntime'),
    import('./runtime/startupDiagnostics'),
  ]);
  await FlowHandler.initialize();

  let runtime: InstanceType<typeof AppRuntime> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let shuttingDown = false;


  const shutdown = (reason = 'shutdown'): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      log.info({ reason }, 'Shutdown requested');
      removeSignalHandlers();
      try {
        await runtime?.stop();
      } catch (err) {
        log.error({ err, reason }, 'Runtime shutdown failed');
      }
      try {
        await database.closeDatabase?.();
      } catch (err) {
        log.error({ err, reason }, 'Database shutdown failed');
      }
    })();
    return shutdownPromise;
  };

  // `process.exitCode` alone does not stop the process: an ffmpeg/ffprobe/yt-dlp
  // child spawned `detached` with piped stdio keeps the event loop alive, so a
  // SIGTERM during a media conversion left the container running until the
  // orchestrator SIGKILLed it — risking a half-written output file. Kill the
  // tracked children first, then exit explicitly once shutdown has finished.
  const onSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal).finally(() => {
      process.exitCode = 0;
      forceExit(0);
    });
  };
  const onFatalError = (error: unknown) => {
    log.fatal({ err: error }, 'Fatal process error');
    void shutdown('fatal').finally(() => {
      process.exitCode = 1;
      forceExit(1);
    });
  };
  const removeSignalHandlers = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('uncaughtException', onFatalError);
    process.off('unhandledRejection', onFatalError);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.once('uncaughtException', onFatalError);
  process.once('unhandledRejection', onFatalError);

  try {
    // `AppRuntimeDeps.runStartupCoverageScan` is optional and nothing passed it,
    // so the parser-coverage startup diagnostic the module documents was never
    // armed in production — only `test/AppRuntime.test.ts` and
    // `scripts/dumpFixtures.ts` ever reached the sibling dumper. Wiring it here
    // is bounded (2 000 rows, delayed 5 s, non-fatal on error) and is the only
    // way the diagnostic can report a gap it finds in live traffic.
    runtime = new AppRuntime({
      runStartupCoverageScan: () => runStartupCoverageScan(null),
    });
    await runtime.start();
    if (shuttingDown) await shutdown('startup-interrupted');
  } catch (error) {
    removeSignalHandlers();
    await runtime?.stop().catch(() => {});
    await database.closeDatabase?.();
    throw error;
  }

  return { runtime, shutdown };
}

if (import.meta.main) {
  void bootstrap().catch(error => {
    log.fatal({ err: error }, 'Bot startup failed');
    process.exitCode = 1;
    forceExit(1);
  });
}
