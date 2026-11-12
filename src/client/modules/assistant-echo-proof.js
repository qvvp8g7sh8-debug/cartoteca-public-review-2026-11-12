// One capture-clock lease and at most one pending Worker job.
function createAssistantEchoProof(state, actions) {
  let sequenceOwner = 0;
  function assistantEchoProof(rate, current) {
    const math = actions.assistantEchoMath();
    const build = document.querySelector?.('meta[name="cartoteca-build"]')?.content;
    if (
      ![44100, 48000].includes(rate) ||
      typeof window.Worker !== 'function' ||
      typeof build !== 'string' ||
      !/^[a-f0-9]{16}$/.test(build)
    )
      return null;
    try {
      const nativeCap = Math.floor(rate * 0.5),
        nativeWindow = Math.floor(rate * 0.032),
        analysisCap = 8000,
        nativeRef = new window.Float32Array(nativeCap),
        nativeMic = new window.Float32Array(nativeCap),
        ref = new window.Float32Array(analysisCap),
        mic = new window.Float32Array(analysisCap);
      let nativeEnd = 0,
        analysisEnd = 0,
        frameStart = 0,
        frameNativeStart = 0,
        previousRef = 0,
        previousMic = 0,
        nextPosition = 0,
        lastTime = null,
        closed = false,
        sequence = 0,
        lastTrainedPlayback = null,
        candidate = null;
      const owner = 'capture-' + ++sequenceOwner;
      let epoch = 1;
      const worker = new window.Worker('/assistant-echo-train.js?v=' + build);
      let workerReady = false,
        pendingJob = null;
      worker.onmessage = ({ data }) => {
        if (closed) return;
        const accepted = data?.type === 'fit' && pendingJob !== null && data.request === pendingJob;
        if (accepted) pendingJob = null;
        if (!current()) return;
        if (data.type === 'ready') {
          workerReady = data.protocol === 1;
          return;
        }
        if (accepted && candidate && data.request === candidate.id) {
          if (
            data.result?.status === 'FIT' &&
            data.result.fit?.epoch === epoch &&
            data.result.fit?.candidate === candidate.id
          ) {
            candidate.fit = Object.freeze(data.result.fit);
          } else {
            candidate.rejected = true;
            candidate.openingAmbiguity =
              candidate.firstForPlayback &&
              data.result?.status === 'UNKNOWN' &&
              data.result.reason === 'ambiguous-lag';
          }
        }
      };
      function close() {
        if (closed) return;
        pendingJob = null;
        closed = true;
        candidate = null;
        worker.terminate();
        nativeRef.fill(0);
        nativeMic.fill(0);
        ref.fill(0);
        mic.fill(0);
      }
      worker.onerror = worker.onmessageerror = close;
      const copy = (array, end, length) => {
        if (
          !Number.isSafeInteger(end) ||
          !Number.isSafeInteger(length) ||
          length <= 0 ||
          length > analysisCap ||
          end < length ||
          end > analysisEnd ||
          end - length < Math.max(0, analysisEnd - analysisCap)
        )
          return null;
        const out = new window.Float32Array(length);
        for (let i = 0; i < length; i++) out[i] = array[(end - length + i) % analysisCap];
        return out;
      };
      const copyNative = (array, end, length) => {
        if (
          !Number.isSafeInteger(end) ||
          !Number.isSafeInteger(length) ||
          length <= 0 ||
          length > nativeCap ||
          end < length ||
          end > nativeEnd ||
          end - length < Math.max(0, nativeEnd - nativeCap)
        )
          return null;
        const out = new window.Float32Array(length);
        for (let i = 0; i < length; i++) out[i] = array[(end - length + i) % nativeCap];
        return out;
      };
      const nativeInput = (start, length) => {
        const end = start + length,
          refLength = end - Math.max(0, nativeEnd - nativeCap),
          reference = refLength >= length ? copyNative(nativeRef, end, refLength) : null,
          samples = copyNative(nativeMic, end, length);
        return reference && samples
          ? {
              sampleRate: rate,
              reference,
              referenceStart: end - refLength,
              mic: samples,
              micStart: start,
            }
          : null;
      };
      const currentNativeInput = ({ nativeLag: lag, secondLag, thirdLag }) => {
        const length = nativeEnd - frameNativeStart;
        const referenceStart = frameNativeStart - lag - 1;
        const referenceEnd = nativeEnd - lag + 1;
        const reference = copyNative(nativeRef, referenceEnd, length + 2);
        const mic = copyNative(nativeMic, nativeEnd, length);
        if (!reference || !mic) return null;
        const input = {
          sampleRate: rate,
          reference,
          referenceStart,
          mic,
          micStart: frameNativeStart,
        };
        if (secondLag !== undefined) {
          input.referenceSecondStart = frameNativeStart - secondLag - 1;
          input.referenceSecond = copyNative(nativeRef, nativeEnd - secondLag + 1, length + 2);
          if (!input.referenceSecond) return null;
        }
        if (thirdLag !== undefined) {
          input.referenceThirdStart = frameNativeStart - thirdLag - 1;
          input.referenceThird = copyNative(nativeRef, nativeEnd - thirdLag + 1, length + 2);
          if (!input.referenceThird) return null;
        }
        return input;
      };
      const input = (start, id) => {
        const end = start + 512,
          length = end - Math.max(0, analysisEnd - analysisCap),
          reference = length >= 512 ? copy(ref, end, length) : null,
          samples = copy(mic, end, 512);
        return reference && samples
          ? {
              reference,
              referenceStart: end - length,
              mic: samples,
              micStart: start,
              analysisRate: 16000,
              owner,
              epoch,
              candidate: id,
            }
          : null;
      };
      function reset() {
        candidate = null;
      }
      function invalidate() {
        candidate = null;
        epoch++;
        nativeRef.fill(0);
        nativeMic.fill(0);
        ref.fill(0);
        mic.fill(0);
        nativeEnd = analysisEnd = frameStart = frameNativeStart = 0;
        previousRef = previousMic = nextPosition = 0;
        lastTime = null;
      }
      function feed(samples, reference, time) {
        if (
          closed ||
          !current() ||
          !(samples instanceof window.Float32Array) ||
          samples.length !== 512 ||
          !(reference instanceof window.Float32Array) ||
          reference.length !== samples.length ||
          !Number.isFinite(time) ||
          samples.some((x) => !Number.isFinite(x)) ||
          reference.some((x) => !Number.isFinite(x))
        ) {
          invalidate();
          return;
        }
        if (lastTime !== null && Math.abs(time - lastTime - samples.length / rate) > 1 / rate) {
          invalidate();
        }
        lastTime = time;
        frameStart = analysisEnd;
        frameNativeStart = nativeEnd;
        for (let i = 0; i < samples.length; i++) {
          const x = reference[i],
            y = samples[i];
          nativeRef[nativeEnd % nativeCap] = x;
          nativeMic[nativeEnd % nativeCap] = y;
          while (nextPosition <= nativeEnd) {
            const fraction = Math.max(0, Math.min(1, nextPosition - (nativeEnd - 1)));
            ref[analysisEnd % analysisCap] = previousRef + fraction * (x - previousRef);
            mic[analysisEnd % analysisCap] = previousMic + fraction * (y - previousMic);
            analysisEnd++;
            nextPosition = (analysisEnd * rate) / 16000;
          }
          previousRef = x;
          previousMic = y;
          nativeEnd++;
        }
      }
      function newCandidate(start, playback, deadline = null, retried = false) {
        return {
          id: ++sequence,
          start,
          nativeStart: Math.floor((start * rate) / 16000),
          sent: false,
          fit: null,
          validated: false,
          lastMatchEnd: null,
          recheckAt: null,
          rejected: false,
          playback,
          firstForPlayback: false,
          openingAmbiguity: false,
          openingRetry: false,
          deadline,
          retried,
        };
      }
      function send(candidate, priorFit) {
        if (candidate.sent || pendingJob !== null || !workerReady) return false;
        const job = input(candidate.start, candidate.id);
        if (!job) return false;
        job.native = nativeInput(candidate.nativeStart, nativeWindow);
        if (!job.native) return false;
        if (priorFit) job.priorFit = priorFit;
        if (
          Number.isSafeInteger(candidate.playback) &&
          candidate.playback !== lastTrainedPlayback
        ) {
          candidate.firstForPlayback = true;
          lastTrainedPlayback = candidate.playback;
        }
        candidate.sent = true;
        pendingJob = candidate.id;
        try {
          worker.postMessage({ type: 'train', request: candidate.id, input: job }, [
            job.reference.buffer,
            job.mic.buffer,
            job.native.reference.buffer,
            job.native.mic.buffer,
          ]);
          return true;
        } catch {
          close();
          return false;
        }
      }
      function hasReference(lag = 0) {
        const start = frameNativeStart - lag;
        if (start < Math.max(0, nativeEnd - nativeCap)) return false;
        for (let i = start; i < nativeEnd - lag; i++)
          if (nativeRef[i % nativeCap] !== 0) return true;
        return false;
      }
      function armDeadline(playback) {
        if (!Number.isSafeInteger(playback) || playback !== candidate.playback || !hasReference())
          return false;
        candidate.deadline ??= nativeEnd + 3 * (nativeEnd - frameNativeStart);
        return nativeEnd < candidate.deadline;
      }
      function retryFit(playback) {
        if (
          candidate.retried ||
          !Number.isSafeInteger(candidate.fit.nativeLag) ||
          !hasReference(candidate.fit.nativeLag) ||
          !armDeadline(playback)
        )
          return;
        // Both fits share the deadline at the first probe decision.
        const deadline = candidate.deadline;
        const latest = Math.floor(((deadline - 2 * nativeWindow) * 16000) / rate);
        const start = Math.min(latest, candidate.start + 512);
        if (start <= candidate.start) return;
        const next = newCandidate(start, playback, deadline, true);
        if (send(next, candidate.fit)) candidate = next;
      }
      function retryOpening(detection, playback) {
        if (!candidate.openingAmbiguity || playback !== candidate.playback || !hasReference())
          return;
        // The opening estimate can be ambiguous before the later reflection arrives.
        // Train on the next complete window and still require separate held-out and live proof.
        const start = candidate.start + 512;
        const nativeStart = Math.floor((start * rate) / 16000);
        if (analysisEnd - start < 512 || nativeEnd - nativeStart < nativeWindow) return;
        if (detection.onsetMs >= 64 && !armDeadline(playback)) return;
        const deadline = candidate.deadline;
        if (deadline !== null && nativeStart + 2 * nativeWindow > deadline) return;
        const next = newCandidate(start, playback, deadline, true);
        next.openingRetry = true;
        if (send(next)) candidate = next;
      }
      function deferProbe() {
        return Boolean(
          !closed &&
          current() &&
          candidate?.deadline != null &&
          !candidate.validated &&
          !candidate.rejected &&
          nativeEnd < candidate.deadline,
        );
      }
      function checkCurrent(candidate) {
        const native = currentNativeInput(candidate.fit);
        const answer =
          native &&
          math.validateCurrent(candidate.fit, {
            owner,
            epoch,
            candidate: candidate.id,
            native,
          });
        if (answer?.status === 'ECHO') {
          candidate.lastMatchEnd = nativeEnd;
          candidate.recheckAt = null;
        }
        return answer;
      }
      function echo(detection, playback) {
        if (closed || !current()) return false;
        if (candidate?.playback != null && playback !== candidate.playback) {
          reset();
          return false;
        }
        if (
          candidate?.deadline != null &&
          !candidate.validated &&
          (nativeEnd > candidate.deadline || !hasReference())
        ) {
          // An expired opening retry stays exhausted for this continuous onset.
          if (candidate.openingRetry && detection.voiced) candidate.rejected = true;
          else reset();
          return false;
        }
        if (candidate?.validated) {
          const recheckAt = candidate.recheckAt;
          const answer =
            recheckAt === null || recheckAt === frameNativeStart ? checkCurrent(candidate) : null;
          if (answer?.status === 'ECHO') return true;
          if (
            recheckAt === null &&
            Number.isSafeInteger(playback) &&
            playback === candidate.playback &&
            candidate.lastMatchEnd === frameNativeStart &&
            answer?.reason === 'native-heldout-residual' &&
            hasReference(candidate.fit.nativeLag)
          ) {
            // The unmatched frame still counts toward onset. Recheck the fit once on fresh PCM.
            candidate.recheckAt = nativeEnd;
            return false;
          }
          reset();
          // A sustained mismatch starts the next fit on the same frame as an immediate reset would.
          if (recheckAt === null) return false;
        }
        if (!detection.voiced) {
          reset();
          return false;
        }
        if (!candidate) candidate = newCandidate(frameStart, playback);
        if (analysisEnd - candidate.start >= 512) send(candidate);
        if (!candidate) return false;
        if (candidate.rejected) {
          retryOpening(detection, playback);
          return false;
        }
        if (detection.onsetMs < 64) return false;
        if (!candidate.fit) {
          if (pendingJob === candidate.id) armDeadline(playback);
          return false;
        }
        if (!candidate.validated) {
          if (nativeEnd - candidate.nativeStart < 2 * nativeWindow) {
            armDeadline(playback);
            return false;
          }
          const heldout = {
            owner,
            epoch,
            candidate: candidate.id,
            native: nativeInput(candidate.nativeStart + nativeWindow, nativeWindow),
          };
          if (!heldout.native) return false;
          const answer = math.validate(candidate.fit, heldout);
          candidate.validated = answer.status === 'ECHO';
          if (!candidate.validated) {
            candidate.rejected = true;
            if (answer.reason === 'native-heldout-residual') retryFit(playback);
            return false;
          }
        }
        const yes = checkCurrent(candidate)?.status === 'ECHO';
        if (!yes) reset();
        return yes;
      }
      return {
        feed,
        echo,
        deferProbe,
        reset,
        close,
        bounds: { nativeSamples: nativeCap, analysisSamples: analysisCap },
      };
    } catch {
      return null;
    }
  }
  return { assistantEchoProof };
}
