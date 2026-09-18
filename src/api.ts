import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApiErrorCode,
  ApiRequest,
  GameCommand,
  GameConfig,
  Notes,
  NotesResult,
  RoomView,
  Session,
} from '../shared/types';

const PREFIX = 'avalon.v1.';
const API_URL = import.meta.env.VITE_API_URL || '/api';
const AUTH_MODE = import.meta.env.VITE_AUTH_MODE || (import.meta.env.DEV ? 'guest' : 'wechat');
const KEY_SESSION = PREFIX + 'session';
const KEY_ROOM = PREFIX + 'room';
const KEY_DEVICE = PREFIX + 'device';
const KEY_OAUTH = PREFIX + 'oauth';
export class ClientError extends Error {
  constructor(
    public code: ApiErrorCode | 'NETWORK',
    message: string,
  ) {
    super(message);
  }
}
function read<T>(key: string): T | null {
  try {
    const data = localStorage.getItem(key);
    return data ? (JSON.parse(data) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error('无法保存登录身份，请关闭无痕模式或允许此网页使用本地存储后重试。');
  }
}
function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* no-op */
  }
}
let storageWarning: string | null = null;
function remember(key: string, value: unknown) {
  try {
    write(key, value);
  } catch {
    storageWarning = '当前状态已同步，但浏览器无法保存恢复信息。请允许本地存储；本页仍可继续游戏。';
  }
}
export function randomId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function apiCall<T>(request: ApiRequest, token?: string): Promise<T> {
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 18000);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(request),
      signal: abort.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    const body = (await response.json()) as {
      ok: boolean;
      data: T;
      error?: { code: ApiErrorCode; message: string };
    };
    if (!body.ok)
      throw new ClientError(
        body.error?.code || 'INTERNAL',
        body.error?.message || '服务暂时不可用，请稍后重试。',
      );
    return body.data;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      'NETWORK',
      navigator.onLine ? '连接暂时中断，正在重新连接。' : '当前离线，连接恢复后会自动同步。',
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

let authenticating: Promise<Session> | null = null;
async function authenticate(): Promise<Session> {
  // Also coalesce event-driven retry / mount work; OAuth codes are single use.
  if (authenticating) return authenticating;
  authenticating = (async () => {
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (AUTH_MODE === 'wechat' && code) {
      const saved = read<{ verifier: string; state: string; room: string | null }>(KEY_OAUTH);
      if (!saved || !state || state !== saved.state)
        throw new Error('微信登录校验失败，请从公众号菜单重新打开。');
      let result: Session;
      try {
        result = await apiCall<Session>({
          action: 'auth.wechat.finish',
          code,
          state,
          verifier: saved.verifier,
        });
      } catch (error) {
        // A code might already have been redeemed before a lost response. Restart a new flow on retry.
        url.searchParams.delete('code');
        url.searchParams.delete('state');
        if (saved.room) url.searchParams.set('room', saved.room);
        history.replaceState(null, '', url);
        remove(KEY_OAUTH);
        throw error;
      }
      remember(KEY_SESSION, result);
      remove(KEY_OAUTH);
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      if (saved.room) url.searchParams.set('room', saved.room);
      history.replaceState(null, '', url);
      return result;
    }
    const saved = read<Session>(KEY_SESSION);
    if (saved?.token && saved.expiresAt > Date.now() && saved.provider === AUTH_MODE) {
      try {
        const renewed = await apiCall<Session>({ action: 'session' }, saved.token);
        remember(KEY_SESSION, renewed);
        return renewed;
      } catch (error) {
        if (!(error instanceof ClientError) || !['UNAUTHORIZED', 'EXPIRED'].includes(error.code))
          throw error;
        remove(KEY_SESSION);
      }
    }
    if (AUTH_MODE === 'guest') {
      let device = read<string>(KEY_DEVICE);
      if (!device) {
        device = randomId();
        write(KEY_DEVICE, device);
      }
      const result = await apiCall<Session>({ action: 'auth.guest', deviceSecret: device });
      remember(KEY_SESSION, result);
      return result;
    }
    if (!/MicroMessenger/i.test(navigator.userAgent))
      throw new Error('请在微信中打开此网页，使用公众号身份登录。');
    const verifier = randomId();
    const redirectUri = location.origin + location.pathname;
    const start = await apiCall<{ url: string; state: string }>({
      action: 'auth.wechat.start',
      redirectUri,
      verifier,
    });
    write(KEY_OAUTH, { verifier, state: start.state, room: url.searchParams.get('room') });
    location.assign(start.url);
    return new Promise<Session>(() => {
      /* OAuth navigation takes over */
    });
  })();
  try {
    return await authenticating;
  } finally {
    authenticating = null;
  }
}

type Connection = 'connecting' | 'online' | 'offline' | 'reconnecting';
type PendingRequest = Extract<ApiRequest, { action: 'create' | 'join' | 'command' }>;
function sameMembership(previous: RoomView | null, next: RoomView): boolean {
  return (
    previous?.room.code === next.room.code &&
    previous.room.createdAt === next.room.createdAt &&
    previous.self.playerId === next.self.playerId
  );
}
export function useGame() {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
  const [notes, setNotes] = useState<Notes>({});
  const [notesRevision, setNotesRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);
  const viewRef = useRef<RoomView | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);
  const busyRef = useRef(false);
  const pollingRef = useRef(false);
  const bootingRef = useRef(false);
  const failures = useRef(0);
  const unchanged = useRef(0);
  const notesRevisionRef = useRef(0);
  const alive = useRef(true);
  // A recycled room code or a new seat is a new membership. Invalidate pending
  // responses and private notes even when the visible room code stays the same.
  const scope = useRef(0);

  const rememberLastRoom = useCallback((code: string | null) => {
    const current = sessionRef.current;
    if (!current || current.lastRoom === code) return;
    const next = { ...current, lastRoom: code };
    sessionRef.current = next;
    setSession(next);
    remember(KEY_SESSION, next);
  }, []);

  const acceptView = useCallback(
    (next: RoomView) => {
      if (!alive.current) return;
      const previous = viewRef.current;
      const sameMember = sameMembership(previous, next);
      if (sameMember && previous!.room.version > next.room.version) return;
      if (!sameMember) {
        scope.current++;
        pendingRef.current = null;
        setPending(false);
        setNotes({});
        setNotesRevision(0);
        notesRevisionRef.current = 0;
      }
      viewRef.current = next;
      setView(next);
      remember(KEY_ROOM, next.room.code);
      rememberLastRoom(next.room.code);
      const url = new URL(location.href);
      if (url.searchParams.get('room') !== next.room.code) {
        url.searchParams.set('room', next.room.code);
        history.replaceState(null, '', url);
      }
      failures.current = 0;
      setConnection('online');
      if (storageWarning) {
        setError(storageWarning);
        storageWarning = null;
      }
    },
    [rememberLastRoom],
  );
  const loadNotes = useCallback(async (code: string, token: string) => {
    const requestScope = scope.current;
    try {
      const result = await apiCall<NotesResult>({ action: 'notes.get', code }, token);
      if (
        alive.current &&
        requestScope === scope.current &&
        viewRef.current?.room.code === code &&
        result.revision >= notesRevisionRef.current
      ) {
        setNotes(result.notes);
        setNotesRevision(result.revision);
        notesRevisionRef.current = result.revision;
      }
    } catch (err) {
      if (alive.current && requestScope === scope.current && viewRef.current?.room.code === code)
        throw err;
    }
  }, []);
  const leaveView = useCallback(() => {
    scope.current++;
    pendingRef.current = null;
    setPending(false);
    viewRef.current = null;
    setView(null);
    setNotes({});
    setNotesRevision(0);
    notesRevisionRef.current = 0;
    remember(KEY_ROOM, '');
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }, []);
  const markError = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : '发生了意外错误，请重试。';
    setError(message);
    if (err instanceof ClientError && err.code === 'NETWORK') {
      failures.current += 1;
      setConnection(navigator.onLine ? 'reconnecting' : 'offline');
    }
  }, []);
  const initialize = useCallback(
    async (forceRestore = false) => {
      if (bootingRef.current) return;
      const requestScope = scope.current;
      bootingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const current = await authenticate();
        if (!alive.current || scope.current !== requestScope) return;
        sessionRef.current = current;
        setSession(current);
        setConnection('online');
        if (storageWarning) {
          setError(storageWarning);
          storageWarning = null;
        }
        const invitation = new URL(location.href).searchParams.get('room');
        const localRoom = read<string>(KEY_ROOM);
        const resume = forceRestore
          ? localRoom || current.lastRoom
          : (localRoom ?? current.lastRoom);
        if (resume && (forceRestore || !invitation || invitation === resume)) {
          try {
            const restored = await apiCall<RoomView>(
              { action: 'get', code: resume },
              current.token,
            );
            if (!alive.current || scope.current !== requestScope) return;
            acceptView(restored);
            await loadNotes(resume, current.token);
          } catch (err) {
            if (
              !alive.current ||
              (scope.current !== requestScope && viewRef.current?.room.code !== resume)
            )
              return;
            if (
              err instanceof ClientError &&
              ['FORBIDDEN', 'NOT_FOUND', 'EXPIRED'].includes(err.code)
            ) {
              leaveView();
              setError('原房间已结束、过期或你已离开，可以重新加入圆桌。');
            } else throw err;
          }
        }
      } catch (err) {
        if (alive.current && scope.current === requestScope) markError(err);
      } finally {
        bootingRef.current = false;
        if (alive.current) setLoading(false);
      }
    },
    [acceptView, loadNotes, leaveView, markError],
  );

  const sync = useCallback(async () => {
    const current = sessionRef.current;
    const previous = viewRef.current;
    if (!current || !previous || pollingRef.current || document.hidden) return;
    pollingRef.current = true;
    const requestScope = scope.current;
    try {
      const result = await apiCall<RoomView | { unchanged: true; version: number }>(
        {
          action: 'get',
          code: previous.room.code,
          version: previous.room.version,
          gameId: previous.room.gameId,
        },
        current.token,
      );
      if (
        !alive.current ||
        requestScope !== scope.current ||
        viewRef.current?.room.code !== previous.room.code
      )
        return;
      if ('unchanged' in result) unchanged.current += 1;
      else {
        unchanged.current = 0;
        const changedMembership = !sameMembership(viewRef.current, result);
        acceptView(result);
        if (changedMembership)
          await loadNotes(result.room.code, current.token).catch((err) => {
            if (alive.current && sameMembership(viewRef.current, result)) markError(err);
          });
      }
      failures.current = 0;
      setConnection('online');
      setError((old) => (old?.includes('连接') || old?.includes('离线') ? null : old));
    } catch (err) {
      if (
        !alive.current ||
        requestScope !== scope.current ||
        viewRef.current?.room.code !== previous.room.code ||
        viewRef.current.room.version > previous.room.version
      )
        return;
      if (err instanceof ClientError && ['FORBIDDEN', 'NOT_FOUND', 'EXPIRED'].includes(err.code)) {
        leaveView();
        setError(err.message);
      } else if (err instanceof ClientError && err.code === 'UNAUTHORIZED') {
        sessionRef.current = null;
        setSession(null);
        await initialize();
      } else markError(err);
    } finally {
      pollingRef.current = false;
    }
  }, [acceptView, leaveView, markError, initialize, loadNotes]);

  const refresh = useCallback(async () => {
    if (!sessionRef.current || (!viewRef.current && failures.current > 0)) await initialize();
    else await sync();
  }, [initialize, sync]);
  const refreshNow = useCallback(async () => {
    if (refreshingRef.current) return;
    const current = sessionRef.current;
    const previous = viewRef.current;
    if (!current || !previous) return initialize();
    const requestScope = scope.current;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      // Explicit refresh also reloads notes, without remounting the editor or
      // resubmitting any pending command. Parallel polling remains read-only.
      const result = await apiCall<RoomView>(
        { action: 'get', code: previous.room.code },
        current.token,
      );
      if (!alive.current || requestScope !== scope.current) return;
      acceptView(result);
      await loadNotes(result.room.code, current.token);
      if (alive.current && sameMembership(viewRef.current, result)) {
        unchanged.current = 0;
        failures.current = 0;
        setConnection('online');
      }
    } catch (err) {
      if (!alive.current || requestScope !== scope.current) return;
      if (err instanceof ClientError && ['FORBIDDEN', 'NOT_FOUND', 'EXPIRED'].includes(err.code)) {
        leaveView();
      }
      if (err instanceof ClientError && err.code === 'UNAUTHORIZED') await initialize();
      else markError(err);
    } finally {
      refreshingRef.current = false;
      if (alive.current) setRefreshing(false);
    }
  }, [acceptView, initialize, leaveView, loadNotes, markError]);
  const restore = useCallback(async () => {
    await initialize(true);
  }, [initialize]);

  useEffect(() => {
    alive.current = true;
    void initialize();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const current = viewRef.current;
      const activePhase =
        current &&
        ['reveal', 'teamVote', 'questVote', 'lady', 'assassination'].includes(current.room.phase);
      const base = current?.room.phase === 'finished' ? 20000 : activePhase ? 4000 : 8000;
      const delay = failures.current
        ? Math.min(30000, 2000 * 2 ** Math.min(failures.current, 4))
        : Math.min(20000, base + unchanged.current * 1000);
      timer = setTimeout(
        async () => {
          if (!document.hidden && navigator.onLine) {
            if (!sessionRef.current || (!viewRef.current && failures.current > 0))
              await initialize();
            else await sync();
          }
          if (alive.current) schedule();
        },
        delay + Math.floor(Math.random() * 500),
      );
    };
    schedule();
    const reconnect = () => {
      if (!document.hidden) {
        unchanged.current = 0;
        void refresh();
      }
    };
    const offline = () => setConnection('offline');
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', offline);
    window.addEventListener('pageshow', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', offline);
      window.removeEventListener('pageshow', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
    };
  }, [initialize, refresh, sync]);

  const execute = useCallback(
    async (request: PendingRequest) => {
      if (busyRef.current) return false;
      const current = sessionRef.current;
      if (!current) {
        await initialize();
        return false;
      }
      const requestScope = scope.current;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await apiCall<RoomView | { left: true }>(request, current.token);
        if (!alive.current || scope.current !== requestScope) return false;
        pendingRef.current = null;
        setPending(false);
        if ('left' in result) {
          rememberLastRoom(null);
          leaveView();
        } else {
          const changedMembership = !sameMembership(viewRef.current, result);
          acceptView(result);
          unchanged.current = 0;
          if (changedMembership) {
            await loadNotes(result.room.code, current.token).catch((err) => {
              if (alive.current && sameMembership(viewRef.current, result)) markError(err);
            });
          }
        }
        return true;
      } catch (err) {
        if (!alive.current || scope.current !== requestScope) return false;
        markError(err);
        if (err instanceof ClientError && (err.code === 'NETWORK' || err.code === 'INTERNAL')) {
          // Never persist a ballot or other private command in browser storage.
          pendingRef.current = request;
          setPending(true);
          setError('尚未确认操作结果。请重试原操作；刷新后也会读取服务器已保存的结果。');
        } else {
          pendingRef.current = null;
          setPending(false);
          if (err instanceof ClientError && err.code === 'CONFLICT') await sync();
          if (err instanceof ClientError && err.code === 'UNAUTHORIZED') {
            sessionRef.current = null;
            setSession(null);
            await initialize();
          }
        }
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [initialize, leaveView, acceptView, loadNotes, markError, sync, rememberLastRoom],
  );

  const create = useCallback(
    async (name: string, config: GameConfig) => {
      if (pendingRef.current) return false;
      return execute({ action: 'create', name, config, requestId: randomId() });
    },
    [execute],
  );
  const join = useCallback(
    async (code: string, name: string) => {
      if (pendingRef.current) return false;
      return execute({ action: 'join', code: code.trim(), name, requestId: randomId() });
    },
    [execute],
  );
  const command = useCallback(
    async (value: GameCommand) => {
      const current = viewRef.current;
      if (!current || pendingRef.current) return false;
      return execute({
        action: 'command',
        code: current.room.code,
        command: value,
        expectedVersion: current.room.version,
        phaseKey: current.room.phaseKey,
        requestId: randomId(),
      });
    },
    [execute],
  );
  const retryPending = useCallback(async () => {
    if (pendingRef.current) await execute(pendingRef.current);
  }, [execute]);
  const saveNotes = useCallback(
    async (next: Notes) => {
      const current = sessionRef.current;
      const room = viewRef.current;
      if (!current || !room || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const requestScope = scope.current;
      try {
        const result = await apiCall<NotesResult>(
          {
            action: 'notes.save',
            code: room.room.code,
            notes: next,
            expectedRevision: notesRevisionRef.current,
          },
          current.token,
        );
        if (
          alive.current &&
          requestScope === scope.current &&
          viewRef.current?.room.code === room.room.code &&
          result.revision >= notesRevisionRef.current
        ) {
          setNotes(result.notes);
          setNotesRevision(result.revision);
          notesRevisionRef.current = result.revision;
        }
      } catch (err) {
        if (!alive.current || requestScope !== scope.current) return;
        markError(err);
        if (err instanceof ClientError && err.code === 'CONFLICT') {
          await loadNotes(room.room.code, current.token);
          setError('笔记在其他窗口已更新，已加载最新内容，请检查后再保存。');
        }
        throw err;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [loadNotes, markError],
  );

  return {
    session,
    view,
    notes,
    notesRevision,
    loading,
    busy,
    error,
    connection,
    pending,
    create,
    join,
    command,
    saveNotes,
    refresh,
    refreshNow,
    refreshing,
    restore,
    clearError: () => setError(null),
    leaveView,
    retryPending,
  };
}
