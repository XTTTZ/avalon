import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomRealtime } from './realtime';
import { subscribeNetworkChanges, withAbort } from './network';
import type {
  ApiErrorCode,
  ApiRequest,
  GameCommand,
  GameConfig,
  Notes,
  NotesResult,
  RealtimeTicket,
  RoomView,
  Session,
} from '../shared/types';

const PREFIX = 'avalon.v1.';
const API_URL = import.meta.env.VITE_API_URL || '/api';
const REALTIME_ENABLED =
  import.meta.env.VITE_REALTIME_ENABLED === 'true' ||
  (import.meta.env.PROD && import.meta.env.VITE_REALTIME_ENABLED !== 'false');
const KEY_SESSION = PREFIX + 'session';
const KEY_ROOM = PREFIX + 'room';
const KEY_DEVICE = PREFIX + 'device';
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
export async function apiCall<T>(
  request: ApiRequest,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (signal?.aborted) abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = window.setTimeout(cancel, 30_000);
  try {
    const response = await withAbort(
      fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(request),
        signal: abort.signal,
        cache: 'no-store',
        credentials: 'omit',
      }),
      abort.signal,
    );
    const body = (await withAbort(response.json(), abort.signal)) as {
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
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (error instanceof ClientError) throw error;
    throw new ClientError(
      'NETWORK',
      navigator.onLine ? '连接暂时中断，正在重新连接。' : '当前离线，连接恢复后会自动同步。',
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
    window.clearTimeout(timeout);
  }
}

let authenticating: { promise: Promise<Session>; signal?: AbortSignal } | null = null;
async function authenticate(signal?: AbortSignal): Promise<Session> {
  // Also coalesce event-driven retry and mount work.
  if (authenticating && !authenticating.signal?.aborted) return authenticating.promise;
  const promise = (async () => {
    const saved = read<Session>(KEY_SESSION);
    if (saved?.token && saved.expiresAt > Date.now() && saved.provider === 'guest') {
      try {
        const renewed = await apiCall<Session>({ action: 'session' }, saved.token, signal);
        remember(KEY_SESSION, renewed);
        return renewed;
      } catch (error) {
        if (!(error instanceof ClientError) || !['UNAUTHORIZED', 'EXPIRED'].includes(error.code))
          throw error;
        remove(KEY_SESSION);
      }
    }
    let device = read<string>(KEY_DEVICE);
    if (!device) {
      device = randomId();
      write(KEY_DEVICE, device);
    }
    const result = await apiCall<Session>(
      { action: 'auth.guest', deviceSecret: device },
      undefined,
      signal,
    );
    remember(KEY_SESSION, result);
    return result;
  })();
  const flight = { promise, signal };
  authenticating = flight;
  try {
    return await promise;
  } finally {
    if (authenticating === flight) authenticating = null;
  }
}

type Connection = 'connecting' | 'online' | 'offline' | 'reconnecting';
const RESUME_NOTICE_DELAY = 10_000;
type PendingRequest = Extract<ApiRequest, { action: 'create' | 'join' | 'command' }>;
function sameMembership(previous: RoomView | null, next: RoomView): boolean {
  return (
    previous?.room.code === next.room.code &&
    previous.room.instanceId === next.room.instanceId &&
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
  // Keep transport notices separate from rejected or unconfirmed player actions.
  // Foreground recovery may hide the former, but must never hide the latter.
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [quietRecovery, setQuietRecovery] = useState(false);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);
  const viewRef = useRef<RoomView | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);
  const busyRef = useRef(false);
  const syncFlight = useRef<{
    controller: AbortController;
    promise: Promise<void>;
    queued: boolean;
  } | null>(null);
  const bootingRef = useRef<AbortController | null>(null);
  const realtimeRef = useRef<RoomRealtime | null>(null);
  const realtimeConnected = useRef(false);
  const reschedulePolling = useRef<() => void>(() => {});
  const restorePending = useRef(true);
  const connectionId = useRef<string | null>(null);
  if (!connectionId.current) connectionId.current = randomId();
  const failures = useRef(0);
  const unchanged = useRef(0);
  const notesRevisionRef = useRef(0);
  const alive = useRef(true);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A recycled room code or a new seat is a new membership. Invalidate pending
  // responses and private notes even when the visible room code stays the same.
  const scope = useRef(0);

  const markConnected = useCallback(() => {
    failures.current = 0;
    setConnection('online');
    setNetworkError(null);
    setQuietRecovery(false);
    if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
    recoveryTimer.current = null;
  }, []);

  const beginQuietRecovery = useCallback(() => {
    if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
    failures.current = 0;
    setConnection('connecting');
    setNetworkError(null);
    setQuietRecovery(true);
    recoveryTimer.current = setTimeout(() => {
      recoveryTimer.current = null;
      if (alive.current) setQuietRecovery(false);
    }, RESUME_NOTICE_DELAY);
  }, []);

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
        syncFlight.current?.controller.abort();
        syncFlight.current = null;
        pendingRef.current = null;
        setPending(false);
        setNotes({});
        setNotesRevision(0);
        notesRevisionRef.current = 0;
      }
      viewRef.current = next;
      restorePending.current = false;
      setView(next);
      remember(KEY_ROOM, next.room.code);
      rememberLastRoom(next.room.code);
      const url = new URL(location.href);
      if (url.searchParams.get('room') !== next.room.code) {
        url.searchParams.set('room', next.room.code);
        history.replaceState(null, '', url);
      }
      markConnected();
      if (storageWarning) {
        setError(storageWarning);
        storageWarning = null;
      }
    },
    [rememberLastRoom, markConnected],
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
    restorePending.current = false;
    scope.current++;
    syncFlight.current?.controller.abort();
    syncFlight.current = null;
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
    if (err instanceof ClientError && err.code === 'NETWORK') {
      setNetworkError(message);
      failures.current += 1;
      setConnection(navigator.onLine ? 'reconnecting' : 'offline');
      // Event-driven reads can fail while the next healthy-WebSocket poll is
      // still a minute away. Start a bounded retry promptly, including in grace.
      reschedulePolling.current();
    } else setError(message);
  }, []);
  const initialize = useCallback(
    async (forceRestore = false) => {
      if (bootingRef.current || document.hidden) return;
      const requestScope = scope.current;
      const controller = new AbortController();
      bootingRef.current = controller;
      restorePending.current = true;
      setLoading(true);
      setError(null);
      try {
        const current = await authenticate(controller.signal);
        if (!alive.current || scope.current !== requestScope) return;
        sessionRef.current = current;
        setSession(current);
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
              controller.signal,
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
        if (!controller.signal.aborted) {
          restorePending.current = false;
          markConnected();
        }
      } catch (err) {
        if (!controller.signal.aborted && alive.current && scope.current === requestScope)
          markError(err);
      } finally {
        if (bootingRef.current === controller) {
          bootingRef.current = null;
          if (alive.current) setLoading(false);
        }
      }
    },
    [acceptView, loadNotes, leaveView, markError, markConnected],
  );

  const sync = useCallback((): Promise<void> => {
    const current = sessionRef.current;
    const previous = viewRef.current;
    if (!current || !previous || document.hidden) return Promise.resolve();
    if (syncFlight.current) {
      // A notice arriving during GET must cause one follow-up read, not disappear.
      syncFlight.current.queued = true;
      return syncFlight.current.promise;
    }
    const flight = { controller: new AbortController(), promise: Promise.resolve(), queued: false };
    syncFlight.current = flight;
    const requestScope = scope.current;
    flight.promise = (async () => {
      do {
        flight.queued = false;
        const previous = viewRef.current;
        if (!previous || flight.controller.signal.aborted || requestScope !== scope.current) break;
        try {
          const result = await apiCall<RoomView | { unchanged: true; version: number }>(
            {
              action: 'get',
              code: previous.room.code,
              version: previous.room.version,
              gameId: previous.room.gameId,
            },
            current.token,
            flight.controller.signal,
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
          markConnected();
        } catch (err) {
          if (flight.controller.signal.aborted) return;
          if (
            !alive.current ||
            requestScope !== scope.current ||
            viewRef.current?.room.code !== previous.room.code ||
            viewRef.current.room.version > previous.room.version
          )
            return;
          if (
            err instanceof ClientError &&
            ['FORBIDDEN', 'NOT_FOUND', 'EXPIRED'].includes(err.code)
          ) {
            leaveView();
            setError(err.message);
          } else if (err instanceof ClientError && err.code === 'UNAUTHORIZED') {
            sessionRef.current = null;
            setSession(null);
            await initialize();
          } else markError(err);
          return;
        }
      } while (flight.queued && !document.hidden && alive.current);
    })().finally(() => {
      if (syncFlight.current === flight) syncFlight.current = null;
    });
    return flight.promise;
  }, [acceptView, leaveView, markError, initialize, loadNotes, markConnected]);

  const cancelReads = useCallback(() => {
    syncFlight.current?.controller.abort();
    syncFlight.current = null;
    bootingRef.current?.abort();
    bootingRef.current = null;
    if (alive.current) setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (
      !sessionRef.current ||
      (!viewRef.current && (restorePending.current || failures.current > 0))
    )
      await initialize();
    else await sync();
  }, [initialize, sync]);
  const refreshNow = useCallback(async () => {
    if (refreshingRef.current) return;
    cancelReads();
    realtimeRef.current?.refresh();
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
        markConnected();
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
  }, [acceptView, initialize, leaveView, loadNotes, markError, cancelReads, markConnected]);
  const restore = useCallback(async () => {
    await initialize(true);
  }, [initialize]);

  useEffect(() => {
    const expectedInstance = view?.room.instanceId;
    const expectedGame = view?.room.gameId;
    if (!REALTIME_ENABLED || !session?.token || !expectedInstance || !expectedGame) return;
    const active = () =>
      !document.hidden &&
      sessionRef.current?.token === session.token &&
      viewRef.current?.room.instanceId === expectedInstance &&
      viewRef.current.room.gameId === expectedGame;
    const realtime = new RoomRealtime({
      roomInstanceId: expectedInstance,
      active,
      getTicket: async (signal) => {
        const current = viewRef.current!;
        try {
          return await apiCall<RealtimeTicket>(
            {
              action: 'realtime.ticket',
              code: current.room.code,
              gameId: expectedGame,
              connectionId: connectionId.current!,
            },
            session.token,
            signal,
          );
        } catch (err) {
          if (
            !signal.aborted &&
            active() &&
            err instanceof ClientError &&
            ['FORBIDDEN', 'NOT_FOUND', 'EXPIRED', 'UNAUTHORIZED', 'CONFLICT'].includes(err.code)
          )
            void sync();
          throw err;
        }
      },
      createSocket: (ticket) => {
        const endpoint = new URL('/ws', location.href);
        endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
        return new WebSocket(endpoint, ['avalon-v1', `avalon-ticket.${ticket}`]);
      },
      connected: (connected) => {
        const changed = realtimeConnected.current !== connected;
        realtimeConnected.current = connected;
        if (changed) reschedulePolling.current();
      },
      subscribed: () => {
        void sync();
      },
      notice: (notice) => {
        const current = viewRef.current;
        if (
          current?.room.instanceId === notice.roomInstanceId &&
          (notice.closed ||
            notice.gameId !== current.room.gameId ||
            notice.version > current.room.version)
        )
          void sync();
      },
    });
    realtimeRef.current = realtime;
    const resume = () => realtime.resume();
    const suspend = () => realtime.suspend();
    const visibility = () => (document.hidden ? suspend() : resume());
    const networkHint = () => realtime.networkChanged();
    window.addEventListener('offline', networkHint);
    window.addEventListener('pageshow', resume);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', visibility);
    resume();
    return () => {
      realtime.dispose();
      if (realtimeRef.current === realtime) realtimeRef.current = null;
      realtimeConnected.current = false;
      reschedulePolling.current();
      window.removeEventListener('offline', networkHint);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('pagehide', suspend);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [session?.token, view?.room.instanceId, view?.room.gameId, sync]);
  useEffect(() => {
    alive.current = true;
    void initialize();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      const current = viewRef.current;
      const activePhase =
        current &&
        ['reveal', 'teamVote', 'questVote', 'lady', 'assassination'].includes(current.room.phase);
      const connected = realtimeConnected.current;
      const base = connected
        ? 60_000
        : current?.room.phase === 'finished'
          ? 20_000
          : activePhase
            ? 4_000
            : 8_000;
      const delay = failures.current
        ? Math.min(30000, 2000 * 2 ** Math.min(failures.current, 4))
        : connected
          ? base
          : Math.min(20_000, base + unchanged.current * 1000);
      timer = setTimeout(
        async () => {
          if (!document.hidden) {
            if (
              !sessionRef.current ||
              (!viewRef.current && (restorePending.current || failures.current > 0))
            )
              await initialize();
            else await sync();
          }
          if (alive.current) schedule();
        },
        delay + Math.floor(Math.random() * 500),
      );
    };
    reschedulePolling.current = schedule;
    schedule();
    let wasHidden = document.hidden;
    const reconnect = () => {
      if (!document.hidden) {
        // One grace period per real background/foreground cycle. Mobile
        // browsers often emit visibilitychange, pageshow and focus together;
        // those duplicate events must not postpone a genuine outage forever.
        if (wasHidden) {
          wasHidden = false;
          beginQuietRecovery();
          cancelReads();
        }
        unchanged.current = 0;
        void refresh();
      }
    };
    let lastRestart = -Infinity;
    const unsubscribeNetwork = subscribeNetworkChanges(() => {
      if (document.hidden) return;
      realtimeRef.current?.networkChanged();
      if (Date.now() - lastRestart < 30_000) return;
      lastRestart = Date.now();
      cancelReads();
      void refresh();
    });
    const suspend = () => {
      wasHidden = true;
      cancelReads();
    };
    const hidden = () => {
      if (document.hidden) suspend();
    };
    // OS offline can be inaccurate with VPNs: discard stale reads, then probe the origin.
    const offline = () => {
      cancelReads();
      reconnect();
    };
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', offline);
    window.addEventListener('pageshow', reconnect);
    window.addEventListener('focus', reconnect);
    window.addEventListener('pagehide', suspend);
    document.addEventListener('visibilitychange', reconnect);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      reschedulePolling.current = () => {};
      unsubscribeNetwork();
      // React StrictMode immediately remounts; only abandon reads on a real unmount.
      queueMicrotask(() => {
        if (!alive.current) {
          cancelReads();
          if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current);
          recoveryTimer.current = null;
        }
      });
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', offline);
      window.removeEventListener('pageshow', reconnect);
      window.removeEventListener('focus', reconnect);
      window.removeEventListener('pagehide', suspend);
      document.removeEventListener('visibilitychange', reconnect);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [initialize, refresh, sync, cancelReads, beginQuietRecovery]);

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
    error: error || (quietRecovery ? null : networkError),
    errorIsNetwork: !error && Boolean(networkError),
    connection: quietRecovery && connection !== 'online' ? ('connecting' as const) : connection,
    pending,
    create,
    join,
    command,
    saveNotes,
    refresh,
    refreshNow,
    refreshing,
    restore,
    clearError: () => {
      setError(null);
      setNetworkError(null);
    },
    leaveView,
    retryPending,
  };
}
