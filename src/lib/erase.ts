/** After "Erase everything", every open Kardabra tab starts over: a tab
 * still holding cards in memory could otherwise show them, or write them
 * back (a pending import, a "Mark paid"). BroadcastChannel stays inside
 * this browser, like everything else. */
const CHANNEL = 'kardabra-erase';

/** Land on the empty dashboard with nothing left in memory. */
export function startOver(): void {
  window.history.replaceState(null, '', '#/');
  window.location.reload();
}

export function announceErased(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage('erased');
  channel.close();
}

/** Start over when another tab erases. Returns the unsubscribe. */
export function followErasesElsewhere(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    if (event.data === 'erased') startOver();
  };
  return () => channel.close();
}
