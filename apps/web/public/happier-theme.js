/* global matchMedia, localStorage, document, addEventListener */
// Shared presentation only; reads the existing non-sensitive appearance setting.
(() => {
  const media = matchMedia('(prefers-color-scheme: light)');
  const apply = () => {
    let theme = 'system';
    try {
      theme = JSON.parse(
        localStorage.getItem('coc-workbench-v1') || '{}',
      ).theme;
    } catch {
      /* The system theme works without browser storage. */
    }
    document.documentElement.dataset.theme =
      theme === 'dark' || theme === 'light'
        ? theme
        : media.matches
          ? 'light'
          : 'dark';
  };
  apply();
  addEventListener('storage', apply);
  media.addEventListener('change', apply);
})();
