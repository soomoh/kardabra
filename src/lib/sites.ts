/**
 * Where Kardabra lives. Three sites, three origins (browser storage is per
 * origin, so none can read another's data): the website, the app, and a
 * demo that holds only the sample card. One build serves the app and the
 * demo; `VITE_DEMO=1` at build time makes it the demo.
 */
export const APP_URL = 'https://my.kardabra.app/';
export const DEMO_URL = 'https://demo.kardabra.app/';
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';
