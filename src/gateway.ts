/**
 * Gateway — WS lifecycle management + bot registration + token refresh.
 */

import { WKSocket } from './octo/socket.js';
import { registerBot, sendHeartbeat } from './octo/api.js';
import type { Config } from './config.js';
import type { BotMessage } from './octo/types.js';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type MessageHandler = (msg: BotMessage) => void;

export class OctoGateway {
  private socket: WKSocket | null = null;
  private robotId = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lockFilePath: string;
  private onMessage: MessageHandler | null = null;

  // Token refresh state
  private isRefreshing = false;
  private lastRefreshTime = 0;
  private readonly REFRESH_COOLDOWN_MS = 60_000;

  // Heartbeat failure tracking
  private heartbeatFailCount = 0;
  private readonly MAX_HEARTBEAT_FAILURES = 3;

  constructor(private readonly config: Config) {
    this.lockFilePath = join(config.dataDir, 'gateway.lock');
  }

  get botId(): string {
    return this.robotId;
  }

  /** Set the message handler. Called for every incoming BotMessage. */
  setMessageHandler(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  /** Start the gateway: acquire lock → register bot → connect WS → start heartbeat */
  async start(): Promise<void> {
    this.acquireLock();
    await this.registerAndConnect();
    this.startHeartbeat();
    this.setupShutdownHandlers();
  }

  /** Gracefully stop: disconnect WS + clear heartbeat + release lock */
  async stop(): Promise<void> {
    this.stopHeartbeat();
    if (this.socket) {
      await this.socket.disconnectAndWait();
      this.socket = null;
    }
    this.releaseLock();
  }

  // --- Lock file ---

  private acquireLock(): void {
    const dir = dirname(this.lockFilePath);
    mkdirSync(dir, { recursive: true });

    if (existsSync(this.lockFilePath)) {
      const content = readFileSync(this.lockFilePath, 'utf-8').trim();
      const pid = parseInt(content, 10);
      if (pid && !isNaN(pid)) {
        try {
          process.kill(pid, 0); // signal 0 = check existence
          throw new Error(
            `Another instance is running (PID ${pid}). Lock file: ${this.lockFilePath}`,
          );
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ESRCH') {
            console.log(`Removing stale lock file (PID ${pid} not found)`);
          } else if (e.message?.includes('Another instance')) {
            throw err;
          } else if (e.code === 'EPERM') {
            throw new Error(
              `Another instance is running (PID ${pid}). Lock file: ${this.lockFilePath}`,
            );
          }
        }
      }
    }
    writeFileSync(this.lockFilePath, String(process.pid), { mode: 0o600 });
  }

  private releaseLock(): void {
    try {
      if (existsSync(this.lockFilePath)) {
        const content = readFileSync(this.lockFilePath, 'utf-8').trim();
        if (content === String(process.pid)) {
          unlinkSync(this.lockFilePath);
        }
      }
    } catch {
      /* best effort */
    }
  }

  // --- Socket factory ---

  private createSocket(wsUrl: string, uid: string, token: string): WKSocket {
    return new WKSocket({
      wsUrl,
      uid,
      token,
      onMessage: (msg) => this.handleMessage(msg),
      onConnected: () => {
        console.log('WS connected');
        this.heartbeatFailCount = 0;
      },
      onDisconnected: () => {
        console.log('WS disconnected');
      },
      onError: (err) => {
        console.error('WS error:', err.message);
        if (err.message.includes('Kicked') || err.message.includes('Connect failed')) {
          void this.attemptTokenRefresh();
        }
      },
    });
  }

  // --- Bot registration + WS connection ---

  private async registerAndConnect(): Promise<void> {
    const reg = await registerBot({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      agentPlatform: 'cc-channel-octo',
      agentVersion: '0.1.0',
    });

    this.robotId = reg.robot_id;
    console.log(`Bot registered: robot_id=${reg.robot_id}`);

    this.socket = this.createSocket(reg.ws_url, reg.robot_id, reg.im_token);
    this.socket.connect();
  }

  private handleMessage(msg: BotMessage): void {
    if (msg.from_uid === this.robotId) return;
    this.onMessage?.(msg);
  }

  // --- Token refresh ---

  private async attemptTokenRefresh(): Promise<void> {
    if (this.isRefreshing) return;

    const now = Date.now();
    if (now - this.lastRefreshTime < this.REFRESH_COOLDOWN_MS) {
      const remaining = Math.ceil((this.REFRESH_COOLDOWN_MS - (now - this.lastRefreshTime)) / 1000);
      console.log(`Token refresh cooldown (${remaining}s remaining)`);
      return;
    }

    this.isRefreshing = true;
    this.lastRefreshTime = now;

    try {
      console.log('Attempting token refresh...');

      if (this.socket) {
        await this.socket.disconnectAndWait();
        this.socket = null;
      }

      const reg = await registerBot({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        forceRefresh: true,
        agentPlatform: 'cc-channel-octo',
        agentVersion: '0.1.0',
      });

      this.robotId = reg.robot_id;
      console.log('Token refreshed, reconnecting...');

      this.socket = this.createSocket(reg.ws_url, reg.robot_id, reg.im_token);
      this.socket.connect();
    } catch (err) {
      console.error('Token refresh failed:', err);
    } finally {
      this.isRefreshing = false;
    }
  }

  // --- Heartbeat (API-level, 30s interval) ---

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatFailCount = 0;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await sendHeartbeat({
          apiUrl: this.config.apiUrl,
          botToken: this.config.botToken,
        });
        this.heartbeatFailCount = 0;
      } catch (err) {
        this.heartbeatFailCount++;
        console.error(
          `Heartbeat failed (${this.heartbeatFailCount}/${this.MAX_HEARTBEAT_FAILURES}):`,
          err,
        );
        if (this.heartbeatFailCount >= this.MAX_HEARTBEAT_FAILURES) {
          console.error('Max heartbeat failures reached, triggering reconnect...');
          this.heartbeatFailCount = 0;
          void this.attemptTokenRefresh();
        }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- Graceful shutdown ---

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  }
}
