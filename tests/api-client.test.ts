// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import type { ApiRequest, RoomView, Session } from '../shared/types';
import { createRoom, projectRoom } from '../server/engine';
import { standardConfig } from '../shared/rules';

type Game = ReturnType<(typeof import('../src/api'))['useGame']>;
let current: Game;
let root: Root | undefined;
let act: (typeof import('react'))['act'];
let fetchMock: ReturnType<typeof vi.fn>;
const KEY = 'avalon.v1.';
const session: Session = {
  token: 'test-session',
  userId: 'test-user',
  lastRoom: '123456',
  expiresAt: Date.now() + 86400000,
  provider: 'guest',
};
function roomView(code = '123456', version = 2): RoomView {
  const state = createRoom('1234', { userId: session.userId, name: '亚瑟' }, standardConfig(5));
  // Restored fixtures include legacy six-digit rooms created before the upgrade.
  state.code = code;
  state.version = version;
  return projectRoom(state, session.userId);
}
function response(data: unknown): Response {
  return { json: async () => ({ ok: true, data }) } as Response;
}
function rejection(code: string): Response {
  return {
    json: async () => ({ ok: false, error: { code, message: `test-${code}` } }),
  } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function requests() {
  return fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string) as ApiRequest);
}
function handle(handler?: (request: ApiRequest) => Response | Promise<Response> | undefined) {
  fetchMock.mockImplementation(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string) as ApiRequest;
    const override = handler?.(request);
    if (override !== undefined) return override;
    if (request.action === 'auth.guest' || request.action === 'session') return response(session);
    if (request.action === 'get') return response(roomView(request.code));
    if (request.action === 'notes.get') return response({ notes: {}, revision: 0 });
    throw new Error(`Unhandled action ${request.action}`);
  });
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
async function mount() {
  const React = await import('react');
  act = React.act;
  const { createRoot } = await import('react-dom/client');
  const { useGame } = await import('../src/api');
  const element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  function Probe() {
    current = useGame();
    return null;
  }
  await act(async () => {
    root!.render(React.createElement(Probe));
  });
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_AUTH_MODE', 'guest');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  history.replaceState(null, '', '/');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  root = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('browser session recovery and mutation safety', () => {
  it('recovers a failed fresh boot on an online event using the same durable device identity', async () => {
    let authCalls = 0;
    handle((request) => {
      if (request.action === 'auth.guest' && ++authCalls === 1) throw new TypeError('lost network');
      return undefined;
    });
    await mount();
    expect(current.session).toBeNull();
    expect(current.connection).toBe('reconnecting');
    const first = requests().find((r) => r.action === 'auth.guest');
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await flush();
    expect(current.view?.room.code).toBe('123456');
    expect(current.connection).toBe('online');
    const auth = requests().filter((r) => r.action === 'auth.guest');
    expect(auth).toHaveLength(2);
    expect(auth[1]).toEqual(first);
  });
  it('retries a lost mutation response with the original idempotency key, without persisting the ballot', async () => {
    const original = roomView();
    const updated = structuredClone(original);
    updated.room.version = 3;
    let calls = 0;
    handle((request) => {
      if (request.action === 'get') return response(original);
      if (request.action === 'command') {
        if (++calls === 1) throw new TypeError('response lost after commit');
        return response(updated);
      }
    });
    await mount();
    await act(async () => {
      expect(await current.command({ type: 'questVote', success: false })).toBe(false);
    });
    expect(current.pending).toBe(true);
    const stored = JSON.stringify({ ...localStorage });
    expect(stored).not.toContain('questVote');
    expect(stored).not.toContain('success');
    await act(async () => {
      await current.retryPending();
    });
    const sent = requests().filter((r) => r.action === 'command');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(current.view?.room.version).toBe(3);
    expect(current.pending).toBe(false);
  });
  it('ignores an old polling result after a newer mutation has advanced the room', async () => {
    const stale = deferred<Response>();
    let gets = 0;
    const original = roomView();
    const advanced = structuredClone(original);
    advanced.room.version = 5;
    advanced.room.phase = 'team';
    handle((request) => {
      if (request.action === 'get') return ++gets === 1 ? response(original) : stale.promise;
      if (request.action === 'command') return response(advanced);
    });
    await mount();
    let sync!: Promise<void>;
    await act(async () => {
      sync = current.refresh();
    });
    await act(async () => {
      await current.command({ type: 'ready' });
    });
    await act(async () => {
      stale.resolve(response(original));
      await sync;
    });
    expect(current.view?.room.version).toBe(5);
    expect(current.view?.room.phase).toBe('team');
  });
  it('ignores an old-room failure after leaving and joining a different room', async () => {
    const stale = deferred<Response>();
    let gets = 0;
    handle((request) => {
      if (request.action === 'get') return ++gets === 1 ? response(roomView()) : stale.promise;
      if (request.action === 'join') return response(roomView(request.code, 1));
    });
    await mount();
    let sync!: Promise<void>;
    await act(async () => {
      sync = current.refresh();
      current.leaveView();
    });
    await act(async () => {
      await current.join('654321', '亚瑟');
    });
    await act(async () => {
      stale.resolve(rejection('FORBIDDEN'));
      await sync;
    });
    expect(current.view?.room.code).toBe('654321');
    expect(current.error).toBeNull();
  });
  it('does not resurrect a room from a mutation response received after going home', async () => {
    const late = deferred<Response>();
    handle((request) => (request.action === 'command' ? late.promise : undefined));
    await mount();
    let mutation!: Promise<boolean>;
    await act(async () => {
      mutation = current.command({ type: 'rename', name: '新名字' });
      current.leaveView();
    });
    await act(async () => {
      late.resolve(response(roomView()));
      expect(await mutation).toBe(false);
    });
    expect(current.view).toBeNull();
    expect(current.pending).toBe(false);
  });
  it('rejects a stale notes fetch when a save has already returned a newer revision', async () => {
    const staleNotes = deferred<Response>();
    const fresh = {
      p1: {
        nickname: '新昵称',
        roleGuess: '' as const,
        alignmentGuess: 'unknown' as const,
        text: '保留我的新笔记',
      },
    };
    handle((request) => {
      if (request.action === 'notes.get') return staleNotes.promise;
      if (request.action === 'notes.save') return response({ notes: fresh, revision: 2 });
    });
    await mount();
    expect(current.view).not.toBeNull();
    await act(async () => {
      await current.saveNotes(fresh);
    });
    await act(async () => {
      staleNotes.resolve(response({ notes: {}, revision: 1 }));
    });
    await flush();
    expect(current.notes).toEqual(fresh);
    expect(current.notesRevision).toBe(2);
  });
  it('treats a committed mutation as success even when local storage becomes unavailable', async () => {
    const updated = roomView('654321', 1);
    handle((request) => (request.action === 'join' ? response(updated) : undefined));
    await mount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await act(async () => {
      expect(await current.join('654321', '亚瑟')).toBe(true);
    });
    expect(current.view?.room.code).toBe('654321');
    expect(current.session?.lastRoom).toBe('654321');
    expect(current.pending).toBe(false);
    expect(current.error).toContain('无法保存恢复信息');
  });
  it('can explicitly restore after returning home, and stores no private room projection', async () => {
    const secret = roomView();
    secret.self.role = 'merlin';
    secret.self.roleText = '绝不能缓存的身份线索';
    handle((request) => (request.action === 'get' ? response(secret) : undefined));
    await mount();
    await act(async () => {
      current.leaveView();
    });
    expect(current.view).toBeNull();
    await act(async () => {
      await current.restore();
    });
    expect(current.view?.room.code).toBe('123456');
    expect(current.session?.lastRoom).toBe('123456');
    const contents = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.getItem(localStorage.key(index)!),
    ).join();
    expect(contents).not.toContain('merlin');
    expect(contents).not.toContain('绝不能缓存');
    expect(JSON.parse(localStorage.getItem(KEY + 'room')!)).toBe('123456');
  });
  it('keeps the accepted session usable when OAuth returns but session persistence fails', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'wechat');
    localStorage.setItem(
      KEY + 'oauth',
      JSON.stringify({ state: 'safe-state', verifier: 'secret-verifier', room: '123456' }),
    );
    history.replaceState(null, '', '/?code=wechat-code&state=safe-state');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full');
    });
    handle((request) =>
      request.action === 'auth.wechat.finish'
        ? response({ ...session, provider: 'wechat' })
        : undefined,
    );
    await mount();
    expect(current.session?.provider).toBe('wechat');
    expect(current.view?.room.code).toBe('123456');
    expect(location.search).toBe('?room=123456');
    expect(localStorage.getItem(KEY + 'oauth')).toBeNull();
    const auth = requests().filter((r) => r.action === 'auth.wechat.finish');
    expect(auth).toEqual([
      {
        action: 'auth.wechat.finish',
        code: 'wechat-code',
        state: 'safe-state',
        verifier: 'secret-verifier',
      },
    ]);
  });
});
