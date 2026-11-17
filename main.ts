import { createServer } from 'node:http';
import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) process.exit(1);

const server = createServer(createApp());
server.listen(0, '0.0.0.0');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No TCP listener');

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path: string, init?: RequestInit): Promise<Response> {
  let delay = 50;
  for (;;) {
    try {
      const response = await fetch(new URL(path, envUrl), init);
      if (response.status === 400 || response.status === 405) throw new Error(`Fatal lifecycle response ${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Fatal lifecycle')) throw error;
      await pause(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
}

await request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: address.port }) });
for (;;) {
  const response = await request('/done');
  let body: { done?: boolean } = {};
  try { body = await response.json() as { done?: boolean }; } catch { /* retry malformed transient response */ }
  if (body.done === true) break;
  await pause(250);
}
await new Promise<void>((resolve) => server.close(() => resolve()));
