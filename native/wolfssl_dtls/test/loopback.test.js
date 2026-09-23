'use strict';
// In-memory loopback between a wolfSSL DTLS 1.3 server and client session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DtlsChannel } = require('..');

const certs = path.join(__dirname, '..', '..', '..', 'certs');
const read = (f) => fs.readFileSync(path.join(certs, f));

function pair({ ca = read('ca-cert.pem'), serverName = 'camera-001.local', dropFirst = 0 } = {}) {
  let client;
  let server;
  let dropped = 0;
  const wire = (to) => (d) => {
    if (dropped < dropFirst) { dropped++; return; } // simulate packet loss
    setImmediate(() => { try { to().receive(d); } catch { /* peer already closed */ } });
  };
  server = new DtlsChannel(
    { role: 'server', cert: read('server-cert.pem'), key: read('server-key.pem') },
    wire(() => client),
  );
  client = new DtlsChannel({ role: 'client', ca, serverName }, wire(() => server));
  return { client, server };
}

const once = (ee, ev) => new Promise((res) => ee.once(ev, res));

test('DTLS 1.3 handshake negotiates X25519 + Ed25519', async () => {
  const { client, server } = pair();
  const est = Promise.all([once(client, 'established'), once(server, 'established')]);
  client.start();
  const [cInfo, sInfo] = await est;

  assert.match(cInfo.version, /DTLS.?1\.?3/i);
  assert.match(sInfo.version, /DTLS.?1\.?3/i);
  assert.match(cInfo.group, /X25519/i);
  assert.equal(cInfo.signature, 'Ed25519');
  assert.match(cInfo.peerSubject, /camera_001/);
  assert.equal(cInfo.verifyResult, 0);
  console.log('client info:', cInfo);
  client.close();
  server.close();
});

test('application data flows both ways', async () => {
  const { client, server } = pair();
  const est = Promise.all([once(client, 'established'), once(server, 'established')]);
  client.start();
  await est;

  const fromClient = once(server, 'data');
  client.send(Buffer.from('hello camera'));
  assert.equal((await fromClient).toString(), 'hello camera');

  const fromServer = once(client, 'data');
  server.send(Buffer.alloc(1100, 7));
  const got = await fromServer;
  assert.equal(got.length, 1100);
  assert.ok(got.every((b) => b === 7));
  client.close();
  server.close();
});

test('handshake survives loss of the first flights (wolfSSL retransmission)', async () => {
  const { client, server } = pair({ dropFirst: 2 });
  const est = Promise.all([once(client, 'established'), once(server, 'established')]);
  client.start();
  await est;
  client.close();
  server.close();
});

test('certificate from an unknown CA is rejected', async () => {
  // Use the server cert itself as "CA": it is not the issuer, so verification must fail.
  const { client, server } = pair({ ca: read('server-cert.pem') });
  server.on('error', () => {});
  const failed = once(client, 'error');
  client.start();
  const err = await failed;
  assert.match(err.message, /DTLS error/);
  assert.equal(client.established, false);
  server.close();
});

test('wrong server name is rejected', async () => {
  const { client, server } = pair({ serverName: 'other-host.local' });
  server.on('error', () => {});
  const failed = once(client, 'error');
  client.start();
  await failed;
  server.close();
});
