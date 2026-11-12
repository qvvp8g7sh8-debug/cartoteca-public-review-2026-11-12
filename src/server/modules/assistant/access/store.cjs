const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { initialState, validateState } = require('./defaults.cjs');
const { stateName, MAX_BYTES, createStateFileReader } = require('./state-file.cjs');
const readStateBytes = createStateFileReader(fs);
function withStateLock(directory, callback) {
  const filename = path.join(directory, 'assistant-state.lock');
  let handle;
  try {
    handle = fs.openSync(filename, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw fail(503, 'Настройки помощника заняты. Повторите позже.');
    throw error;
  }
  try {
    return callback();
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(filename);
  }
}
function createAssistantFileStore({ directory, seal, open }) {
  const filename = path.join(directory, stateName);
  let cached = null;
  function readProjected(project) {
    try {
      const bytes = readStateBytes(directory);
      if (!bytes) {
        cached = null;
        return project(initialState());
      }
      // Recheck the actual buffer too: a writer can replace the file after stat.
      if (bytes.length > MAX_BYTES) throw Error('Assistant state exceeds its limit.');
      if (cached && bytes.equals(cached.bytes)) return project(cached.state);
      const state = validateState(open(bytes));
      const result = project(state);
      cached = { bytes, state };
      return result;
    } catch (error) {
      cached = null;
      throw error;
    }
  }
  function read() {
    return readProjected(structuredClone);
  }
  function readAccess(resolveMember) {
    return readProjected((state) => {
      // Only the mode leaves the private snapshot before a fresh membership lookup.
      const member = resolveMember(state.policy.mode);
      const grant =
        member &&
        state.grants.find(
          (entry) =>
            entry.organizationId === member.organizationId &&
            entry.accountId === member.accountId &&
            entry.membershipId === member.membershipId,
        );
      return {
        member,
        state: structuredClone({
          revision: state.revision,
          policy: {
            mode: state.policy.mode,
            commands: state.policy.commands,
            limits: state.policy.limits,
          },
          providers: Object.fromEntries(
            Object.entries(state.providers).map(([kind, value]) => [
              kind,
              { provider: value.provider },
            ]),
          ),
          credentials: { timeweb: Boolean(state.credentials.timeweb) },
          grants: grant ? [grant] : [],
        }),
      };
    });
  }
  function write(state) {
    validateState(state);
    const bytes = seal(state);
    if (bytes.length > MAX_BYTES) throw fail(507, 'Журнал помощника достиг ограничения.');
    const temp = path.join(directory, '.assistant-state-' + randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, filename);
      cached = null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  function update(callback) {
    return withStateLock(directory, () => {
      const state = read();
      const result = callback(state);
      if (result && typeof result.then === 'function')
        throw Error('Async assistant update denied.');
      write(state);
      return result;
    });
  }
  return { read, readAccess, update, filename };
}
function assertAssistantStateBackend(context, options) {
  return require('./row-backend.cjs').assertAssistantStateBackend(context, options);
}
function createAssistantStore(context) {
  const { backend = 'file', directory } = context;
  // Standalone legacy readers remain lazy. Platform contexts validate component
  // agreement eagerly; a standalone file read still rejects the schema fence.
  if (context.db || backend !== 'file')
    assertAssistantStateBackend(context, { directory, backend });
  return backend === 'file'
    ? createAssistantFileStore(context)
    : require('./row-store.cjs').createAssistantRowStore(context, { directory });
}
function resetRestoredAssistant({ directory, seal, open }) {
  const store = createAssistantStore({ directory, seal, open });
  if (!readStateBytes(directory)) return;
  store.update((state) => {
    state.revision++;
    state.policy.mode = 'off';
    state.grants = [];
    state.credentials = {};
    state.reservations = {};
    state.operations = [];
    state.audit = [];
    state.history = [];
    state.behavior = { version: state.behavior.version + 1, current: null, history: [] };
  });
}
module.exports = {
  createAssistantStore,
  createAssistantFileStore,
  assertAssistantStateBackend,
  withStateLock,
  readStateBytes,
  resetRestoredAssistant,
  stateName,
  validateState,
};
