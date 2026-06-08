/**
 * Gateway — WS lifecycle management + bot registration + token refresh.
 */

import { WKSocket } from './octo/socket.js';
import { registerBot, sendHeartbeat } from './octo/api.js';
import type { Config } from './config.js';
import type { BotMessage } from './octo/types.js';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

// Read version from package.json at load time (Q31: no hardcoded version).
const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require('../package.json') as { version: string }).version;

export type MessageHandler = (msg: BotMessage) => void;

export class OctoGateway {
  private socket: WKSocket | null = null;
  private robotId = '';
  // Stored registration result from register(); consumed by connect().
  private registration: Awaited<ReturnType<typeof registerBot>> | null = null;
  // True once connect() opened the WebSocket. Webhook mode leaves this false, so
  // token refresh re-registers WITHOUT reopening a socket (no WS in that mode).
  private wsEnabled = false;
  // G18: owner_uid from registerBot; used by SessionRouter for future permission model.
  private _ownerUid = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lockFilePath: string;
  /** Random per-process token written into the lock so ownership survives PID
   *  reuse: release only removes a lock that still carries OUR nonce. */
  private readonly lockNonce = randomUUID();
  private onMessage: MessageHandler | null = null;

  /** When true, new messages are silently dropped (shutdown draining). */
  private _draining = false;

  // Token refresh state
  private isRefreshing = false;
  private lastRefreshTime = 0;
  private readonly REFRESH_COOLDOWN_MS = 60_000;

  // Heartbeat failure tracking
  private heartbeatFailCount = 0;
  private readonly MAX_HEARTBEAT_FAILURES = 3;
  /** True while a heartbeat request is in flight — prevents overlapping ticks. */
  private heartbeatInFlight = false;
  /** Bumped on each startHeartbeat() so an orphaned tick from a prior run can't
   *  mutate the new counter (see the generation guard in the tick). */
  private heartbeatGen = 0;

  constructor(
    private readonly config: Config,
    private readonly options: { handleSignals?: boolean } = {},
  ) {
    this.lockFilePath = join(config.dataDir, 'gateway.lock');
  }

  get botId(): string {
    return this.robotId;
  }

  /** G18: owner_uid returned by registerBot. Empty string until start() succeeds. */
  get ownerUid(): string {
    return this._ownerUid;
  }

  /** Set the message handler. Called for every incoming BotMessage. */
  setMessageHandler(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  /**
   * Start the gateway: register → connect WS → heartbeat. Convenience wrapper
   * that does registration and connection in one call (single-bot path + tests).
   * Multi-bot startup calls register() and connect() separately so no socket
   * begins ACKing messages before its message handler is installed.
   */
  async start(): Promise<void> {
    await this.register();
    this.connect();
  }

  /**
   * Phase 1 of startup: acquire the lock and register the bot over REST. This
   * populates botId/ownerUid but does NOT open the WebSocket, so no messages can
   * arrive yet. Safe to call before the message handler is wired.
   */
  async register(): Promise<void> {
    this.acquireLock();
    try {
      const reg = await registerBot({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        agentPlatform: 'cc-channel-octo',
        agentVersion: PKG_VERSION,
      });
      this.robotId = reg.robot_id;
      this._ownerUid = reg.owner_uid;
      this.registration = reg;
      console.log(`Bot registered: robot_id=${reg.robot_id}`);
    } catch (err) {
      // registerBot failed (bad token, network) AFTER we took the lock. Release
      // it so a partial-startup failure doesn't leave a stale lock with this
      // live PID — otherwise the next start refuses with "Another instance is
      // running". The multi-bot startup cleanup only tears down bots that
      // returned a BotStack, so this failed bot must clean up its own lock here.
      this.releaseLock();
      throw err;
    }
  }

  /**
   * Phase 2 of startup: open the WebSocket and start the heartbeat. Call only
   * AFTER setMessageHandler() so inbound messages are dispatched, not ACK'd and
   * dropped. Registers signal handlers unless handleSignals is false.
   */
  connect(): void {
    if (!this.registration) {
      throw new Error('OctoGateway.connect() called before register()');
    }
    const reg = this.registration;
    this.socket = this.createSocket(reg.ws_url, reg.robot_id, reg.im_token);
    this.socket.connect();
    this.wsEnabled = true;
    this.startServices();
  }

  /**
   * Start the REST-backed runtime services that must run regardless of inbound
   * transport: the heartbeat / token-refresh loop and (unless handleSignals is
   * false) the SIGINT/SIGTERM shutdown handlers. Called by connect() for the WS
   * path, and directly by webhook mode — which opens no socket but still needs
   * heartbeat + graceful shutdown. Idempotent-safe to call once per gateway.
   */
  startServices(): void {
    if (!this.registration) {
      throw new Error('OctoGateway.startServices() called before register()');
    }
    this.startHeartbeat();
    // Multi-bot: the orchestrator owns a single combined SIGINT/SIGTERM handler,
    // so individual gateways skip registering their own (default true keeps the
    // single-bot behavior unchanged).
    if (this.options.handleSignals !== false) {
      this.setupShutdownHandlers();
    }
  }

  /** Whether the gateway is draining (rejecting new messages). */
  get draining(): boolean {
    return this._draining;
  }

  /**
   * Gracefully stop: set draining → wait for in-flight handlers →
   * stop heartbeat → disconnect WS → release lock.
   *
   * @param activeHandlers - Set of in-flight handler promises to drain.
   *   Supplied by the orchestrator (index.ts) that tracks them.
   * @param drainTimeoutMs - Max time (ms) to wait for in-flight handlers
   *   before force-proceeding. Default 10000.
   */
  async stop(
    activeHandlers?: Set<Promise<void>>,
    drainTimeoutMs = 10_000,
  ): Promise<void> {
    // Mark draining — new messages will be dropped by handleMessage
    this._draining = true;

    // Wait for in-flight message handlers to complete (with timeout)
    if (activeHandlers && activeHandlers.size > 0) {
      console.log(`[cc-channel-octo] Draining ${activeHandlers.size} in-flight handler(s)...`);
      const drainPromise = Promise.allSettled([...activeHandlers]);
      const timeout = new Promise<void>((r) => setTimeout(r, drainTimeoutMs));
      await Promise.race([drainPromise, timeout]);
      if (activeHandlers.size > 0) {
        console.warn(`[cc-channel-octo] Drain timeout, ${activeHandlers.size} handler(s) still active`);
      }
    }

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

    const content = `${process.pid} ${this.lockNonce}`;
    // Try at most twice: first attempt, then once more after reclaiming a stale
    // lock. The create is ATOMIC (flag 'wx' = O_EXCL) so two processes racing to
    // acquire can't both succeed — the loser gets EEXIST and is handled as "held"
    // (or reclaims only if the holder is provably dead).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.lockFilePath, content, { mode: 0o600, flag: 'wx' });
        return; // won the lock atomically
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'EEXIST') throw err; // unexpected fs error
        // Lock exists — decide whether the holder is alive.
        if (attempt > 0 || !this.reclaimIfStale()) {
          // Either we already reclaimed once and lost the re-create race (a
          // concurrent process won — it IS running), or the holder is alive.
          const held = this.readLockPid();
          throw new Error(
            `Another instance is running (PID ${held ?? 'unknown'}). Lock file: ${this.lockFilePath}`,
          );
        }
        // reclaimIfStale() removed a dead lock — loop once to re-create.
      }
    }
  }

  /** Read the PID field of the existing lock, or null if unreadable. */
  private readLockPid(): number | null {
    try {
      const pid = parseInt(readFileSync(this.lockFilePath, 'utf-8').trim().split(/\s+/)[0], 10);
      return Number.isInteger(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * If the existing lock's holder is provably gone, remove it and return true so
   * the caller can retry the atomic create. Returns false if the holder is alive
   * (or the lock vanished — caller's retry will race fairly).
   */
  private reclaimIfStale(): boolean {
    const pid = this.readLockPid();
    if (pid === null) {
      // Corrupt/empty/non-numeric lock (e.g. a partial write) — reclaim it.
      try { unlinkSync(this.lockFilePath); } catch { /* vanished — fine */ }
      return true;
    }
    try {
      process.kill(pid, 0); // signal 0 = liveness check
      return false; // holder is alive and signalable → genuinely held
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EPERM') {
        // PID exists but owned by another user — can't be our bot (one service
        // user per dataDir), so almost certainly a reused PID. Reclaim.
        console.warn(
          `Lock PID ${pid} exists but is not signalable (EPERM) — likely a reused ` +
          `PID; reclaiming the stale lock at ${this.lockFilePath}`,
        );
      } else {
        console.log(`Removing stale lock file (PID ${pid} not found)`);
      }
      try { unlinkSync(this.lockFilePath); } catch { /* vanished — fine */ }
      return true;
    }
  }

  private releaseLock(): void {
    try {
      if (existsSync(this.lockFilePath)) {
        const content = readFileSync(this.lockFilePath, 'utf-8').trim();
        // Only remove the lock if it still carries OUR nonce — so a lock another
        // instance acquired after a PID-reuse race is never deleted by us.
        const [, nonce] = content.split(/\s+/);
        if (nonce === this.lockNonce) {
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
  // (register() + connect() above split the two phases; see start().)

  private handleMessage(msg: BotMessage): void {
    if (this._draining) return; // Q6: reject new messages during shutdown
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

      // Q33: Stop heartbeat during refresh to avoid empty pings
      this.stopHeartbeat();

      if (this.socket) {
        await this.socket.disconnectAndWait();
        this.socket = null;
      }

      const reg = await registerBot({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        forceRefresh: true,
        agentPlatform: 'cc-channel-octo',
        agentVersion: PKG_VERSION,
      });

      this.robotId = reg.robot_id;
      this._ownerUid = reg.owner_uid;
      this.registration = reg;
      console.log('Token refreshed' + (this.wsEnabled ? ', reconnecting...' : ' (webhook mode, no socket)'));

      // Only reopen the WebSocket when this gateway actually uses one. In webhook
      // mode there is no socket to reconnect — refreshing the credentials is
      // enough for outbound REST calls.
      if (this.wsEnabled) {
        this.socket = this.createSocket(reg.ws_url, reg.robot_id, reg.im_token);
        this.socket.connect();
      }
      this.startHeartbeat(); // Q33: Restart API heartbeat after successful refresh
    } catch (err) {
      console.error('Token refresh failed:', String(err));
      this.startHeartbeat(); // Q33: Restore heartbeat on failure for self-healing
    } finally {
      this.isRefreshing = false;
    }
  }

  // --- Heartbeat (API-level, 30s interval) ---

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatFailCount = 0;
    const gen = ++this.heartbeatGen;
    this.heartbeatTimer = setInterval(() => {
      // Overlap guard: if the previous heartbeat hasn't settled (degraded API
      // where a request takes ~>= the 30s interval), skip this tick instead of
      // piling up concurrent requests and racing heartbeatFailCount.
      if (this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      void (async () => {
        try {
          await sendHeartbeat({
            apiUrl: this.config.apiUrl,
            botToken: this.config.botToken,
          });
          // Generation guard: a tick from a superseded startHeartbeat() (e.g.
          // after a token refresh re-armed the timer) must not touch the live
          // counter or it could spuriously reset/trip the new one.
          if (gen !== this.heartbeatGen) return;
          this.heartbeatFailCount = 0;
        } catch (err) {
          if (gen !== this.heartbeatGen) return;
          this.heartbeatFailCount++;
          console.error(
            `Heartbeat failed (${this.heartbeatFailCount}/${this.MAX_HEARTBEAT_FAILURES}):`,
            String(err),
          );
          if (this.heartbeatFailCount >= this.MAX_HEARTBEAT_FAILURES) {
            console.error('Max heartbeat failures reached, triggering reconnect...');
            this.heartbeatFailCount = 0;
            void this.attemptTokenRefresh();
          }
        } finally {
          // Guard the flag reset by generation too: an orphaned tick from a
          // superseded startHeartbeat() must NOT clear the live generation's
          // in-flight flag, or the next live tick could start a 2nd concurrent
          // request — exactly the overlap this guard prevents. stopHeartbeat()
          // resets the flag when it abandons a generation.
          if (gen === this.heartbeatGen) this.heartbeatInFlight = false;
        }
      })();
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Invalidate any in-flight tick so its result is ignored, and allow the next
    // startHeartbeat to issue immediately.
    this.heartbeatGen++;
    this.heartbeatInFlight = false;
  }

  // --- Graceful shutdown ---

  private onShutdown: (() => Promise<void>) | null = null;

  /**
   * Set a shutdown callback. Called on SIGINT/SIGTERM before process.exit.
   * The orchestrator (index.ts) wires this to drain handlers + close store.
   */
  setShutdownCallback(fn: () => Promise<void>): void {
    this.onShutdown = fn;
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down...`);
      if (this.onShutdown) {
        await this.onShutdown();
      } else {
        await this.stop();
      }
      process.exit(0);
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  }
}
