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
      // an empty field fits its placeholder, which the scroll height leaves out: a long
      // hint on a narrow field was cut off after its first line
      const showsPlaceholder = !textarea.value && Boolean(textarea.placeholder);
      if (showsPlaceholder) textarea.value = textarea.placeholder;
      const contentHeight = textarea.scrollHeight + border;
      if (showsPlaceholder) textarea.value = '';
      textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
      textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    }

    // the placeholder can be set after binding (translated once the page loads)
    const placeholder = new MutationObserver(resize);
    placeholder.observe(textarea, { attributes: true, attributeFilter: ['placeholder'] });
    // and the field can be bound while hidden, measuring nothing: fit it again whenever
    // its width changes, which includes being shown (only the width: fitting changes the
    // height, which would call this again)
    let width = -1;
    const shown = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resize();
    });
    shown.observe(textarea);
    textarea.addEventListener('input', resize);
    textarea.addEventListener('focus', resize);
    window.addEventListener('resize', resize);
    resize();

    return () => {
      placeholder.disconnect();
      shown.disconnect();
      textarea.removeEventListener('input', resize);
      textarea.removeEventListener('focus', resize);
      window.removeEventListener('resize', resize);
    };
  }

  globalThis.louroNoteInput = { bind };
})();
