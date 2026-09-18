export interface ExpiringNote {
  expiresAt: number;
  roomInstanceId?: string;
  roomCreatedAt?: number;
}
export interface NoteRoom {
  instanceId?: string;
  createdAt: number;
  expiresAt: number;
  players: { userId: string }[];
}

/** Room numbers are reusable. A retained note must belong to this room instance. */
export function noteMatchesRoom(
  note: ExpiringNote,
  room: Pick<NoteRoom, 'createdAt' | 'instanceId'>,
) {
  if (room.instanceId) return note.roomInstanceId === room.instanceId;
  if (note.roomInstanceId) return false;
  return note.roomCreatedAt === undefined
    ? note.expiresAt > room.createdAt
    : note.roomCreatedAt === room.createdAt;
}

/** Renew notes lazily during cleanup, so ordinary room polling never writes. */
export function retainedNoteExpiry(
  note: ExpiringNote,
  room: NoteRoom | undefined,
  userId: string,
  now: number,
): number | null {
  return room &&
    room.expiresAt > now &&
    room.players.some((player) => player.userId === userId) &&
    noteMatchesRoom(note, room)
    ? room.expiresAt
    : null;
}
