# Setting up multi-device sync

This is the one-time setup that lets 3–6 phones share one till's data and gives
the owner and each cashier their own login. Budget about twenty minutes, plus
five minutes per extra device and a minute per cashier.

You need:

- A free [Supabase](https://supabase.com) account.
- An email address and password to use as the **shop's sync login**. Every
  device signs in with the *same* details. This is the cloud connection, not a
  person's till login.
- The till that already holds the shop's history, so it can upload it.
- An **owner password** for the app (at least 8 characters), and a name plus a
  PIN or password for each cashier. These staff logins are local to each phone
  and are separate from the shop sync login.

> **Never change the Supabase project URL once the tills are in use.** If you
> swap it, the devices stop seeing each other's data. The same rule as the
> Netlify site: the address is part of where the data lives.

There are two different logins, and mixing them up is the usual source of
confusion:

| Login | What it is for | Where it lives |
|---|---|---|
| **Shop sync login** | Lets the phones send sales and catalog changes to Supabase. One shared email and password for the shop. | **More → Cloud sync** |
| **Staff login** | Lets a person open the till. The owner sees every section; a cashier sees Sell and Catalog only. | **More → Staff & app lock** |

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

## 6. Set up the owner and cashier accounts

The shop sync login is only for the cloud. Staff accounts are local to each
phone and are what people use to open the till. A cashier does not need an email
address, and their PIN or password never leaves the phone.

On the original till, open **More → Staff & app lock**.

1. Tap **Set up owner account**. Use a password of at least 8 characters, not a
   4-digit PIN. The owner can open Sell, Catalog, History, Money, Z-Report and
   Settings.
2. If this till already had an app lock, it is already the owner account. The
   card shows it. If it is still a PIN, tap **Set password**, enter the current
   PIN, then choose a password. The owner password is required before any
   cashier can be added.
3. Tap **Add cashier** for each person who sells on this phone. Give each a
   distinct name (for example `Thabo`) and either a 4–8 digit PIN or a password.
4. Hand the phone to that cashier, tap **Lock now**, and let them sign in under
   their own name. The sales screen will then record their name on every sale.

What a cashier can and cannot do:

- **Can:** use Sell, including ad-hoc items with just a name and price; browse
  Catalog read-only; sign in with their own name.
- **Cannot:** open History, Money, Z-Report or Settings; see the drawer cash
  balance; see cost or profit; add, edit, import, export or stock-adjust
  catalog items; void or refund a sale; manage staff or sync.
- If a cashier forgets their PIN, they see **Ask the owner**. The owner signs in
  and uses **More → Staff & app lock → Reset** on that cashier. Past sales keep
  the name. Removing and re-adding the account is not needed.
- Biometric unlock is for the owner only. Cashiers always type their PIN or
  password.
- Voids and refunds are owner work. Do them from **History**.

The roster and its password hashes never sync. Adding a cashier on one phone
does not create the account on another phone. Add the owner to every phone, and
add a cashier only to the phone that cashier carries.

> Roles are a screen-level boundary. A cashier phone still holds the whole local
> database. It stops a cashier using the shop-floor interface, not someone with
> developer tools and the unlocked device. Treat a cashier phone as a shop
> device.

## 7. Set up every other device

On each extra phone:

1. Install the app if it is not installed, and open it once.
2. **More** → **Cloud sync**, and repeat step 5's first five points — the same
   URL, anon key, email and password, but a **different label** for each device:
   `B`, `C`, `D`…
3. Tap **Turn on sync**. It signs in and downloads the shop's history. Do **not**
   tap "Send all records" on these devices.
4. Check **Catalog** and **History**: the products and past sales should appear.
5. While still signed in as the owner, open **More → Staff & app lock**. Set up
   the owner account, then add only the cashier who carries this phone.
6. Tap **Lock now** and have that cashier sign in under their own name.

The label matters: it goes in front of receipt numbers (`A-0001`, `B-0001`) so
two tills selling at the same moment never print the same number. Give each
device its own.

Only the original history phone should ever press **Send all records**. Doing it
again from a cashier phone would upload that phone's complete copy of the ledger
a second time. The app protects against duplicate row ids, but it is still the
wrong action and wastes a long sync.

---

## Day to day

- Tills keep selling with no network. Queued changes go up when they reconnect.
- A sale made on one till appears on the others within about twenty seconds
  while they are open and online.
- **Every sale carries the cashier's name.** The owner sees it in History, in
  the sales CSV and in the books sales journal PDF. Check it when a cashier
  starts on a new phone.
- **Sync before closing the day.** A Z-report only counts what has reached that
  device, so if the other till has not synced yet its sales are not in the
  report yet.
- **Stock is shared.** Stock is the sum of the movements on all devices, so it
  is shop-wide, not per till. Selling more than you have is allowed, as before;
  the balance simply goes negative and you correct it with a stock adjustment.
- **Cash is one drawer.** Every device's payments feed the same drawer figures.
  Cashiers do not see the drawer balance; the owner does.
- **Use Lock now at a handover.** The till also locks whenever the app is
  launched or reloaded. Cashiers never reach Settings, so the owner should lock
  before passing the phone back.

## If something looks wrong

| Symptom | What it means |
|---|---|
| "Waiting to send" keeps climbing | No connection, or the phone is signed out. Open the card and tap **Sign in** or **Sync now**. |
| An error mentioning `Invalid login credentials` | Wrong shop email or password, or the user was not "Auto Confirmed" in step 3. |
| An error mentioning `permission denied` | The schema in step 2 did not run, or you pasted the `service_role` key by mistake. |
| An error mentioning `row-level security` | You are signed out. Sign in again. |
| Another till's sales never arrive | Confirm both devices show the *same* project URL and the same email. |
| A product edit on one till is ignored | The other till made a newer edit — the newest edit wins. |
| "Set the owner password before adding a cashier" | The owner account still uses the old PIN. Open **More → Staff & app lock → Set password**, then add the cashier. |
| A cashier sees History or Settings | They are signed in as the owner. Tap **Lock now** and have them choose their own name on the lock screen. |
| A cashier forgot their PIN | The owner signs in and taps **Reset** next to that cashier in **More → Staff & app lock**. |
| A cashier cannot see a cashier account | Staff accounts are per phone. Add that cashier on the phone they carry. |

Diagnostics: **More → Device → This device id** shows the first eight characters
of the device's id, which is stamped on every row it creates. Staff names are
local labels only; they are not cloud users.

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
- **Owner and cashier secrets** are stored as PBKDF2 hashes under
  `security.staff` on each phone. They are never synced, never queued to the
  cloud, and never included in a JSON backup. Setting a cashier PIN on one till
  does not create that cashier on another.
- The owner's hash is also kept in the older `security.credential` row so a
  rollback to the previous build still opens with the same password.
- Biometric enrolment is owner-only and per device. Changing the owner password
  removes it, so add the fingerprint or face again afterwards.
- A **JSON backup** from the owner's "Forgot password?" sheet deliberately
  excludes the staff roster, the biometric enrolment, the session and the sync
  cursor.
