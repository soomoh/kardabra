/**
 * Ask the browser not to clear Kardabra's storage when the disk runs low
 * (and Safari not to after a week unused). Called once there is data worth
 * keeping (an import, a restore), not on first load: Firefox asks the user,
 * and a prompt before anything is stored makes no sense. Chrome decides
 * silently (an installed app is granted). Already granted: nothing to ask.
 * A refusal changes nothing else; backups remain the guarantee.
 */
export function keepStorage(): void {
  const storage = navigator.storage;
  if (!storage?.persist || !storage.persisted) return;
  storage
    .persisted()
    .then((kept) => (kept ? undefined : storage.persist()))
    .catch(() => {});
}
