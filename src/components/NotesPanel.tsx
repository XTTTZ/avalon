import { useEffect, useState } from 'react';
import { LockKeyhole, Save } from 'lucide-react';
import type {
  Alignment,
  DepartedPlayer,
  Notes,
  PlayerNote,
  PublicPlayer,
  Role,
} from '../../shared/types';
import { ROLE_META } from '../../shared/rules';
import { playerInitial } from '../player-names';

const blankNote = (): PlayerNote => ({
  nickname: '',
  roleGuess: '',
  alignmentGuess: 'unknown',
  text: '',
});
export function NotesPanel({
  players,
  departedPlayers = [],
  selfId,
  notes,
  revision,
  roomCode,
  busy,
  save,
}: {
  players: PublicPlayer[];
  departedPlayers?: DepartedPlayer[];
  selfId: string;
  notes: Notes;
  revision: number;
  roomCode: string;
  busy: boolean;
  save: (notes: Notes) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Notes>(notes);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(players.find((p) => p.id !== selfId)?.id ?? selfId);
  useEffect(() => {
    if (!dirty) setDraft(notes);
  }, [notes, revision, dirty]);
  useEffect(() => {
    setDraft(notes);
    setDirty(false);
    setSaved(false);
  }, [roomCode]);
  useEffect(() => {
    if (selected === selfId || !players.some((p) => p.id === selected))
      setSelected(players.find((p) => p.id !== selfId)?.id ?? selfId);
  }, [players, selected, selfId]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const note = draft[selected] ?? blankNote();
  const displayName = (id: string) =>
    draft[id]?.nickname.trim() || players.find((player) => player.id === id)?.name || '玩家';
  const patch = (value: Partial<PlayerNote>) => {
    setDraft((current) => ({
      ...current,
      [selected]: { ...(current[selected] ?? blankNote()), ...value },
    }));
    setDirty(true);
    setSaved(false);
    setError('');
  };
  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await save(
        Object.fromEntries(
          Object.entries(draft).filter(([id]) => players.some((player) => player.id === id)),
        ),
      );
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };
  if (!players.some((player) => player.id !== selfId)) {
    return (
      <div className="card empty-state locked-state">
        <LockKeyhole size={36} />
        <h2>等待其他玩家加入</h2>
        <p>朋友加入后可以记录笔记</p>
      </div>
    );
  }
  return (
    <div className="notes-page">
      <div className="section-heading">
        <div>
          <h2>私人笔记</h2>
        </div>
        <span className="pill">
          <LockKeyhole size={12} />
          仅你可见
        </span>
      </div>
      <div className="notes-layout">
        <div className="notes-player-list" aria-label="选择笔记玩家">
          {players
            .filter((p) => p.id !== selfId)
            .map((player) => (
              <button
                className={`notes-player ${selected === player.id ? 'selected' : ''}`}
                key={player.id}
                onClick={() => setSelected(player.id)}
              >
                <span className="avatar mini">
                  <span className="avatar-letter">{playerInitial(displayName(player.id))}</span>
                </span>
                <span>
                  {displayName(player.id)}
                  <small>
                    {departedPlayers.find((departed) => departed.id === player.id)?.departure ===
                    'left'
                      ? '已离开'
                      : departedPlayers.some((departed) => departed.id === player.id)
                        ? '已移除'
                        : `${player.seat + 1} 号`}
                  </small>
                </span>
                {draft[player.id]?.text && <i className="note-dot" />}
              </button>
            ))}
        </div>
        <div className="card note-editor">
          <div className="subheading">
            <h3>{displayName(selected)}</h3>
            <span className="small muted">{dirty ? '未保存' : saved ? '已保存' : ''}</span>
          </div>
          <label className="field">
            私人昵称
            <input
              value={note.nickname}
              maxLength={24}
              placeholder="昵称"
              onChange={(e) => patch({ nickname: e.target.value })}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              阵营猜测
              <select
                value={note.alignmentGuess}
                onChange={(e) => patch({ alignmentGuess: e.target.value as Alignment | 'unknown' })}
              >
                <option value="unknown">不确定</option>
                <option value="good">好人</option>
                <option value="evil">坏人</option>
              </select>
            </label>
            <label className="field">
              身份猜测
              <select
                value={note.roleGuess}
                onChange={(e) => patch({ roleGuess: e.target.value as Role | '' })}
              >
                <option value="">不确定</option>
                {Object.entries(ROLE_META).map(([role, meta]) => (
                  <option key={role} value={role}>
                    {meta.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            推理笔记
            <textarea
              value={note.text}
              maxLength={1000}
              rows={4}
              placeholder="备注"
              onChange={(e) => patch({ text: e.target.value })}
            />
          </label>
          <p className="small muted">{note.text.length}/1000</p>
          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary full"
            disabled={busy || saving || !dirty}
            onClick={() => void submit()}
          >
            <Save size={16} />
            {saving ? '正在保存…' : '保存私人笔记'}
          </button>
        </div>
      </div>
    </div>
  );
}
