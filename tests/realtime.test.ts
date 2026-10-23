import { describe, expect, it } from 'vitest';
import { issueRealtimeTicket, verifyRealtimeTicket } from '../server/realtime.js';

const secret = 's'.repeat(48);

describe('Avalon realtime tickets', () => {
  it('binds a short-lived ticket to a member, room instance, game, and version', () => {
    const now = 1_000_000;
    const issued = issueRealtimeTicket(
      {
        userId: 'user-1',
        sessionExpiresAt: now + 86_400_000,
        roomInstanceId: 'room_instance_123456',
        gameId: 'game_123456',
        version: 19,
        connectionId: 'page_1234567890123456',
      },
      secret,
      now,
    );
    expect(verifyRealtimeTicket(issued.ticket, secret, now + 10_000)).toMatchObject({
      userId: 'user-1',
      roomInstanceId: 'room_instance_123456',
      gameId: 'game_123456',
      version: 19,
      connectionId: 'page_1234567890123456',
    });
    expect(() => verifyRealtimeTicket(`${issued.ticket}x`, secret, now + 10_000)).toThrow(
      '实时连接已失效',
    );
    expect(() => verifyRealtimeTicket(issued.ticket, secret, issued.expiresAt)).toThrow(
      '实时连接已失效',
    );
  });
});
