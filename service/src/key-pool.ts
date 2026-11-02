import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Lightweight async mutex — serialises critical sections on the Node.js event loop. */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

export interface KeyInfo {
  apiKey: string;
  remainingCredit: number;
  lastUsed?: string;
  enabled: boolean;
  qps?: number;
  lastRequestTime?: number;
  disabledUntil?: string;
}

export interface KeyWithMetadata {
  credit: number;
  lastUsed?: string;
  enabled: boolean;
  qps?: number;
  lastRequestTime?: number;
  /** Timestamps (ms) of upstream calls in the rolling 60 s window; the per-key RPM budget is enforced on this. */
  requestTimes?: number[];
  /** Number of consecutive non-auth errors (reset on success). */
  consecutiveErrors?: number;
  /** ISO timestamp when the key was temporarily disabled. */
  disabledUntil?: string;
}

interface KeyStoreData {
  version: string;
  lastSync: string;
  keys: Record<string, KeyWithMetadata>;
}

const DEFAULT_QPS = 1;
const MIN_REQUEST_INTERVAL_MS = 100;

export interface LocalKVStoreOptions {
  /**
   * Per-key rolling 60-second request cap — mirrors the upstream per-key RPM
   * limit (Tavily: 100 RPM). A key is rate-limited once its window is full.
   */
  rpmLimit?: number;
}

export class LocalKVStore {
  private storePath: string;
  private cache: KeyStoreData | null = null;
  private mutex = new AsyncMutex();
  /** Serialises disk writes. Held only inside save(); never nested in other locks. */
  private saveMutex = new AsyncMutex();
  /** Debounced persistence: mutations mark dirty; flush() writes when needed. */
  private dirty = false;
  private flushTimer?: ReturnType<typeof setInterval>;
  private static readonly FLUSH_INTERVAL_MS = 30_000;
  /** Rolling-window length for the per-key RPM budget. */
  private static readonly RPM_WINDOW_MS = 60_000;
  /** Per-key request cap within RPM_WINDOW_MS (from options; default 100). */
  private readonly rpmLimit: number;

  constructor(storePath: string, options: LocalKVStoreOptions = {}) {
    this.storePath = storePath;
    this.rpmLimit = options.rpmLimit ?? 100;
  }

  async initialize(): Promise<void> {
    try {
      await fs.access(this.storePath);
      await this.load();
    } catch {
      this.cache = {
        version: "1.1",
        lastSync: new Date().toISOString(),
        keys: {}
      };
      await this.save();
    }
    this.startFlushTimer();
  }

  /** Background interval that flushes dirty state to disk. Unref'd so it never keeps the process alive. */
  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => console.error('[key-pool] periodic flush failed:', err));
    }, LocalKVStore.FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  /** Mark in-memory state dirty; written out by the next flush(). Replaces per-request disk writes. */
  private markDirty(): void {
    this.dirty = true;
  }

  /** Persist now if dirty. No-op when clean. On failure the dirty flag is re-set so the timer retries. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.save();
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  /** Stop the background timer and persist any pending state. Call on graceful shutdown. */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  private async load(): Promise<void> {
    const content = await fs.readFile(this.storePath, 'utf-8');
    this.cache = JSON.parse(content);
  }

  private async save(): Promise<void> {
    // Serialise writes: concurrent callers used to share one tempPath, so the
    // first rename() consumed the file and the second rename() hit ENOENT.
    const unlock = await this.saveMutex.acquire();
    try {
      if (!this.cache) throw new Error('Store not initialized');

      const dir = path.dirname(this.storePath);
      await fs.mkdir(dir, { recursive: true });

      // Unique temp name per call — belt-and-braces against any future
      // interleaving (e.g. another writer pointing at the same file).
      const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.cache, null, 2), 'utf-8');
      await fs.rename(tempPath, this.storePath);
    } finally {
      unlock();
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.cache) await this.load();
    if (!this.cache) return null;
    
    const keyData = this.cache.keys[key];
    return keyData ? String(keyData.credit) : null;
  }

  async put(key: string, value: string, qps?: number): Promise<void> {
    if (!this.cache) await this.load();
    if (!this.cache) throw new Error('Store not initialized');
    
    const existing = this.cache.keys[key];
    this.cache.keys[key] = {
      // Preserve everything already tracked (requestTimes, consecutiveErrors,
      // disabledUntil...) — a bare literal here used to silently wipe them
      // every time a credit sync ran.
      ...existing,
      credit: Number(value),
      lastUsed: new Date().toISOString(),
      enabled: true,
      qps: qps ?? existing?.qps ?? DEFAULT_QPS,
      lastRequestTime: existing?.lastRequestTime
    };
    this.cache.lastSync = new Date().toISOString();

    this.markDirty();
  }

  async updateLastRequestTime(key: string): Promise<void> {
    if (!this.cache) await this.load();
    if (!this.cache) throw new Error('Store not initialized');
    
    const keyData = this.cache.keys[key];
    if (keyData) {
      keyData.lastRequestTime = Date.now();
      keyData.lastUsed = new Date().toISOString();
      this.markDirty();
    }
  }

  async setQps(key: string, qps: number): Promise<void> {
    if (!this.cache) await this.load();
    if (!this.cache) throw new Error('Store not initialized');
    
    const keyData = this.cache.keys[key];
    if (keyData) {
      keyData.qps = Math.max(0.1, Math.min(100, qps));
      await this.save();
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.cache) await this.load();
    if (!this.cache) throw new Error('Store not initialized');
    
    delete this.cache.keys[key];
    this.cache.lastSync = new Date().toISOString();
    
    await this.save();
  }

  async list(): Promise<{ 
    keys: Array<{ name: string }>, 
    list_complete?: boolean, 
    cursor?: string 
  }> {
    if (!this.cache) await this.load();
    if (!this.cache) return { keys: [] };
    
    const keyNames = Object.keys(this.cache.keys);
    return {
      keys: keyNames.map(name => ({ name })),
      list_complete: true
    };
  }

  async getAllKeys(): Promise<KeyInfo[]> {
    if (!this.cache) await this.load();
    if (!this.cache) return [];
    
    return Object.entries(this.cache.keys).map(([apiKey, data]) => ({
      apiKey,
      remainingCredit: data.credit,
      lastUsed: data.lastUsed,
      enabled: data.enabled,
      qps: data.qps ?? DEFAULT_QPS,
      lastRequestTime: data.lastRequestTime,
      disabledUntil: data.disabledUntil,
    }));
  }

  /** Record a non-auth error for a key. After 3 consecutive errors, temporarily disable for 5 minutes. */
  async recordError(apiKey: string): Promise<void> {
    if (!this.cache) await this.load();
    if (!this.cache) return;

    const keyData = this.cache.keys[apiKey];
    if (!keyData) return;

    keyData.consecutiveErrors = (keyData.consecutiveErrors ?? 0) + 1;

    if (keyData.consecutiveErrors >= 3) {
      const disabledUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      keyData.disabledUntil = disabledUntil;
      console.warn(`[key-pool] Key ${apiKey.substring(0, 13)}... temporarily disabled until ${disabledUntil} (${keyData.consecutiveErrors} consecutive errors)`);
    }

    this.markDirty();
  }

  /** Reset consecutive error count on success. */
  async recordSuccess(apiKey: string): Promise<void> {
    if (!this.cache) await this.load();
    if (!this.cache) return;

    const keyData = this.cache.keys[apiKey];
    if (!keyData) return;

    keyData.consecutiveErrors = 0;
    // Clear temporary disable if any
    if (keyData.disabledUntil) {
      delete keyData.disabledUntil;
    }

    this.markDirty();
  }

  /** Requests made on this key within the rolling 60 s window. */
  private recentRequests(keyData: KeyWithMetadata, now: number): number[] {
    return (keyData.requestTimes ?? []).filter(
      (t) => now - t < LocalKVStore.RPM_WINDOW_MS
    );
  }

  /**
   * Rate-limit rule (mirrors the upstream per-key 100 RPM budget):
   * a key is limited when its rolling 60 s request count reached rpmLimit,
   * or within MIN_REQUEST_INTERVAL_MS of the previous request (burst floor).
   * The legacy `qps` field no longer drives spacing.
   */
  private isRateLimited(keyData: KeyWithMetadata): boolean {
    const now = Date.now();
    if (
      keyData.lastRequestTime &&
      now - keyData.lastRequestTime < MIN_REQUEST_INTERVAL_MS
    ) {
      return true;
    }
    return this.recentRequests(keyData, now).length >= this.rpmLimit;
  }

  /** Stamp an actual upstream request on a key: one entry in the RPM window. */
  async recordRequestStart(apiKey: string): Promise<void> {
    if (!this.cache) await this.load();
    if (!this.cache) return;

    const keyData = this.cache.keys[apiKey];
    if (!keyData) return;

    const now = Date.now();
    keyData.lastRequestTime = now;
    const window = this.recentRequests(keyData, now);
    window.push(now);
    keyData.requestTimes = window;
    this.markDirty();
  }

  async pickBestKey(): Promise<{ apiKey: string; wasRateLimited: boolean } | null> {
    const unlock = await this.mutex.acquire();
    try {
      return await this._pickBestKeyInner();
    } finally {
      unlock();
    }
  }

  private async _pickBestKeyInner(): Promise<{ apiKey: string; wasRateLimited: boolean } | null> {
    const QPS_TIMEOUT_MS = 10_000;

    const allKeys = await this.getAllKeys();
    const now = Date.now();
    const availableKeys = allKeys.filter(k => {
      if (k.remainingCredit <= 0 || !k.enabled) return false;
      // Skip keys that are temporarily disabled
      if (k.disabledUntil && new Date(k.disabledUntil).getTime() > now) return false;
      return true;
    });

    if (availableKeys.length === 0) return null;

    availableKeys.sort((a, b) => b.remainingCredit - a.remainingCredit);

    if (!this.cache) await this.load();
    if (!this.cache) return null;

    // Try to find an immediately available key; if found, lock it before returning.
    for (const key of availableKeys) {
      const keyData = this.cache.keys[key.apiKey];
      if (keyData && !this.isRateLimited(keyData)) {
        // Atomic soft-lock: stamp lastRequestTime now so concurrent calls cannot
        // pick the same key within the same rate-limit window.
        keyData.lastRequestTime = Date.now();
        this.markDirty();
        return { apiKey: key.apiKey, wasRateLimited: false };
      }
    }

    // All keys are rate-limited – wait for the best key, capped at QPS_TIMEOUT_MS.
    const bestKey = availableKeys[0];
    const keyData = this.cache.keys[bestKey.apiKey];
    let waitTimeMs = 0;
    if (keyData) {
      const burstRemaining = keyData.lastRequestTime
        ? Math.max(0, MIN_REQUEST_INTERVAL_MS - (now - keyData.lastRequestTime))
        : 0;
      const window = this.recentRequests(keyData, now);
      if (window.length < this.rpmLimit) {
        // Only the burst floor stands in the way.
        waitTimeMs = burstRemaining;
      } else if (window.length > 0) {
        // Window is full: wait until the oldest request ages out of it.
        const oldest = Math.min(...window);
        waitTimeMs = Math.max(0, oldest + LocalKVStore.RPM_WINDOW_MS - now);
      }
    }

    if (waitTimeMs > QPS_TIMEOUT_MS) {
      throw new Error(
        `All API keys are rate-limited (rolling 60s window full); minimum wait (${waitTimeMs}ms) exceeds timeout (${QPS_TIMEOUT_MS}ms). Try again later.`
      );
    }

    console.log(`[rate-limit] All keys limited, waiting ${waitTimeMs}ms for best key: ${bestKey.apiKey.substring(0, 13)}...`);

    if (waitTimeMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTimeMs));
    }

    // Re-load cache after the wait so we stamp the latest state.
    if (!this.cache) await this.load();
    if (!this.cache) return null;

    const keyDataAfterWait = this.cache.keys[bestKey.apiKey];
    if (keyDataAfterWait) {
      // Atomic soft-lock: stamp now before returning.
      keyDataAfterWait.lastRequestTime = Date.now();
      this.markDirty();
    }

    return { apiKey: bestKey.apiKey, wasRateLimited: true };
  }
}

export function createLocalKV(storePath: string, options?: LocalKVStoreOptions): LocalKVStore {
  const store = new LocalKVStore(storePath, options);
  return store;
}

export async function syncKeyWithApi(kv: LocalKVStore, apiKey: string): Promise<number> {
  const { getRemainingCredit } = await import('./tavily-client.js');
  const remaining = await getRemainingCredit(apiKey);
  await kv.put(apiKey, String(remaining));
  return remaining;
}