import { PokerError } from '../../shared/types.js';
import type { Collection, Store, Transaction } from './store.js';

interface Snapshot {
  revision: string | null;
  value: unknown;
}

interface Read {
  collection: Collection;
  id: string;
  revision: string | null;
}

interface Write {
  collection: Collection;
  id: string;
  value?: unknown;
  expiresAt?: number;
  delete?: boolean;
}

export class PostgresStore implements Store {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid PostgreSQL endpoint');
    if (!apiKey) throw new Error('Missing PostgreSQL API key');
  }

  private async rpc<T>(name: string, body: unknown): Promise<T> {
    const response = await this.request(`${this.endpoint.replace(/\/$/, '')}/rpc/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Poker PostgreSQL operation failed');
    return response.json() as Promise<T>;
  }

  private snapshot(collection: Collection, id: string) {
    return this.rpc<Snapshot>('poker_get', { p_collection: collection, p_id: id });
  }

  async get<T>(collection: Collection, id: string): Promise<T | null> {
    return (await this.snapshot(collection, id)).value as T | null;
  }

  async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const reads = new Map<string, Read>();
      const snapshots = new Map<string, Snapshot>();
      const writes = new Map<string, Write>();
      const key = (collection: Collection, id: string) => `${collection}/${id}`;
      const read = async (collection: Collection, id: string) => {
        const idKey = key(collection, id);
        if (!snapshots.has(idKey)) {
          const value = await this.snapshot(collection, id);
          snapshots.set(idKey, value);
          reads.set(idKey, { collection, id, revision: value.revision });
        }
        return snapshots.get(idKey)!;
      };
      let result: T | undefined;
      let failure: unknown;
      try {
        result = await work({
          get: async <V>(collection: Collection, id: string) => {
            const pending = writes.get(key(collection, id));
            if (pending) return pending.delete ? null : structuredClone(pending.value as V);
            return structuredClone((await read(collection, id)).value as V | null);
          },
          set: async (collection, id, value, expiresAt) => {
            await read(collection, id);
            writes.set(key(collection, id), {
              collection,
              id,
              value: structuredClone(value),
              expiresAt,
            });
          },
          delete: async (collection, id) => {
            await read(collection, id);
            writes.set(key(collection, id), { collection, id, delete: true });
          },
        });
      } catch (error) {
        failure = error;
      }
      const committed = await this.rpc<boolean>('poker_commit', {
        p_reads: [...reads.values()],
        p_writes: failure ? [] : [...writes.values()],
      });
      if (committed) {
        if (failure) throw failure;
        return result as T;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 40 * (attempt + 1)));
    }
    throw new PokerError('CONFLICT', '操作冲突，请同步后重试');
  }

  cleanup(now: number, limit = 400) {
    return this.rpc<number>('poker_cleanup', { p_now: now, p_limit: Math.min(400, limit) });
  }
}
