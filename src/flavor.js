// UI flavors: how controls, panels and the calendar look (see src/flavors/
// and the UI flavors in index.css), chosen in Settings and kept on the
// server (see server/UiManager.js)
export const FLAVORS = [
  { name: 'glass', label: 'Glass' },
  { name: 'default', label: 'Default' },
];
export const DEFAULT_FLAVOR = 'glass';

// Shows the page in `flavor`, by its class on the page (flavor-<name>)
export function applyFlavor(flavor) {
  const root = document.documentElement;
  FLAVORS.forEach(({ name }) => root.classList.toggle(`flavor-${name}`, name === flavor));
}
