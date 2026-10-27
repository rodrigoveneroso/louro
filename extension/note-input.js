// Shared display-only behavior for Louro's multiline note fields.
(() => {
  const MAX_LINES = 8;
  const pixels = (value) => Number.parseFloat(value) || 0;

  function bind(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement)) return () => {};

    function resize() {
      const style = getComputedStyle(textarea);
      const fontSize = pixels(style.fontSize) || 13;
      const lineHeight = pixels(style.lineHeight) || fontSize * 1.4;
      const padding = pixels(style.paddingTop) + pixels(style.paddingBottom);
      const border = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
      const maxHeight = lineHeight * MAX_LINES + padding + border;

      textarea.style.height = 'auto';
      const contentHeight = textarea.scrollHeight + border;
      textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
      textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    }

    textarea.addEventListener('input', resize);
    textarea.addEventListener('focus', resize);
    window.addEventListener('resize', resize);
    resize();

    return () => {
      textarea.removeEventListener('input', resize);
      textarea.removeEventListener('focus', resize);
      window.removeEventListener('resize', resize);
    };
  }

  globalThis.louroNoteInput = { bind };
})();
