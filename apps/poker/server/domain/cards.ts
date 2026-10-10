import { randomInt } from 'node:crypto';
import type { HandState } from '../../shared/types.js';

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';

export interface OnlineHandSecrets {
  handId: string;
  deck: string[];
  holeCards: Record<string, string[]>;
}

export interface EvaluatedHand {
  score: number[];
  label: string;
}

export function createOnlineDeal(hand: HandState): OnlineHandSecrets {
  const deck = [...SUITS].flatMap((suit) => [...RANKS].map((rank) => `${rank}${suit}`));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  const seats = [...hand.players].sort((left, right) => left.seat - right.seat);
  const buttonIndex = seats.findIndex((item) => item.participantId === hand.buttonId);
  const order = [...seats.slice(buttonIndex + 1), ...seats.slice(0, buttonIndex + 1)];
  const holeCards = Object.fromEntries(order.map((item) => [item.participantId, [] as string[]]));
  for (let round = 0; round < 2; round += 1) {
    for (const player of order) holeCards[player.participantId].push(deck.shift()!);
  }
  return { handId: hand.id, deck, holeCards };
}

export function dealBoardStreet(deck: string[], street: HandState['street']) {
  if (street === 'RIVER' || street === 'SHOWDOWN') return [];
  deck.shift();
  return deck.splice(0, street === 'PREFLOP' ? 3 : 1);
}

export function completeBoard(deck: string[], street: HandState['street']) {
  const cards: string[] = [];
  let current = street;
  while (current !== 'RIVER' && current !== 'SHOWDOWN') {
    cards.push(...dealBoardStreet(deck, current));
    current = current === 'PREFLOP' ? 'FLOP' : current === 'FLOP' ? 'TURN' : 'RIVER';
  }
  return cards;
}

function fiveCardScore(cards: string[]): EvaluatedHand {
  const values = cards.map((card) => RANKS.indexOf(card[0]) + 2).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts.entries()].sort(
    ([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || rightValue - leftValue,
  );
  const unique = [...new Set(values)];
  if (unique[0] === 14) unique.push(1);
  let straightHigh = 0;
  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique[index] - unique[index + 4] === 4) {
      straightHigh = unique[index];
      break;
    }
  }
  const flush = cards.every((card) => card[1] === cards[0][1]);
  if (flush && straightHigh)
    return {
      score: [8, straightHigh],
      label: straightHigh === 14 ? '皇家同花顺' : '同花顺',
    };
  if (groups[0][1] === 4) return { score: [7, groups[0][0], groups[1][0]], label: '四条' };
  if (groups[0][1] === 3 && groups[1][1] === 2)
    return { score: [6, groups[0][0], groups[1][0]], label: '葫芦' };
  if (flush) return { score: [5, ...values], label: '同花' };
  if (straightHigh) return { score: [4, straightHigh], label: '顺子' };
  if (groups[0][1] === 3)
    return {
      score: [
        3,
        groups[0][0],
        ...groups
          .slice(1)
          .map(([value]) => value)
          .sort((a, b) => b - a),
      ],
      label: '三条',
    };
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    return { score: [2, ...pairs, groups[2][0]], label: '两对' };
  }
  if (groups[0][1] === 2)
    return {
      score: [
        1,
        groups[0][0],
        ...groups
          .slice(1)
          .map(([value]) => value)
          .sort((a, b) => b - a),
      ],
      label: '一对',
    };
  return { score: [0, ...values], label: '高牌' };
}

export function compareScores(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validCards(cards: string[]) {
  return (
    new Set(cards).size === cards.length &&
    cards.every((card) => card.length === 2 && RANKS.includes(card[0]) && SUITS.includes(card[1]))
  );
}

function bestFiveCards(cards: string[]): EvaluatedHand {
  let best: EvaluatedHand | null = null;
  for (let first = 0; first < cards.length - 4; first += 1)
    for (let second = first + 1; second < cards.length - 3; second += 1)
      for (let third = second + 1; third < cards.length - 2; third += 1)
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1)
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            const result = fiveCardScore([
              cards[first],
              cards[second],
              cards[third],
              cards[fourth],
              cards[fifth],
            ]);
            if (!best || compareScores(result.score, best.score) > 0) best = result;
          }
  return best!;
}

export function evaluateHoldem(cards: string[]): EvaluatedHand {
  if (cards.length !== 7 || !validCards(cards)) throw new Error('Invalid Holdem cards');
  return bestFiveCards(cards);
}

// Describe only the cards already available at the table; never complete a future board.
export function madeHandLabel(holeCards: string[], communityCards: string[]): string {
  const cards = [...holeCards, ...communityCards];
  if (holeCards.length !== 2 || ![0, 3, 4, 5].includes(communityCards.length) || !validCards(cards))
    throw new Error('Invalid visible Holdem cards');
  if (communityCards.length === 0) return holeCards[0][0] === holeCards[1][0] ? '一对' : '高牌';
  return bestFiveCards(cards).label;
}
