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

  // Signal handlers are installed *before* the first await. They used to be
  // registered only after `ensureDatabaseSchema()` and `FlowHandler.initialize()`
  // had finished, so a SIGTERM during a long migration took the default
  // disposition: the process died with no `runtime.stop()`, no
  // `closeDatabase()`, no lease release and no `forceExit` for children.
  let database: (typeof import('./db') & { closeDatabase?: () => void | Promise<void> }) | undefined;
  let databaseReady = false;
  let runtime: InstanceType<typeof import('./runtime/AppRuntime').AppRuntime> | undefined;
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
      // Only close a database whose schema work has finished: closing it while
      // `ensureDatabaseSchema` is mid-migration would abort that work under it.
      // The process exits right after a startup signal anyway.
      if (databaseReady) {
        try {
          await database?.closeDatabase?.();
        } catch (err) {
          log.error({ err, reason }, 'Database shutdown failed');
        }
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

  // Signals only, and only they need to be live this early: the point is a
  // graceful exit during a long migration. The fatal-error handlers stay where
  // they were (just before the runtime starts), because making every stray
  // rejection fatal during library import would turn a benign warning into a
  // boot crash-loop.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    database = await import('./db') as typeof import('./db') & {
      closeDatabase?: () => void | Promise<void>;
    };
    await database.ensureDatabaseSchema();
    databaseReady = true;

    const [{ FlowHandler }, { AppRuntime }, { runStartupCoverageScan }] = await Promise.all([
      import('./core/FlowHandler'),
      import('./runtime/AppRuntime'),
      import('./runtime/startupDiagnostics'),
    ]);
    await FlowHandler.initialize();

    // Registered here rather than at the top: see the note where the signal
    // handlers are installed.
    process.on('uncaughtException', onFatalError);
    process.on('unhandledRejection', onFatalError);

    if (shuttingDown) {
      // A signal landed after the schema work finished, so shutdown has already
      // closed the database and the process is exiting. Do not start providers
      // against a closed handle.
      throw new Error('Startup interrupted by shutdown signal');
    }

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
    await runtime?.stop().catch((err) => { log.warn({ err }, 'Runtime stop failed during bootstrap error handling'); });
    await database?.closeDatabase?.();
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
