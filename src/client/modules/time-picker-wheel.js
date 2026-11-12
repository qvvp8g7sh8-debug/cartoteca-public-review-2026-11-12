function createTimePickerWheel(state, actions) {
  let sequence = 0;
  function mountTimePickerWheel(root, values, value, onChange, onCommit) {
    const prefix = 'time-wheel-' + ++sequence + '-';
    let items = [],
      selected = '',
      interacted = false,
      destroyed = false,
      frame = 0,
      settle = 0,
      pointer = null,
      interaction = 0,
      committed = 0,
      programmaticTop = null,
      drag = null,
      blockedClickUntil = 0;
    const enabled = () =>
      !destroyed && !root.closest('[inert]') && root.getAttribute('aria-disabled') !== 'true';
    const rowHeight = () =>
      parseFloat(window.getComputedStyle(root).getPropertyValue('--time-wheel-row')) || 44;
    const clamp = (index) => Math.max(0, Math.min(items.length - 1, index));
    const cyclic = () => items.length > 1;
    const logicalIndex = (index) =>
      items.length ? ((index % items.length) + items.length) % items.length : 0;
    const middleIndex = (index) => index + (cyclic() ? items.length : 0);
    function setScroll(top) {
      root.scrollTop = top;
      programmaticTop = root.scrollTop;
    }
    function renderSelection() {
      root.dataset.wheelEmpty = String(selected === '');
      for (const option of root.children) {
        option.dataset.wheelSelected = String(option.dataset.wheelValue === selected);
        if (option.getAttribute('role') === 'option')
          option.setAttribute('aria-selected', String(option.dataset.wheelValue === selected));
      }
      const index = items.indexOf(selected);
      if (index >= 0) root.setAttribute('aria-activedescendant', prefix + index);
      else root.removeAttribute('aria-activedescendant');
    }
    function choose(index, notify) {
      if (!items.length) return '';
      const next = items[clamp(index)];
      if (next === selected) return selected;
      selected = next;
      renderSelection();
      if (notify && enabled()) {
        actions.playTimePickerTick();
        onChange(selected);
      }
      return selected;
    }
    function recenter(physicalIndex) {
      if (
        destroyed ||
        !cyclic() ||
        (physicalIndex >= items.length && physicalIndex < items.length * 2)
      )
        return;
      // Shift an exact cycle, preserving the finger's fractional row position.
      const centered = middleIndex(logicalIndex(physicalIndex));
      setScroll(root.scrollTop + (centered - physicalIndex) * rowHeight());
    }
    function readCenter(notify = interacted) {
      if (selected === '' && !notify) return selected;
      const physical = Math.round(root.scrollTop / rowHeight());
      const value = choose(cyclic() ? logicalIndex(physical) : 0, notify);
      recenter(physical);
      return value;
    }
    function clearPending() {
      if (frame) window.cancelAnimationFrame(frame);
      if (settle) window.clearTimeout(settle);
      frame = settle = 0;
    }
    function finish() {
      if (!enabled() || pointer !== null) return selected;
      const version = interaction;
      clearPending();
      readCenter();
      if (!enabled() || interaction !== version) return selected;
      setScroll(middleIndex(Math.max(0, items.indexOf(selected))) * rowHeight());
      if (interaction !== committed) {
        committed = interaction;
        onCommit?.(selected);
      }
      return selected;
    }
    function snap() {
      if (settle) window.clearTimeout(settle);
      settle = 0;
      if (interacted && items.length) finish();
    }
    function queueScroll() {
      if (!enabled() || !interacted) return;
      if (interaction === committed) interaction++;
      if (!frame)
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          if (enabled()) readCenter();
        });
      if (settle) window.clearTimeout(settle);
      settle = window.setTimeout(snap, 140);
    }
    function scroll() {
      if (programmaticTop !== null && Math.abs(root.scrollTop - programmaticTop) < 0.5) return;
      programmaticTop = null;
      queueScroll();
    }
    function scrollEnd() {
      if (programmaticTop !== null && Math.abs(root.scrollTop - programmaticTop) < 0.5) return;
      snap();
    }
    function interact() {
      if (!enabled() || !items.length) return false;
      interacted = true;
      interaction++;
      actions.unlockTimePickerSound();
      return true;
    }
    function wheel() {
      if (interact()) queueScroll();
    }
    function releaseDrag() {
      const id = drag?.id;
      if (drag) root.style.scrollSnapType = drag.snapType;
      drag = null;
      if (id !== undefined && root.hasPointerCapture?.(id)) {
        try {
          root.releasePointerCapture(id);
        } catch {
          // The browser may have already released capture after cancellation.
        }
      }
    }
    function pointerDown(event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!interact()) return;
      pointer = event.pointerId;
      blockedClickUntil = 0;
      if (event.pointerType !== 'mouse') return;
      drag = {
        id: event.pointerId,
        y: event.clientY,
        travel: 0,
        option: event.target.closest('[data-wheel-value]'),
        snapType: root.style.scrollSnapType,
      };
      root.style.scrollSnapType = 'none';
      root.focus({ preventScroll: true });
      event.preventDefault();
      try {
        root.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture can be unavailable when the pointer has already ended.
      }
    }
    function pointerMove(event) {
      if (!drag || drag.id !== event.pointerId || !enabled()) return;
      const delta = drag.y - event.clientY;
      drag.y = event.clientY;
      drag.travel += Math.abs(delta);
      event.preventDefault();
      programmaticTop = null;
      root.scrollTop += delta;
      queueScroll();
    }
    function pointerEnd(event) {
      if (pointer !== event.pointerId) return;
      pointer = null;
      const clicked = event.type === 'pointerup' && drag?.travel <= 3 ? drag.option : null;
      if (drag?.travel > 3 || clicked) blockedClickUntil = Date.now() + 250;
      releaseDrag();
      if (clicked) move(items.indexOf(clicked.dataset.wheelValue));
      else queueScroll();
    }
    function move(index) {
      clearPending();
      const next = clamp(index);
      setScroll(middleIndex(next) * rowHeight());
      choose(next, true);
      finish();
    }
    function keydown(event) {
      if (
        !['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) ||
        !items.length ||
        !interact()
      )
        return;
      event.preventDefault();
      const index = selected === '' ? 0 : items.indexOf(readCenter());
      const page = Math.max(1, Math.floor(root.clientHeight / rowHeight()) - 1);
      const next = {
        ArrowUp: index - 1,
        ArrowDown: index + 1,
        Home: 0,
        End: items.length - 1,
        PageUp: index - page,
        PageDown: index + page,
      }[event.key];
      move(next);
    }
    function click(event) {
      if (Date.now() < blockedClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const option = event.target.closest('[data-wheel-value]');
      if (!option || option.parentElement !== root || !interact()) return;
      root.focus({ preventScroll: true });
      move(items.indexOf(option.dataset.wheelValue));
    }
    function set(nextValues, nextValue) {
      if (destroyed) return;
      const choices = [...new Set(nextValues.map(String))];
      const sameItems =
        choices.length === items.length && choices.every((item, index) => item === items[index]);
      const nextSelected =
        nextValue === null ? '' : choices.includes(nextValue) ? nextValue : choices[0] || '';
      if (sameItems && nextSelected === selected && settled()) return;
      clearPending();
      interacted = false;
      pointer = null;
      releaseDrag();
      blockedClickUntil = 0;
      committed = ++interaction;
      items = choices;
      selected = nextSelected;
      root.classList.toggle('time-picker-wheel-fixed', items.length === 1);
      if (!sameItems) {
        const fragment = document.createDocumentFragment();
        for (let copy = 0; copy < (cyclic() ? 3 : 1); copy++)
          for (const [index, item] of items.entries()) {
            const option = document.createElement('div');
            const accessible = !cyclic() || copy === 1;
            option.dataset.wheelValue = item;
            option.setAttribute('role', accessible ? 'option' : 'presentation');
            if (accessible) {
              option.id = prefix + index;
              option.setAttribute('aria-posinset', String(index + 1));
              option.setAttribute('aria-setsize', String(items.length));
            } else option.setAttribute('aria-hidden', 'true');
            option.textContent = item;
            fragment.append(option);
          }
        root.replaceChildren(fragment);
      }
      renderSelection();
      setScroll(middleIndex(Math.max(0, items.indexOf(selected))) * rowHeight());
    }
    function current() {
      if (destroyed) return selected;
      return readCenter();
    }
    function settled() {
      return destroyed || (pointer === null && !frame && !settle && interaction === committed);
    }
    function flush() {
      if (destroyed) return selected;
      pointer = null;
      releaseDrag();
      return finish();
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pointer = null;
      releaseDrag();
      clearPending();
      root.removeEventListener('scroll', scroll);
      root.removeEventListener('scrollend', scrollEnd);
      root.removeEventListener('wheel', wheel);
      root.removeEventListener('pointerdown', pointerDown);
      root.removeEventListener('pointermove', pointerMove);
      root.removeEventListener('lostpointercapture', pointerEnd);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
      root.removeEventListener('keydown', keydown);
      root.removeEventListener('click', click);
      root.removeAttribute('aria-activedescendant');
    }
    root.addEventListener('scroll', scroll, { passive: true });
    root.addEventListener('scrollend', scrollEnd);
    root.addEventListener('wheel', wheel, { passive: true });
    root.addEventListener('pointerdown', pointerDown);
    root.addEventListener('pointermove', pointerMove);
    root.addEventListener('lostpointercapture', pointerEnd);
    window.addEventListener('pointerup', pointerEnd, { passive: true });
    window.addEventListener('pointercancel', pointerEnd, { passive: true });
    root.addEventListener('keydown', keydown);
    root.addEventListener('click', click);
    set(values, value);
    return { set, current, settled, flush, destroy };
  }
  return { mountTimePickerWheel };
}
