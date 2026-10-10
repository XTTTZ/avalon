import { PokerError, type PokerCommand, type RoomState } from '../../shared/types.js';
import { compareScores, evaluateHoldem } from './cards.js';
import { legalActions } from './engine.js';

type BotAction = Extract<PokerCommand, { type: 'act' }>;

const FULL_DECK = [...'shdc'].flatMap((suit) => [...'23456789TJQKA'].map((rank) => rank + suit));
const EQUITY_TRIALS = 40;

function randomUnit(random: () => number) {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0.5;
}

/** Sample hypothetical opponents, never the actual deal or another player's cards. */
function estimateEquity(
  holeCards: string[],
  board: string[],
  opponents: number,
  random: () => number,
) {
  const known = new Set([...holeCards, ...board]);
  const unseen = FULL_DECK.filter((card) => !known.has(card));
  let shares = 0;
  let allSamplesTie = board.length === 5;
  const riverScore = board.length === 5 ? evaluateHoldem([...holeCards, ...board]).score : null;
  for (let trial = 0; trial < EQUITY_TRIALS; trial += 1) {
    const sample = [...unseen];
    let drawn = 0;
    const draw = () => {
      const index = drawn + Math.floor(randomUnit(random) * (sample.length - drawn));
      [sample[drawn], sample[index]] = [sample[index], sample[drawn]];
      return sample[drawn++];
    };
    const runout = [...board];
    while (runout.length < 5) runout.push(draw());
    const ownScore = riverScore ?? evaluateHoldem([...holeCards, ...runout]).score;
    let tied = 1;
    let beaten = false;
    for (let opponent = 0; opponent < opponents; opponent += 1) {
      const score = evaluateHoldem([draw(), draw(), ...runout]).score;
      const comparison = compareScores(ownScore, score);
      if (comparison !== 0) allSamplesTie = false;
      if (comparison < 0) beaten = true;
      if (comparison === 0) tied += 1;
    }
    if (!beaten) shares += 1 / tied;
  }
  // Sampling only gates this uncommon, exhaustive check. Certainty comes from
  // checking every possible unseen holding, not from observing 40 sampled ties.
  if (allSamplesTie && riverScore) {
    for (let first = 0; first < unseen.length - 1; first += 1) {
      for (let second = first + 1; second < unseen.length; second += 1) {
        const score = evaluateHoldem([unseen[first], unseen[second], ...board]).score;
        if (compareScores(riverScore, score) !== 0)
          return { equity: shares / EQUITY_TRIALS, forcedSplit: false };
      }
    }
    return { equity: shares / EQUITY_TRIALS, forcedSplit: true };
  }
  return { equity: shares / EQUITY_TRIALS, forcedSplit: false };
}

function streetAggression(room: RoomState) {
  let count = 0;
  for (let index = room.events.length - 1; index >= 0; index -= 1) {
    const entry = room.events[index];
    if (entry.revertedBy) continue;
    if (entry.type === 'HAND_STARTED' || entry.type === 'STREET_CONFIRMED') break;
    if (
      entry.type === 'PLAYER_ACTED' &&
      entry.street === room.hand!.street &&
      (entry.action === 'bet' || entry.action === 'raise' || entry.action === 'all-in')
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * A casual opponent: public pot odds, modest value bets, occasional bluffs, and
 * at most two aggressive actions in a street before it switches to call/fold.
 * The caller supplies only this bot's cards; no online secrets are accepted.
 */
export function chooseBotAction(
  room: RoomState,
  participantId: string,
  holeCards: string[],
  random: () => number = Math.random,
): BotAction {
  const legal = legalActions(room, participantId);
  const hand = room.hand;
  if (!legal || !hand) throw new PokerError('INVALID', '机器人当前无法行动');
  const player = hand.players.find((item) => item.participantId === participantId)!;
  const owner = room.participants.find((item) => item.id === participantId)!;
  const board = hand.communityCards ?? [];
  const known = [...holeCards, ...board];
  const expectedBoard = { PREFLOP: 0, FLOP: 3, TURN: 4, RIVER: 5, SHOWDOWN: 5 }[hand.street];
  if (
    holeCards.length !== 2 ||
    board.length !== expectedBoard ||
    new Set(known).size !== known.length ||
    known.some((card) => !FULL_DECK.includes(card))
  ) {
    throw new PokerError('INVALID', '机器人手牌或公共牌无效');
  }
  const opponents = hand.players.filter(
    (item) => !item.folded && item.participantId !== participantId,
  );
  if (opponents.length === 0) throw new PokerError('INVALID', '机器人没有对手');

  const { equity, forcedSplit } = estimateEquity(holeCards, board, opponents.length, random);
  if (forcedSplit) {
    return { type: 'act', action: legal.actions.includes('check') ? 'check' : 'call' };
  }
  const roll = randomUnit(random);
  const aggression = streetAggression(room);
  const pot = hand.players.reduce((sum, item) => sum + item.handCommitted, 0);
  // Exclude chips above this bot's maximum contribution from the pot-odds reward.
  const contestablePot = hand.players.reduce(
    (sum, item) => sum + Math.min(item.handCommitted, player.handCommitted + owner.stack),
    0,
  );
  const potOdds = legal.callPayable / Math.max(1, contestablePot + legal.callPayable);
  const stackExposure = legal.callPayable / Math.max(1, owner.stack);
  const pressure = Math.min(0.12, aggression * 0.025 + stackExposure * 0.06);
  const continueThreshold = potOdds + pressure;
  const valueThreshold = Math.min(0.66, 1 / (opponents.length + 1) + 0.18);
  const strong = equity > valueThreshold + 0.12;
  const canAggress = legal.actions.includes('bet') || legal.actions.includes('raise');
  const valueBet = equity >= valueThreshold && roll < (strong ? 0.94 : 0.7);
  const bluff =
    opponents.length <= 2 &&
    aggression === 0 &&
    stackExposure < 0.08 &&
    roll < (legal.callNeeded === 0 ? 0.05 : 0.02);

  if (legal.callNeeded > 0 && equity < continueThreshold && !bluff) {
    return { type: 'act', action: 'fold' };
  }

  if (canAggress && aggression < 2 && (valueBet || bluff)) {
    const unit = room.config.chipUnit;
    const minimum = legal.minBetTo ?? legal.minRaiseTo!;
    const raw =
      hand.street === 'PREFLOP'
        ? hand.currentBet <= hand.bigBlind
          ? hand.bigBlind * 2.5
          : hand.currentBet * 2.5
        : hand.currentBet === 0
          ? pot * (strong ? 2 / 3 : 1 / 2)
          : Math.max(hand.currentBet * 2.25, pot * (strong ? 3 / 4 : 1 / 2));
    const target = Math.min(legal.maxTo, Math.max(minimum, Math.ceil(raw / unit) * unit));
    // A tiny stack may require a legal short all-in; deeper stacks are never
    // shoved merely because a suggested size would consume most of the stack.
    const allIn = target === legal.maxTo;
    if (!allIn || equity >= Math.max(continueThreshold + 0.12, valueThreshold)) {
      if (allIn && legal.actions.includes('all-in')) return { type: 'act', action: 'all-in' };
      if (!allIn) {
        return { type: 'act', action: hand.currentBet === 0 ? 'bet' : 'raise', to: target };
      }
    }
  }
  return { type: 'act', action: legal.actions.includes('check') ? 'check' : 'call' };
}
