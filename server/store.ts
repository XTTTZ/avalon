import { mkdir, readFile, rename, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { retainedNoteExpiry, type ExpiringNote, type NoteRoom } from './room-lifecycle.js';

export type Collection = 'rooms' | 'users' | 'notes';
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
      let deleted = 0;
      for (const [id, document] of expired) {
        if (id.startsWith('notes/')) {
          const [code, ...userParts] = id.slice('notes/'.length).split('_');
          const room = (draft[key('rooms', code)]?.value as { state?: NoteRoom } | undefined)
            ?.state;
          const expiresAt = retainedNoteExpiry(
            document.value as ExpiringNote,
            room,
            userParts.join('_'),
            now,
          );
          if (expiresAt !== null) {
            document.expiresAt = expiresAt;
            document.value = {
              ...(document.value as Record<string, unknown>),
              expiresAt,
              ...(room!.instanceId ? { roomInstanceId: room!.instanceId } : {}),
              roomCreatedAt: room!.createdAt,
            };
            continue;
          }
        }
        delete draft[id];
        deleted++;
      }
      if (expired.length) await this.persist(draft);
      return deleted;
    });
  }
}
