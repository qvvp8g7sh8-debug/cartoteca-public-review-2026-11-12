function createDialogInteractions() {
  function bindDialogInteractionEvents() {
    const desktop = window.matchMedia('(min-width: 701px) and (pointer: fine)');
    const positions = new Map();
    let stack = [],
      drag = null;
    const headingSelector =
      '.dialog-heading,.settings-help-heading,.client-contact-heading,[data-dialog-drag-handle]';
    const interactiveSelector =
      'button,a,input,select,textarea,label,summary,[contenteditable],[draggable="true"]';

    function reset(dialog) {
      positions.delete(dialog);
      dialog.classList.remove('dialog-positioned', 'dialog-dragging');
      dialog.style.removeProperty('--dialog-offset-x');
      dialog.style.removeProperty('--dialog-offset-y');
    }
    function finish() {
      if (!drag) return;
      const current = drag;
      drag = null;
      current.dialog.classList.remove('dialog-dragging');
      if (current.handle.hasPointerCapture?.(current.pointerId))
        current.handle.releasePointerCapture(current.pointerId);
    }
    function register(dialog) {
      // Native Escape/explicit close stay available; light-dismiss never closes a form.
      dialog.setAttribute('closedby', 'closerequest');
      const handle = dialog.querySelector(headingSelector) || dialog.querySelector('h2,h3');
      handle?.classList.add('dialog-drag-handle');
      if (dialog.open && !stack.includes(dialog)) stack.push(dialog);
    }
    function changes(records) {
      for (const record of records) {
        if (record.type === 'attributes') {
          const dialog = record.target;
          if (drag?.dialog === dialog) finish();
          reset(dialog);
          stack = stack.filter((item) => item !== dialog);
          register(dialog);
          continue;
        }
        const containingDialog = record.target.closest?.('dialog');
        if (containingDialog) register(containingDialog);
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('dialog')) register(node);
          node.querySelectorAll('dialog').forEach(register);
        }
      }
      stack = stack.filter((dialog) => dialog.open && dialog.isConnected);
      for (const dialog of positions.keys()) {
        if (!dialog.open || !dialog.isConnected) reset(dialog);
        else if (desktop.matches) place(dialog, dialog.getBoundingClientRect(), 0, 0);
      }
      if (drag && (!drag.dialog.open || !drag.dialog.isConnected)) finish();
    }
    const observer = new window.MutationObserver(changes);
    document.querySelectorAll('dialog').forEach(register);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });

    function place(dialog, box, deltaX, deltaY) {
      const previous = positions.get(dialog) || { x: 0, y: 0 };
      const left = Math.max(8, Math.min(box.left + deltaX, window.innerWidth - box.width - 8));
      const top = Math.max(8, Math.min(box.top + deltaY, window.innerHeight - box.height - 8));
      const position = {
        x: previous.x + left - box.left,
        y: previous.y + top - box.top,
      };
      positions.set(dialog, position);
      dialog.style.setProperty('--dialog-offset-x', position.x + 'px');
      dialog.style.setProperty('--dialog-offset-y', position.y + 'px');
      dialog.classList.add('dialog-positioned');
    }
    document.addEventListener(
      'pointerdown',
      (event) => {
        changes(observer.takeRecords());
        if (
          !desktop.matches ||
          event.button !== 0 ||
          (event.pointerType && event.pointerType !== 'mouse') ||
          event.target.closest(interactiveSelector)
        )
          return;
        const handle = event.target.closest('.dialog-drag-handle');
        const dialog = handle?.closest('dialog');
        if (!dialog?.open || dialog !== stack.at(-1)) return;
        finish();
        drag = {
          dialog,
          handle,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
        dialog.classList.add('dialog-dragging');
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      },
      true,
    );
    document.addEventListener(
      'pointermove',
      (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!desktop.matches || !drag.dialog.open || drag.dialog !== stack.at(-1)) {
          finish();
          return;
        }
        place(
          drag.dialog,
          drag.dialog.getBoundingClientRect(),
          event.clientX - drag.x,
          event.clientY - drag.y,
        );
        drag.x = event.clientX;
        drag.y = event.clientY;
        event.preventDefault();
      },
      true,
    );
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      document.addEventListener(
        type,
        (event) => {
          if (drag?.pointerId === event.pointerId) finish();
        },
        true,
      );
    document.addEventListener(
      'close',
      (event) => {
        if (!event.target.matches?.('dialog')) return;
        if (drag?.dialog === event.target) finish();
        reset(event.target);
        stack = stack.filter((dialog) => dialog !== event.target);
      },
      true,
    );
    function fitViewport() {
      finish();
      for (const dialog of positions.keys()) {
        if (!desktop.matches || !dialog.open || !dialog.isConnected) reset(dialog);
        else place(dialog, dialog.getBoundingClientRect(), 0, 0);
      }
    }
    let phoneFocusFrame = 0;
    function keepPhoneFieldVisible() {
      if (!document.body.classList.contains('phone-landscape') || phoneFocusFrame) return;
      phoneFocusFrame = window.requestAnimationFrame(() => {
        phoneFocusFrame = 0;
        if (!document.body.classList.contains('phone-landscape')) return;
        const field = document.activeElement;
        if (!field?.matches('input,select,textarea')) return;
        const content = field.closest('#form-content');
        if (!content?.closest('#editor[open]')) return;
        const visible = content.getBoundingClientRect(),
          bounds = field.getBoundingClientRect();
        if (visible.height <= 0) return;
        const gap = Math.min(8, Math.max(0, (visible.height - bounds.height) / 2)),
          top = visible.top + gap,
          bottom = visible.bottom - gap;
        // A textarea taller than the body cannot fit at both edges: retain its top.
        if (bounds.top < top || bounds.height > bottom - top) content.scrollTop += bounds.top - top;
        else if (bounds.bottom > bottom) content.scrollTop += bounds.bottom - bottom;
      });
    }
    window.addEventListener('resize', fitViewport);
    window.addEventListener('resize', keepPhoneFieldVisible);
    window.visualViewport?.addEventListener('resize', keepPhoneFieldVisible);
    document.addEventListener('focusin', keepPhoneFieldVisible);
    document.addEventListener('phone-layout-change', keepPhoneFieldVisible);
    desktop.addEventListener('change', fitViewport);
    window.addEventListener('blur', finish);
    window.addEventListener('pagehide', finish);
  }
  return { bindDialogInteractionEvents };
}
