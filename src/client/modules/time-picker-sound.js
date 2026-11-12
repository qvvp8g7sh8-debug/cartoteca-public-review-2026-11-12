function createTimePickerSound(state, actions) {
  let context = null,
    unavailable = false,
    resuming = false,
    resumeDenied = false,
    lastTick = -Infinity;
  function unlockTimePickerSound() {
    // Call synchronously from a trusted picker action, never from initialization.
    if (document.hidden || unavailable || resumeDenied || resuming) return;
    if (window.navigator.userActivation && !window.navigator.userActivation.isActive) return;
    try {
      if (!context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
          unavailable = true;
          return;
        }
        context = new AudioContext({ latencyHint: 'interactive' });
      }
      if (context.state === 'running' || context.state === 'closed') return;
      resuming = true;
      Promise.resolve(context.resume()).then(
        () => {
          resuming = false;
        },
        () => {
          resuming = false;
          resumeDenied = true;
        },
      );
    } catch {
      resuming = false;
      if (context) resumeDenied = true;
      else unavailable = true;
    }
  }
  function playTimePickerTick() {
    if (document.hidden || !context || context.state !== 'running') return;
    const now = context.currentTime;
    if (now - lastTick < 0.05) return;
    lastTick = now;
    try {
      const tone = context.createOscillator(),
        gain = context.createGain();
      tone.type = 'sine';
      tone.frequency.setValueAtTime(1450, now);
      tone.frequency.exponentialRampToValueAtTime(950, now + 0.018);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.035, now + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.019);
      gain.gain.linearRampToValueAtTime(0, now + 0.022);
      tone.connect(gain);
      gain.connect(context.destination);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
      tone.start(now);
      tone.stop(now + 0.024);
    } catch {
      // Audio feedback must never interfere with selecting the appointment time.
    }
  }
  return {
    unlockTimePickerSound,
    playTimePickerTick,
  };
}
