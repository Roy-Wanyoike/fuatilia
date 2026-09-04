'use strict';
/**
 * db/pgclient.cjs — minimal PostgreSQL frontend (wire protocol v3, stdlib only).
 *
 * WHY THIS EXISTS: the portable PostgreSQL 16.4 toolchain at $HOME/tools/pgsql
 * ships initdb/pg_ctl/postgres but NO psql, and the repo must not gain
 * dependencies (house rule: lanes import nothing outside their own directory,
 * stdlib only). This module speaks just enough of the PostgreSQL
 * frontend/backend protocol to run our migrations and smoke assertions:
 *
 *   - startup + AuthenticationOk (trust auth ONLY — validate.sh always
 *     initdb's a throwaway cluster with -A trust; SASL/md5 auth is refused
 *     loudly rather than half-supported);
 *   - the simple-query protocol: one Query message per call, which the server
 *     wraps in a single implicit transaction (so a whole migration file is
 *     atomic without explicit BEGIN/COMMIT);
 *   - ErrorResponse/NoticeResponse parsing (severity, SQLSTATE code, message,
 *     position) and CommandComplete tag collection.
 *
 * Everything else (TLS, COPY, binary formats, prepared statements) is
 * deliberately unimplemented and refused with a clear error.
 */

const net = require('net');

const PROTOCOL_VERSION = 196608; // 3.0

/** Parse one length-prefixed backend message. Returns null when more bytes are needed. */
function parseMessage(buf) {
  if (buf.length < 5) return null;
  const type = String.fromCharCode(buf[0]);
  const len = buf.readInt32BE(1); // includes the 4 length bytes, excludes the type byte
  if (buf.length < 1 + len) return null;
  return { type, body: buf.subarray(5, 1 + len), rest: buf.subarray(1 + len) };
}

/** ErrorResponse / NoticeResponse fields (null-terminated key/value pairs). */
function parseErrorFields(body) {
  const fields = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const key = String.fromCharCode(body[i]);
    let end = body.indexOf(0, i + 1);
    if (end === -1) end = body.length;
    fields[key] = body.toString('utf8', i + 1, end);
    i = end + 1;
  }
  return fields;
}

class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'unknown PostgreSQL error');
    this.name = 'PgError';
    this.severity = fields.S || fields.V || 'ERROR';
    this.code = fields.C || 'XX000';
    this.position = fields.P ? Number(fields.P) : null;
    this.detail = fields.D || null;
  }
}

/**
 * Open a connection and run startup. Options: {host, port, user, database}.
 * Trust authentication is the only supported path by design.
 */
function connect(opts) {
  const { host = '127.0.0.1', port = 5432, user, database } = opts;
  if (!user || !database) {
    return Promise.reject(new Error('pgclient.connect requires user and database'));
  }

  const socket = net.connect({ host, port });
  let buf = Buffer.alloc(0);
  let settled = false;

  let rejectStartup = null;
  const fail = (err) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    const wrapped = err instanceof Error ? err : new Error(`pgclient: ${String(err)}`);
    if (rejectStartup) rejectStartup(wrapped);
  };

  const promise = new Promise((resolve, reject) => {
    rejectStartup = reject;

    // --- startup message ------------------------------------------------------
    // Layout: Int32 total len | Int32 196608 | "key\0value\0" pairs | \0 terminator
    const params = [
      ['user', user],
      ['database', database],
      ['application_name', 'fuatilia-db-validate'],
    ];
    let payload = Buffer.alloc(8);
    payload.writeInt32BE(PROTOCOL_VERSION, 4);
    for (const [k, v] of params) {
      payload = Buffer.concat([payload, Buffer.from(`${k}\0${v}\0`, 'utf8')]);
    }
    payload = Buffer.concat([payload, Buffer.from([0])]); // protocol terminator
    payload.writeInt32BE(payload.length, 0);
    socket.write(payload);

    // --- backend message loop -------------------------------------------------
    socket.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const msg = parseMessage(buf);
        if (!msg) break;
        buf = msg.rest;
        if (msg.type === 'E') {
          fail(new PgError(parseErrorFields(msg.body)));
          return;
        }
        if (msg.type === 'R') {
          const authType = msg.body.readInt32BE(0);
          if (authType === 0) continue; // AuthenticationOk
          fail(
            new Error(
              `unsupported auth request (type ${authType}) — this client speaks trust auth only`,
            ),
          );
          return;
        }
        if (msg.type === 'S' || msg.type === 'K' || msg.type === 'N') {
          continue; // ParameterStatus / BackendKeyData / NoticeResponse
        }
        if (msg.type === 'Z') {
          // ReadyForQuery — startup complete.
          settled = true;
          socket.removeListener('data', onData);
          resolve({ socket, query, end });
          return;
        }
        fail(new Error(`unexpected message ${msg.type} during startup`));
        return;
      }
    });

    socket.on('error', (err) => fail(err));
    socket.on('close', () => {
      if (!settled) fail(new Error('connection closed before startup completed'));
    });
  });

  // --- simple query ---------------------------------------------------------
  function query(sql) {
    return new Promise((resolve, reject) => {
      let qbuf = Buffer.alloc(0);
      const tags = [];
      const notices = [];
      let lastError = null;
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        socket.removeListener('data', onData);
        socket.removeListener('error', onErr);
        fn(arg);
      };
      const onData = (chunk) => {
        qbuf = Buffer.concat([qbuf, chunk]);
        for (;;) {
          const msg = parseMessage(qbuf);
          if (!msg) break;
          qbuf = msg.rest;
          switch (msg.type) {
            case 'C':
              tags.push(msg.body.toString('utf8'));
              break;
            case 'E':
              lastError = new PgError(parseErrorFields(msg.body));
              break;
            case 'N':
              notices.push(parseErrorFields(msg.body).M || 'notice');
              break;
            case 'Z': {
              // ReadyForQuery — the whole Query message is done.
              if (lastError) finish(reject, lastError);
              else finish(resolve, { tags, notices });
              return;
            }
            case 'S':
            case 'K':
            case 'T':
            case 'D':
              break; // ParameterStatus/BackendKeyData/RowDescription/DataRow — not consumed
            default:
              finish(reject, new Error(`unexpected message ${msg.type} during query`));
              return;
          }
        }
      };
      const onErr = (err) => finish(reject, err);
      socket.on('data', onData);
      socket.on('error', onErr);
      const body = Buffer.from(sql, 'utf8');
      const head = Buffer.alloc(5);
      head.write('Q', 0);
      head.writeInt32BE(body.length + 4 + 1, 1);
      socket.write(Buffer.concat([head, body, Buffer.from([0])]));
    });
  }

  function end() {
    return new Promise((resolve) => {
      if (socket.destroyed) return resolve();
      socket.once('close', resolve);
      socket.end(Buffer.from([0x58, 0, 0, 0, 4])); // 'X' Terminate
      setTimeout(() => socket.destroy(), 250).unref();
    });
  }

  return promise;
}

/** One-shot helper: connect, run every sql in `statements` (same connection), end. */
async function runAll(opts, statements) {
  const conn = await connect(opts);
  try {
    const results = [];
    for (const sql of statements) results.push(await conn.query(sql));
    return results;
  } finally {
    await conn.end();
  }
}

module.exports = { connect, runAll, PgError };
