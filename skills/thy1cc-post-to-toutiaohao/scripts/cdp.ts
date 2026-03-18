import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a free TCP port.')));
        return;
      }

      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export function findChromeExecutable(): string | undefined {
  const override = process.env.TOUTIAOHAO_BROWSER_CHROME_PATH?.trim();
  if (override && fs.existsSync(override)) return override;

  const candidates: string[] = [];
  switch (process.platform) {
    case 'darwin':
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      );
      break;
    case 'win32':
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      );
      break;
    default:
      candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium');
      break;
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function getDefaultProfileDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'toutiaohao-browser-profile');
}

export async function fetchJsonDirect<T = unknown>(url: string): Promise<T> {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;

  return await new Promise<T>((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number.parseInt(target.port, 10) : undefined,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    }, (res) => {
      const statusCode = res.statusCode ?? 0;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Request failed: ${statusCode} ${res.statusMessage || ''}`.trim()));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

export function getChromeSpawnOptions(): SpawnOptions {
  return {
    stdio: 'ignore',
    detached: true,
  };
}

export function getChromeLaunchArgs(url: string, port: number, profileDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--start-maximized',
    url,
  ];
}

async function waitForChromeDebugPort(port: number, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let lastError: unknown = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const version = await fetchJsonDirect<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      lastError = new Error('Missing webSocketDebuggerUrl');
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  throw new Error(`Chrome debug port not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export class CdpConnection {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }>();
  private eventHandlers = new Map<string, Set<(params: unknown) => void>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener('message', (event) => {
      try {
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(data) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };

        if (msg.method) {
          const handlers = this.eventHandlers.get(msg.method);
          if (handlers) handlers.forEach((handler) => handler(msg.params));
        }

        if (msg.id) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (msg.error?.message) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        }
      } catch {}
    });

    this.ws.addEventListener('close', () => {
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed.'));
      }
    });
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout.')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connection failed.'));
      });
    });
    return new CdpConnection(ws);
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>, options?: { sessionId?: string; timeoutMs?: number }): Promise<T> {
    const id = ++this.nextId;
    const message: Record<string, unknown> = { id, method };
    if (params) message.params = params;
    if (options?.sessionId) message.sessionId = options.sessionId;

    const timeoutMs = options?.timeoutMs ?? 15_000;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(message));
    });
    return result as T;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

export interface ChromeSession {
  cdp: CdpConnection;
  sessionId: string;
  targetId: string;
}

export async function tryConnectExisting(port: number): Promise<CdpConnection | null> {
  try {
    const version = await fetchJsonDirect<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
    if (version.webSocketDebuggerUrl) {
      return await CdpConnection.connect(version.webSocketDebuggerUrl, 5_000);
    }
  } catch {}
  return null;
}

export async function findExistingChromeDebugPort(): Promise<number | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    const { execSync } = await import('node:child_process');
    const cmd = process.platform === 'darwin'
      ? `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i 'google\\|chrome' | awk '{print $9}' | sed 's/.*://'`
      : `ss -tlnp 2>/dev/null | grep -i chrome | awk '{print $4}' | sed 's/.*://'`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5_000 }).trim();
    if (!output) return null;

    const ports = output
      .split('\n')
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);

    for (const port of ports) {
      try {
        const version = await fetchJsonDirect<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
        if (version.webSocketDebuggerUrl) return port;
      } catch {}
    }
  } catch {}
  return null;
}

export async function launchChrome(url: string, profileDir?: string): Promise<{ cdp: CdpConnection; chrome: ReturnType<typeof spawn> }> {
  const chromePath = findChromeExecutable();
  if (!chromePath) throw new Error('Chrome not found. Set TOUTIAOHAO_BROWSER_CHROME_PATH if needed.');

  const profile = profileDir ?? getDefaultProfileDir();
  await mkdir(profile, { recursive: true });

  const port = await getFreePort();
  console.error(`[cdp] Launching Chrome (profile: ${profile})`);
  const chrome = spawn(chromePath, getChromeLaunchArgs(url, port, profile), getChromeSpawnOptions());
  chrome.unref();

  const wsUrl = await waitForChromeDebugPort(port, 30_000);
  const cdp = await CdpConnection.connect(wsUrl, 30_000);
  return { cdp, chrome };
}

export async function attachSessionToTarget(cdp: CdpConnection, targetId: string): Promise<ChromeSession> {
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, { sessionId });
  await cdp.send('Runtime.enable', {}, { sessionId });
  await cdp.send('DOM.enable', {}, { sessionId });
  return { cdp, sessionId, targetId };
}

export async function getPageSession(cdp: CdpConnection, urlPattern: string): Promise<ChromeSession> {
  const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
  const pageTarget = targets.targetInfos.find((target) => target.type === 'page' && target.url.includes(urlPattern));
  if (!pageTarget) throw new Error(`Page not found: ${urlPattern}`);
  return await attachSessionToTarget(cdp, pageTarget.targetId);
}

export async function evaluate<T = unknown>(session: ChromeSession, expression: string): Promise<T> {
  const result = await session.cdp.send<{ result: { value: T } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, { sessionId: session.sessionId });
  return result.result.value;
}
