import { GameError, type Alignment, type GameConfig, type Role } from './types';

export const ROLE_META: Record<Role, { name: string; alignment: Alignment; description: string }> =
  {
    merlin: {
      name: '梅林',
      alignment: 'good',
      description: '知道开局邪恶玩家（莫德雷德除外）。帮助好人完成任务，同时避免被刺客认出。',
    },
    percival: {
      name: '派西维尔',
      alignment: 'good',
      description: '看到梅林与莫甘娜的候选人，但不知道谁是梅林。',
    },
    assassin: {
      name: '刺客',
      alignment: 'evil',
      description: '与其他知情邪恶互认；好人完成获胜任务数后，可刺杀一名玩家，命中梅林则邪恶获胜。',
    },
    morgana: {
      name: '莫甘娜',
      alignment: 'evil',
      description: '与其他知情邪恶互认；在派西维尔眼中与梅林无法区分。',
    },
    mordred: {
      name: '莫德雷德',
      alignment: 'evil',
      description: '与其他知情邪恶互认；梅林无法看到你。',
    },
    oberon: {
      name: '奥伯伦',
      alignment: 'evil',
      description: '不认识其他邪恶，其他邪恶也不认识你；梅林仍能看到你。',
    },
    loyalist: {
      name: '忠臣',
      alignment: 'good',
      description: '没有开局身份线索。观察讨论与投票，帮助任务成功。',
    },
    minion: {
      name: '爪牙',
      alignment: 'evil',
      description: '与其他知情邪恶互认，可以秘密破坏任务。',
    },
    lancelot_good: {
      name: '正义兰斯洛特',
      alignment: 'good',
      description:
        '本应用扩展：知道另一位兰斯洛特。若开启阵营变化，从第三轮开始按公开抽牌交换当前阵营。以当前阵营决定任务票与胜负。',
    },
    lancelot_evil: {
      name: '邪恶兰斯洛特',
      alignment: 'evil',
      description:
        '本应用扩展：只知道另一位兰斯洛特，不与其他邪恶互认。若开启变化，则按抽牌交换当前阵营；当前为邪恶时可投成功或失败。',
    },
  };

export const STANDARD_QUEST_SIZES: Readonly<Record<number, readonly number[]>> = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};
export const STANDARD_EVIL_COUNTS: Readonly<Record<number, number>> = {
  5: 2,
  6: 2,
  7: 3,
  8: 3,
  9: 3,
  10: 4,
};

/** Common Chinese reference setup. The rulebook fixes team counts, while these roles are recommended. */
export const STANDARD_ROLES: Readonly<Partial<Record<number, readonly Role[]>>> = {
  5: ['merlin', 'percival', 'loyalist', 'morgana', 'assassin'],
  6: ['merlin', 'percival', 'loyalist', 'loyalist', 'morgana', 'assassin'],
  7: ['merlin', 'percival', 'loyalist', 'loyalist', 'morgana', 'assassin', 'oberon'],
  8: ['merlin', 'percival', 'loyalist', 'loyalist', 'loyalist', 'morgana', 'assassin', 'minion'],
  9: [
    'merlin',
    'percival',
    'loyalist',
    'loyalist',
    'loyalist',
    'loyalist',
    'morgana',
    'assassin',
    'mordred',
  ],
  10: [
    'merlin',
    'percival',
    'loyalist',
    'loyalist',
    'loyalist',
    'loyalist',
    'morgana',
    'assassin',
    'oberon',
    'mordred',
  ],
};

/** 11–12 are deliberately labelled custom; their tables are this app's house defaults. */
export function standardConfig(playerCount: number): GameConfig {
  integer(playerCount, 5, 12, '玩家人数');
  const evilCount = STANDARD_EVIL_COUNTS[playerCount] ?? 4;
  const defaultRoles = STANDARD_ROLES[playerCount];
  const roles: Role[] = defaultRoles
    ? [...defaultRoles]
    : [
        'merlin',
        'percival',
        ...Array<Role>(playerCount - evilCount - 2).fill('loyalist'),
        'morgana',
        'assassin',
        'mordred',
        'oberon',
      ];
  return {
    preset: playerCount <= 10 ? 'standard' : 'custom',
    playerCount,
    evilCount,
    roles,
    quests: (STANDARD_QUEST_SIZES[playerCount] ?? [3, 4, 5, 6, 6]).map((size, i) => ({
      size,
      failsRequired: playerCount >= 7 && i === 3 ? 2 : 1,
    })),
    winsRequired: 3,
    rejectionLimit: 5,
    lady: false,
    lancelot: 'off',
  };
}

function invalid(message: string): never {
  throw new GameError('INVALID', message);
}
function integer(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(`${label}须为 ${min}–${max} 的整数`);
}

/** Runtime validation: never trust the TypeScript type of a network payload. */
export function validateConfig(input: GameConfig): GameConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('规则配置格式错误');
  if (input.preset !== 'standard' && input.preset !== 'custom') invalid('未知规则预设');
  integer(input.playerCount, 5, 12, '玩家人数');
  integer(input.evilCount, 1, Math.floor((input.playerCount - 1) / 2), '邪恶人数');
  if (typeof input.lady !== 'boolean') invalid('湖中仙女开关格式错误');
  if (!['off', 'fixed', 'changing'].includes(input.lancelot)) invalid('兰斯洛特模式错误');
  if (!Array.isArray(input.roles) || input.roles.length !== input.playerCount)
    invalid('角色总数必须等于玩家人数');
  const counts = new Map<Role, number>();
  for (const role of input.roles) {
    if (typeof role !== 'string' || !Object.hasOwn(ROLE_META, role)) invalid('存在未知角色');
    counts.set(role, (counts.get(role) ?? 0) + 1);
    if (role !== 'loyalist' && role !== 'minion' && counts.get(role)! > 1)
      invalid('特殊角色不可重复');
  }
  if (input.roles.filter((role) => ROLE_META[role].alignment === 'evil').length !== input.evilCount)
    invalid('角色阵营数量与邪恶人数不一致');
  if ((counts.get('merlin') ?? 0) !== (counts.get('assassin') ?? 0))
    invalid('梅林和刺客必须成对启用');
  if (counts.has('percival') && !counts.has('merlin')) invalid('启用派西维尔时必须有梅林');
  const hasPair = counts.get('lancelot_good') === 1 && counts.get('lancelot_evil') === 1;
  if (
    input.lancelot === 'off' ? counts.has('lancelot_good') || counts.has('lancelot_evil') : !hasPair
  )
    invalid('兰斯洛特必须一善一恶成对配置，且模式一致');
  if (!Array.isArray(input.quests) || input.quests.length < 3 || input.quests.length > 9)
    invalid('任务总轮数须为 3–9');
  for (const quest of input.quests) {
    if (!quest || typeof quest !== 'object' || Array.isArray(quest)) invalid('任务配置格式错误');
    integer(quest.size, 1, input.playerCount, '任务人数');
    integer(quest.failsRequired, 1, Math.min(quest.size, input.evilCount), '失败票门槛');
  }
  // A common threshold w guarantees resolution within 2w−1 missions. Any later
  // configured rounds are unused. Do not accept a configuration that can tie.
  integer(input.winsRequired, 2, Math.floor((input.quests.length + 1) / 2), '获胜任务数');
  integer(input.rejectionLimit, 1, 10, '连续拒绝上限');
  if (input.preset === 'standard') {
    if (input.playerCount > 10) invalid('11–12 人只能使用自定义扩展');
    const standard = standardConfig(input.playerCount);
    if (
      input.evilCount !== standard.evilCount ||
      input.winsRequired !== 3 ||
      input.rejectionLimit !== 5 ||
      input.quests.length !== 5 ||
      input.quests.some(
        (q, i) =>
          q.size !== standard.quests[i].size ||
          q.failsRequired !== standard.quests[i].failsRequired,
      )
    )
      invalid('标准规则的阵营比例、任务表、胜利数与拒绝上限不可修改；请切换自定义');
    if (!counts.has('merlin') || !counts.has('assassin')) invalid('标准规则必须有梅林和刺客');
  }
  // Whitelist properties so extra input never persists into public state.
  return {
    preset: input.preset,
    playerCount: input.playerCount,
    evilCount: input.evilCount,
    roles: [...input.roles],
    quests: input.quests.map((q) => ({ size: q.size, failsRequired: q.failsRequired })),
    winsRequired: input.winsRequired,
    rejectionLimit: input.rejectionLimit,
    lady: input.lady,
    lancelot: input.lancelot,
  };
}

export const LANCELOT_RULES =
  '本应用扩展：两位兰斯洛特互认，均不参与其他邪恶互认；梅林只看到开局邪恶兰斯洛特。开局线索之后不更新。变化牌组含 3 张不变、2 张交换；第三轮起每轮开始公开抽一张，抽完后重洗。交换当前阵营，角色名不变；当前善只能投成功，当前恶可投成功或失败。湖中仙女查验当前阵营。';
