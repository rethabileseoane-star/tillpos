# Licensing setup

This is the seller-controlled subscription layer. It is separate from the
customer's shop data and cloud sync.

- One licence key covers one business.
- The key only activates phones whose **device codes** are on the licence.
- The till works offline for the licence's `offline_hours` (24 by default).
- After that it locks until it can reach the licence server.
- A new, unapproved phone stays locked. Existing approved phones are not
  suspended when someone tries a shared key.
- A successful check renews the 24-hour offline token in the background.

The server stores only a SHA-256 hash of the key. The app keeps the key locally
so a renewal can recover without retyping it, and stores signed access and
refresh tokens. A different phone has a different device code, so copying the
app does not make the key work there.

## 1. Run the database schema

Open the Supabase project you want to use as the **seller's licence server**.
This can be the existing project, or a new one dedicated to licensing. If it is
a different project, also set `VITE_LICENSE_URL` and `VITE_LICENSE_ANON_KEY`
when building the app.

In the SQL editor, run:

```text
supabase/license-schema.sql
```

It creates:

- `license_admins` — which Supabase Auth users may manage licences
- `licenses` — key hash, business, device limit, shop limit, offline hours, expiry
- `license_devices` — the approved device codes
- `license_events` — activation, check-in and denied-attempt audit

RLS is enabled. The public anon key cannot read any of it. Only an authenticated
user in `license_admins` can manage licences.

## 2. Create the seller admin login

In **Authentication → Users**, create a normal email/password user for yourself
and tick **Auto Confirm User**.

Then link that user to the admin table:

```sql
insert into public.license_admins (user_id)
select id
from auth.users
where email = 'you@example.com'
on conflict (user_id) do nothing;
```

You will sign in with this account at `/#/admin`. It is not a shop login and not
a cashier PIN.

## 3. Generate the signing key

Run once on the machine that builds/deploys the app:

```text
node tools/license-keys.mjs --write
```

This writes:

- `.license-keys.local.json` — **secret**, gitignored
- `src/licensing/publicKey.generated.ts` — public verification key, safe to commit

The private key signs licence tokens. Never commit it, email it, or put it in the
app bundle. Keep a secure backup: if it is lost, all existing sessions stop
verifying when you deploy a new public key.

## 4. Deploy the Edge Function

The function is at:

```text
supabase/functions/license/index.ts
```

### Dashboard method

1. Open **Edge Functions → Deploy a new function**.
2. Name it exactly `license`.
3. Paste the contents of `supabase/functions/license/index.ts`.
4. Deploy.
5. In **Edge Functions → Secrets** (or **Project Settings → Edge Functions**),
   add:

| Secret | Value |
|---|---|
| `LICENSE_PRIVATE_JWK` | the `privateJwk` object from `.license-keys.local.json`, as compact JSON |
| `LICENSE_PUBLIC_JWK` | the `publicJwk` object, as compact JSON |
| `LICENSE_ISSUER` | `till-license` (optional) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by the
Supabase runtime. Do not copy the service-role key into the app.

### CLI method

```text
supabase functions deploy license
supabase secrets set LICENSE_PRIVATE_JWK='...' LICENSE_PUBLIC_JWK='...'
```

Keep JWT verification enabled. The app sends the public anon key.

## 5. Build and open the admin screen

If the licence project is the built-in default, no environment variables are
needed. If it is a different project, create `.env.production` (or set the
hosting environment variables):

```text
VITE_LICENSE_URL=https://your-project.supabase.co
VITE_LICENSE_ANON_KEY=your-anon-key
```

Then build/deploy as usual.

Open:

```text
https://your-app.example/#/admin
```

Sign in with the admin user. You can create a licence, copy its key once, add
device codes, extend it by a year, suspend/reactivate it, and regenerate its key.

## 6. Selling a licence

1. Customer installs the app and opens it.
2. The activation screen shows a device code, e.g. `D-7F3A-92K1`.
3. Customer sends you the code for each phone they bought.
4. In `/#/admin`, create a licence:
   - business name
   - max devices (e.g. 3)
   - max shops (e.g. 1 or 2)
   - offline hours (24)
   - subscription end date (one year from now)
5. Add each device code to that licence.
6. Give the customer the key.
7. They enter it on each approved phone.

If a fourth phone tries the same key, the server rejects it and that phone stays
locked. The original phones are unaffected. Remove a device in the admin screen
when a phone is replaced, then add the new code.

## Renewal

The admin screen has **Extend 1 year**. The customer's phone keeps a refresh
token for two years, so after the seller extends the licence the next background
check unlocks the till without asking for the key again. If the device has been
offline for a very long time, the app asks for the key again.

## How the checks behave

- On launch, the app verifies its stored access token locally. A valid token
  opens the till even with no internet.
- While online, it refreshes on launch, on `online`, on returning to the
  foreground, and every 15 minutes.
- A network failure is **not** a licence failure. The current access token stays
  usable until it expires.
- At expiry, the till locks. It tries the server; if the licence is valid, it
  unlocks automatically. If there is no internet, it shows a full-screen lock
  with a retry button.
- A revoked device or suspended licence locks and stays locked. The saved key
  lets the app recover if the seller re-adds the device or reactivates the
  licence.
- Sales, stock and cash data are never deleted by a licence lock.

A PWA cannot force-close itself. The lock screen is the enforceable web
equivalent. If you need the process to actually exit, wrap the app as a native
Android/iOS app later.

## Security notes

- The licence key is stored as a SHA-256 hash. The plaintext is shown once in the
  admin screen.
- The Edge Function uses the service-role key only inside Supabase. The app only
  has the public anon key.
- Tokens are ES256-signed. The app has only the public key.
- Activation and check-in are rate-limited per device: 20 denied attempts in 10
  minutes returns `TOO_MANY_ATTEMPTS`.
- A determined person can still patch a web app's JavaScript. This stops normal
  sharing, key resale and copied installs. Native app attestation (Play Integrity
  or App Attest) is the next level if you need it.

## Keeping the licence server awake

A free Supabase project is paused after about a week without database activity.
A paused project takes activation and check-in down with it: every phone keeps
working until its 24-hour offline token runs out, then locks and cannot renew.
Restoring is a click, but it happens at the worst possible moment.

The function therefore has a `ping` action that performs one real query against
`public.licenses`. JWT verification stays on, so it is not an open endpoint and
it cannot read anything back.

```bash
curl -X POST "$SUPABASE_URL/functions/v1/license" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{"action":"ping"}'
```

`.github/workflows/keep-warm.yml` calls it once a day (03:17 UTC) and can also be
run by hand from the Actions tab. The key in that file is the public anon key
that already ships in the app bundle; it is not a secret.

A paused project can be restored from the dashboard within a year. If a client
ever reports that the till will not unlock while their internet is fine, check
the Supabase project state first.

## Before you ship

Existing installations have no licence token. Issue a licence for each existing
phone before releasing this build, or they will lock at the activation screen.

Keep `.license-keys.local.json` backed up securely. Losing the private key means
new tokens cannot be issued until you generate a new key pair and rebuild the
app with the new public key.
