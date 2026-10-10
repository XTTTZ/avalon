import type { RoomView } from '../shared/types';
import type { usePoker } from './api/client';

export function RunoutPanel({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const hand = room.hand;
  if (hand?.phase !== 'RUNOUT_DECISION' || !hand.runout) return null;
  const { maxRuns, proposedRuns, approvedIds, eligibleIds } = hand.runout;
  const ownId = room.me.participantId;
  const involved = Boolean(ownId && eligibleIds.includes(ownId));
  const approved = Boolean(ownId && approvedIds.includes(ownId));
  const canPropose = room.me.isDealer || involved;
  const ready = proposedRuns === 1 || eligibleIds.every((id) => approvedIds.includes(id));
  const disabled = busy || room.paused;
  return (
    <section className="card runout-panel" aria-label="协商发牌次数">
      <header>
        <strong>All-in · 发几次？</strong>
        <small>各底池按次数平分</small>
      </header>
      <div className="runout-options">
        {Array.from({ length: maxRuns }, (_, index) => index + 1).map((runs) => (
          <button
            key={runs}
            className={`secondary ${proposedRuns === runs ? 'selected' : ''}`}
            disabled={disabled || !canPropose || proposedRuns === runs}
            aria-pressed={proposedRuns === runs}
            onClick={() => void command({ type: 'propose-runouts', handId: hand.id, runs })}
          >
            {runs} 次
          </button>
        ))}
      </div>
      {proposedRuns > 1 && (
        <>
          <div className="runout-consents">
            {eligibleIds.map((id) => (
              <span key={id} className={approvedIds.includes(id) ? 'agreed' : ''}>
                {room.participants.find((player) => player.id === id)?.name} ·{' '}
                {approvedIds.includes(id) ? '同意' : '待确认'}
              </span>
            ))}
          </div>
          {involved && (
            <div className="runout-actions">
              <button
                className="primary"
                disabled={disabled || approved}
                onClick={() => void command({ type: 'agree-runouts', handId: hand.id })}
              >
                {approved ? '已同意' : `同意发 ${proposedRuns} 次`}
              </button>
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => void command({ type: 'reject-runouts', handId: hand.id })}
              >
                只发一次
              </button>
            </div>
          )}
        </>
      )}
      {room.me.isDealer ? (
        <button
          className="primary wide"
          disabled={disabled || !ready}
          onClick={() => void command({ type: 'finish-runouts', handId: hand.id })}
        >
          {ready ? `确认发 ${proposedRuns} 次` : '等待所有留场玩家同意'}
        </button>
      ) : (
        <small className="muted">{room.paused ? '牌局已暂停' : '等待荷官确认发牌'}</small>
      )}
    </section>
  );
}
