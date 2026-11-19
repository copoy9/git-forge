// main.ts — process entry point and environment lifecycle.
//
// The harness contract: bind an ephemeral port (never 8080, the environment
// owns it), POST the chosen port to $MAKEFUN_ENV_URL/register, then poll
// $MAKEFUN_ENV_URL/done until the environment reports the trial is over and
// exit 0. Without MAKEFUN_ENV_URL the forge runs in development mode: it
// listens on $PORT (or an ephemeral port) and serves until killed, which is
// how the kit's local runner is pointed at it.

import { Forge } from './store.ts';
import { createForgeServer } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerWithRetry(envUrl: string, port: number): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await response.text();
      if (response.ok) return;
    } catch {
      // The environment may still be coming up; keep trying.
    }
    await sleep(250);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A transient poll failure is not the end of the trial; keep waiting.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const forge = new Forge();
  const server = createForgeServer(forge);
  const envUrl = process.env['MAKEFUN_ENV_URL'];

  if (envUrl === undefined || envUrl === '') {
    const requested = Number.parseInt(process.env['PORT'] ?? '', 10);
    const port = Number.isFinite(requested) && requested > 0 ? requested : 0;
    await new Promise<void>((resolve) => server.listen(port, resolve));
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`forge listening on port ${bound} (development mode)`);
    return;
  }

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('server did not bind a port');
  await registerWithRetry(envUrl, address.port);
  await waitForDone(envUrl);
  server.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('forge: fatal startup error:', err);
  process.exit(1);
});
