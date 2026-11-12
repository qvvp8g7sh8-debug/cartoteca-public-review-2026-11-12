const serviceConnectionSchema = `
CREATE TABLE billing_service_connections(
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 service TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 key_id TEXT,
 credential_hash TEXT,
 value BLOB NOT NULL,
 changed_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,service)
);
CREATE TABLE billing_customer_operations(
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 account_id TEXT NOT NULL REFERENCES accounts(id),
 request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 value BLOB NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,account_id,request_id)
);
`;
module.exports = { serviceConnectionSchema, serviceConnectionSchemaSQL: serviceConnectionSchema };
