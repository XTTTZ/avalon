import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RoomRealtime,
  REALTIME_PING_INTERVAL,
  REALTIME_PONG_TIMEOUT,
  type RealtimeSocket,
} from '../src/realtime';
import type { RealtimeNotice, RealtimeTicket } from '../shared/types';

const notice: RealtimeNotice = {
  type: 'room-version',
  roomInstanceId: 'room_instance',
  gameId: 'game_1',
  version: 10,
};
const ticket: RealtimeTicket = {
  ticket: 'signed',
  roomInstanceId: notice.roomInstanceId,
  expiresAt: 999999,
  notice,
};
class Socket implements RealtimeSocket {
  readyState = 0;
  onopen: RealtimeSocket['onopen'] = null;
  onmessage: RealtimeSocket['onmessage'] = null;
  onerror: RealtimeSocket['onerror'] = null;
  onclose: RealtimeSocket['onclose'] = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  message(value: unknown) {
    this.onmessage?.({
      data: typeof value === 'string' ? value : JSON.stringify(value),
    } as MessageEvent);
  }
  ready() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    this.message(notice);
  }
}
function fixture(getTicket = vi.fn(async (_signal: AbortSignal) => ticket)) {
  let active = true;
  const sockets: Socket[] = [];
  const connected = vi.fn();
  const subscribed = vi.fn();
  const changed = vi.fn();
  const realtime = new RoomRealtime({
    roomInstanceId: notice.roomInstanceId,
    getTicket,
    createSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    active: () => active,
    connected,
    subscribed,
    notice: changed,
  });
  return {
    realtime,
    getTicket,
    sockets,
    connected,
    subscribed,
    changed,
    active: (value: boolean) => {
      active = value;
    },
  };
}
const controllers: RoomRealtime[] = [];
const track = (f: ReturnType<typeof fixture>) => {
  controllers.push(f.realtime);
  return f;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('room realtime recovery', () => {
  it('coalesces foreground events before ticket resolution and validates the room before connected', async () => {
    let finish!: (value: RealtimeTicket) => void;
    const f = track(
      fixture(
        vi.fn(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
      ),
    );
    f.realtime.resume();
    f.realtime.resume();
    f.realtime.resume();
    expect(f.getTicket).toHaveBeenCalledTimes(1);
    finish(ticket);
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0].message({ ...notice, roomInstanceId: 'other-room' });
    expect(f.connected).not.toHaveBeenCalledWith(true);
    f.sockets[0].ready();
    expect(f.connected).toHaveBeenLastCalledWith(true);
    expect(f.subscribed).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledWith(notice);
  });
  it('detects a silent OPEN socket and ignores its late notices after reconnect', async () => {
    const f = track(fixture());
    f.realtime.resume();
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0].ready();
    const oldMessage = f.sockets[0].onmessage!;
    await vi.advanceTimersByTimeAsync(REALTIME_PING_INTERVAL + REALTIME_PONG_TIMEOUT + 1000);
    expect(f.sockets).toHaveLength(2);
    f.sockets[1].ready();
    oldMessage({ data: JSON.stringify({ ...notice, version: 999 }) } as MessageEvent);
    expect(f.changed).not.toHaveBeenCalledWith(expect.objectContaining({ version: 999 }));
    expect(f.connected).toHaveBeenLastCalledWith(true);
  });
  it('keeps a responsive socket on focus/network changes and continues heartbeat during busy games', async () => {
    const f = track(fixture());
    f.realtime.resume();
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0].ready();
    f.realtime.resume();
    f.realtime.networkChanged();
    await vi.advanceTimersByTimeAsync(3000);
    f.sockets[0].message('pong');
    for (let n = 0; n < 60; n++) {
      await vi.advanceTimersByTimeAsync(1000);
      f.sockets[0].message({ ...notice, version: 11 + n });
    }
    expect(f.sockets).toHaveLength(1);
    expect(f.sockets[0].sent.length).toBeGreaterThanOrEqual(4);
  });
  it('probes a changed route and rebuilds a stale socket without waiting for polling', async () => {
    const f = track(fixture());
    f.realtime.resume();
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0].ready();
    f.realtime.networkChanged();
    await vi.advanceTimersByTimeAsync(13000);
    expect(f.sockets).toHaveLength(2);
  });
  it('bounds ticket and handshake separately and ignores late ticket generations', async () => {
    let finish!: (value: RealtimeTicket) => void;
    const get = vi
      .fn<(_: AbortSignal) => Promise<RealtimeTicket>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(ticket);
    const f = track(fixture(get));
    f.realtime.resume();
    await vi.advanceTimersByTimeAsync(31000);
    expect(get.mock.calls[0][0].aborted).toBe(true);
    expect(f.sockets).toHaveLength(1);
    finish(ticket);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(32000);
    expect(f.sockets).toHaveLength(2);
  });
  it('does not starve slow replacement handshakes on repeated network hints', async () => {
    let finish!: (value: RealtimeTicket) => void;
    const get = vi.fn(
      (_: AbortSignal) =>
        new Promise<RealtimeTicket>((resolve) => {
          finish = resolve;
        }),
    );
    const f = track(fixture(get));
    f.realtime.resume();
    f.realtime.networkChanged();
    expect(get.mock.calls[0][0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    f.realtime.networkChanged();
    expect(get).toHaveBeenCalledTimes(2);
    finish(ticket);
    await vi.advanceTimersByTimeAsync(15000);
    f.realtime.networkChanged();
    f.sockets[0].ready();
    expect(f.connected).toHaveBeenLastCalledWith(true);
  });
  it('closes in background, reconnects on resume and stops replaced tabs competing', async () => {
    const f = track(fixture());
    f.realtime.resume();
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0].ready();
    f.active(false);
    f.realtime.suspend();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.sockets).toHaveLength(1);
    f.active(true);
    f.realtime.resume();
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[1].ready();
    f.sockets[1].message({ type: 'replaced' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.sockets).toHaveLength(2);
    f.realtime.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sockets).toHaveLength(3);
  });
  it('manual refresh and disposal abort old reads without creating orphan sockets', async () => {
    const get = vi.fn((_: AbortSignal) => new Promise<RealtimeTicket>(() => {}));
    const f = track(fixture(get));
    f.realtime.resume();
    f.realtime.refresh();
    expect(get.mock.calls[0][0].aborted).toBe(true);
    f.realtime.dispose();
    await vi.advanceTimersByTimeAsync(120000);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][0].aborted).toBe(true);
    expect(f.sockets).toHaveLength(0);
  });
});
