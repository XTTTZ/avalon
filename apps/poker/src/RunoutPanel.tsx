import { useEffect, useState } from 'react';
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
  const [dealerRuns, setDealerRuns] = useState(hand?.runout?.proposedRuns ?? 1);
  useEffect(
    () => setDealerRuns(hand?.runout?.proposedRuns ?? 1),
    [hand?.id, hand?.runout?.proposedRuns],
  );
  if (hand?.phase !== 'RUNOUT_DECISION' || !hand.runout) return null;
  const { maxRuns, proposedRuns, approvedIds, eligibleIds } = hand.runout;
  const ownId = room.me.participantId;
  const involved = Boolean(ownId && eligibleIds.includes(ownId));
  const approved = Boolean(ownId && approvedIds.includes(ownId));
  const canPropose = room.me.isDealer || involved;
  const selectedRuns = room.me.isDealer ? Math.min(dealerRuns, maxRuns) : proposedRuns;
  const disabled = busy || room.paused;
  return (
    <section className="card runout-panel" aria-label="协商发牌次数">
      <header>
        <strong>All-in · 发几次？</strong>
        <small>全员同意即发牌 · 荷官可直接指定</small>
      </header>
      <div className="runout-options">
        {Array.from({ length: maxRuns }, (_, index) => index + 1).map((runs) => (
          <button
            key={runs}
            className={`secondary ${selectedRuns === runs ? 'selected' : ''}`}
            disabled={disabled || !canPropose || (!room.me.isDealer && proposedRuns === runs)}
            aria-pressed={selectedRuns === runs}
            onClick={() =>
              room.me.isDealer
                ? setDealerRuns(runs)
                : void command({ type: 'propose-runouts', handId: hand.id, runs })
            }
          >
            {runs} 次
          </button>
        ))}
      </div>
      <div className="runout-agreement">
        <small className="muted">玩家协商：发 {proposedRuns} 次</small>
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
            {proposedRuns > 1 && (
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => void command({ type: 'reject-runouts', handId: hand.id })}
              >
                只发一次
              </button>
            )}
          </div>
        )}
      </div>
      {room.me.isDealer ? (
        <button
          className="primary wide"
          disabled={disabled}
          onClick={() =>
            void command({ type: 'finish-runouts', handId: hand.id, runs: selectedRuns })
          }
        >
          直接发 {selectedRuns} 次
        </button>
      ) : (
        <small className="muted">{room.paused ? '牌局已暂停' : '所有留场玩家同意后自动发牌'}</small>
      )}
    </section>
  );
}
