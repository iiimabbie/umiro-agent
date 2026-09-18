(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const apply = mode => {
    const selected = mode === 'light' || mode === 'dark' ? mode : 'system';
    document.documentElement.dataset.theme = selected === 'system' ? (media.matches ? 'dark' : 'light') : selected;
  };
  window.applyUmiroTheme = apply;
  apply(localStorage.umiroTheme);
  media.addEventListener('change', () => { if (!['light', 'dark'].includes(localStorage.umiroTheme)) apply('system'); });
})();
