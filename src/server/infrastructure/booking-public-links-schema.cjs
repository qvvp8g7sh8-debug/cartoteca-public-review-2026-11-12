// A separately prepared component: never change platform user_version or create
// tables at application startup. Public codes are durable identities, not secrets.
const definitions = [
  {
    type: 'table',
    name: 'booking_public_links_schema',
    sql: `CREATE TABLE booking_public_links_schema(
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1))`,
  },
  {
    type: 'table',
    name: 'booking_public_links',
    sql: `CREATE TABLE booking_public_links(
      code TEXT PRIMARY KEY NOT NULL CHECK(typeof(code)='text' AND length(code)=8 AND length(CAST(code AS BLOB))=8 AND code NOT GLOB '*[^a-z0-9]*'),
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      staff_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
      UNIQUE(organization_id,staff_id))`,
  },
  {
    type: 'trigger',
    name: 'booking_public_links_no_reassignment',
    sql: `CREATE TRIGGER booking_public_links_no_reassignment
      BEFORE UPDATE OF code,organization_id,staff_id ON booking_public_links
      WHEN NEW.code<>OLD.code OR NEW.organization_id<>OLD.organization_id OR NEW.staff_id<>OLD.staff_id
      BEGIN SELECT RAISE(ABORT,'Public booking links cannot be reassigned'); END`,
  },
  {
    type: 'trigger',
    name: 'booking_public_links_no_delete',
    sql: `CREATE TRIGGER booking_public_links_no_delete BEFORE DELETE ON booking_public_links
      BEGIN SELECT RAISE(ABORT,'Public booking links must be preserved'); END`,
  },
];
const schema =
  definitions.map(({ sql }) => sql + ';').join('\n') +
  '\nINSERT INTO booking_public_links_schema(id,version) VALUES(1,1);';
const normalize = (sql) =>
  String(sql || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function validate(db) {
  const objects = db
    .prepare("SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'booking_public_links%'")
    .all();
  if (!objects.length) return null;
  if (
    objects.length !== definitions.length ||
    definitions.some((definition) => {
      const actual = objects.find(({ name }) => name === definition.name);
      return (
        !actual ||
        actual.type !== definition.type ||
        normalize(actual.sql) !== normalize(definition.sql)
      );
    })
  )
    throw Error('Public booking links component schema mismatch');
  const registration = db.prepare('SELECT id,version FROM booking_public_links_schema').all();
  if (registration.length !== 1 || registration[0].id !== 1 || registration[0].version !== 1)
    throw Error('Public booking links component registration mismatch');
  if (
    db
      .prepare(
        `SELECT 1 FROM booking_public_links links
    LEFT JOIN organizations org ON org.id=links.organization_id
    WHERE typeof(links.code)<>'text' OR length(links.code)<>8 OR length(CAST(links.code AS BLOB))<>8 OR links.code GLOB '*[^a-z0-9]*'
      OR typeof(links.organization_id)<>'text' OR org.id IS NULL
      OR typeof(links.staff_id)<>'text' OR length(links.staff_id)>120
      OR typeof(links.created_at)<>'integer' OR links.created_at<0 OR links.created_at>9007199254740991
    LIMIT 1`,
      )
      .get()
  )
    throw Error('Invalid public booking link mapping');
  return { version: 1 };
}

module.exports = { schema, validate };
