import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApiErrorCode,
  ApiRequest,
  GameConfig,
  PokerCommand,
  RoomView,
  Session,
} from '../../shared/types';

const PREFIX = 'poker.v1.';
const API_URL = import.meta.env.VITE_API_URL || '/api/poker';
const KEY_SESSION = `${PREFIX}session`;
const KEY_DEVICE = `${PREFIX}device`;
const KEY_ROOM = `${PREFIX}room`;
const KEY_PENDING = `${PREFIX}pending`;
const HEARTBEAT_INTERVAL = 10 * 60_000;

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
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function randomId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function call<T>(request: ApiRequest, token?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 18_000);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const value = (await response.json()) as {
      ok: boolean;
      data?: T;
      error?: { code: ApiErrorCode; message: string };
    };
    if (!response.ok || !value.ok)
      throw new ClientError(value.error?.code ?? 'INTERNAL', value.error?.message ?? '请求失败');
    return value.data as T;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError('NETWORK', '网络连接失败，请检查网络后重试');
  } finally {
    window.clearTimeout(timeout);
  }
}

interface Pending {
  request: Extract<ApiRequest, { action: 'command' }>;
}

export function usePoker() {
  const [session, setSession] = useState<Session | null>(() => read(KEY_SESSION));
  const [room, setRoom] = useState<RoomView | null>(null);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef(session);
  const roomRef = useRef(room);
  const lastHeartbeatRef = useRef(0);
  sessionRef.current = session;
  roomRef.current = room;

  const accept = useCallback((view: RoomView) => {
    setRoom((current) => (!current || view.version >= current.version ? view : current));
    write(KEY_ROOM, view.code);
    setConnection('online');
    setError(null);
  }, []);

  const login = useCallback(async () => {
    setConnection('connecting');
    let device = read<string>(KEY_DEVICE);
    if (!device) {
      device = randomId();
      write(KEY_DEVICE, device);
    }
    try {
      const current = sessionRef.current;
      const next = current
        ? await call<Session>({ action: 'session' }, current.token)
        : await call<Session>({ action: 'auth.guest', deviceSecret: device });
      write(KEY_SESSION, next);
      setSession(next);
      setConnection('online');
      return next;
    } catch (loginError) {
      if (
        loginError instanceof ClientError &&
        loginError.code === 'UNAUTHORIZED' &&
        sessionRef.current
      ) {
        localStorage.removeItem(KEY_SESSION);
        setSession(null);
        return null;
      }
      setConnection('offline');
      setError(loginError instanceof Error ? loginError.message : '登录失败');
      return null;
    }
  }, []);

  const sync = useCallback(
    async (code?: string, silent = false) => {
      const currentSession = sessionRef.current ?? (await login());
      const roomCode = code ?? roomRef.current?.code ?? read<string>(KEY_ROOM);
      if (!currentSession || !roomCode) return;
      try {
        const shouldHeartbeat =
          !document.hidden && Date.now() - lastHeartbeatRef.current >= HEARTBEAT_INTERVAL;
        const request: ApiRequest = shouldHeartbeat
          ? { action: 'heartbeat', code: roomCode, version: roomRef.current?.version }
          : { action: 'get', code: roomCode, version: roomRef.current?.version };
        const result = await call<RoomView | { unchanged: true; version: number }>(
          request,
          currentSession.token,
        );
        if (shouldHeartbeat) lastHeartbeatRef.current = Date.now();
        if (!('unchanged' in result)) accept(result);
        else setConnection('online');
      } catch (syncError) {
        if (syncError instanceof ClientError && syncError.code === 'NOT_FOUND') {
          localStorage.removeItem(KEY_ROOM);
          setRoom(null);
          setConnection('online');
          setError('房间长期未活跃，已自动解散');
          return;
        }
        if (!silent) setError(syncError instanceof Error ? syncError.message : '同步失败');
        setConnection('offline');
      }
    },
    [accept, login],
  );

  useEffect(() => {
    void (async () => {
      const current = await login();
      const invitation = new URLSearchParams(window.location.search).get('room');
      const saved = invitation ?? read<string>(KEY_ROOM) ?? current?.lastRoom;
      if (saved) await sync(saved);
    })();
  }, [login, sync]);

  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (!document.hidden && navigator.onLine && roomRef.current) void sync(undefined, true);
      },
      room?.hand && !['SETTLED', 'VOIDED'].includes(room.hand.phase)
        ? room.participants.some((item) => item.id === room.hand?.actorId && item.isBot)
          ? 1600
          : 3500
        : room?.hand?.phase === 'SETTLED' && room.config.mode === 'online'
          ? 2500
          : 10_000,
    );
    const reconnect = () => {
      if (!document.hidden && navigator.onLine) void sync();
    };
    window.addEventListener('online', reconnect);
    window.addEventListener('pageshow', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('pageshow', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
    };
  }, [room?.hand?.phase, room?.hand?.actorId, sync]);

  const create = useCallback(
    async (name: string, config: GameConfig) => {
      const current = sessionRef.current ?? (await login());
      if (!current) return false;
      setBusy(true);
      try {
        const view = await call<RoomView>(
          { action: 'create', name, config, requestId: randomId() },
          current.token,
        );
        accept(view);
        return true;
      } catch (createError) {
        setError(createError instanceof Error ? createError.message : '创建失败');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [accept, login],
  );

  const join = useCallback(
    async (code: string, name: string, as: 'player' | 'spectator') => {
      const current = sessionRef.current ?? (await login());
      if (!current) return false;
      setBusy(true);
      try {
        const view = await call<RoomView>(
          { action: 'join', code, name, as, requestId: randomId() },
          current.token,
        );
        accept(view);
        return true;
      } catch (joinError) {
        setError(joinError instanceof Error ? joinError.message : '加入失败');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [accept, login],
  );

  const command = useCallback(
    async (value: PokerCommand) => {
      const current = roomRef.current;
      const currentSession = sessionRef.current;
      if (!current || !currentSession || busy) return false;
      const request: Extract<ApiRequest, { action: 'command' }> = {
        action: 'command',
        code: current.code,
        command: value,
        expectedVersion: current.version,
        phaseKey: current.phaseKey,
        requestId: randomId(),
      };
      write(KEY_PENDING, { request } satisfies Pending);
      setBusy(true);
      try {
        const view = await call<RoomView>(request, currentSession.token);
        localStorage.removeItem(KEY_PENDING);
        accept(view);
        return true;
      } catch (commandError) {
        if (commandError instanceof ClientError && commandError.code !== 'NETWORK')
          localStorage.removeItem(KEY_PENDING);
        setError(commandError instanceof Error ? commandError.message : '操作失败');
        if (commandError instanceof ClientError && commandError.code === 'CONFLICT') await sync();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [accept, busy, sync],
  );

  const retryPending = useCallback(async () => {
    const pending = read<Pending>(KEY_PENDING);
    const currentSession = sessionRef.current;
    if (!pending || !currentSession) return false;
    setBusy(true);
    try {
      const view = await call<RoomView>(pending.request, currentSession.token);
      localStorage.removeItem(KEY_PENDING);
      accept(view);
      return true;
    } catch (pendingError) {
      if (pendingError instanceof ClientError && pendingError.code !== 'NETWORK')
        localStorage.removeItem(KEY_PENDING);
      setError(pendingError instanceof Error ? pendingError.message : '确认操作失败');
      return false;
    } finally {
      setBusy(false);
    }
  }, [accept]);

  const leaveLocal = useCallback(() => {
    localStorage.removeItem(KEY_ROOM);
    setRoom(null);
  }, []);

  return {
    session,
    room,
    busy,
    connection,
    error,
    hasPending: Boolean(read(KEY_PENDING)),
    create,
    join,
    command,
    sync,
    retryPending,
    leaveLocal,
    clearError: () => setError(null),
  };
}
