import { randomInt } from 'node:crypto';

export function randomRoomCode(): string {
  return String(randomInt(1000, 10000));
}
