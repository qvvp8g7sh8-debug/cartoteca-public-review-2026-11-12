const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const {
  createCalendarSubscription,
} = require("../src/server/modules/calendar/subscription.cjs");
const {
  routes,
} = require("../src/server/modules/calendar/subscription-routes.cjs");

const subscriptionRoute = (method) =>
  routes.find(
    (route) =>
      route.method === method && route.path === "/api/calendar/subscription",
  );
const feedRoute = routes.find(
  (route) => route.path === "/api/calendar/feed.ics",
);

test("subscription routes dispatch the selected provider and preserve Apple as the default", async () => {
  for (const [query, provider] of [
    ["", "apple"],
    ["?provider=apple", "apple"],
    ["?provider=google", "google"],
  ]) {
    for (const [method, operation] of [
      ["GET", "status"],
      ["POST", "connect"],
      ["DELETE", "disconnect"],
    ]) {
      const calls = [],
        result = {
          connected: method !== "DELETE",
          credential: "synthetic-credential",
        };
      const assertCurrent = () => {};
      const context = {
        url: new URL("https://example.test/api/calendar/subscription" + query),
        req: {},
        res: {},
        token: "synthetic-session",
        assertCurrent,
        readBody: async (req, limit) => {
          assert.equal(req, context.req);
          assert.equal(limit, 1024);
          calls.push("body");
        },
        json: (res, code, body) => {
          assert.equal(res, context.res);
          assert.equal(code, 200);
          assert.equal(body, result);
          calls.push("json");
          return body;
        },
        platform: {
          calendarSubscription: {
            [operation](...args) {
              calls.push(args);
              return result;
            },
          },
        },
      };
      const route = subscriptionRoute(method);
      assert.equal(route.access, "organization");
      assert.equal(await route.handle(context), result);
      assert.deepEqual(calls, [
        ...(method === "GET" ? [] : ["body"]),
        method === "GET"
          ? [context.token, provider]
          : [context.token, assertCurrent, provider],
        "json",
      ]);
    }
  }
});

test("invalid or ambiguous providers are rejected before body, service or response work", async () => {
  for (const query of [
    "?provider=",
    "?provider=Google",
    "?provider=unknown",
    "?provider=apple&provider=google",
    "?provider=google&provider=google",
  ]) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      let work = 0;
      const unexpected = () => {
        work++;
        throw Error("Provider validation was too late");
      };
      const context = {
        url: new URL("https://example.test/api/calendar/subscription" + query),
        req: {},
        res: {},
        token: "synthetic-session",
        assertCurrent: unexpected,
        readBody: unexpected,
        json: unexpected,
        platform: {
          calendarSubscription: {
            status: unexpected,
            connect: unexpected,
            disconnect: unexpected,
            updateSelection: unexpected,
          },
        },
      };
      await assert.rejects(
        async () => subscriptionRoute(method).handle(context),
        { status: 400 },
      );
      assert.equal(work, 0);
    }
  }
});

function feedFixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,value TEXT,status TEXT);
    CREATE TABLE memberships(account_id TEXT,organization_id TEXT,role TEXT,status TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO accounts VALUES('a','{}','active');
    INSERT INTO organizations VALUES('org','active');
    INSERT INTO memberships VALUES('a','org','cosmetologist','active');`);
  const service = createCalendarSubscription({
    db,
    open: JSON.parse,
    seal: JSON.stringify,
    transaction: (fn) => fn(),
    audit() {},
    session: () => ({ accountId: "a", organizationId: "org" }),
    subscription: () => ({ status: "active" }),
  });
  const guard = () => {};
  const apple = service.connect("session", guard).credential;
  function request(credential, unchanged, afterRead = () => {}) {
    const observed = {
      reads: [],
      headers: [],
      responses: [],
      resolves: 0,
      stores: 0,
    };
    const storage = {};
    const platform = {
      calendarSubscription: {
        resolve(value) {
          observed.resolves++;
          return service.resolve(value);
        },
      },
    };
    const context = {
      url: new URL(
        "https://example.test/api/calendar/feed.ics?subscription=" + credential,
      ),
      req: { headers: { "if-none-match": 'W/"shared"' } },
      platform,
      tenantStore(organizationId) {
        assert.equal(organizationId, "org");
        observed.stores++;
        return storage;
      },
      calendarFeeds: {
        read(options) {
          assert.deepEqual(options, {
            current: {
              accountId: "a",
              organizationId: "org",
              role: "cosmetologist",
            },
            storage,
            platform,
            ifNoneMatch: 'W/"shared"',
          });
          observed.reads.push(options);
          afterRead();
          return {
            etag: 'W/"shared"',
            body: "Synthetic shared feed",
            unchanged,
          };
        },
      },
      res: {
        setHeader(name, value) {
          observed.headers.push([name, value]);
        },
        writeHead(...args) {
          observed.responses.push(args);
        },
        end(body) {
          observed.responses.push(body);
        },
      },
    };
    return { context, observed };
  }
  return { service, guard, apple, request };
}

test("Google credentials use the shared feed and both authorization checks for 200 and 304", (t) => {
  const { service, guard, apple, request } = feedFixture(t);
  for (const unchanged of [false, true]) {
    const google = service.connect("session", guard, "google").credential;
    const download = request(google, unchanged);
    feedRoute.handle(download.context);
    assert.equal(download.observed.resolves, 2);
    assert.equal(download.observed.reads.length, 1);
    assert.equal(download.observed.responses[0][0], unchanged ? 304 : 200);
    assert.equal(
      download.observed.responses[1],
      unchanged ? undefined : "Synthetic shared feed",
    );
    assert.ok(
      download.observed.headers.some(
        ([name, value]) =>
          name === "Cache-Control" && value === "private, no-cache",
      ),
    );
    const revoked = request(google, unchanged, () =>
      service.disconnect("session", guard, "google"),
    );
    assert.throws(() => feedRoute.handle(revoked.context), { status: 404 });
    assert.equal(revoked.observed.resolves, 2);
    assert.equal(revoked.observed.reads.length, 1);
    assert.deepEqual(revoked.observed.headers, []);
    assert.deepEqual(revoked.observed.responses, []);
    assert.equal(service.resolve(apple).accountId, "a");
  }
});

test("malformed provider credentials stop the feed before any tenant/cache read or response", (t) => {
  const { service, guard, request } = feedFixture(t);
  const google = JSON.parse(
    Buffer.from(
      service.connect("session", guard, "google").credential,
      "base64url",
    ),
  );
  for (const values of [
    google.slice(0, 3),
    [...google.slice(0, 3), "apple"],
    [...google, "extra"],
    ["a", "org", {}, "google"],
  ]) {
    const credential = Buffer.from(JSON.stringify(values)).toString(
      "base64url",
    );
    const download = request(credential, false);
    assert.throws(() => feedRoute.handle(download.context), { status: 404 });
    assert.equal(download.observed.resolves, 1);
    assert.equal(download.observed.stores, 0);
    assert.deepEqual(download.observed.reads, []);
    assert.deepEqual(download.observed.headers, []);
    assert.deepEqual(download.observed.responses, []);
  }
});
