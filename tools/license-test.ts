/**
 * Licence token tests.
 *
 * The app's gate is only as good as the verifier: a token must be signed by the
 * seller's key, bound to this device, unexpired and still inside the
 * subscription. These tests sign real ES256 tokens with a throwaway key and
 * check every rejection path.
 *
 * Run with: npm run test:license
 */
import './setup-env'
import assert from 'node:assert/strict'
import {
  compactLicenseKey,
  generateDeviceCode,
  generateLicenseKey,
  hashLicenseKey,
  isDeviceCode,
  isLicenseKey,
  normalizeDeviceCode,
  normalizeLicenseKey,
} from '../src/licensing/format'
import {
  LicenseTokenError,
  signLicenseToken,
  tokenExpiresAt,
  verifyLicenseToken,
  type LicenseClaims,
} from '../src/licensing/token'

let passed = 0
let failed = 0

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL  ${name}`)
    console.error(`      ${err instanceof Error ? (err.stack ?? err.message) : err}`)
    process.exitCode = 1
  }
}

async function makePair(): Promise<{ privateKey: JsonWebKey; publicKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  return {
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
  }
}

function claims(overrides: Partial<LicenseClaims> = {}): LicenseClaims {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'till-license',
    sub: '11111111-1111-4111-8111-111111111111',
    typ: 'access',
    dev: 'D-7F3A-92K1',
    lic: '11111111-1111-4111-8111-111111111111',
    name: 'Maluti Traders',
    maxShops: 2,
    offlineHours: 24,
    lexp: now + 365 * 86_400,
    iat: now,
    exp: now + 86_400,
    v: 1,
    ...overrides,
  }
}

async function expectCode(fn: () => Promise<unknown>, code: string) {
  let caught: unknown = null
  try {
    await fn()
  } catch (err) {
    caught = err
  }
  assert.ok(caught, `expected ${code}, but nothing was thrown`)
  assert.ok(caught instanceof LicenseTokenError, `expected LicenseTokenError, got ${String(caught)}`)
  assert.equal(caught.code, code)
}

const pair = await makePair()
const otherPair = await makePair()
const device = 'D-7F3A-92K1'

console.log('\nLicence formats')

await check('a generated key has the display shape and validates', () => {
  const key = generateLicenseKey()
  assert.match(key, /^TILL-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.equal(isLicenseKey(key), true)
  assert.equal(normalizeLicenseKey(key), key)
})

await check('keys typed without hyphens or lowercase still normalise', () => {
  const key = generateLicenseKey()
  const messy = key.toLowerCase().replace(/-/g, ' ')
  assert.equal(compactLicenseKey(messy), compactLicenseKey(key))
  assert.equal(normalizeLicenseKey(messy), key)
  assert.equal(isLicenseKey(messy), true)
})

await check('a short or wrong-prefix key is rejected', () => {
  assert.equal(isLicenseKey('TILL-ABCD'), false)
  assert.equal(isLicenseKey('NOPE-ABCD-EFGH-JKLM-NPQR'), false)
  assert.equal(isLicenseKey('TILL-ABCD-EFGH-JKLM-NPQ0'), false)
})

await check('the licence hash is SHA-256 of the compact key', async () => {
  const key = 'TILL-7K4P-92MX-AB34-CD56'
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(compactLicenseKey(key)),
  )
  const expected = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  assert.equal(await hashLicenseKey(key), expected)
  assert.equal(await hashLicenseKey(key.toLowerCase().replace(/-/g, '')), expected)
})

await check('a generated device code is canonical', () => {
  const code = generateDeviceCode()
  assert.match(code, /^D-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  assert.equal(isDeviceCode(code), true)
  assert.equal(normalizeDeviceCode(code.toLowerCase().replace(/-/g, '')), code)
})

console.log('\nLicence tokens')

await check('a valid access token verifies', async () => {
  const token = await signLicenseToken(claims(), pair.privateKey)
  const decoded = await verifyLicenseToken(token, pair.publicKey, {
    expectedDevice: device,
    expectedType: 'access',
  })
  assert.equal(decoded.lic, claims().lic)
  assert.equal(decoded.dev, device)
  assert.equal(decoded.name, 'Maluti Traders')
  assert.equal(decoded.maxShops, 2)
  assert.ok(tokenExpiresAt(decoded) > Date.now())
})

await check('a refresh token is accepted only when a refresh is expected', async () => {
  const token = await signLicenseToken(claims({ typ: 'refresh' }), pair.privateKey)
  const decoded = await verifyLicenseToken(token, pair.publicKey, {
    expectedDevice: device,
    expectedType: 'refresh',
  })
  assert.equal(decoded.typ, 'refresh')
  await expectCode(
    () =>
      verifyLicenseToken(token, pair.publicKey, {
        expectedDevice: device,
        expectedType: 'access',
      }),
    'TOKEN_TYPE',
  )
})

await check('an expired offline token is rejected', async () => {
  const now = Math.floor(Date.now() / 1000)
  const token = await signLicenseToken(claims({ exp: now - 120 }), pair.privateKey)
  await expectCode(
    () => verifyLicenseToken(token, pair.publicKey, { expectedDevice: device }),
    'TOKEN_EXPIRED',
  )
})

await check('an expired subscription is rejected even with a live access token', async () => {
  const now = Math.floor(Date.now() / 1000)
  const token = await signLicenseToken(claims({ lexp: now - 120 }), pair.privateKey)
  await expectCode(
    () => verifyLicenseToken(token, pair.publicKey, { expectedDevice: device }),
    'TOKEN_LICENSE_EXPIRED',
  )
})

await check('a token for another device is rejected', async () => {
  const token = await signLicenseToken(claims({ dev: 'D-AAAA-BBBB' }), pair.privateKey)
  await expectCode(
    () => verifyLicenseToken(token, pair.publicKey, { expectedDevice: device }),
    'TOKEN_DEVICE',
  )
})

await check('a token signed with another key is rejected', async () => {
  const token = await signLicenseToken(claims(), otherPair.privateKey)
  await expectCode(
    () => verifyLicenseToken(token, pair.publicKey, { expectedDevice: device }),
    'TOKEN_SIGNATURE',
  )
})

await check('a tampered token is rejected', async () => {
  const token = await signLicenseToken(claims(), pair.privateKey)
  const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA')
  await expectCode(
    () => verifyLicenseToken(tampered, pair.publicKey, { expectedDevice: device }),
    'TOKEN_SIGNATURE',
  )
})

await check('a malformed token is rejected', async () => {
  await expectCode(
    () => verifyLicenseToken('not-a-token', pair.publicKey, { expectedDevice: device }),
    'TOKEN_MALFORMED',
  )
})

await check('a token from another issuer is rejected', async () => {
  const token = await signLicenseToken(claims({ iss: 'somebody-else' }), pair.privateKey)
  await expectCode(
    () => verifyLicenseToken(token, pair.publicKey, { expectedDevice: device }),
    'TOKEN_ISSUER',
  )
})

if (failed > 0) {
  console.error(`\n${failed} licence check${failed === 1 ? '' : 's'} failed`)
} else {
  console.log(`\n${passed} licence checks passed`)
}
