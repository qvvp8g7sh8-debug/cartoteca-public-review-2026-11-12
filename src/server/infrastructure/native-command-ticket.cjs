const { Reflect } = globalThis;
const ticketPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const ticketHeader = 'x-cartoteca-native-command-ticket';
// Three copies cover the owner JSON string, UTF-8 output and proxy transit.
// Keep a fixed allowance for the two HTTP legs; unknown/large output stays full.
const commandRetainedLimit = 512 * 1024 * 1024;
const commandRetainedFloor = 2 * 1024 * 1024;
function createCommandResponseBudget(res) {
  let bytes = 0,
    known = true,
    ended = false;
  const write = res.write,
    end = res.end;
  const count = (chunk, encoding) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    let length;
    if (typeof chunk === 'string') {
      if (
        encoding !== undefined &&
        typeof encoding !== 'function' &&
        !Buffer.isEncoding(encoding)
      ) {
        known = false;
        return;
      }
      length = Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    } else if (chunk instanceof Uint8Array) length = chunk.byteLength;
    else {
      known = false;
      return;
    }
    bytes += length;
    if (!Number.isSafeInteger(bytes) || bytes > (commandRetainedLimit - commandRetainedFloor) / 3)
      known = false;
  };
  const trackedWrite = function (chunk, encoding, callback) {
    count(chunk, encoding);
    return Reflect.apply(write, this, arguments);
  };
  const trackedEnd = function (chunk, encoding, callback) {
    count(chunk, encoding);
    try {
      const result = Reflect.apply(end, this, arguments);
      ended = true;
      return result;
    } catch (error) {
      known = false;
      throw error;
    }
  };
  res.write = trackedWrite;
  res.end = trackedEnd;
  return () => {
    if (res.write !== trackedWrite || res.end !== trackedEnd) known = false;
    if (res.write === trackedWrite) res.write = write;
    if (res.end === trackedEnd) res.end = end;
    return known && ended ? commandRetainedFloor + bytes * 3 : null;
  };
}

// One private reservation per command PID. A canceled reservation cannot later
// authorize delayed HTTP; an executing handler retains it until actual settle.
function createCommandTicketState(finished) {
  let current = null;
  const complete = (ticket, retainedBytes = null) => {
    current = null;
    finished(ticket, retainedBytes);
  };
  return {
    reserve(ticket) {
      if (!ticketPattern.test(ticket || '') || current) return false;
      current = { ticket, running: false };
      return true;
    },
    begin(ticket) {
      if (!current || current.ticket !== ticket || current.running) return null;
      current.running = true;
      let done = false;
      return (retainedBytes = null) => {
        if (done) return;
        done = true;
        complete(ticket, retainedBytes);
      };
    },
    cancel(ticket) {
      if (current?.ticket === ticket && !current.running) complete(ticket);
    },
  };
}
module.exports = {
  ticketPattern,
  ticketHeader,
  createCommandTicketState,
  createCommandResponseBudget,
  commandRetainedLimit,
  commandRetainedFloor,
};
