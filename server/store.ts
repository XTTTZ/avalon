import { mkdir, readFile, rename, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export type Collection = 'rooms' | 'users' | 'notes' | 'oauth';
export const COLLECTIONS: Collection[] = ['rooms', 'users', 'notes', 'oauth'];
export interface Transaction {
  get<T>(collection: Collection, id: string): Promise<T | null>;
  set<T>(collection: Collection, id: string, value: T, expiresAt: number): Promise<void>;
  delete(collection: Collection, id: string): Promise<void>;
}
export interface Store {
  get<T>(collection: Collection, id: string): Promise<T | null>;
  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T>;
  cleanup(now: number, limit?: number): Promise<number>;
}
interface StoredDocument {
  value: unknown;
  expiresAt: number;
}
type Documents = Record<string, StoredDocument>;
const key = (collection: Collection, id: string) => `${collection}/${id}`;

/** Single-process development store. Atomic rename commits the complete transaction. */
export class FileStore implements Store {
  private documents: Documents | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly filename: string | null) {}
  private async load() {
    if (this.documents) return;
    if (!this.filename) {
      this.documents = {};
      return;
    }
    try {
      const data = JSON.parse(await readFile(this.filename, 'utf8'));
      if (data.format !== 1 || typeof data.documents !== 'object' || !data.documents)
        throw new Error('Invalid local database');
      this.documents = data.documents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.documents = {};
    }
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async get<T>(collection: Collection, id: string): Promise<T | null> {
    return this.exclusive(async () => {
      await this.load();
      const document = this.documents![key(collection, id)];
      return document ? structuredClone(document.value as T) : null;
    });
  }
  async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.load();
      const draft = structuredClone(this.documents!);
      let dirty = false;
      const result = await work({
        get: async <V>(collection: Collection, id: string) => {
          const document = draft[key(collection, id)];
          return document ? structuredClone(document.value as V) : null;
        },
        set: async (collection, id, value, expiresAt) => {
          draft[key(collection, id)] = { value: structuredClone(value), expiresAt };
          dirty = true;
        },
        delete: async (collection, id) => {
          delete draft[key(collection, id)];
          dirty = true;
        },
      });
      if (dirty) await this.persist(draft);
      return result;
    });
  }
  private async persist(documents: Documents) {
    if (this.filename) {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${process.pid}.tmp`;
      const file = await open(temporary, 'w', 0o600);
      try {
        await file.writeFile(JSON.stringify({ format: 1, documents }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.filename);
    }
    this.documents = documents;
  }
  async cleanup(now: number, limit = 200) {
    return this.exclusive(async () => {
      await this.load();
      const draft = structuredClone(this.documents!);
      const expired = Object.entries(draft)
        .filter(([, d]) => d.expiresAt <= now)
        .slice(0, limit);
      for (const [id] of expired) delete draft[id];
      if (expired.length) await this.persist(draft);
      return expired.length;
    });
  }
}

export interface DatabaseDocument {
  get(): Promise<{
    data: Record<string, unknown>[] | Record<string, unknown> | null;
    code?: string;
  }>;
  set(value: Record<string, unknown>): Promise<unknown>;
  delete?(): Promise<unknown>;
  remove?(): Promise<unknown>;
}
interface DatabaseCollection {
  doc(id: string): DatabaseDocument;
  where(filter: Record<string, unknown>): {
    limit(count: number): { get(): Promise<{ data: { _id: string }[] }> };
  };
}
export interface DatabaseLike {
  collection(name: string): DatabaseCollection;
  runTransaction<T>(callback: (transaction: DatabaseLike) => Promise<T>): Promise<T>;
  command: { lte(value: number): unknown };
}
const collectionName = (collection: Collection) => `avalon_${collection}`;
function checkDatabaseResult(result: unknown) {
  if (result && typeof result === 'object' && 'code' in result && result.code) {
    // The SDK may return {code} rather than throw. Preserve conflict codes so
    // runTransaction can retry, but do not propagate database details to HTTP.
    const error = new Error('Database operation failed') as Error & { code: unknown };
    error.code = result.code;
    throw error;
  }
}

/** CloudBase server SDK adapter; no browser database SDK is used anywhere. */
export class CloudBaseStore implements Store {
  constructor(private readonly db: DatabaseLike) {}
  private adapter(db: DatabaseLike): Transaction {
    return {
      get: async <T>(collection: Collection, id: string) => {
        const result = await db.collection(collectionName(collection)).doc(id).get();
        checkDatabaseResult(result);
        const document = Array.isArray(result.data) ? result.data[0] : result.data;
        return document ? (document.value as T) : null;
      },
      set: async (collection, id, value, expiresAt) => {
        checkDatabaseResult(
          await db.collection(collectionName(collection)).doc(id).set({ value, expiresAt }),
        );
      },
      delete: async (collection, id) => {
        const document = db.collection(collectionName(collection)).doc(id);
        if (document.delete) checkDatabaseResult(await document.delete());
        else if (document.remove) checkDatabaseResult(await document.remove());
        else throw new Error('Database delete unavailable');
      },
    };
  }
  get<T>(collection: Collection, id: string) {
    return this.adapter(this.db).get<T>(collection, id);
  }
  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction((transaction) => work(this.adapter(transaction)));
  }
  async cleanup(now: number, limit = 200) {
    let count = 0;
    for (const collection of COLLECTIONS) {
      if (count >= limit) break;
      const result = await this.db
        .collection(collectionName(collection))
        .where({ expiresAt: this.db.command.lte(now) })
        .limit(Math.min(100, limit - count))
        .get();
      checkDatabaseResult(result);
      for (const document of result.data) {
        // Recheck inside the transaction: a user may have renewed since the query.
        const deleted = await this.db.runTransaction(async (transaction) => {
          const ref = transaction.collection(collectionName(collection)).doc(document._id);
          const read = await ref.get();
          checkDatabaseResult(read);
          const current = Array.isArray(read.data) ? read.data[0] : read.data;
          if (current && Number(current.expiresAt) <= now) {
            if (ref.delete) checkDatabaseResult(await ref.delete());
            else checkDatabaseResult(await ref.remove!());
            return true;
          }
          return false;
        });
        if (deleted) count++;
      }
    }
    return count;
  }
}
