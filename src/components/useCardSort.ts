import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export function movePlayer(order: string[], id: string, targetId: string): string[] {
  const from = order.indexOf(id),
    to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function useCardSort(
  order: string[] | null,
  disabled: boolean,
  onChange: (ids: string[]) => void,
) {
  const [dragging, setDragging] = useState<string | null>(null);
  const latest = useRef({ order, disabled, onChange });
  latest.current = { order, disabled, onChange };
  const drag = useRef<{
    id: string;
    pointerId: number;
    original: string[];
    x: number;
    y: number;
    grid: HTMLElement;
  } | null>(null);
  const members = [...(order ?? [])].sort().join(',');
  useEffect(() => {
    drag.current = null;
    setDragging(null);
  }, [members, order !== null]);
  useEffect(() => {
    let frame = 0;
    const moveAtPointer = () => {
      const current = drag.current;
      if (!current || !latest.current.order || latest.current.disabled) return;
      const target = document
        .elementFromPoint(current.x, current.y)
        ?.closest<HTMLElement>('[data-player-id]');
      if (!target || !current.grid.contains(target)) return;
      const next = movePlayer(latest.current.order, current.id, target.dataset.playerId!);
      if (next !== latest.current.order) {
        latest.current.order = next;
        latest.current.onChange(next);
      }
    };
    const scroll = () => {
      const current = drag.current;
      if (!current) {
        frame = 0;
        return;
      }
      const direction = current.y < 85 ? -1 : current.y > window.innerHeight - 105 ? 1 : 0;
      if (direction) {
        window.scrollBy(0, direction * 8);
        moveAtPointer();
      }
      frame = requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent) => {
      if (!drag.current || event.pointerId !== drag.current.pointerId) return;
      event.preventDefault();
      drag.current.x = event.clientX;
      drag.current.y = event.clientY;
      moveAtPointer();
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const end = (event: PointerEvent) => {
      if (!drag.current || event.pointerId !== drag.current.pointerId) return;
      if (event.type === 'pointercancel') latest.current.onChange(drag.current.original);
      drag.current = null;
      setDragging(null);
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const cancel = () => {
      if (drag.current) latest.current.onChange(drag.current.original);
      drag.current = null;
      setDragging(null);
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      drag.current = null;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  const begin = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (!order || disabled || event.button !== 0 || !event.isPrimary || drag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id,
      pointerId: event.pointerId,
      original: [...order],
      x: event.clientX,
      y: event.clientY,
      grid: event.currentTarget.parentElement!,
    };
    setDragging(id);
  };
  return { dragging, begin };
}
