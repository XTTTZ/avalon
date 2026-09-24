import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function NumberStepper({
  label,
  value,
  min,
  max,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing || (draft !== '' && Number(draft) !== value)) setDraft(String(value));
  }, [draft, editing, value]);

  const commit = () => {
    const parsed = draft === '' ? value : Number(draft);
    const next = clamp(Number.isSafeInteger(parsed) ? parsed : value, min, max);
    setDraft(String(next));
    setEditing(false);
    if (next !== value) onChange(next);
  };
  const step = (amount: number) => {
    const parsed = draft === '' ? value : Number(draft);
    const next = clamp((Number.isSafeInteger(parsed) ? parsed : value) + amount, min, max);
    setDraft(String(next));
    setEditing(false);
    if (next !== value) onChange(next);
  };
  const displayed = draft === '' ? value : Number(draft);

  return (
    <div className={`number-stepper${disabled ? ' disabled' : ''}`}>
      <button
        type="button"
        aria-label={`减少${label}`}
        disabled={disabled || displayed <= min}
        onClick={() => step(-1)}
      >
        <Minus size={18} />
      </button>
      <input
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        role="spinbutton"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        disabled={disabled}
        value={draft}
        onFocus={(event) => {
          setEditing(true);
          event.currentTarget.select();
        }}
        onChange={(event) => {
          const raw = event.target.value;
          if (!/^\d*$/.test(raw)) return;
          setDraft(raw);
          if (raw !== '') onChange(Number(raw));
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            step(-1);
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            step(1);
          }
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      <button
        type="button"
        aria-label={`增加${label}`}
        disabled={disabled || displayed >= max}
        onClick={() => step(1)}
      >
        <Plus size={18} />
      </button>
    </div>
  );
}
