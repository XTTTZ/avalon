import type { RealtimeNotice, RealtimeTicket } from '../shared/types';

export interface RealtimeSocket {
  readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface RealtimeOptions {
  roomInstanceId: string;
  getTicket(signal: AbortSignal): Promise<RealtimeTicket>;
  createSocket(ticket: string): RealtimeSocket;
  active(): boolean;
  connected(value: boolean): void;
  notice(value: RealtimeNotice): void;
  subscribed(): void;
}

export const REALTIME_CONNECT_TIMEOUT = 30_000;
export const REALTIME_TICKET_TIMEOUT = 30_000;
export const REALTIME_PING_INTERVAL = 20_000;
export const REALTIME_PONG_TIMEOUT = 35_000;
const NETWORK_PROBE_TIMEOUT = 12_000;

function validNotice(value: unknown): value is RealtimeNotice {
  if (!value || typeof value !== 'object') return false;
  const notice = value as Partial<RealtimeNotice>;
  return (
    notice.type === 'room-version' &&
    typeof notice.roomInstanceId === 'string' &&
    typeof notice.gameId === 'string' &&
    Number.isSafeInteger(notice.version) &&
    Number(notice.version) >= 1 &&
    (notice.closed === undefined || typeof notice.closed === 'boolean')
  );
}

/** Owns both the socket and its ticket request; foreground events share one connection. */
export class RoomRealtime {
  private socket: RealtimeSocket | null = null;
  private connecting = false;
  private disposed = false;
  private replaced = false;
  private generation = 0;
  private attempts = 0;
  private networkRestartedAt = -Infinity;
  private lastMessageAt = -Infinity;
  private retry?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private ping?: ReturnType<typeof setTimeout>;
  private pong?: ReturnType<typeof setTimeout>;
  private networkProbe?: ReturnType<typeof setTimeout>;
  private ticketController?: AbortController;

  constructor(private options: RealtimeOptions) {}

  private release() {
    this.generation++;
    clearTimeout(this.retry);
    clearTimeout(this.handshake);
    clearTimeout(this.ping);
    clearTimeout(this.pong);
    clearTimeout(this.networkProbe);
    this.retry = this.handshake = this.ping = this.pong = this.networkProbe = undefined;
    this.connecting = false;
    this.ticketController?.abort();
    this.ticketController = undefined;
    const old = this.socket;
    this.socket = null;
    if (!old) return;
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try {
      old.close(1000, 'reconnecting');
    } catch {
      // A mobile socket may already be terminated.
    }
  }

  private retryLater() {
    if (this.disposed || this.replaced || !this.options.active() || this.retry) return;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5));
    this.retry = setTimeout(
      () => {
        this.retry = undefined;
        void this.connect();
      },
      Math.round(base * (0.8 + Math.random() * 0.4)),
    );
  }

  private failed(generation: number) {
    if (this.disposed || this.generation !== generation) return;
    this.release();
    this.options.connected(false);
    this.retryLater();
  }

  private sendPing(generation: number) {
    this.ping = undefined;
    if (this.disposed || this.generation !== generation || !this.socket || this.pong) return;
    if (!this.options.active()) return this.suspend();
    try {
      this.socket.send('ping');
      this.pong = setTimeout(() => this.failed(generation), REALTIME_PONG_TIMEOUT);
    } catch {
      this.failed(generation);
    }
  }

  private received(generation: number, pong: boolean) {
    this.lastMessageAt = Date.now();
    if (pong) {
      clearTimeout(this.networkProbe);
      this.networkProbe = undefined;
    }
    clearTimeout(this.pong);
    this.pong = undefined;
    // Frequent room notices must not defer heartbeats indefinitely.
    if (!this.ping) this.ping = setTimeout(() => this.sendPing(generation), REALTIME_PING_INTERVAL);
  }

  private async connect() {
    if (this.disposed || this.replaced || this.connecting || this.socket || !this.options.active())
      return;
    this.connecting = true;
    const generation = ++this.generation;
    this.options.connected(false);
    const controller = new AbortController();
    this.ticketController = controller;
    this.handshake = setTimeout(() => this.failed(generation), REALTIME_TICKET_TIMEOUT);
    try {
      const ticket = await this.options.getTicket(controller.signal);
      if (this.disposed || generation !== this.generation) return;
      this.ticketController = undefined;
      clearTimeout(this.handshake);
      this.handshake = setTimeout(() => this.failed(generation), REALTIME_CONNECT_TIMEOUT);
      if (!this.options.active()) return this.suspend();
      if (ticket.roomInstanceId !== this.options.roomInstanceId) return this.failed(generation);
      const socket = this.options.createSocket(ticket.ticket);
      this.socket = socket;
      const current = () =>
        !this.disposed && generation === this.generation && this.socket === socket;
      socket.onopen = () => {
        if (current()) this.sendPing(generation);
      };
      socket.onmessage = ({ data }) => {
        if (!current() || typeof data !== 'string') return;
        if (data === 'pong') return this.received(generation, true);
        try {
          const message: unknown = JSON.parse(data);
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'replaced'
          ) {
            this.replaced = true;
            this.release();
            this.options.connected(false);
            return;
          }
          if (!validNotice(message) || message.roomInstanceId !== this.options.roomInstanceId)
            return;
          this.received(generation, false);
          if (this.connecting) {
            clearTimeout(this.handshake);
            this.handshake = undefined;
            this.connecting = false;
            this.attempts = 0;
            this.options.connected(true);
            this.options.subscribed();
          }
          this.options.notice(message);
        } catch {
          // Only version hints are accepted; HTTP owns all public and private state.
        }
      };
      socket.onerror = () => this.failed(generation);
      socket.onclose = ({ code }) => {
        if (!current()) return;
        if (code === 4001) this.replaced = true;
        this.failed(generation);
      };
    } catch {
      this.failed(generation);
    }
  }

  resume() {
    if (this.disposed || !this.options.active() || this.connecting) return;
    if (this.socket?.readyState === 1) {
      if (!this.pong && Date.now() - this.lastMessageAt >= REALTIME_PING_INTERVAL) {
        clearTimeout(this.ping);
        this.sendPing(this.generation);
      }
      return;
    }
    if (this.socket?.readyState === 0) return;
    this.replaced = false;
    this.release();
    this.attempts = 0;
    void this.connect();
  }

  networkChanged() {
    if (this.disposed || !this.options.active()) return;
    if (!this.connecting && this.socket?.readyState === 1) {
      if (this.networkProbe) return;
      const generation = this.generation;
      this.networkProbe = setTimeout(() => this.failed(generation), NETWORK_PROBE_TIMEOUT);
      if (!this.pong) {
        clearTimeout(this.ping);
        this.sendPing(generation);
      }
      return;
    }
    if (
      this.connecting &&
      Date.now() - this.networkRestartedAt < REALTIME_TICKET_TIMEOUT + REALTIME_CONNECT_TIMEOUT
    )
      return;
    this.refresh();
  }

  refresh() {
    if (this.disposed) return;
    this.networkRestartedAt = Date.now();
    this.replaced = false;
    this.release();
    this.attempts = 0;
    void this.connect();
  }

  suspend() {
    if (this.disposed) return;
    this.release();
    this.options.connected(false);
  }

  dispose() {
    this.disposed = true;
    this.release();
  }
}
