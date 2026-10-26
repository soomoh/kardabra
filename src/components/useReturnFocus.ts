import { useEffect, useRef } from 'react';

/** Closing an inline editor unmounts the control that had focus; this
 * hands focus back to the button that opened it. Returns a ref for that
 * button. Fires only on an open → closed change, never on first render.
 *
 * An editor that closes on Enter must `preventDefault` that keydown: the
 * browser would otherwise deliver the same Enter to the button focus just
 * returned to, "clicking" it and reopening the editor. */
export function useReturnFocus<T extends HTMLElement>(open: boolean) {
  const opener = useRef<T>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      // Only when focus was lost with the editor (it sat on a control that
      // unmounted); if the user moved it elsewhere, leave it there.
      const active = document.activeElement;
      if (active === null || active === document.body) opener.current?.focus();
    }
  }, [open]);
  return opener;
}
