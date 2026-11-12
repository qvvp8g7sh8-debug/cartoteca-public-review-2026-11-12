const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCalendarFeedCache,
  matchesEtag,
} = require("../src/server/modules/calendar/feed-cache.cjs");
const { feedWindow } = require("../src/server/modules/calendar/feed.cjs");
const {
  routes,
} = require("../src/server/modules/calendar/subscription-routes.cjs");
const {
  createReadCacheBudget,
} = require("../src/server/infrastructure/read-cache-budget.cjs");

const now = Date.parse("2026-10-15T12:00:00Z");
function fixture() {
  const current = {
    organizationId: "org",
    accountId: "a",
    role: "cosmetologist",
  };
  const state = {
    zone: "Europe/Moscow",
    appointmentVersions: { a: "a-1", b: "b-1", c: "c-1" },
    personalVersions: { a: "p-1", b: "q-1", c: "r-1" },
    appointments: ["a", "b", "c"].map((staffId) => ({
      id: "appointment-" + staffId,
      staffId,
      date: "2026-10-16",
      time: "12:00",
      duration: 30,
      patientName: "Клиент " + staffId.toUpperCase(),
    })),
    personalEvents: [
      {
        id: "personal-a",
        staffId: "a",
        date: "2026-10-17",
        time: "13:00",
        duration: 60,
      },
    ],
    snapshots: [],
    personalReads: 0,
  };
  const storage = {
    calendarOccupancyVersion: (staffId) => state.appointmentVersions[staffId],
    calendarSnapshot(from, to, options) {
      assert.equal(options.projection, "subscription");
      state.snapshots.push({ from, to, options });
      state.onSnapshot?.();
      return {
        appointments: state.appointments.filter(
          (a) =>
            a.staffId === options.staffId && a.date >= from && a.date <= to,
        ),
      };
    },
  };
  const platform = {
    calendarSubscription: {
      metadata: (actor) => ({
        zone: state.zone,
        personalVersion: state.personalVersions[actor.accountId],
      }),
    },
    personalEvents: {
      view(actor, from, to, options) {
        state.personalReads++;
        assert.equal(options.projection, "occupancy");
        assert.equal(actor.role, "cosmetologist");
        return {
          personalEvents: state.personalEvents.filter(
            (event) =>
              event.staffId === actor.accountId &&
              event.date >= from &&
              event.date <= to,
          ),
        };
      },
    },
  };
  const read = (cache, options = {}) =>
    cache.read({ current, storage, platform, now, ...options });
  return { current, state, storage, platform, read };
}

test("repeat downloads reuse one bounded subscription snapshot and do not read personal events again", () => {
  const { read, state } = fixture();
  const cache = createCalendarFeedCache();
  const first = read(cache);
  const repeated = read(cache, { now: now + 600000 });
  assert.equal(first.unchanged, false);
  assert.equal(repeated.body, first.body);
  assert.equal(repeated.etag, first.etag);
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.personalReads, 1);
  assert.deepEqual(state.snapshots[0], {
    from: "2026-10-08",
    to: "2026-11-14",
    options: { staffId: "a", projection: "subscription" },
  });
  assert.equal(
    (Date.parse(state.snapshots[0].to) - Date.parse(state.snapshots[0].from)) /
      86400000 +
      1,
    38,
  );
  assert.equal((first.body.match(/BEGIN:VEVENT/g) || []).length, 2);
});

test("another employee and clinical notes do not invalidate the exported occupancy", () => {
  const { read, state } = fixture();
  const cache = createCalendarFeedCache();
  const first = read(cache);
  state.appointments[0].notes = "Synthetic clinical note";
  state.appointmentVersions.b = "b-2";
  state.personalVersions.b = "q-2";
  state.appointments[1].time = "15:00";
  assert.deepEqual(read(cache), first);
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.personalReads, 1);
});

test("renaming the client changes the staff feed and validator after its persisted version advances", () => {
  const { read, state } = fixture();
  const cache = createCalendarFeedCache();
  const first = read(cache);
  assert.ok(
    first.body
      .replace(/\r\n[ \t]/g, "")
      .includes("SUMMARY:Клиент A — приём\r\n"),
  );
  state.appointments[0].patientName = "Новое имя";
  state.appointmentVersions.a = "a-name-2";
  const renamed = read(cache, { ifNoneMatch: first.etag });
  assert.equal(renamed.unchanged, false);
  assert.notEqual(renamed.etag, first.etag);
  assert.ok(
    renamed.body
      .replace(/\r\n[ \t]/g, "")
      .includes("SUMMARY:Новое имя — приём\r\n"),
  );
  assert.ok(!renamed.body.includes("Клиент A"));
  assert.equal(state.snapshots.length, 2);
  assert.deepEqual(read(cache), renamed);
  assert.equal(state.snapshots.length, 2);
});

test("rescheduling, personal occupancy, cancellations and deletions update the feed after their versions change", () => {
  const { read, state } = fixture();
  const cache = createCalendarFeedCache();
  const first = read(cache);
  state.appointments[0].time = "14:00";
  state.appointmentVersions.a = "a-2";
  const moved = read(cache, { ifNoneMatch: first.etag });
  assert.equal(moved.unchanged, false);
  assert.notEqual(moved.etag, first.etag);
  assert.match(moved.body, /DTSTART:20261016T110000Z/);
  state.personalEvents[0].duration = 90;
  state.personalVersions.a = "p-2";
  const personal = read(cache);
  assert.notEqual(personal.etag, moved.etag);
  assert.match(personal.body, /DTEND:20261017T113000Z/);
  state.appointments[0].status = "cancelled";
  state.appointmentVersions.a = "a-3";
  assert.equal((read(cache).body.match(/BEGIN:VEVENT/g) || []).length, 1);
  state.personalEvents = [];
  state.personalVersions.a = "p-3";
  assert.doesNotMatch(read(cache).body, /BEGIN:VEVENT/);
  assert.equal(state.snapshots.length, 5);
});

test("the local day boundary and organization time zone invalidate the window and UTC times", () => {
  const { read, state } = fixture();
  const cache = createCalendarFeedCache();
  const before = read(cache, { now: Date.parse("2026-10-15T20:59:00Z") });
  const nextDay = read(cache, { now: Date.parse("2026-10-15T21:01:00Z") });
  assert.notEqual(before.etag, nextDay.etag);
  assert.deepEqual(feedWindow(Date.parse("2026-10-15T21:01:00Z"), state.zone), {
    from: "2026-10-09",
    to: "2026-11-15",
  });
  state.zone = "Asia/Yerevan";
  const shifted = read(cache, { now: Date.parse("2026-10-15T21:01:00Z") });
  assert.notEqual(shifted.etag, nextDay.etag);
  assert.match(shifted.body, /DTSTART:20261016T080000Z/);
  assert.equal(state.snapshots.length, 3);
});

test("independent workers share a weak validator despite their different generation timestamps", () => {
  const { read, state } = fixture();
  const first = read(createCalendarFeedCache());
  const second = read(createCalendarFeedCache(), { now: now + 600000 });
  assert.match(first.etag, /^W\/"[a-f0-9]+"$/);
  assert.equal(second.etag, first.etag);
  assert.notEqual(second.body, first.body);
  const readsBefore = state.snapshots.length;
  const cold = read(createCalendarFeedCache(), { ifNoneMatch: second.etag });
  assert.deepEqual(cold, { etag: first.etag, unchanged: true });
  assert.equal(state.snapshots.length, readsBefore);
  assert.equal(state.personalReads, readsBefore);
});

test("conditional downloads accept weak and strong validators, lists and wildcard", () => {
  const etag = 'W/"current"';
  for (const value of [
    etag,
    '"current"',
    ' "old", W/"current" ',
    "*",
    '"old", *',
  ])
    assert.equal(matchesEtag(value, etag), true, value);
  for (const value of [
    undefined,
    "",
    'W/"old"',
    '"current-extra"',
    '"CURRENT"',
  ])
    assert.equal(matchesEtag(value, etag), false, String(value));
  const { read, state } = fixture();
  const result = read(createCalendarFeedCache(), { ifNoneMatch: "*" });
  assert.equal(result.unchanged, true);
  assert.equal(result.body, undefined);
  assert.equal(state.snapshots.length, 0);
  assert.equal(state.personalReads, 0);
});

test("entry LRU evicts the least recently used employee, and clear releases retained bytes", () => {
  const { current, read, state } = fixture();
  const budget = createReadCacheBudget({ maxBytes: 100000 });
  const cache = createCalendarFeedCache({ maxEntries: 2, budget });
  const as = (accountId) => read(cache, { current: { ...current, accountId } });
  as("a");
  as("b");
  as("a");
  as("c");
  assert.equal(state.snapshots.length, 3);
  as("a");
  assert.equal(state.snapshots.length, 3);
  as("b");
  assert.equal(state.snapshots.length, 4);
  assert.equal(budget.stats().entries, 2);
  assert.ok(budget.stats().bytes > 0);
  cache.clear();
  assert.equal(budget.stats().bytes, 0);
  assert.equal(budget.stats().entries, 0);
});

test("oversized or globally evicted feeds are returned safely and rebuilt on the next request", () => {
  for (const options of [
    { maxBytes: 1 },
    { maxEntries: 0 },
    { budget: createReadCacheBudget({ maxBytes: 1 }) },
  ]) {
    const { read, state } = fixture();
    const cache = createCalendarFeedCache(options);
    assert.match(read(cache).body, /BEGIN:VCALENDAR/);
    read(cache);
    assert.equal(state.snapshots.length, 2);
  }
  const { read, state } = fixture();
  const budget = createReadCacheBudget({ maxBytes: 100000 });
  const cache = createCalendarFeedCache({ budget });
  read(cache);
  budget.clear();
  read(cache);
  assert.equal(state.snapshots.length, 2);
});

test("a concurrent occupancy change retries once and caches only the current version", () => {
  const { read, state } = fixture();
  state.onSnapshot = () => {
    state.appointmentVersions.a = "a-2";
    state.appointments[0].time = "16:00";
    state.onSnapshot = undefined;
  };
  const cache = createCalendarFeedCache();
  const fresh = read(cache);
  assert.equal(state.snapshots.length, 2);
  assert.match(fresh.body, /DTSTART:20261016T130000Z/);
  assert.deepEqual(read(cache), fresh);
  assert.equal(state.snapshots.length, 2);
});

test("continuous external changes stop after two attempts instead of blocking the server", () => {
  const { read, state } = fixture();
  state.onSnapshot = () => {
    state.appointmentVersions.a += "-changed";
  };
  assert.throws(
    () => read(createCalendarFeedCache()),
    (error) => error.status === 503 && error.retryAfter === 1,
  );
  assert.equal(state.snapshots.length, 2);
});

test("feed route checks revocation before and after cached 200 and 304 responses", () => {
  const route = routes.find(
    (item) => item.method === "GET" && item.path === "/api/calendar/feed.ics",
  );
  for (const unchanged of [false, true]) {
    for (const revokeAt of [1, 2]) {
      let resolves = 0,
        reads = 0,
        emitted = 0;
      const revoked = Object.assign(
        new Error("Synthetic revoked subscription"),
        { status: 404 },
      );
      const context = {
        url: new URL(
          "https://example.test/api/calendar/feed.ics?subscription=synthetic",
        ),
        req: { headers: { "if-none-match": 'W/"cached"' } },
        platform: {
          calendarSubscription: {
            resolve() {
              if (++resolves === revokeAt) throw revoked;
              return { organizationId: "org", accountId: "a" };
            },
          },
        },
        tenantStore: () => ({}),
        calendarFeeds: {
          read() {
            reads++;
            return {
              etag: 'W/"cached"',
              body: "Synthetic calendar",
              unchanged,
            };
          },
        },
        res: {
          setHeader() {
            emitted++;
          },
          writeHead() {
            emitted++;
          },
          end() {
            emitted++;
          },
        },
      };
      assert.throws(
        () => route.handle(context),
        (error) => error === revoked,
      );
      assert.equal(resolves, revokeAt);
      assert.equal(reads, revokeAt - 1);
      assert.equal(emitted, 0);
    }
  }
});
