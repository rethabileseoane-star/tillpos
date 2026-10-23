/**
 * Generates a self-signed certificate for HTTPS on your LAN.
 *
 * Why this exists: `getUserMedia` only works in a secure context, so the phone
 * cannot open the camera over plain `http://192.168.x.x`. Either you get a cert
 * from a trusted CA (Tailscale, Cloudflare) or you make one yourself. This is
 * the fully-offline route: it needs no internet at any point.
 *
 * Run with: npm run cert
 *
 * Then install certs/ca.pem on the phone as a trusted CA:
 *   Android  Settings > Security > Install a certificate > CA certificate
 *   iOS      Settings > General > VPN & Device Management > install, then
 *            Settings > General > About > Certificate Trust Settings > enable
 *
 * Removing the profile from the phone reverts the trust.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import selfsigned from 'selfsigned'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'certs')

/** Collect non-internal IPv4 addresses so the cert works on every interface. */
function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

const altNames = [
  { type: 2, value: 'localhost' },
  { type: 2, value: 'pos.local' },
  // type 7 = IP
  ...['127.0.0.1', ...lanAddresses()].map((ip) => ({ type: 7, ip })),
]

console.log('Including addresses:')
console.log('  localhost')
for (const ip of ['127.0.0.1', ...lanAddresses()]) console.log(`  ${ip}`)

// This version of selfsigned returns a promise rather than the pems directly.
const pems = await selfsigned.generate(
  [{ name: 'commonName', value: 'Till POS LAN' }],
  {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'subjectAltName', altNames },
      // cA: true so the phone can trust this as a root, not just pin the leaf.
      { name: 'basicConstraints', cA: true },
    ],
  },
)

mkdirSync(DIR, { recursive: true })
writeFileSync(join(DIR, 'key.pem'), pems.private)
writeFileSync(join(DIR, 'cert.pem'), pems.cert)
writeFileSync(join(DIR, 'ca.pem'), pems.cert)

/**
 * Windows and iOS both prefer the .cer extension in their import wizards, and
 * a double-click on a .pem does nothing useful. This is the same certificate
 * with the extension those flows look for, so the same file works everywhere.
 */
writeFileSync(join(DIR, 'till-lan.cer'), pems.cert)

for (const f of ['key.pem', 'cert.pem', 'ca.pem', 'till-lan.cer']) {
  console.log(`wrote certs/${f}`)
}
if (!existsSync(join(DIR, 'ca.pem'))) process.exitCode = 1

console.log('\nStart the app over HTTPS:')
console.log('  npm run dev:https')
console.log('\nTrust the certificate so the browser stops warning:')
console.log('  Windows : double-click certs\\till-lan.cer, Install Certificate')
console.log('            choose "Trusted Root Certification Authorities" (needs admin)')
console.log('  Android : Settings > Security > Install a certificate > CA certificate')
console.log('  iOS     : transfer till-lan.cer, install the profile under')
console.log('            VPN & Device Management, then also enable it under')
console.log('            About > Certificate Trust Settings')
console.log('\nDesktop shortcut: just use http://localhost:5173 instead.')
console.log('localhost is a secure context, so the camera works with no cert at all.')
console.log('\nNote: certs/ is gitignored. Regenerate yearly; days=365 above.')