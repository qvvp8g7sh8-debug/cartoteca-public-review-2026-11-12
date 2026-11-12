function createAssistantTrigger(state) {
  let target = null,
    cleanup = null;
  const accountContext = () =>
    JSON.stringify([state.account?.id, state.account?.organizationId, state.account?.role]);
  const scoped = () =>
    state.currentView === 'calendar' &&
    state.assistantReady === true &&
    state.assistantScope?.enabled === true &&
    state.assistantScope.organizationId === state.account?.organizationId;
  function preserveClick(button, pointerId, ended) {
    let timer;
    const remove = () => {
      window.clearTimeout(timer);
      button.removeEventListener('click', click, true);
      button.removeEventListener('pointerdown', remove, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
    const click = (event) => {
      if (event.detail === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const release = (event) => {
      if (event.pointerId !== pointerId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(remove, 1000);
    };
    // Revocation can remove the live binding while the original finger is down.
    // Preserve only its trailing click guard, never the ability to open anything.
    button.addEventListener('click', click, true);
    button.addEventListener('pointerdown', remove, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    timer = window.setTimeout(remove, ended ? 1000 : 30000);
  }
  function destroyAssistantTrigger() {
    const dispose = cleanup;
    cleanup = null;
    target = null;
    dispose?.();
  }
  function mountAssistantTrigger(open, activateAudio = null, prepareScope = null) {
    const button = document.querySelector('#calendar-new');
    if (!button || !scoped() || typeof open !== 'function') {
      destroyAssistantTrigger();
      return;
    }
    if (button === target && cleanup) return;
    destroyAssistantTrigger();
    target = button;
    const attributes = ['title', 'aria-description', 'aria-keyshortcuts'];
    const original = attributes.map((name) => button.getAttribute(name));
    const hadClass = button.classList.contains('assistant-trigger');
    button.classList.add('assistant-trigger');
    button.title = 'Новая запись. Удерживайте для помощника; с клавиатуры — Shift+Enter.';
    button.setAttribute(
      'aria-description',
      'Короткое нажатие — новая запись. Удерживание или Shift+Enter — помощник.',
    );
    button.setAttribute('aria-keyshortcuts', 'Shift+Enter');
    let confirmed = null;
    const ownsConfirmation = (owner) =>
      Boolean(
        owner &&
        usable() &&
        owner.generation === state.assistantGeneration &&
        owner.account === state.account &&
        owner.identity === accountContext() &&
        owner.version === state.assistantScope.policyVersion,
      );
    const activate = (event) => {
      if (event.isTrusted === false || !ownsConfirmation(confirmed)) return;
      try {
        Promise.resolve(activateAudio?.()).catch(() => {});
      } catch {}
    };
    const vibrate = (event, owner) => {
      if (event.isTrusted === false || event.pointerType === 'mouse' || owner.vibrated) return;
      try {
        owner.vibrated = window.navigator.vibrate?.(18) === true;
      } catch {}
    };
    let press = null,
      blocked = false,
      pointerId = null,
      ended = true,
      disposed = false;
    const usable = () =>
      scoped() &&
      button.isConnected &&
      !button.disabled &&
      !button.closest('[hidden]') &&
      !document.hidden &&
      !state.busy &&
      !state.editorMode;
    const cancel = (block = false) => {
      const previous = press;
      press = null;
      syncPointerListeners();
      if (!previous) return;
      window.clearTimeout(previous.timer);
      window.clearTimeout(previous.scopeTimer);
      previous.preparedScope?.controller.abort();
      if (block) blocked = true;
      if (button.hasPointerCapture?.(previous.id)) {
        try {
          button.releasePointerCapture(previous.id);
        } catch {}
      }
    };
    const down = (event) => {
      if (press || (!ended && event.pointerId !== pointerId)) {
        cancel(true);
        return;
      }
      if (
        !button.contains(event.target) ||
        event.button !== 0 ||
        event.isPrimary === false ||
        !usable()
      )
        return;
      confirmed = null;
      blocked = false;
      pointerId = event.pointerId;
      ended = false;
      const current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        generation: state.assistantGeneration,
        account: state.account,
        identity: accountContext(),
        version: state.assistantScope.policyVersion,
        timer: null,
        scopeTimer: null,
        preparedScope: null,
        vibrated: false,
      };
      press = current;
      syncPointerListeners();
      try {
        button.setPointerCapture?.(event.pointerId);
      } catch {}
      if (prepareScope)
        current.scopeTimer = window.setTimeout(() => {
          if (press === current && ownsConfirmation(current))
            current.preparedScope = prepareScope();
        }, 250);
      current.timer = window.setTimeout(() => {
        if (press !== current) return;
        if (
          !usable() ||
          current.generation !== state.assistantGeneration ||
          current.account !== state.account ||
          current.identity !== accountContext() ||
          current.version !== state.assistantScope.policyVersion
        ) {
          cancel(true);
          return;
        }
        blocked = true;
        confirmed = current;
        const preparedScope = current.preparedScope;
        current.preparedScope = null;
        // Start at the hold threshold, even while the pointer is still down.
        // Release may unlock touch audio later, but must never open twice.
        activate(event);
        vibrate(event, current);
        open({ voice: true, ...(preparedScope ? { preparedScope } : {}) });
      }, 600);
    };
    const outsideDown = (event) => {
      if (!button.contains(event.target)) cancel(true);
    };
    function syncPointerListeners() {
      const bind = (type, listener, active) => {
        if (!disposed && active) window.addEventListener(type, listener, true);
        else window.removeEventListener(type, listener, true);
      };
      bind('pointerdown', outsideDown, Boolean(press));
      bind('pointermove', move, Boolean(press));
      bind('pointerup', up, !ended);
      bind('pointercancel', up, !ended);
    }
    const move = (event) => {
      if (
        press?.id === event.pointerId &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10
      )
        cancel(true);
    };
    const up = (event) => {
      if (event.pointerId !== pointerId) return;
      if (event.type === 'pointerup' && press === confirmed && ownsConfirmation(confirmed)) {
        // Touch activation can begin only on release. This is an audio retry,
        // not the trigger for starting the already opened assistant.
        activate(event);
        vibrate(event, confirmed);
      } else if (event.type === 'pointercancel') confirmed = null;
      ended = true;
      cancel(event.type === 'pointercancel');
    };
    const abandon = () => {
      confirmed = null;
      ended = true;
      pointerId = null;
      cancel(true);
    };
    const lost = (event) => {
      if (press?.id === event.pointerId) abandon();
    };
    const blur = abandon;
    const visibility = () => {
      if (document.hidden) abandon();
    };
    const click = (event) => {
      if (!blocked || event.detail === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const keyboard = (event) => {
      if (
        event.key !== 'Enter' ||
        !event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !usable()
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      cancel(true);
      if (event.isTrusted !== false) {
        try {
          Promise.resolve(activateAudio?.()).catch(() => {});
        } catch {}
      }
      open({ voice: false });
    };
    const context = (event) => {
      if (press || blocked) event.preventDefault();
    };
    let ancestors = [];
    const ancestry = () => {
      const nodes = [];
      for (let node = button; node; node = node.parentNode) {
        nodes.push(node);
        if (node === document.body) break;
      }
      return nodes;
    };
    const observer = new window.MutationObserver(() => {
      if (!button.isConnected || !scoped() || button.closest('[hidden]')) {
        if (target === button) destroyAssistantTrigger();
      } else {
        const current = ancestry();
        if (
          current.length !== ancestors.length ||
          current.some((node, index) => node !== ancestors[index])
        )
          observeAncestors(current);
        if (press && !usable()) cancel(true);
      }
    });
    function observeAncestors(nodes) {
      observer.disconnect();
      ancestors = nodes;
      // Only direct removal edges and ancestor visibility can invalidate this button.
      for (const node of ancestors)
        observer.observe(node, {
          childList: true,
          attributes: true,
          attributeFilter: ['hidden'],
        });
    }
    observeAncestors(ancestry());
    button.addEventListener('pointerdown', down, true);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    button.addEventListener('lostpointercapture', lost);
    button.addEventListener('click', click, true);
    button.addEventListener('keydown', keyboard);
    button.addEventListener('contextmenu', context);
    cleanup = () => {
      const pendingPointer = Boolean(press);
      disposed = true;
      confirmed = null;
      cancel(true);
      observer.disconnect();
      button.removeEventListener('pointerdown', down, true);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      button.removeEventListener('lostpointercapture', lost);
      button.removeEventListener('click', click, true);
      button.removeEventListener('keydown', keyboard);
      button.removeEventListener('contextmenu', context);
      if (pendingPointer || blocked) preserveClick(button, pointerId, ended);
      if (!hadClass) button.classList.remove('assistant-trigger');
      attributes.forEach((name, index) => {
        if (original[index] === null) button.removeAttribute(name);
        else button.setAttribute(name, original[index]);
      });
    };
  }
  return { mountAssistantTrigger, destroyAssistantTrigger };
}
