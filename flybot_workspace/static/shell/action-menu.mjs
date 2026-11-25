export function mountActionMenus(document) {
  let active = null;
  const items = menu => [...menu.querySelectorAll('[role="menuitem"]')].filter(item =>
    !item.disabled && item.getAttribute('aria-disabled') !== 'true' && !item.closest('[hidden]'));

  function close({focus = false} = {}) {
    if (!active) return false;
    const {button, menu, onClose} = active;
    active = null;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    onClose?.();
    if (focus && button.isConnected !== false) button.focus({preventScroll: true});
    return true;
  }

  function dismissOutside(event) {
    if (active && !active.button.contains(event.target) && !active.menu.contains(event.target)) close();
  }
  document.addEventListener('click', dismissOutside);
  document.addEventListener('focusin', dismissOutside);

  function bind(button, menu, {onOpen, onClose} = {}) {
    if (!button || !menu) return {close: () => false};
    const entry = {button, menu, onClose};

    function open(fromEnd = false) {
      if (active !== entry) {
        close();
        active = entry;
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        onOpen?.();
      }
      const visible = items(menu);
      for (const item of visible) item.tabIndex = -1;
      visible.at(fromEnd ? -1 : 0)?.focus();
    }

    button.addEventListener('click', () => {
      if (active === entry) close({focus: true});
      else open();
    });
    button.addEventListener('keydown', event => {
      if (event.defaultPrevented) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        open(event.key === 'ArrowUp');
      } else if (event.key === 'Escape' && active === entry) {
        event.preventDefault();
        close({focus: true});
      }
    });
    menu.addEventListener('keydown', event => {
      if (active !== entry || event.defaultPrevented) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        // Continue the page's Tab order from the trigger, including for menus
        // positioned outside their original container.
        close({focus: true});
        return;
      }
      if (event.key === ' ' && document.activeElement?.tagName === 'A') {
        event.preventDefault();
        document.activeElement.click();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const visible = items(menu);
      if (!visible.length) return;
      event.preventDefault();
      const index = visible.indexOf(document.activeElement);
      if (event.key === 'Home') visible[0].focus();
      else if (event.key === 'End') visible.at(-1).focus();
      else if (event.key === 'ArrowDown') visible[(index + 1) % visible.length].focus();
      else visible[(index < 0 ? visible.length - 1 : (index + visible.length - 1) % visible.length)].focus();
    });
    menu.addEventListener('click', event => {
      const item = event.target.closest?.('[role="menuitem"]');
      if (active === entry && item && !item.disabled && item.getAttribute('aria-disabled') !== 'true') close({focus: true});
    }, {capture: true});
    return {close: options => active === entry && close(options)};
  }

  return {bind, close, get activeButton() { return active?.button; }};
}
