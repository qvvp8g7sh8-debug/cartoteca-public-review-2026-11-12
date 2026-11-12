const writes = [];
const add = (sql, org, operations) =>
  writes.push(
    Object.freeze({
      sql,
      org: Object.freeze([...org]),
      operations: Object.freeze([...operations]),
    }),
  );
const save = ['cabinet', 'booking', 'confirmation'];
const all = [...save, 'intent'];
add('INSERT INTO notification_schedule_intents VALUES(?,?,?,?)', [2], all);
add('DELETE FROM notification_schedule_intents WHERE id=? AND organization_id=?', [2], all);
add(
  `INSERT INTO notification_schedule_dirty(kind,organization_id,subject)
    VALUES(?,?,?) ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor=''`,
  [2],
  all,
);
add(
  'DELETE FROM appointment_manual_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=?',
  [1],
  save,
);
add(
  'INSERT OR REPLACE INTO appointment_manual_confirmations VALUES(?,?,?,?)',
  [1],
  ['confirmation'],
);
add(
  "UPDATE telegram_jobs SET status='cancelled' WHERE organization_id=? AND patient_id=? AND fingerprint=? AND status IN ('pending','sending')",
  [1],
  save,
);
add(
  "UPDATE telegram_jobs SET status='cancelled' WHERE organization_id=? AND patient_id=? AND fingerprint=? AND status='pending'",
  [1],
  ['booking', 'confirmation', 'journal'],
);
add(
  "INSERT INTO staff_push_jobs(id,organization_id,account_id,device_id,event_key,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?) ON CONFLICT(device_id,event_key) DO UPDATE SET value=excluded.value,status='pending',next_at=excluded.next_at,expires_at=excluded.expires_at,attempts=0,lease_id=NULL,lease_until=0 WHERE staff_push_jobs.organization_id=excluded.organization_id AND (staff_push_jobs.status='cancelled' OR (? AND staff_push_jobs.status='pending' AND staff_push_jobs.expires_at<>excluded.expires_at))",
  [2],
  save,
);
for (const table of ['staff_notification_jobs', 'staff_max_jobs'])
  add(
    `INSERT OR IGNORE INTO ${table}(id,organization_id,account_id,event_key,value,status,next_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?)`,
    [2],
    ['booking', 'confirmation', 'journal'],
  );
add(
  'INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,?,?)',
  [3],
  ['booking', 'confirmation'],
);
add(
  `INSERT INTO booking_requests
      (id,organization_id,staff_id,request_key,value,status,expires_at,day_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
  [2],
  ['booking'],
);
add(
  'UPDATE booking_requests SET value=?,day_key=? WHERE organization_id=? AND id=?',
  [3],
  ['booking'],
);
add(
  'UPDATE booking_requests SET status=?,revision=revision+1 WHERE organization_id=? AND id=? AND revision=?',
  [2],
  ['booking'],
);
add('UPDATE booking_requests SET value=? WHERE organization_id=? AND id=?', [2], ['booking']);
add(
  'UPDATE booking_requests SET value=?,day_key=?,revision=revision+1 WHERE organization_id=? AND id=? AND revision=?',
  [3],
  ['booking'],
);
add(
  "UPDATE notification_channel_jobs SET status='cancelled',lease_until=0 WHERE organization_id=? AND patient_id=? AND (?='' OR appointment_id=?) AND status IN ('pending','reserved')",
  [1],
  ['booking', 'confirmation'],
);
add(
  "UPDATE notification_channel_jobs SET status='cancelled',lease_until=0,value=? WHERE id=? AND organization_id=? AND status IN ('pending','reserved')",
  [3],
  ['booking', 'confirmation'],
);
add(
  "UPDATE notification_channel_jobs SET callback_hash=?,value=?,status='pending',next_at=?,expires_at=?,attempt=0,lease_until=0 WHERE id=? AND organization_id=? AND status='cancelled'",
  [6],
  ['booking', 'journal'],
);
add(
  "INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)",
  [2],
  ['booking', 'journal'],
);
add('INSERT INTO notification_confirmations VALUES(?,?,?,?,?)', [1], ['confirmation']);
module.exports = Object.freeze(writes);
