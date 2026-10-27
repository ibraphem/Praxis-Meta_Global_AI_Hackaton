import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // Give active analyses a bounded opportunity to finish.
    const forceExit = setTimeout(
      () => process.exit(1),
      config.ANALYSIS_TIMEOUT_MS + 5000,
    );
    forceExit.unref();
    await app.close();
    clearTimeout(forceExit);
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  await app.listen({ host: config.HOST, port: config.PORT });
  console.info(
    `Praxis listening on ${config.HOST}:${config.PORT} (${config.VISION_MODE}).`,
  );
}

main().catch(() => {
  // Do not emit SDK errors or arbitrary environment values on startup.
  console.error(
    'Praxis could not start. Check configuration, installed dependencies, and port availability.',
  );
  process.exitCode = 1;
});
