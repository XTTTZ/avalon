import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export type Collection = 'rooms' | 'users';

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
      const data = JSON.parse(await readFile(this.filename, 'utf8')) as {
        format: number;
        documents: Documents;
      };
      if (data.format !== 1 || !data.documents || typeof data.documents !== 'object')
        throw new Error('Invalid local database');
      this.documents = data.documents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.documents = {};
    }
  }

  private exclusive<T>(work: () => Promise<T>) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async get<T>(collection: Collection, id: string): Promise<T | null> {
    return this.exclusive(async () => {
      await this.load();
      const value = this.documents![key(collection, id)]?.value;
      return value === undefined ? null : structuredClone(value as T);
    });
  }

  async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.load();
      const draft = structuredClone(this.documents!);
      let dirty = false;
      const result = await work({
        get: async <V>(collection: Collection, id: string) => {
          const value = draft[key(collection, id)]?.value;
          return value === undefined ? null : structuredClone(value as V);
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

  async cleanup(now: number, limit = 400) {
    return this.exclusive(async () => {
      await this.load();
      const draft = structuredClone(this.documents!);
      const expired = Object.entries(draft)
        .filter(([, value]) => value.expiresAt <= now)
        .slice(0, Math.min(400, Math.max(0, limit)));
      for (const [id] of expired) delete draft[id];
      if (expired.length) await this.persist(draft);
      return expired.length;
    });
  }
}
