import { useEffect } from 'react';

/** Sets the browser tab title for the current view ("Import · Kardabra"),
 * so tabs, history and screen readers name the page. `null` while the
 * view's data is still loading leaves the title as it was. */
export function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (title !== null) document.title = `${title} · Kardabra`;
  }, [title]);
}
