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

export class LocalKVStore {
  private storePath: string;
  private cache: KeyStoreData | null = null;
  private mutex = new AsyncMutex();

  constructor(storePath: string) {
    this.storePath = storePath;
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
  }

  private async load(): Promise<void> {
    const content = await fs.readFile(this.storePath, 'utf-8');
    this.cache = JSON.parse(content);
  }

  private async save(): Promise<void> {
    if (!this.cache) throw new Error('Store not initialized');
    
    const dir = path.dirname(this.storePath);
    await fs.mkdir(dir, { recursive: true });
    
    const tempPath = this.storePath + '.tmp';
    await fs.writeFile(tempPath, JSON.stringify(this.cache, null, 2), 'utf-8');
    await fs.rename(tempPath, this.storePath);
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
      credit: Number(value),
      lastUsed: new Date().toISOString(),
      enabled: true,
      qps: qps ?? existing?.qps ?? DEFAULT_QPS,
      lastRequestTime: existing?.lastRequestTime
    };
    this.cache.lastSync = new Date().toISOString();
    
    await this.save();
  }

  async updateLastRequestTime(key: string): Promise<void> {
    if (!this.cache) await this.load();
    if (!this.cache) throw new Error('Store not initialized');
    
    const keyData = this.cache.keys[key];
    if (keyData) {
      keyData.lastRequestTime = Date.now();
      keyData.lastUsed = new Date().toISOString();
      await this.save();
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

    await this.save();
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

    await this.save();
  }

  private isRateLimited(keyData: KeyWithMetadata): boolean {
    if (!keyData.lastRequestTime) return false;
    
    const qps = keyData.qps ?? DEFAULT_QPS;
    const minIntervalMs = Math.max(MIN_REQUEST_INTERVAL_MS, 1000 / qps);
    const elapsed = Date.now() - keyData.lastRequestTime;
    
    return elapsed < minIntervalMs;
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
        await this.save();
        return { apiKey: key.apiKey, wasRateLimited: false };
      }
    }

    // All keys are rate-limited – wait for the best key, capped at QPS_TIMEOUT_MS.
    const bestKey = availableKeys[0];
    const keyData = this.cache.keys[bestKey.apiKey];
    const qps = keyData?.qps ?? DEFAULT_QPS;
    const waitTimeMs = keyData?.lastRequestTime
      ? Math.max(0, Math.ceil(1000 / qps) - (Date.now() - keyData.lastRequestTime))
      : 0;

    if (waitTimeMs > QPS_TIMEOUT_MS) {
      throw new Error(
        `All API keys are rate-limited; minimum wait (${waitTimeMs}ms) exceeds timeout (${QPS_TIMEOUT_MS}ms). Try again later.`
      );
    }

    console.log(`[QPS] All keys rate-limited, waiting ${waitTimeMs}ms for best key: ${bestKey.apiKey.substring(0, 13)}...`);

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
      await this.save();
    }

    return { apiKey: bestKey.apiKey, wasRateLimited: true };
  }
}

export function createLocalKV(storePath: string): LocalKVStore {
  const store = new LocalKVStore(storePath);
  return store;
}

export async function syncKeyWithApi(kv: LocalKVStore, apiKey: string): Promise<number> {
  const { getRemainingCredit } = await import('./tavily-client.js');
  const remaining = await getRemainingCredit(apiKey);
  await kv.put(apiKey, String(remaining));
  return remaining;
}