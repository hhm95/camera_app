'use strict';
// Generate a private CA and an Ed25519 server certificate for camera_server.
// Output (certs/): ca-cert.pem, ca-key.pem, server-cert.pem, server-key.pem
// The host validates the camera's certificate against ca-cert.pem.

const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const x509 = require('@peculiar/x509');

x509.cryptoProvider.set(webcrypto);

const outDir = path.join(__dirname, '..', 'certs');
const alg = { name: 'Ed25519' };
const cameraId = process.argv[2] || 'camera_001';

const toPem = (label, der) => {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
};
const exportKey = async (key) => toPem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', key));

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000);

  const caKeys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Camera Demo CA,O=IP Camera Project',
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  const srvKeys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const srvCert = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: `CN=${cameraId},O=IP Camera Project`,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: alg,
    publicKey: srvKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension(
        [
          // wolfSSL only accepts valid FQDNs for the domain check (no underscores).
          { type: 'dns', value: `${cameraId.replace(/_/g, '-')}.local` },
          { type: 'dns', value: 'localhost' },
          { type: 'ip', value: '127.0.0.1' },
        ],
        false,
      ),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
      await x509.SubjectKeyIdentifierExtension.create(srvKeys.publicKey),
    ],
  });

  fs.writeFileSync(path.join(outDir, 'ca-cert.pem'), caCert.toString('pem') + '\n');
  fs.writeFileSync(path.join(outDir, 'ca-key.pem'), await exportKey(caKeys.privateKey));
  fs.writeFileSync(path.join(outDir, 'server-cert.pem'), srvCert.toString('pem') + '\n');
  fs.writeFileSync(path.join(outDir, 'server-key.pem'), await exportKey(srvKeys.privateKey));
  console.log(`Wrote CA + Ed25519 server certificate for "${cameraId}" to ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
