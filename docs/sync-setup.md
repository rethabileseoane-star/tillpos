# Setting up multi-device sync and more than one shop

This guide covers two things that are related but separate:

1. **Multi-device sync** — 3–6 phones share one shop's ledger through Supabase.
2. **More than one shop** — the same installed app can hold two or more shops on
   one phone, each with its own catalog, sales, cash, staff, lock and cloud login.

Budget about twenty minutes for the first shop and five minutes per extra device.
Adding a second shop on the same phone takes about two minutes; giving it cloud
sync takes another five.

You need:

- A free [Supabase](https://supabase.com) account.
- One **shop sync login** (email and password) per shop. Every device for that
  shop signs in with the *same* details. This is the cloud connection, not a
  person's till login.
- The till that already holds each shop's history, so it can upload it.
- An **owner password** for the app (at least 8 characters), and a name plus a
  PIN or password for each cashier. Staff logins are local to each phone and are
  separate from the shop sync login.

> **Never change the Supabase project URL once the tills are in use.** If you
> swap it, the devices stop seeing each other's data. The same rule as the
> Netlify site: the address is part of where the data lives.

There are two different logins, and mixing them up is the usual source of
confusion:

| Login | What it is for | Where it lives |
|---|---|---|
| **Shop sync login** | Lets that shop's phones send sales and catalog changes to Supabase. One shared email and password per shop. | **More → Cloud sync** |
| **Staff login** | Lets a person open the till. The owner sees every section; a cashier sees Sell, Catalog and a money-free History. | **More → Staff & app lock** |

## How the shops are separated

- Each shop is a **separate local database** on the phone. Shop A keeps the
  original database name (`till-pos`), so upgrading an existing phone does not
  move or erase its history. A new shop gets `till-pos-<shop-code>`.
- Each shop has its own **shop code** (for example `shop-a` or `shop-b`). The
  code is permanent and must match the shop's Supabase login claim
  `app_metadata.shop_id`.
- Adding a shop copies **only the owner account**, using the same owner password.
  No products, sales, cash, settings or cashiers are copied. The new shop starts
  empty and locked.
- Every synced row is tagged with `shopId` in Supabase, and row-level security
  only lets a login touch rows whose `shopId` matches that login's
  `app_metadata.shop_id`. Two shops can safely share one Supabase project.
- The app checks the claim too. A shop A login used on shop B's phone is refused
  before it can read or write anything.

---

## 1. Create the Supabase project

Skip this if the shop already has a Supabase project. Both shops use the same
project.

1. Sign in at [supabase.com](https://supabase.com) → **New project**.
2. Name it something like `maluti-traders-till`.
3. Set a **database password** you will keep. You will not need it for the app,
   but keep it if you ever connect another tool. Store it somewhere safe.
4. **Region**: pick the closest to the shop. A nearby region means faster syncs.
5. **Plan**: the free plan is plenty for a shop with six tills.
6. Click **Create new project** and wait a minute or two for it to come up.

## 2. Run or update the schema

1. In the left sidebar open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this repository, copy the whole file, and
   paste it into the editor.
3. Click **Run**. You should see "Success. No rows returned".

This creates the six tables, the sync sequence, the access rules and the
per-shop keys. It is safe to run again later.

**Credit-sale upgrade:** the same script adds the credit columns to `sales`
(`customerName`, `writtenOffAt`, `writeOffDate`, `writtenOffAmount`,
`writeOffReason`, `writtenOffBy`) and `staffName` to `cash_movements`. Run it
**before** installing the build that supports credit. PostgREST refuses a row
that names a column the table does not have, so a new build syncing against the
old schema would park its changes in the outbox until the upgrade runs. Existing
rows get safe defaults, and re-running the script changes nothing.

If you prefer the smallest possible change, run `supabase/credit-upgrade.sql`
instead of the whole schema. It contains the same seven `alter table ... add
column if not exists` statements and a verification query that should list seven
rows.

**Upgrading an existing single-shop project:** running the updated schema adds
the `shopId` column to every existing row and backfills it to `shop-a`. Existing
history stays in shop A. The script also changes `settings` to a composite
`(shopId, id)` key and replaces the old open policies with per-shop RLS. Make a
dashboard backup first if the project already holds real data.

> **Update every phone after running this schema.** The previous build does not
> send the new required `shopId` tag, so its sync requests will fail until the
> new build opens. Its queued changes stay on the phone; the new build retries
> any rows the old build had parked, once, on its first successful sync. Open
> each till once while it has a connection, and check that “Waiting to send”
> reaches “nothing”.

## 3. Create the shop A login and give it the shop code

Shop A is the existing shop. Its code is always **`shop-a`**.

1. Sidebar → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter the shop's email and a password of at least 8 characters.
3. **Tick "Auto Confirm User".** Without this the account cannot sign in until
   the email link is clicked, which is a dead end on a shop phone.
4. Click **Create user**.
5. Open the new user → **Edit** and find **App metadata** (the raw JSON field,
   not "User metadata"). Add the shop code:

   ```json
   {
     "provider": "email",
     "providers": ["email"],
     "shop_id": "shop-a"
   }
   ```

   The key must be **`shop_id`** inside **app_metadata**. Do not put it in user
   metadata: users can edit their own user metadata, and RLS would become a
   suggestion rather than a boundary.
6. Save.

If the shop A user already exists from the single-shop setup, edit that same user
and add `"shop_id": "shop-a"` to its app metadata. Then sign in again on the
phones, or let the updated app refresh the session once.

Every device for shop A will use the same email and password. Give the password
to whoever runs the tills. If you do not know the existing password, use
**Authentication → Users → … → Reset password** first, then sign in with the new
one on every shop A device.

> Anyone with this login can read and write all of that shop's ledger. That is
> the intended shape of a shop account. To revoke a departed employee, change the
> password in this same screen and sign in again on each remaining device.

## 4. Copy the project URL and anon key

1. Sidebar → **Project Settings** (the gear) → **API**.
2. Copy **Project URL** — looks like `https://abcdefghijkl.supabase.co`.
3. Copy the **anon / public** key — a long string starting with `eyJ`.

Both shops use the same URL and anon key. Do **not** copy the `service_role`
key. That one bypasses every access rule and must never be typed into a phone.

## 5. Set up the first shop-A till

On the device that already has shop A's history:

1. Open the till → **More** → **Cloud sync**.
2. Paste the **Project URL** and the **anon key**.
3. Enter the shop A **email** and **password**.
4. Leave the label as **A**.
5. Tap **Turn on sync**. It signs in and starts sending.
6. Tap **Send all records** and confirm. This uploads shop A's existing catalog,
   past sales, stock movements and cash movements.
7. Wait for "Last sync — just now" and "Waiting to send — nothing".

If the card says the login has no shop code, return to step 3 and set
`app_metadata.shop_id` to `shop-a`.

## 6. Set up owner and cashier accounts

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
   their own name. The sales screen records their name on every sale.

What a cashier can and cannot do:

- **Can:** use Sell, including ad-hoc items with just a name and price and
  credit sales; browse Catalog read-only; open today's History with every price,
  total, cost and cash figure hidden; take a payment against any outstanding
  credit sale or write off an uncollectible debt.
- **Cannot:** see sale totals, revenue, profit, cost or drawer cash; export or
  print reports; add, edit, import, export or stock-adjust catalog items; void
  or refund a sale; manage staff, shops or sync.
- If a cashier forgets their PIN, they see **Ask the owner**. The owner signs in
  and uses **More → Staff & app lock → Reset** on that cashier. Past sales keep
  the name.
- Biometric unlock is for the owner only. Cashiers always type their PIN or
  password.
- Voids and refunds are owner work. Do them from **History**.

The roster and its password hashes never sync. Adding a cashier on one phone
does not create the account on another phone. Add the owner to every phone, and
add a cashier only to the phone that cashier carries.

> Roles are a screen-level boundary. A cashier phone still holds that shop's
> whole local database. It stops a cashier using the shop-floor interface, not
> someone with developer tools and the unlocked device. Treat a cashier phone as
> a shop device.

## 7. Set up every other shop-A device

On each extra phone:

1. Install the app if it is not installed, and open it once.
2. **More** → **Cloud sync**, and repeat step 5's first five points — the same
   URL, anon key, email and password, but a **different label** for each device:
   `B`, `C`, `D`…
3. Tap **Turn on sync**. It signs in and downloads shop A's history. Do **not**
   tap "Send all records" on these devices.
4. Check **Catalog** and **History**: the products and past sales should appear.
5. While still signed in as the owner, open **More → Staff & app lock**. Set up
   the owner account, then add only the cashier who carries this phone.
6. Tap **Lock now** and have that cashier sign in under their own name.

The label matters: it goes in front of receipt numbers (`A-0001`, `B-0001`) so
two tills selling at the same moment never print the same number. Give each
device its own label within the shop.

Only the original history phone should ever press **Send all records** for that
shop. Doing it again from a cashier phone would upload that phone's complete copy
of the ledger a second time. The app protects against duplicate row ids, but it
is still the wrong action and wastes a long sync.

## 8. Add a second shop on the same phone

1. While signed in as the owner of shop A, open **More → Shops**. If shop A still
   uses an old 4-digit PIN, first set the owner password in **Staff & app lock**:
   a new shop copies the owner's password, not a PIN.
2. Tap **Add another shop**.
3. Give it a **shop name** and a permanent **shop code** (for example `shop-b`).
   Lowercase letters, numbers and hyphens only. The suggested code is already
   the next free one.
4. Tap **Create shop**, then **Open shop**.
5. The app reloads into the new shop's lock screen. Sign in with the **same owner
   password** you used in shop A. The new shop has only that owner account and an
   empty catalog.

The new shop does **not** copy products, sales, cash or cashiers. Add its
catalog, cashiers and sync login separately. The owner password is copied as a
hash; the app never stores or displays the plain password.

Switch shops at any time from **More → Shops → Switch**, or from the lock screen
link **Shop: … · Change**. Switching reloads the app so it opens the other shop's
database. Each shop has its own lock state, so switching does not unlock the
other shop.

### Give shop B its own cloud login

1. In Supabase, **Authentication → Users → Add user**. Use a different email
   (for example `shop-b@yourdomain.com`), set a password, and tick **Auto
   Confirm User**.
2. Edit the new user's **app metadata** and set the shop code to match the code
   you chose in the app:

   ```json
   {
     "provider": "email",
     "providers": ["email"],
     "shop_id": "shop-b"
   }
   ```

3. On the phone, switch to shop B. Open **More → Cloud sync**. Enter the **same
   project URL and anon key**, but the shop B email and password. Give this
   shop's tills labels `A`, `B`, `C`… independently of shop A.
4. Tap **Turn on sync**. Shop B starts empty, so there is nothing to "Send all
   records" unless you are restoring a backup of shop B. If this is the first
   shop B till, just let it sync.
5. Add shop B's cashiers on this phone through **Staff & app lock**. They are
   separate from shop A's cashiers.

The app refuses a login whose `shop_id` does not match the shop code shown on
the card. Fix the claim in Supabase, or use the correct shop's login.

**Do not reuse one shop's login in another shop.** It would either be refused by
the app or, if the claim were changed, mix that login's access with the wrong
local database.

## 9. Add another till to shop B

1. Install the app and stay in the shop the phone opens (shop A on a fresh
   install). If this is a fresh install, first open **More → Staff & app lock**
   and set up the owner account with the owner password. Adding a shop copies
   that owner account; it cannot create one from nothing.
2. Create shop B on that phone with the **same code** and name. Adding it seeds
   only the owner account; the catalog is empty.
3. Switch to shop B, then set up Cloud sync with the shop B login and a new
   till label.
4. **Turn on sync** and let it download shop B. Do not press **Send all records**
   unless this phone holds shop B's only history.
5. Add the cashier who carries this phone, then lock it.

---

## Day to day

- Tills keep selling with no network. Queued changes go up when they reconnect.
- A sale made on one till appears on that shop's other tills within about twenty
  seconds while they are open and online.
- **Every sale carries the cashier's name.** The owner sees it in History, in
  the sales CSV and in the books sales journal PDF.
- **Shop data never crosses shops.** Catalog, sales, cash, staff, lock, settings,
  sync login and sync cursor are per shop. A change in shop B is invisible to
  shop A, even on the same phone.
- **Sync before closing the day.** A Z-report only counts what has reached that
  device, so if the other till has not synced yet its sales are not in the
  report yet.
- **Stock is shared within a shop.** Stock is the sum of that shop's movements on
  all its devices. Selling more than you have is allowed, as before; the balance
  goes negative and you correct it with a stock adjustment.
- **Cash is one drawer per shop.** Every device's payments feed that shop's
  drawer figures. Cashiers do not see the drawer balance; the owner does.
- **Credit is per shop and per sale.** A credit sale names the customer and
  carries its unpaid balance. Any till can take a payment or write off that debt
  from **History → Credit book**; payments are cash movements, so they reach the
  shop's drawer and journals, while a write-off is a bad-debt expense. Sync
  before closing if the owner needs every till's debt book in one Z-report.
- **Use Lock now at a handover.** The till also locks whenever the app is
  launched or reloaded. Cashiers never reach Settings, so the owner should lock
  before passing the phone back.

## If something looks wrong

| Symptom | What it means |
|---|---|
| "Waiting to send" keeps climbing | No connection, or the phone is signed out. Open the card and tap **Sign in** or **Sync now**. |
| "This cloud login has no shop code" | Add `shop_id` to that user's **app_metadata** in Supabase, then sign in again. |
| "This cloud login belongs to shop …" | The phone is in a different shop from the login. Switch to the right shop, or use that shop's login. |
| An error mentioning `Invalid login credentials` | Wrong shop email or password, or the user was not "Auto Confirmed". |
| An error mentioning `permission denied` | The schema in step 2 did not run, or you pasted the `service_role` key by mistake. |
| An error mentioning `row-level security` | The login's `app_metadata.shop_id` is missing or wrong, or the schema update has not run. |
| Another till's sales never arrive | Confirm both devices are in the same shop, show the same project URL and use the same shop email. |
| A product edit on one till is ignored | The other till made a newer edit — the newest edit wins. |
| "That shop code is already on this phone" | Shop codes are permanent. Use a different code for a genuinely different shop, or switch to the existing one. |
| A shop disappeared after a registry reset | It still has its own database. Add it again with the **same shop code**; the app will reuse the existing data instead of seeding a blank one. |
| "Set the owner password before adding a cashier" | The owner account still uses the old PIN. Open **More → Staff & app lock → Set password**, then add the cashier. |
| A cashier sees Money, Z-Report or Settings | They are signed in as the owner. Tap **Lock now** and have them choose their own name. |
| A cashier cannot open History | They are on an old build. The current build allows today's History with amounts hidden. |
| A credit payment will not sync | Run the credit-column part of `supabase/schema.sql` (step 2), then tap **Sync now**. The payment is already saved on this phone. |
| A cashier forgot their PIN | The owner signs in and taps **Reset** next to that cashier in **More → Staff & app lock**. |
| A cashier cannot see a cashier account | Staff accounts are per shop and per phone. Add that cashier in that shop on the phone they carry. |

Diagnostics: **More → Device → This device id** shows the first eight characters
of the device's id, which is stamped on every row it creates. The current shop
name and code are shown on **More → Shops** and on the Cloud sync card. Staff
names are local labels only; they are not cloud users.

## Backups and erasing

- A **JSON backup** from the owner's "Forgot password?" sheet covers the **active
  shop only**. Switch shops and download again for the other shop.
- **Erase this device** is the destructive recovery action for a forgotten lock.
  It deletes **every shop's local database on that phone**, every lock, the shop
  registry and the sync settings. Cloud copies are not touched. Export each
  shop's backup first if you can.
- To restore a shop after erasing, add it again with the same shop code and set
  up its cloud login. Its local data downloads from the cloud.

## Free plan notes

- The database is 500 MB, which holds years of several small shops' ledgers.
- **A free project pauses after about a week with no activity.** A shop open
  daily never hits this. If the shop closes for a long holiday, open the
  Supabase dashboard and press **Restore** before the tills will sync again.
  The phones keep selling offline meanwhile.
- Tills keep working with Supabase down. Only syncing stops.

## Where the secrets live

- The **anon key** is public by design. It is the access rules from step 2 that
  protect the data, which is why the SQL is not optional.
- The **service_role key** must never be put in the app.
- Each shop's **cloud session** is stored on the phone under a shop-specific
  `till.supabase.auth.<shop-code>` key. Switching shops does not reuse the other
  shop's session; the app's erase action wipes them all.
- **Owner and cashier secrets** are stored as PBKDF2 hashes under
  `security.staff` in that shop's local database. They are never synced, never
  queued to the cloud, and never included in a JSON backup. Setting a cashier PIN
  on one phone does not create that cashier on another.
- The owner's hash is also kept in the older `security.credential` row so a
  rollback to the previous build still opens with the same password.
- Biometric enrolment is owner-only and per device, and is stored in the active
  shop's database. Changing the owner password removes it, so add the fingerprint
  or face again afterwards.
- A **JSON backup** deliberately excludes the staff roster, the biometric
  enrolment, the session and the sync cursor.
