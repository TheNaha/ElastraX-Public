import { validateEnv } from './config/env';
import { logger } from './utils/logger';

const log = logger.child({ module: 'Bootstrap' });

export type BootstrapHandle = {
  runtime: import('./runtime/AppRuntime').AppRuntime;
  shutdown(reason?: string): Promise<void>;
};

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<BootstrapHandle> {
  validateEnv(env);

  const database = await import('./db') as typeof import('./db') & {
    closeDatabase?: () => void | Promise<void>;
  };
  await database.ensureDatabaseSchema();

  const [{ FlowHandler }, { AppRuntime }] = await Promise.all([
    import('./core/FlowHandler'),
    import('./runtime/AppRuntime'),
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

  const onSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal).finally(() => {
      process.exitCode = 0;
    });
  };
  const onFatalError = (error: unknown) => {
    log.fatal({ err: error }, 'Fatal process error');
    void shutdown('fatal').finally(() => {
      process.exitCode = 1;
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
    runtime = new AppRuntime();
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
  });
}
