import { neon } from '@neondatabase/serverless';
import { GameError } from '../shared/types.js';
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

export interface NeonSqlClient {
  query(
    statement: string,
    parameters?: unknown[],
    options?: { fetchOptions?: { signal?: AbortSignal } },
  ): Promise<Record<string, unknown>[]>;
}

type NeonFactory = (connectionString: string) => NeonSqlClient;

function validateConnectionString(connectionString: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Invalid Neon connection string');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    !url.hostname.endsWith('.neon.tech') ||
    url.searchParams.get('sslmode') !== 'require' ||
    url.hash
  )
    throw new Error('Invalid Neon connection string');
}

/**
 * Optimistic Store adapter backed by server-only Neon functions.
 *
 * The application role has EXECUTE on the three functions and no direct table
 * privileges. Every mutation validates all read revisions and writes atomically
 * inside `avalon_commit`.
 */
export class NeonStore implements Store {
  private readonly sql: NeonSqlClient;

  constructor(connectionString: string, factory: NeonFactory = neon as unknown as NeonFactory) {
    validateConnectionString(connectionString);
    this.sql = factory(connectionString);
  }

  private async query(statement: string, parameters: unknown[]) {
    try {
      return await this.sql.query(statement, parameters, {
        fetchOptions: { signal: AbortSignal.timeout(15_000) },
      });
    } catch {
      // Provider messages can contain SQL, role names, and document fragments.
      throw new Error('Database operation failed');
    }
  }

  private async snapshot(collection: Collection, id: string): Promise<Snapshot> {
    const rows = await this.query('SELECT public.avalon_get($1, $2) AS snapshot', [collection, id]);
    const snapshot = rows[0]?.snapshot;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      !Object.hasOwn(snapshot, 'revision') ||
      !Object.hasOwn(snapshot, 'value') ||
      (!((snapshot as Snapshot).revision === null) &&
        typeof (snapshot as Snapshot).revision !== 'string')
    )
      throw new Error('Database operation failed');
    return snapshot as Snapshot;
  }

  async get<T>(collection: Collection, id: string): Promise<T | null> {
    return structuredClone((await this.snapshot(collection, id)).value as T | null);
  }

  async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const reads = new Map<string, Read>();
      const snapshots = new Map<string, Snapshot>();
      const writes = new Map<string, Write>();
      const key = (collection: Collection, id: string) => `${collection}/${id}`;
      const read = async (collection: Collection, id: string) => {
        const documentKey = key(collection, id);
        if (!snapshots.has(documentKey)) {
          const snapshot = await this.snapshot(collection, id);
          snapshots.set(documentKey, snapshot);
          reads.set(documentKey, { collection, id, revision: snapshot.revision });
        }
        return snapshots.get(documentKey)!;
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

      const rows = await this.query(
        'SELECT public.avalon_commit($1::jsonb, $2::jsonb) AS committed',
        [JSON.stringify([...reads.values()]), JSON.stringify(failure ? [] : [...writes.values()])],
      );
      if (rows[0]?.committed === true) {
        if (failure) throw failure;
        return result as T;
      }
      if (rows[0]?.committed !== false) throw new Error('Database operation failed');
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 40 * (attempt + 1)));
    }
    throw new GameError('CONFLICT', '操作冲突，请重试');
  }

  async cleanup(now: number, limit = 200): Promise<number> {
    const rows = await this.query('SELECT public.avalon_cleanup($1, $2) AS deleted', [
      now,
      Math.min(Math.max(Math.trunc(limit), 0), 400),
    ]);
    const deleted = Number(rows[0]?.deleted);
    if (!Number.isSafeInteger(deleted) || deleted < 0) throw new Error('Database operation failed');
    return deleted;
  }
}
