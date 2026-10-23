# Setting up multi-device sync

This is the one-time setup that lets 3–6 phones share one till's data. Budget
about fifteen minutes, plus five minutes per extra device.

You need:

- A free [Supabase](https://supabase.com) account.
- An email address and password to use as the shop's login. Every device signs
  in with the *same* details; this is not a per-person login.
- The till that already holds the shop's history, so it can upload it.

> **Never change the Supabase project URL once the tills are in use.** If you
> swap it, the devices stop seeing each other's data. The same rule as the
> Netlify site: the address is part of where the data lives.

---

## 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) → **New project**.
2. Name it something like `maluti-traders-till`.
3. Set a **database password** you will keep (you will not need it for the app,
   but you will want it if you ever connect a tool to the database). Store it
   somewhere safe.
4. **Region**: pick the closest to the shop. A nearby region means faster syncs.
5. **Plan**: the free plan is plenty for a shop with six tills.
6. Click **Create new project** and wait a minute or two for it to come up.

## 2. Run the schema

1. In the left sidebar open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this repository, copy the whole file, and
   paste it into the editor.
3. Click **Run**. You should see "Success. No rows returned".

This creates the six tables, the sync cursor, and the access rules. It is safe
to run again later.

## 3. Create the shop login

1. Sidebar → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter the shop's email and a password of at least 8 characters.
3. **Tick "Auto Confirm User".** Without this the account cannot sign in until
   the email link is clicked, which is a dead end on a shop phone.
4. Click **Create user**.

Every device will use these same details. Give the password to whoever runs the
tills.

> Anyone with this login can read and write the whole ledger. That is the
> intended shape of a single shop account. To revoke a departed employee, change
> the password in this same screen and sign in again on each remaining device.

## 4. Copy the project URL and anon key

1. Sidebar → **Project Settings** (the gear) → **API**.
2. Copy **Project URL** — looks like `https://abcdefghijkl.supabase.co`.
3. Copy the **anon / public** key — a long string starting with `eyJ`.

Do **not** copy the `service_role` key. That one bypasses every access rule and
must never be typed into a phone.

## 5. Set up the first till

On the device that already has the shop's history:

1. Open the till → **More** → **Cloud sync**.
2. Paste the **Project URL** and the **anon key**.
3. Enter the shop **email** and **password**.
4. Leave the label as **A**.
5. Tap **Turn on sync**. It signs in and starts sending.
6. Tap **Send all records** and confirm. This uploads the existing catalog,
   past sales, stock movements and cash movements — the part that makes the
   other devices useful.
7. Wait for "Last sync — just now" and "Waiting to send — nothing".

## 6. Set up every other device

On each extra phone:

1. Install the app if it is not installed, and open it once.
2. **More** → **Cloud sync**, and repeat step 5's first five points — the same
   URL, anon key, email and password, but a **different label** for each device:
   `B`, `C`, `D`…
3. Tap **Turn on sync**. It signs in and downloads the shop's history. Do **not**
   tap "Send all records" on these devices.
4. Check **Catalog** and **History**: the products and past sales should appear.

The label matters: it goes in front of receipt numbers (`A-0001`, `B-0001`) so
two tills selling at the same moment never print the same number. Give each
device its own.

---

## Day to day

- Tills keep selling with no network. Queued changes go up when they reconnect.
- A sale made on one till appears on the others within about twenty seconds
  while they are open and online.
- **Sync before closing the day.** A Z-report only counts what has reached that
  device, so if the other till has not synced yet its sales are not in the
  report yet.
- **Stock is shared.** Stock is the sum of the movements on all devices, so it
  is shop-wide, not per till. Selling more than you have is allowed, as before;
  the balance simply goes negative and you correct it with a stock adjustment.
- **Cash is one drawer.** Every device's payments feed the same drawer figures.
  Do not treat each phone as a separate tin.

## If something looks wrong

| Symptom | What it means |
|---|---|
| "Waiting to send" keeps climbing | No connection, or the phone is signed out. Open the card and tap **Sign in** or **Sync now**. |
| An error mentioning `Invalid login credentials` | Wrong shop email or password, or the user was not "Auto Confirmed" in step 3. |
| An error mentioning `permission denied` | The schema in step 2 did not run, or you pasted the `service_role` key by mistake. |
| An error mentioning `row-level security` | You are signed out. Sign in again. |
| Another till's sales never arrive | Confirm both devices show the *same* project URL and the same email. |
| A product edit on one till is ignored | The other till made a newer edit — the newest edit wins. |

Diagnostics: **More → Device → This device id** shows the first eight characters
of the device's id, which is stamped on every row it creates.

## Free plan notes

- The database is 500 MB, which holds years of a small shop's ledger.
- **A free project pauses after about a week with no activity.** A shop open
  daily never hits this. If the shop closes for a long holiday, open the
  Supabase dashboard and press **Restore** before the tills will sync again.
  The phones keep selling offline meanwhile.
- Tills keep working with Supabase down. Only syncing stops.

## Where the secrets live

- The **anon key** is public by design. It is the access rules from step 2 that
  protect the data, which is why the SQL is not optional.
- The **service_role key** must never be put in the app.
- The **shop session** is stored on each phone under a `till.` key and is wiped
  by the app's "erase this device" recovery action.
- The **app lock PIN** is per device and never synced. Setting a PIN on one till
  does not lock the others.
- A **JSON backup** from the lock screen's "Forgot PIN?" sheet deliberately
  excludes the lock, the session and the sync cursor.
