const { cleanBusy } = require('./queue-org134.cjs');
const { createNotificationScheduler } = require('./notification-scheduler.cjs');
const { markNotificationPhase } = require('./notification-diagnostics140.cjs');

// Reuses the bounded-yield/lifecycle contract, but the iterator consumes durable
// dirty/due indexes instead of enumerating every organization on each pass.
function createDueRunner({ schedule, kind, rebuild, dispatch, recover = () => 0, clock }) {
  let cursor = null,
    dueCursor = null;
  function prepareOne(row, admit) {
    admit((onEntered) =>
      schedule.transaction(() => {
        onEntered();
        if (!schedule.dirtyMatches(row)) return;
        const org = row.organization_id;
        if (!row.subject) {
          const subjects = (kind === 'client' ? schedule.clientSubjects : schedule.workdaySubjects)(
            org,
            row.cursor,
            25,
          );
          // Advance this organization to useful work before the round-robin
          // visits every other organization's discovery marker. Keep the same
          // total page of 25, not 25 dirty rows plus an extra selected subject.
          const immediate = schedule.subjectDirty && subjects[0];
          for (const subject of immediate ? subjects.slice(1) : subjects)
            schedule.markDirty(org, kind, subject);
          if (immediate) {
            const prior = schedule.subjectDirty(kind, org, immediate);
            rebuild(org, immediate);
            // Coalesce a previously dirty subject only at its captured version.
            // Any re-dirty during rebuilding survives finishDirty's fresh CAS.
            if (prior) schedule.finishDirty(prior);
          }
          schedule.finishDirty(row, subjects.length === 25 ? subjects.at(-1) : null);
        } else {
          rebuild(org, row.subject);
          schedule.finishDirty(row);
        }
      }, row.organization_id),
    );
  }
  function discover(read) {
    try {
      return read();
    } catch (error) {
      markNotificationPhase(error, 'discovery');
      throw error;
    }
  }
  function* work() {
    // Recover the same maximum of ten intents, with one completed owning
    // transaction per iterator step instead of ten tenant opens before yielding.
    for (let index = 0; index < 10; index++) {
      let recovered;
      try {
        recovered = recover();
      } catch (error) {
        markNotificationPhase(error, 'recovery');
        throw error;
      }
      if (!recovered) break;
      yield;
    }
    // Alternate discovery and dispatch: a stream of changed calendars must not
    // prevent an already planned due notification from entering delivery.
    const skipped = [];
    const attempt = (org, callback, phase) => {
      let refusedAdmission = null;
      // Only the real owning transaction can prove its callback never began.
      // A lookalike BUSY thrown by a read/callback or an unknown outcome must
      // propagate; it never authorizes trying another organization.
      const admit = (work) => {
        let entered = false;
        try {
          return work(() => {
            entered = true;
          });
        } catch (error) {
          if (!entered && cleanBusy(error)) refusedAdmission = error;
          throw error;
        }
      };
      try {
        callback(admit);
      } catch (error) {
        if (!schedule.nextScopedDirty || error !== refusedAdmission) {
          markNotificationPhase(error, phase);
          throw error;
        }
        if (!skipped.includes(org)) skipped.push(org);
      }
    };
    for (;;) {
      if (skipped.length >= 8) return;
      // Keyset round-robin survives hot first organizations. Discover without
      // locks, then let the dispatcher account the actual owning organization.
      const dirty = discover(() =>
        schedule.nextScopedDirty
          ? schedule.nextScopedDirty(kind, cursor, skipped)
          : schedule.nextDirty(kind, cursor),
      );
      if (dirty) {
        cursor = schedule.nextScopedDirty ? { organization_id: dirty.organization_id } : dirty;
        yield { organizationId: dirty.organization_id };
        attempt(dirty.organization_id, (admit) => prepareOne(dirty, admit), 'rebuild');
        yield;
        if (skipped.length >= 8) return;
      }
      const task = discover(() =>
        schedule.nextScopedDue
          ? schedule.nextScopedDue(kind, clock(), dueCursor, skipped)
          : schedule.due(kind, clock(), 1)[0],
      );
      if (task) {
        yield { organizationId: task.organization_id };
        dueCursor = { organization_id: task.organization_id };
        attempt(task.organization_id, (admit) => dispatch(task, admit), 'dispatch');
        yield;
      }
      if (!dirty && !task) return;
    }
  }
  return createNotificationScheduler({ organizations: () => [''], work });
}
module.exports = { createDueRunner };
