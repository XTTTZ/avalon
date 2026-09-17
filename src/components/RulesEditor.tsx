import { useState } from 'react';
import type { GameConfig, Role } from '../../shared/types';
import { ROLE_META, standardConfig, validateConfig } from '../../shared/rules';

const editableRoles: Role[] = [
  'merlin',
  'percival',
  'assassin',
  'morgana',
  'mordred',
  'oberon',
  'loyalist',
  'minion',
];

export function RulesEditor({
  initial,
  onSave,
  busy,
  onCancel,
}: {
  initial: GameConfig;
  onSave: (config: GameConfig) => Promise<void>;
  busy: boolean;
  onCancel: () => void;
}) {
  const [config, setConfig] = useState<GameConfig>(
    () => JSON.parse(JSON.stringify(initial)) as GameConfig,
  );
  const [error, setError] = useState('');
  const custom = config.preset === 'custom';
  const change = (patch: Partial<GameConfig>) => {
    setError('');
    setConfig((value) => ({ ...value, ...patch }));
  };
  const setRoleCount = (role: Role, count: number) =>
    change({
      roles: [
        ...config.roles.filter((r) => r !== role),
        ...Array.from({ length: Math.max(0, Math.min(12, count)) }, () => role),
      ],
    });
  const setLancelot = (mode: GameConfig['lancelot']) => {
    if (mode !== 'off' && config.lancelot !== 'off') {
      change({ lancelot: mode });
      return;
    }
    const roles: Role[] = config.roles.filter(
      (r) => r !== 'lancelot_good' && r !== 'lancelot_evil',
    );
    if (mode !== 'off') {
      const good = roles.lastIndexOf('loyalist');
      if (good >= 0) roles.splice(good, 1);
      const evil = roles.lastIndexOf('minion');
      if (evil >= 0) roles.splice(evil, 1);
      roles.push('lancelot_good', 'lancelot_evil');
    } else if (config.lancelot !== 'off') {
      roles.push('loyalist', 'minion');
    }
    change({ lancelot: mode, roles });
  };
  const save = async () => {
    try {
      validateConfig(config);
      await onSave(config);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请检查规则配置');
    }
  };
  const evilRoles = config.roles.filter((r) => ROLE_META[r].alignment === 'evil').length;
  return (
    <div className="rules-editor">
      <label className="field">
        游戏人数
        <select
          value={config.playerCount}
          onChange={(e) => setConfig(standardConfig(Number(e.target.value)))}
        >
          {Array.from({ length: 8 }, (_, i) => i + 5).map((n) => (
            <option key={n} value={n}>
              {n} 人{n > 10 ? ' · 自定义扩展' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="segmented" aria-label="规则模式">
        <button
          className={!custom ? 'selected' : ''}
          disabled={config.playerCount > 10}
          onClick={() => setConfig(standardConfig(config.playerCount))}
        >
          标准规则
        </button>
        <button className={custom ? 'selected' : ''} onClick={() => change({ preset: 'custom' })}>
          自定义规则
        </button>
      </div>
      <p className="muted small">
        {custom ? '自定义规则；11–12 人为扩展玩法。' : '标准人数、五轮任务，连续五次拒绝则坏人胜。'}
      </p>
      {custom && (
        <div className="form-grid">
          <label className="field">
            坏人人数
            <input
              type="number"
              min={1}
              max={Math.floor((config.playerCount - 1) / 2)}
              value={config.evilCount}
              onChange={(e) => change({ evilCount: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            好人人数
            <input readOnly value={config.playerCount - config.evilCount} />
          </label>
          <label className="field">
            获胜所需任务数
            <input
              type="number"
              min={2}
              max={Math.floor((config.quests.length + 1) / 2)}
              value={config.winsRequired}
              onChange={(e) => change({ winsRequired: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            连续拒绝上限
            <input
              type="number"
              min={1}
              max={10}
              value={config.rejectionLimit}
              onChange={(e) => change({ rejectionLimit: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      <div className="subheading">
        <h3>角色配置</h3>
        <span
          className={
            config.roles.length !== config.playerCount || evilRoles !== config.evilCount
              ? 'text-warning small'
              : 'muted small'
          }
        >
          {config.roles.length}/{config.playerCount} 人 · 好 {config.roles.length - evilRoles} / 坏{' '}
          {evilRoles}
        </span>
      </div>
      <div className="role-editor">
        {editableRoles.map((role) => (
          <label className="role-row" key={role}>
            <span>
              <strong>{ROLE_META[role].name}</strong>
              <small>{ROLE_META[role].alignment === 'good' ? '好人' : '坏人'}</small>
            </span>
            <input
              aria-label={`${ROLE_META[role].name}人数`}
              type="number"
              min={0}
              max={role === 'loyalist' || role === 'minion' ? 12 : 1}
              value={config.roles.filter((r) => r === role).length}
              onChange={(e) => setRoleCount(role, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
      <label className="toggle-row">
        <span>
          <strong>湖中仙女</strong>
          <small>第 2、3、4 轮结束后，查看一名玩家的当前阵营</small>
        </span>
        <input
          type="checkbox"
          checked={config.lady}
          onChange={(e) => change({ lady: e.target.checked })}
        />
      </label>
      <label className="field">
        兰斯洛特扩展
        <select
          value={config.lancelot}
          onChange={(e) => setLancelot(e.target.value as GameConfig['lancelot'])}
        >
          <option value="off">不启用</option>
          <option value="fixed">一好一坏 · 阵营固定</option>
          <option value="changing">一好一坏 · 阵营可变化</option>
        </select>
      </label>
      {config.lancelot !== 'off' && (
        <p className="notice small">
          成对加入，替换忠臣和爪牙。变化模式从第 3 轮起抽牌，可能交换阵营。本应用扩展。
        </p>
      )}
      <div className="subheading">
        <h3>任务安排</h3>
        {custom && (
          <label className="inline-field">
            轮数
            <select
              aria-label="任务总轮数"
              value={config.quests.length}
              onChange={(e) => {
                const count = Number(e.target.value);
                change({
                  quests: Array.from(
                    { length: count },
                    (_, i) =>
                      config.quests[i] ?? {
                        size: Math.min(config.playerCount, 5),
                        failsRequired: 1,
                      },
                  ),
                });
              }}
            >
              {[3, 4, 5, 6, 7, 8, 9].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="quest-editor">
        <div className="quest-editor-head">
          <span>任务</span>
          <span>出任务人数</span>
          <span>失败票门槛</span>
        </div>
        {config.quests.map((quest, index) => (
          <div className="quest-editor-row" key={index}>
            <span>第 {index + 1} 轮</span>
            <input
              aria-label={`第${index + 1}轮人数`}
              type="number"
              disabled={!custom}
              min={1}
              max={config.playerCount}
              value={quest.size}
              onChange={(e) =>
                change({
                  quests: config.quests.map((q, i) =>
                    i === index ? { ...q, size: Number(e.target.value) } : q,
                  ),
                })
              }
            />
            <input
              aria-label={`第${index + 1}轮失败票门槛`}
              type="number"
              disabled={!custom}
              min={1}
              max={Math.min(quest.size, config.evilCount)}
              value={quest.failsRequired}
              onChange={(e) =>
                change({
                  quests: config.quests.map((q, i) =>
                    i === index ? { ...q, failsRequired: Number(e.target.value) } : q,
                  ),
                })
              }
            />
          </div>
        ))}
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <div className="sticky-modal-actions">
        <button className="button secondary" onClick={onCancel}>
          取消
        </button>
        <button className="button primary" onClick={() => void save()} disabled={busy}>
          保存规则
        </button>
      </div>
    </div>
  );
}

export function RulesSummary({ config }: { config: GameConfig }) {
  return (
    <div className="rules-summary">
      <div className="faction-summary">
        {(['good', 'evil'] as const).map((alignment) => {
          const roles = config.roles.filter((role) => ROLE_META[role].alignment === alignment);
          return (
            <div className={`faction-group ${alignment}`} key={alignment}>
              <h3 className="faction-heading">
                <i className={`dot ${alignment}`} />
                {alignment === 'good' ? '好人' : '坏人'} {roles.length} 人
              </h3>
              <p className="faction-roles">
                {Array.from(new Set(roles))
                  .map((role) => {
                    const count = roles.filter((r) => r === role).length;
                    return `${ROLE_META[role].name}${count > 1 ? ` ×${count}` : ''}`;
                  })
                  .join('、')}
              </p>
            </div>
          );
        })}
      </div>
      <div className="stat-pair">
        <span>胜利任务数</span>
        <strong>{config.winsRequired} 次</strong>
      </div>
      <div className="stat-pair">
        <span>连续拒绝上限</span>
        <strong>{config.rejectionLimit} 次</strong>
      </div>
      {(config.lady || config.lancelot !== 'off') && (
        <p className="muted small">
          {[
            config.lady && '湖中仙女',
            config.lancelot === 'changing' && '兰斯洛特：阵营变化',
            config.lancelot === 'fixed' && '兰斯洛特：固定阵营',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  );
}
