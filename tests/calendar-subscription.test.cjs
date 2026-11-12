const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const {
  createCalendarSubscription,
} = require("../src/server/modules/calendar/subscription.cjs");
const {
  calendarFeed,
  fold,
} = require("../src/server/modules/calendar/feed.cjs");
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,value TEXT,status TEXT);
    CREATE TABLE memberships(account_id TEXT,organization_id TEXT,role TEXT,status TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO accounts VALUES('a','{}','active'),('b','{}','active');
    INSERT INTO organizations VALUES('org','active'),('other','active');
    INSERT INTO memberships VALUES('a','org','cosmetologist','active'),('b','org','cosmetologist','active'),('a','other','owner','active');`);
  let active = true;
  const activity = { transactions: 0, audits: 0 };
  const sessions = {
    a: { accountId: "a", organizationId: "org" },
    b: { accountId: "b", organizationId: "org" },
    other: { accountId: "a", organizationId: "other" },
  };
  const service = createCalendarSubscription({
    db,
    open: JSON.parse,
    seal: JSON.stringify,
    transaction: (fn) => {
      activity.transactions++;
      return fn();
    },
    session: (token) => sessions[token],
    audit() {
      activity.audits++;
    },
    subscription: () => ({ status: active ? "active" : "suspended" }),
  });
  return {
    db,
    service,
    activity,
    changes: () =>
      db.prepare("SELECT total_changes() AS changes").get().changes,
    subscriptions: (id = "a") =>
      JSON.parse(
        db.prepare("SELECT value FROM accounts WHERE id=?").get(id).value,
      ).calendarSubscriptions,
    suspendPlan: () => {
      active = false;
    },
  };
}
test("subscription belongs to one account and organization, revokes old credentials", (t) => {
  const { service } = fixture(t),
    guard = () => {};
  const first = service.connect("a", guard);
  assert.equal(service.connect("a", guard).credential, first.credential);
  assert.equal(service.status("b").connected, false);
  assert.notEqual(service.connect("other", guard).credential, first.credential);
  assert.deepEqual(service.resolve(first.credential), {
    accountId: "a",
    organizationId: "org",
    role: "cosmetologist",
  });
  const forged = JSON.parse(Buffer.from(first.credential, "base64url"));
  forged[0] = "b";
  assert.throws(
    () =>
      service.resolve(
        Buffer.from(JSON.stringify(forged)).toString("base64url"),
      ),
    {
      status: 404,
    },
  );
  service.disconnect("a", guard);
  assert.throws(() => service.resolve(first.credential), { status: 404 });
  assert.notEqual(service.connect("a", guard).credential, first.credential);
});
test("feed access checks live membership, account, organization, role and subscription", (t) => {
  for (const provider of ["apple", "google"]) {
    const { service, db, suspendPlan } = fixture(t);
    const { credential } = service.connect("a", () => {}, provider);
    for (const [table, condition] of [
      ["accounts", "id='a'"],
      ["organizations", "id='org'"],
      ["memberships", "account_id='a' AND organization_id='org'"],
    ]) {
      db.exec(`UPDATE ${table} SET status='suspended' WHERE ${condition}`);
      assert.throws(() => service.resolve(credential), { status: 404 });
      assert.throws(() => service.status("a", provider), { status: 403 });
      assert.throws(() => service.connect("a", () => {}, provider), {
        status: 403,
      });
      assert.throws(() => service.disconnect("a", () => {}, provider), {
        status: 403,
      });
      db.exec(`UPDATE ${table} SET status='active' WHERE ${condition}`);
      assert.equal(service.resolve(credential).accountId, "a");
    }
    db.exec("UPDATE memberships SET role='salon_admin' WHERE account_id='a'");
    assert.throws(() => service.resolve(credential), { status: 404 });
    const admin = service.connect("a", () => {}, provider);
    assert.notEqual(admin.credential, credential);
    assert.equal(service.resolve(admin.credential).role, "salon_admin");
    db.exec("UPDATE memberships SET role='cosmetologist' WHERE account_id='a'");
    assert.throws(() => service.resolve(admin.credential), { status: 404 });
    assert.equal(service.resolve(credential).role, "cosmetologist");
    suspendPlan();
    assert.throws(() => service.resolve(credential), { status: 404 });
    assert.throws(() => service.connect("a", () => {}, provider), {
      status: 403,
    });
    assert.throws(() => service.resolve("invalid"), { status: 404 });
  }
});

const encodeCredential = (values) =>
  Buffer.from(JSON.stringify(values)).toString("base64url");
const decodeCredential = (credential) =>
  JSON.parse(Buffer.from(credential, "base64url"));
const guard = () => {};

test("an existing Apple credential survives the Google upgrade without a rewrite", (t) => {
  const { service, db, changes, subscriptions } = fixture(t);
  const legacySecret = "legacy-apple-subscription-secret";
  db.prepare("UPDATE accounts SET value=? WHERE id=?").run(
    JSON.stringify({
      calendarSubscriptions: { org: { secret: legacySecret } },
    }),
    "a",
  );
  const legacy = encodeCredential(["a", "org", legacySecret]);
  const before = changes();
  assert.equal(service.status("a").credential, legacy);
  assert.equal(service.status("a", "apple").credential, legacy);
  assert.equal(service.connect("a", guard).credential, legacy);
  assert.equal(changes(), before);
  assert.deepEqual(service.status("a", "google"), {
    connected: false,
    credential: null,
  });
  const google = service.connect("a", guard, "google");
  assert.equal(subscriptions().org.secret, legacySecret);
  assert.notEqual(subscriptions().org.googleSecret, legacySecret);
  assert.deepEqual(decodeCredential(google.credential), [
    "a",
    "org",
    subscriptions().org.googleSecret,
    "google",
  ]);
  const afterConnect = changes();
  assert.equal(
    service.connect("a", guard, "google").credential,
    google.credential,
  );
  assert.equal(changes(), afterConnect);
  assert.equal(service.status("a").credential, legacy);
  assert.equal(service.resolve(legacy).accountId, "a");
  service.disconnect("a", guard, "google");
  assert.equal(service.resolve(legacy).accountId, "a");
  assert.deepEqual(subscriptions().org, { secret: legacySecret });
});

test("Apple and Google revoke and reconnect independently while other identities remain connected", (t) => {
  const { service, subscriptions } = fixture(t);
  const apple = service.connect("a", guard).credential;
  const google = service.connect("a", guard, "google").credential;
  const otherOrganization = service.connect(
    "other",
    guard,
    "google",
  ).credential;
  const otherAccount = service.connect("b", guard, "google").credential;
  service.disconnect("a", guard, "google");
  assert.throws(() => service.resolve(google), { status: 404 });
  assert.equal(service.status("a").credential, apple);
  assert.equal(service.resolve(apple).accountId, "a");
  const newGoogle = service.connect("a", guard, "google").credential;
  assert.notEqual(newGoogle, google);
  service.disconnect("a", guard, "apple");
  assert.throws(() => service.resolve(apple), { status: 404 });
  assert.deepEqual(service.status("a"), { connected: false, credential: null });
  assert.equal(service.status("a", "google").credential, newGoogle);
  assert.equal(service.resolve(newGoogle).accountId, "a");
  assert.deepEqual(Object.keys(subscriptions().org), ["googleSecret"]);
  const newApple = service.connect("a", guard, "apple").credential;
  assert.notEqual(newApple, apple);
  assert.equal(service.status("a", "google").credential, newGoogle);
  service.disconnect("a", guard);
  assert.equal(service.resolve(newGoogle).accountId, "a");
  service.disconnect("a", guard, "google");
  assert.equal(subscriptions().org, undefined);
  assert.equal(service.resolve(otherOrganization).organizationId, "other");
  assert.equal(service.resolve(otherAccount).accountId, "b");
  assert.throws(() => service.resolve(newApple), { status: 404 });
  assert.throws(() => service.resolve(newGoogle), { status: 404 });
});

test("credentials reject provider, secret and identity swaps and malformed tuples", (t) => {
  const { service } = fixture(t);
  const apple = decodeCredential(service.connect("a", guard).credential);
  const google = decodeCredential(
    service.connect("a", guard, "google").credential,
  );
  const foreign = decodeCredential(
    service.connect("b", guard, "google").credential,
  );
  service.connect("other", guard, "google");
  for (const values of [
    [...apple, "google"],
    google.slice(0, 3),
    [...apple, "apple"],
    ["b", "org", google[2], "google"],
    ["a", "other", google[2], "google"],
    ["a", "org", foreign[2], "google"],
    ["a", "org", google[2], "unknown"],
    [...google, "extra"],
    ["a", "org"],
    ["a", "org", 123],
    ["", "org", google[2], "google"],
    ["a", null, google[2], "google"],
    { accountId: "a", organizationId: "org", secret: google[2] },
  ])
    assert.throws(() => service.resolve(encodeCredential(values)), {
      status: 404,
    });
  for (const credential of [null, "", "bad=encoding", "a".repeat(1025)])
    assert.throws(() => service.resolve(credential), { status: 404 });
  assert.equal(service.resolve(encodeCredential(apple)).accountId, "a");
  assert.equal(service.resolve(encodeCredential(google)).accountId, "a");
});

test("unknown providers and stale mutation guards perform no account writes or audit", (t) => {
  const { service, activity, changes } = fixture(t);
  const before = changes();
  let guards = 0;
  for (const provider of [null, "", "Google", "unknown", 7, {}]) {
    assert.throws(() => service.status("a", provider), { status: 400 });
    for (const method of ["connect", "disconnect"])
      assert.throws(
        () =>
          service[method](
            "a",
            () => {
              guards++;
            },
            provider,
          ),
        { status: 400 },
      );
  }
  assert.equal(changes(), before);
  assert.deepEqual(activity, { transactions: 0, audits: 0 });
  assert.equal(guards, 0);
  for (const provider of ["apple", "google"]) {
    service.connect("a", guard, provider);
    const connected = service.status("a", provider);
    const snapshot = { changes: changes(), audits: activity.audits };
    const stale = Object.assign(new Error("Synthetic stale session"), {
      status: 403,
    });
    for (const method of ["connect", "disconnect"])
      assert.throws(
        () =>
          service[method](
            "a",
            () => {
              throw stale;
            },
            provider,
          ),
        (error) => error === stale,
      );
    assert.deepEqual(service.status("a", provider), connected);
    assert.equal(changes(), snapshot.changes);
    assert.equal(activity.audits, snapshot.audits);
  }
});
test("feed reads a bounded private subscription projection; stable UID follows move, cancellation removes event, personal time crosses midnight", () => {
  let appointments = [
    {
      id: "one",
      staffId: "a",
      date: "2026-10-15",
      time: "12:00",
      duration: 30,
      patientName: "Тестовый Клиент",
      patientPhone: "PHONE_SECRET",
      notes: "SECRET",
    },
    {
      id: "foreign",
      staffId: "b",
      date: "2026-10-15",
      time: "12:00",
      duration: 30,
      patientName: "FOREIGN_NAME",
    },
  ];
  const options = {
    current: { accountId: "a", organizationId: "org", role: "owner" },
    now: Date.parse("2026-10-15T00:00:00Z"),
    storage: {
      calendarSnapshot(from, to, settings) {
        assert.equal(settings.projection, "subscription");
        assert.equal(settings.staffId, "a");
        assert.ok((Date.parse(to) - Date.parse(from)) / 86400000 < 45);
        return {
          appointments: appointments.filter(
            (a) => a.date >= from && a.date <= to,
          ),
        };
      },
    },
    platform: {
      organizationTimeZone: () => "Europe/Moscow",
      personalEvents: {
        view(current, from, to, settings) {
          assert.equal(current.role, "cosmetologist");
          assert.equal(settings.projection, "occupancy");
          return {
            personalEvents: [
              {
                id: "personal",
                staffId: "a",
                date: "2026-10-15",
                time: "23:30",
                duration: 60,
                notes: "SECRET",
                patientName: "PERSONAL_NAME_SECRET",
              },
            ],
          };
        },
      },
    },
  };
  const first = calendarFeed(options),
    uid = first.match(/UID:([^\r]+)/)[1];
  assert.equal((first.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(first, /DTSTART:20261015T203000Z\r\nDTEND:20261015T213000Z/);
  const unfolded = first.replace(/\r\n[ \t]/g, "");
  assert.ok(unfolded.includes("SUMMARY:Тестовый Клиент — приём\r\n"));
  assert.match(unfolded, /^DESCRIPTION:[^\r\n]*30[^\r\n]*мин/m);
  assert.ok(
    !unfolded.includes("SECRET") &&
      !unfolded.includes("foreign") &&
      !unfolded.includes("FOREIGN_NAME"),
  );
  appointments[0].date = "2026-10-16";
  appointments[0].time = "13:00";
  const moved = calendarFeed(options);
  assert.ok(moved.includes("UID:" + uid));
  assert.match(moved, /DTSTART:20261016T100000Z/);
  appointments[0].status = "cancelled";
  assert.equal((calendarFeed(options).match(/BEGIN:VEVENT/g) || []).length, 1);
  appointments = [];
  assert.equal((calendarFeed(options).match(/BEGIN:VEVENT/g) || []).length, 1);
  for (const line of fold("SUMMARY:" + "я".repeat(120)).split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75);
});

function exportAppointments(appointments) {
  return calendarFeed({
    current: { accountId: "a", organizationId: "org", role: "cosmetologist" },
    now: Date.parse("2026-10-15T12:00:00Z"),
    storage: {
      calendarSnapshot(from, to, settings) {
        assert.equal(settings.projection, "subscription");
        assert.equal(settings.staffId, "a");
        return { appointments };
      },
    },
    platform: {
      organizationTimeZone: () => "Europe/Moscow",
      personalEvents: {
        view(current, from, to, settings) {
          assert.equal(settings.projection, "occupancy");
          return { personalEvents: [] };
        },
      },
    },
  });
}

test("named appointment exports its exact start, end and duration without contacts or clinical details", () => {
  const feed = exportAppointments([
    {
      id: "named",
      staffId: "a",
      date: "2026-10-16",
      time: "09:20",
      duration: 45,
      patientName: "Клиент А",
      patientPhone: "+79990001122",
      phone: "+79990003344",
      notes: "CLINICAL_SECRET",
      diagnosis: "DIAGNOSIS_SECRET",
      services: ["SERVICE_SECRET"],
    },
    {
      id: "foreign",
      staffId: "b",
      date: "2026-10-16",
      time: "10:00",
      duration: 60,
      patientName: "FOREIGN_CLIENT_SECRET",
    },
  ]).replace(/\r\n[ \t]/g, "");
  assert.ok(feed.includes("SUMMARY:Клиент А — приём\r\n"));
  assert.match(feed, /^DTSTART:20261016T062000Z\r?$/m);
  assert.match(feed, /^DTEND:20261016T070500Z\r?$/m);
  assert.match(feed, /^DESCRIPTION:[^\r\n]*45[^\r\n]*мин/m);
  assert.equal((feed.match(/^BEGIN:VEVENT\r?$/gm) || []).length, 1);
  for (const hidden of [
    "+79990001122",
    "+79990003344",
    "CLINICAL_SECRET",
    "DIAGNOSIS_SECRET",
    "SERVICE_SECRET",
    "FOREIGN_CLIENT_SECRET",
  ])
    assert.ok(!feed.includes(hidden), hidden);
});

test("client names escape text delimiters and line breaks without injecting calendar fields or events", () => {
  const patientName =
    "Имя\\фамилия;запятая,\r\nBEGIN:VEVENT\nSUMMARY:Чужое\nEND:VEVENT";
  const raw = exportAppointments([
    {
      id: "escaped",
      staffId: "a",
      date: "2026-10-16",
      time: "12:00",
      duration: 30,
      patientName,
    },
  ]);
  const feed = raw.replace(/\r\n[ \t]/g, "");
  assert.ok(
    feed.includes(
      "SUMMARY:Имя\\\\фамилия\\;запятая\\,\\nBEGIN:VEVENT\\nSUMMARY:Чужое\\nEND:VEVENT — приём\r\n",
    ),
  );
  assert.equal((feed.match(/^BEGIN:VEVENT\r?$/gm) || []).length, 1);
  assert.equal((feed.match(/^END:VEVENT\r?$/gm) || []).length, 1);
  assert.equal((feed.match(/^SUMMARY:/gm) || []).length, 1);
  assert.doesNotMatch(feed, /^SUMMARY:Чужое\r?$/m);
  for (const line of raw.split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75);
});

test("an absent or blank client name exports a generic appointment without falling back to the phone", () => {
  for (const patientName of [undefined, "", "   "]) {
    const feed = exportAppointments([
      {
        id: "unnamed",
        staffId: "a",
        date: "2026-10-16",
        time: "12:00",
        duration: 30,
        patientName,
        patientPhone: "+79990001122",
        phone: "+79990003344",
      },
    ]).replace(/\r\n[ \t]/g, "");
    assert.ok(feed.includes("SUMMARY:Приём\r\n"));
    assert.ok(!feed.includes("+79990001122") && !feed.includes("+79990003344"));
  }
});
