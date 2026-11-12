function createAssistantIdle() {
  function assistantIdleTimer(expire) {
    let timer = null,
      owner = null;
    function stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      owner = null;
    }
    function update(value) {
      if (
        !value.active ||
        !value.voice ||
        value.busy ||
        value.recording ||
        value.turnPending ||
        value.pendingTurn ||
        value.pendingHandoff ||
        value.hasDialogue ||
        value.recoverable ||
        document.hidden
      ) {
        stop();
        return;
      }
      if (timer !== null && owner === value.owner) return;
      stop();
      owner = value.owner;
      const captured = owner;
      const handle = setTimeout(() => {
        if (timer !== handle || owner !== captured) return;
        timer = null;
        owner = null;
        if (!document.hidden) expire(captured);
      }, 30000);
      timer = handle;
    }
    return { update, stop };
  }
  return { assistantIdleTimer };
}
