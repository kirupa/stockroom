// Light and dark themes. The choice is stored so it survives a page reload.

const THEME_KEY = 'crumb-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = document.querySelector('.theme-toggle');
  if (toggle) toggle.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

applyTheme(localStorage.getItem(THEME_KEY) || 'light');
