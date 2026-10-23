import { useEffect } from 'react';

// Avalon uses a scrolling page rather than Poker's fixed table. Keep that layout,
// but avoid covering notes/forms with the fixed navigation when the keyboard opens.
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const resize = () => {
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
      const keyboardOpen = Boolean(
        editing && viewport && window.innerHeight - viewport.height > 100,
      );
      document.documentElement.classList.toggle('keyboard-open', keyboardOpen);
      if (keyboardOpen && viewport) {
        document.documentElement.style.setProperty('--visible-height', `${viewport.height}px`);
        document.documentElement.style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
      } else {
        document.documentElement.style.removeProperty('--visible-height');
        document.documentElement.style.removeProperty('--viewport-top');
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    };
    resize();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      document.documentElement.classList.remove('keyboard-open');
      document.documentElement.style.removeProperty('--visible-height');
      document.documentElement.style.removeProperty('--viewport-top');
    };
  }, []);
}
