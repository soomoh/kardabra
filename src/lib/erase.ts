/** After "Erase everything" or a restore, every other open Kardabra tab
 * starts over: a tab still holding the old cards in memory could otherwise
 * show them, or write them back (a pending import, a "Mark paid").
 * BroadcastChannel stays inside this browser, like everything else. */
const CHANNEL = 'kardabra-erase';

/** One channel per tab, for sending and listening: a BroadcastChannel
 * never receives its own messages, so the tab that erased or restored
 * isn't sent back to the start. */
let shared: BroadcastChannel | null = null;
function channel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  shared ??= new BroadcastChannel(CHANNEL);
  return shared;
}

/** Land on the dashboard with nothing left in memory. */
export function startOver(): void {
  window.history.replaceState(null, '', '#/');
  window.location.reload();
}

export function announceDataReplaced(): void {
  channel()?.postMessage('replaced');
}

/** Start over when another tab erases or restores. Returns the
 * unsubscribe. */
export function followDataReplacedElsewhere(): () => void {
  const ch = channel();
  if (ch === null) return () => {};
  ch.onmessage = (event) => {
    if (event.data === 'replaced') startOver();
  };
  return () => {
    ch.onmessage = null;
  };
}
