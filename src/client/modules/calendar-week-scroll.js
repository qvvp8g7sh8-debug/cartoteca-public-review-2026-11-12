function createCalendarWeekScroll() {
  const weekScrolls = new WeakSet();
  const horizontalSlop = 12;
  function bindCalendarWeekScroll(scroll) {
    if (weekScrolls.has(scroll)) return;
    weekScrolls.add(scroll);
    const overflow = () => Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    const clampLeft = (left, end = overflow()) => Math.min(end, Math.max(0, left));
    let pointer = null;
    let touch = null;
    let suppressClick = false;
    let settleFrame = 0;
    let wheel = null;
    let wheelIdle;

    function stopSettling() {
      if (settleFrame) window.cancelAnimationFrame(settleFrame);
      settleFrame = 0;
      delete scroll.dataset.weekScrollTarget;
    }
    function glideToDay(from, target) {
      stopSettling();
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        scroll.scrollLeft = target;
        return;
      }
      const distance = target - from;
      const duration = Math.min(360, 160 + Math.abs(distance) * 0.55);
      const start = window.performance.now();
      scroll.dataset.weekScrollTarget = String(target);
      function advance(now) {
        settleFrame = 0;
        if (!scroll.isConnected || document.hidden) {
          stopSettling();
          return;
        }
        const progress = Math.min(1, Math.max(0, now - start) / duration);
        const eased = 1 - (1 - progress) ** 2;
        scroll.scrollLeft = from + distance * eased;
        if (progress < 1) settleFrame = window.requestAnimationFrame(advance);
        else delete scroll.dataset.weekScrollTarget;
      }
      settleFrame = window.requestAnimationFrame(advance);
    }
    function dragHorizontal(origin, left) {
      const offset = left - origin;
      const distance = Math.max(0, Math.abs(offset) - horizontalSlop);
      scroll.scrollLeft = clampLeft(origin + Math.sign(offset) * distance);
    }
    function dayBoundaries(end) {
      const corner = scroll.querySelector('.time-corner');
      if (!corner) return [0, end];
      const edge =
        scroll.getBoundingClientRect().left + scroll.clientLeft + corner.getBoundingClientRect().width;
      const left = scroll.scrollLeft;
      return [
        0,
        ...Array.from(scroll.querySelectorAll('.time-columns > .time-day-heading'), (heading) =>
          clampLeft(left + heading.getBoundingClientRect().left - edge, end),
        ),
        end,
      ];
    }
    function settleDay(origin, requestedLeft) {
      delete scroll.dataset.weekScrollTarget;
      const end = overflow();
      if (!end || !scroll.isConnected) return;
      const offset = requestedLeft - origin;
      const left = clampLeft(scroll.scrollLeft, end);
      if (Math.abs(offset) < horizontalSlop) {
        const start = clampLeft(origin, end);
        if (Math.abs(start - left) >= 1) glideToDay(left, start);
        return;
      }
      const destination = clampLeft(requestedLeft, end);
      let nearest = destination < end / 2 ? 0 : end;
      let previousDay = 0;
      let nextDay = end;
      for (const day of dayBoundaries(end)) {
        if (Math.abs(day - destination) < Math.abs(nearest - destination)) nearest = day;
        if (day < origin - 1) previousDay = Math.max(previousDay, day);
        if (day > origin + 1) nextDay = Math.min(nextDay, day);
      }
      // A deliberate gesture reaches at least the next boundary in its direction.
      const target = offset > 0 ? Math.max(nearest, nextDay) : Math.min(nearest, previousDay);
      if (Math.abs(target - left) < 1) return;
      glideToDay(left, target);
    }
    function clearWheel() {
      clearTimeout(wheelIdle);
      wheel = null;
    }
    function endPointer(event) {
      if (event.pointerId !== pointer?.id) return;
      const { moved, origin, left } = pointer;
      pointer = null;
      if (moved) settleDay(origin, left);
    }

    function beginDrag(id, x, y) {
      const left = clampLeft(scroll.scrollLeft);
      return { id, x, y, origin: left, left, axis: null };
    }
    function moveDrag(drag, x, y) {
      const dx = x - drag.x;
      const dy = y - drag.y;
      if (!drag.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
        drag.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      }
      if (drag.axis !== 'x') return false;
      drag.left = drag.origin - dx;
      if (Math.abs(dx) >= horizontalSlop) drag.moved = true;
      if (drag.moved) {
        // A background redraw during contact can restore the last settled day.
        scroll.dataset.weekScrollTarget = String(drag.origin);
        scroll.scrollLeft = clampLeft(drag.left);
      }
      return true;
    }
    // iOS can cancel Pointer Events as the browser takes ownership of a pan.
    // Handle finger movement in Touch Events and claim only the horizontal axis.
    scroll.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1) {
        if (touch?.moved) settleDay(touch.origin, touch.left);
        touch = null;
        return;
      }
      suppressClick = false;
      clearWheel();
      stopSettling();
      if (!overflow()) return;
      const finger = event.changedTouches[0];
      touch = beginDrag(finger.identifier, finger.clientX, finger.clientY);
    }, { passive: true });
    scroll.addEventListener('touchmove', (event) => {
      if (!touch || event.touches.length !== 1 || !event.cancelable) return;
      const finger = event.changedTouches[0];
      if (finger?.identifier !== touch.id) return;
      if (moveDrag(touch, finger.clientX, finger.clientY)) {
        suppressClick ||= touch.moved;
        event.preventDefault();
      }
    }, { passive: false });
    function endTouch(event) {
      if (!touch || !Array.from(event.changedTouches).some((finger) => finger.identifier === touch.id))
        return;
      const drag = touch;
      touch = null;
      if (drag.moved) settleDay(drag.origin, drag.left);
    }
    scroll.addEventListener('touchend', endTouch);
    scroll.addEventListener('touchcancel', endTouch);

    let previousEnd = overflow();
    const resize = new ResizeObserver(() => {
      if (!scroll.isConnected) {
        resize.disconnect();
        return;
      }
      const end = overflow();
      const oldEnd = previousEnd;
      previousEnd = end;
      if (end === oldEnd || touch || pointer || wheel) return;
      const intended = Number(scroll.dataset.weekScrollTarget ?? scroll.scrollLeft);
      stopSettling();
      scroll.scrollLeft = oldEnd > 0 && intended >= oldEnd - 1
        ? end
        : dayBoundaries(end).reduce((nearest, day) =>
          Math.abs(day - intended) < Math.abs(nearest - intended) ? day : nearest,
        );
    });
    resize.observe(scroll);

    scroll.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') return;
      if (!event.isPrimary) {
        if (pointer && scroll.hasPointerCapture(pointer.id))
          scroll.releasePointerCapture(pointer.id);
        pointer = null;
        return;
      }
      suppressClick = false;
      clearWheel();
      stopSettling();
      if (event.button !== 0 || event.pointerType !== 'pen' || !overflow()) return;
      pointer = beginDrag(event.pointerId, event.clientX, event.clientY);
    });
    scroll.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointer?.id || pointer.axis === 'y') return;
      const axis = pointer.axis;
      if (moveDrag(pointer, event.clientX, event.clientY)) {
        suppressClick ||= pointer.moved;
        if (axis) return;
        try {
          scroll.setPointerCapture(event.pointerId);
        } catch {
          // A pointer cancelled by the browser no longer has capture to transfer.
        }
      }
    });
    scroll.addEventListener('pointerup', endPointer);
    scroll.addEventListener('pointercancel', endPointer);
    scroll.addEventListener('keydown', stopSettling);
    scroll.addEventListener('lostpointercapture', (event) => {
      if (event.target === scroll) endPointer(event);
    });
    scroll.addEventListener(
      'click',
      (event) => {
        if (!suppressClick || !event.detail) return;
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );

    scroll.addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey || event.metaKey) {
          clearWheel();
          stopSettling();
          return;
        }
        const end = overflow();
        if (!end || !event.cancelable) return;
        const mode = event.deltaMode;
        const shifted = event.shiftKey && !event.deltaX;
        const x = shifted ? event.deltaY : event.deltaX;
        const y = shifted ? 0 : event.deltaY;
        if (!x && !y) return;
        if (!wheel) {
          stopSettling();
          const left = clampLeft(scroll.scrollLeft);
          wheel = {
            axis: Math.abs(x) > Math.abs(y) ? 'x' : 'y',
            origin: left,
            left,
          };
        }
        clearTimeout(wheelIdle);
        wheelIdle = setTimeout(() => {
          const ended = wheel;
          wheel = null;
          if (ended?.axis === 'x') settleDay(ended.origin, ended.left);
        }, 140);
        // Pure vertical wheel input can keep its native scroll and scroll chaining.
        if (wheel.axis === 'y' && !x) return;
        event.preventDefault();
        if (wheel.axis === 'x') {
          const left = wheel.left + x * (mode === 2 ? scroll.clientWidth : mode === 1 ? 16 : 1);
          wheel.left = Math.max(-horizontalSlop, Math.min(end + horizontalSlop, left));
          dragHorizontal(wheel.origin, wheel.left);
        } else {
          scroll.scrollTop += y * (mode === 2 ? scroll.clientHeight : mode === 1 ? 16 : 1);
        }
      },
      { passive: false },
    );
  }
  return { bindCalendarWeekScroll };
}
