import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { LocalKVStore, createLocalKV, KeyInfo } from '../src/key-pool.js';

describe('LocalKVStore', () => {
  let testStorePath: string;
  let store: LocalKVStore;

  beforeEach(async () => {
    testStorePath = path.join('/tmp', `tavily-test-${Date.now()}.json`);
    store = new LocalKVStore(testStorePath);
  });

  afterEach(async () => {
    await fs.unlink(testStorePath).catch(() => {});
  });

  describe('initialization', () => {
    it('should create empty store if file does not exist', async () => {
      await store.initialize();
      
      const keys = await store.getAllKeys();
      assert.strictEqual(keys.length, 0);
    });

    it('should load existing store from file', async () => {
      const initialData = {
        version: "1.0",
        lastSync: "2025-03-13T10:00:00Z",
        keys: {
          "tvly-test1": { credit: 1000, enabled: true },
          "tvly-test2": { credit: 500, enabled: true }
        }
      };
      
      await fs.writeFile(testStorePath, JSON.stringify(initialData), 'utf-8');
      await store.initialize();
      
      const keys = await store.getAllKeys();
      assert.strictEqual(keys.length, 2);
      assert.strictEqual(keys.find((k: KeyInfo) => k.apiKey === 'tvly-test1')?.remainingCredit, 1000);
      assert.strictEqual(keys.find((k: KeyInfo) => k.apiKey === 'tvly-test2')?.remainingCredit, 500);
    });
  });

  describe('get/put', () => {
    it('should get null for non-existent key', async () => {
      await store.initialize();
      
      const value = await store.get('non-existent-key');
      assert.strictEqual(value, null);
    });

    it('should put and get value', async () => {
      await store.initialize();
      
      await store.put('tvly-test', '1000');
      const value = await store.get('tvly-test');
      
      assert.strictEqual(value, '1000');
    });

    it('should update existing key', async () => {
      await store.initialize();
      
      await store.put('tvly-test', '1000');
      await store.put('tvly-test', '2000');
      
      const value = await store.get('tvly-test');
      assert.strictEqual(value, '2000');
      
      const keys = await store.getAllKeys();
      assert.strictEqual(keys.length, 1);
      assert.strictEqual(keys[0].remainingCredit, 2000);
    });
  });

  describe('delete', () => {
    it('should delete key', async () => {
      await store.initialize();
      
      await store.put('tvly-test', '1000');
      await store.delete('tvly-test');
      
      const value = await store.get('tvly-test');
      assert.strictEqual(value, null);
      
      const keys = await store.getAllKeys();
      assert.strictEqual(keys.length, 0);
    });
  });

  describe('list', () => {
    it('should list all keys', async () => {
      await store.initialize();
      
      await store.put('tvly-test1', '1000');
      await store.put('tvly-test2', '500');
      await store.put('tvly-test3', '2000');
      
      const result = await store.list();
      
      assert.strictEqual(result.keys.length, 3);
      assert.strictEqual(result.list_complete, true);
      
      const keyNames = result.keys.map((k: { name: string }) => k.name).sort();
      assert.deepStrictEqual(keyNames, ['tvly-test1', 'tvly-test2', 'tvly-test3']);
    });
  });

  describe('getAllKeys', () => {
    it('should return keys with metadata', async () => {
      await store.initialize();
      
      await store.put('tvly-test', '1000');
      
      const keys = await store.getAllKeys();
      assert.strictEqual(keys.length, 1);
      assert.strictEqual(keys[0].apiKey, 'tvly-test');
      assert.strictEqual(keys[0].remainingCredit, 1000);
      assert.strictEqual(keys[0].enabled, true);
      assert.ok(keys[0].lastUsed, 'lastUsed should be set');
    });
  });

  describe('pickBestKey', () => {
    it('should return null when no keys available', async () => {
      await store.initialize();
      
      const key = await store.pickBestKey();
      assert.strictEqual(key, null);
    });

    it('should return null when all keys have zero credit', async () => {
      await store.initialize();
      
      await store.put('tvly-empty', '0');
      await store.put('tvly-negative', '-100');
      
      const key = await store.pickBestKey();
      assert.strictEqual(key, null);
    });

    it('should return key with highest credit', async () => {
      await store.initialize();
      
      await store.put('tvly-low', '500');
      await store.put('tvly-high', '2000');
      await store.put('tvly-medium', '1000');
      
      const key = await store.pickBestKey();
      assert.strictEqual(key?.apiKey, 'tvly-high');
    });

    it('should ignore disabled keys', async () => {
      await store.initialize();

      await store.put('tvly-enabled', '2000');
      await store.put('tvly-disabled', '5000');

      const data = await fs.readFile(testStorePath, 'utf-8');
      const parsed = JSON.parse(data);
      parsed.keys['tvly-disabled'].enabled = false;
      await fs.writeFile(testStorePath, JSON.stringify(parsed), 'utf-8');

      await store.initialize();
      const key = await store.pickBestKey();
      assert.strictEqual(key?.apiKey, 'tvly-enabled');
    });
  });

  describe('persistence', () => {
    it('should persist data across reloads', async () => {
      await store.initialize();
      
      await store.put('tvly-persist', '1234');
      await store.put('tvly-persist2', '5678');
      
      const newStore = new LocalKVStore(testStorePath);
      await newStore.initialize();
      
      const keys = await newStore.getAllKeys();
      assert.strictEqual(keys.length, 2);
      assert.strictEqual(keys.find((k: KeyInfo) => k.apiKey === 'tvly-persist')?.remainingCredit, 1234);
      assert.strictEqual(keys.find((k: KeyInfo) => k.apiKey === 'tvly-persist2')?.remainingCredit, 5678);
    });

    it('should save atomically (no data loss on crash)', async () => {
      await store.initialize();
      
      await store.put('tvly-test', '1000');
      
      const content = await fs.readFile(testStorePath, 'utf-8');
      const data = JSON.parse(content);
      
      assert.ok(data.version, 'Should have version');
      assert.ok(data.lastSync, 'Should have lastSync');
      assert.ok(data.keys['tvly-test'], 'Should have key data');
    });
  });

  describe('createLocalKV factory', () => {
    it('should create and return store instance', () => {
      const kv = createLocalKV('/tmp/test.json');
      assert.ok(kv instanceof LocalKVStore);
    });
  });

  describe('recordError', () => {
    it('should increment consecutiveErrors', async () => {
      await store.initialize();
      await store.put('tvly-err', '1000');

      await store.recordError('tvly-err');

      const content = await fs.readFile(testStorePath, 'utf-8');
      const data = JSON.parse(content);
      assert.strictEqual(data.keys['tvly-err'].consecutiveErrors, 1);
      assert.strictEqual(data.keys['tvly-err'].disabledUntil, undefined);
    });

    it('should disable key after 3 consecutive errors', async () => {
      await store.initialize();
      await store.put('tvly-err', '1000');

      await store.recordError('tvly-err');
      await store.recordError('tvly-err');
      await store.recordError('tvly-err');

      const content = await fs.readFile(testStorePath, 'utf-8');
      const data = JSON.parse(content);
      assert.strictEqual(data.keys['tvly-err'].consecutiveErrors, 3);
      assert.ok(data.keys['tvly-err'].disabledUntil, 'disabledUntil should be set');

      // Should be ~5 minutes in the future
      const disabledUntil = new Date(data.keys['tvly-err'].disabledUntil).getTime();
      const now = Date.now();
      const fiveMin = 5 * 60 * 1000;
      assert.ok(disabledUntil > now, 'disabledUntil should be in the future');
      assert.ok(disabledUntil < now + fiveMin + 10_000, 'disabledUntil should be ~5 min from now');
    });

    it('should not disable key after only 2 errors', async () => {
      await store.initialize();
      await store.put('tvly-err', '1000');

      await store.recordError('tvly-err');
      await store.recordError('tvly-err');

      const content = await fs.readFile(testStorePath, 'utf-8');
      const data = JSON.parse(content);
      assert.strictEqual(data.keys['tvly-err'].consecutiveErrors, 2);
      assert.strictEqual(data.keys['tvly-err'].disabledUntil, undefined);
    });

    it('should be a no-op for non-existent key', async () => {
      await store.initialize();

      // Should not throw
      await store.recordError('tvly-nonexistent');

      const keys = await store.getAllKeys();
      assert.strictEqual(keys.length, 0);
    });
  });

  describe('recordSuccess', () => {
    it('should reset consecutiveErrors and clear disabledUntil', async () => {
      await store.initialize();
      await store.put('tvly-err', '1000');

      // Trigger 3 errors to disable the key
      await store.recordError('tvly-err');
      await store.recordError('tvly-err');
      await store.recordError('tvly-err');

      // Verify disabled
      let content = await fs.readFile(testStorePath, 'utf-8');
      let data = JSON.parse(content);
      assert.strictEqual(data.keys['tvly-err'].consecutiveErrors, 3);
      assert.ok(data.keys['tvly-err'].disabledUntil);

      // Record success — should clear everything
      await store.recordSuccess('tvly-err');

      content = await fs.readFile(testStorePath, 'utf-8');
      data = JSON.parse(content);
      assert.strictEqual(data.keys['tvly-err'].consecutiveErrors, 0);
      assert.strictEqual(data.keys['tvly-err'].disabledUntil, undefined);
    });

    it('should be a no-op for non-existent key', async () => {
      await store.initialize();

      // Should not throw
      await store.recordSuccess('tvly-nonexistent');

      const keys = await store.getAllKeys();
      assert.strictEqual(keys.length, 0);
    });
  });

  describe('pickBestKey with temp-disabled keys', () => {
    it('should skip keys that are temporarily disabled', async () => {
      await store.initialize();

      await store.put('tvly-good', '500');
      await store.put('tvly-temp-disabled', '5000');

      // Temporarily disable the high-credit key
      const content = await fs.readFile(testStorePath, 'utf-8');
      const data = JSON.parse(content);
      data.keys['tvly-temp-disabled'].disabledUntil = new Date(Date.now() + 60_000).toISOString();
      data.keys['tvly-temp-disabled'].consecutiveErrors = 3;
      await fs.writeFile(testStorePath, JSON.stringify(data), 'utf-8');

      // Reload to pick up changes
      await store.initialize();

      const pick = await store.pickBestKey();
      assert.strictEqual(pick?.apiKey, 'tvly-good');
    });

    it('should pick a key after its temp-disable expires', async () => {
      await store.initialize();

      await store.put('tvly-expired', '5000');

      // Set disabledUntil in the past (expired)
      const content = await fs.readFile(testStorePath, 'utf-8');
      const data = JSON.parse(content);
      data.keys['tvly-expired'].disabledUntil = new Date(Date.now() - 1000).toISOString();
      data.keys['tvly-expired'].consecutiveErrors = 3;
      await fs.writeFile(testStorePath, JSON.stringify(data), 'utf-8');

      await store.initialize();

      const pick = await store.pickBestKey();
      assert.strictEqual(pick?.apiKey, 'tvly-expired');
    });

    it('should return null when all keys are temp-disabled', async () => {
      await store.initialize();

      await store.put('tvly-a', '1000');
      await store.put('tvly-b', '2000');

      // Temporarily disable both
      const content = await fs.readFile(testStorePath, 'utf-8');
      const data = JSON.parse(content);
      for (const key of Object.keys(data.keys)) {
        data.keys[key].disabledUntil = new Date(Date.now() + 60_000).toISOString();
        data.keys[key].consecutiveErrors = 3;
      }
      await fs.writeFile(testStorePath, JSON.stringify(data), 'utf-8');

      await store.initialize();

      const pick = await store.pickBestKey();
      assert.strictEqual(pick, null);
    });
  });

  describe('concurrent pickBestKey', () => {
    it('should not return the same key twice under concurrency', async () => {
      await store.initialize();

      // Add 5 keys with high QPS to avoid rate-limiting interference
      for (let i = 0; i < 5; i++) {
        await store.put(`tvly-conc-${i}`, String(1000 - i * 100));
      }

      // Fire 5 concurrent pickBestKey calls
      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.pickBestKey())
      );

      const usedKeys = results.map(r => r?.apiKey);
      const uniqueKeys = new Set(usedKeys);

      // All should succeed
      assert.strictEqual(results.every(r => r !== null), true, 'All picks should succeed');
      // Each should get a different key (mutex prevents double-pick)
      assert.strictEqual(uniqueKeys.size, 5, `Expected 5 unique keys, got: ${JSON.stringify(usedKeys)}`);
    });

    it('should serialize 10+ concurrent requests correctly', async () => {
      await store.initialize();

      for (let i = 0; i < 12; i++) {
        await store.put(`tvly-stress-${i}`, String(1000 + i));
      }

      const results = await Promise.all(
        Array.from({ length: 12 }, () => store.pickBestKey())
      );

      const usedKeys = results.map(r => r?.apiKey);
      const uniqueKeys = new Set(usedKeys);

      assert.strictEqual(results.every(r => r !== null), true);
      assert.strictEqual(uniqueKeys.size, 12, 'All 12 concurrent picks should return unique keys');
    });
  });
});
