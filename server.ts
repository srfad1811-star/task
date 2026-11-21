import express from 'express';
import path from 'node:path';
import { createApiApp } from './server/app.ts';
import { reclassifyStoredEntries } from './server/reclassify.ts';
import { recoverRecordingSessionsOnStartup } from './server/recordingEngine.ts';

const PORT = Number(process.env.PORT) || 3000;
const app = createApiApp();

// ---------------------------------------------------------------------------
// VITE DEV / STATIC PROD SERVING ON PORT 3000
// ---------------------------------------------------------------------------
async function start() {
  let viteServer: Awaited<ReturnType<typeof import('vite')['createServer']>> | null = null;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const hmrEnabled = process.env.DISABLE_HMR !== 'true';
    viteServer = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrEnabled,
        ws: hmrEnabled ? undefined : false,
        watch: hmrEnabled ? undefined : null,
      },
      appType: 'spa',
    });
    app.use(viteServer.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`TV-TASKVERIFY running on http://0.0.0.0:${PORT}`);

    // Run non-blocking startup maintenance after port 3000 is already bound
    setImmediate(() => {
      try {
        reclassifyStoredEntries();
      } catch {
        // non-fatal on startup
      }
      if (process.env.ENABLE_EMBEDDED_WORKER === 'true') {
        recoverRecordingSessionsOnStartup().catch((err) => {
          console.error('Recording session auto-recovery error:', err);
        });
      }
    });
  });

  const shutdown = async () => {
    httpServer.close();
    if (viteServer) {
      await viteServer.close().catch(() => {});
    }
    process.exit(0);
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
