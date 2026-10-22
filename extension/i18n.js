// Interface text comes from _locales/<lang>/messages.json; Chrome picks the language.

/** The message `key`, with `$1`, `$2`… filled in from `values`. */
export function t(key, ...values) {
  return chrome.i18n.getMessage(key, values.map(String)) || key;
}

/** Fill every element marked `data-i18n="key"` with its text. */
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  if (document.documentElement.dataset.i18nTitle) {
    document.title = t(document.documentElement.dataset.i18nTitle);
  }
}
