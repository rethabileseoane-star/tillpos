# Till POS

Offline-first barcode point-of-sale for a single till. Scan with the phone
camera, take cash, stock comes down, and the Z-report balances at the end of the
day. Works with the network off.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```bash
npm test           # money / barcode / cart logic checks
npm run build      # typecheck + production build into dist/
npm run preview    # serve the built app on your LAN, for phone testing
npm run icons      # regenerate the PWA icon PNGs
```

## Testing it

### On your computer

```bash
npm run dev
```

Open **http://localhost:5173**. No certificate, no warning — `localhost` counts
as a secure context, so the camera works on plain http there.

Catalog tab → Import CSV, and use `tools/product-import-template.csv` as the
starting shape.

You do not need a camera or printed labels to test the flow. When the camera is
not running, the Sell screen shows a field where you can type a barcode and press
Enter; it goes through exactly the same code path as a real scan.

### On your phone

The camera needs HTTPS, and a plain `http://192.168.x.x` address is not one, so
the app has to be served over TLS. This repo generates its own certificate, which
needs no internet and no account:

```bash
npm run cert        # writes certs/key.pem, certs/cert.pem, certs/ca.pem, till-lan.cer
npm run dev:https   # serves https on the LAN
```

The certificate is self-signed, so the browser will warn until you trust it. Pick
whichever applies:

- **Windows** — double-click `certs\till-lan.cer` → Install Certificate → choose
  **Trusted Root Certification Authorities**. Needs admin. Then restart the
  browser.
- **Android** — transfer `certs/ca.pem` to the phone, then Settings → Security →
  Install a certificate → CA certificate.
- **iOS** — transfer `certs/ca.pem`, install the profile under Settings → General →
  VPN & Device Management, **then** also enable it under Settings → General →
  About → Certificate Trust Settings. Both steps, or it will not work.

Open `https://192.168.16.102:5173` on the phone (your LAN IP will differ).
The cert is generated for whatever addresses the machine has at generation time,
so if your IP changes, rerun `npm run cert`.

Then **Add to Home Screen** and launch from the icon. Browsers hide the camera
from a plain web page even over HTTPS.

Verify it is genuinely offline: load once, switch on airplane mode, reopen from
the icon. The barcode decoder is a bundled WebAssembly module, not a CDN script,
so scanning still works.

### Why the three requirements exist

Three things must all be true for the camera, and only one needs a network:

1. **Secure context.** The page must be `https://`, `http://localhost`, or
   `http://127.0.0.1`. A phone hitting `http://192.168.x.x:5173` is not a secure
   context, so the browser blocks the camera outright.
2. **Installed as an app.** Chrome on Android and Safari on iOS both withhold
   `navigator.mediaDevices` from a web page until it is launched from the home
   screen icon. Add to Home Screen, then open from the icon.
3. **Permission granted.** Tap Allow once.

Once the app is installed, the service worker serves everything from cache. The
barcode decoder is a bundled WebAssembly module, not a CDN script, so scanning
works in airplane mode. Turn on airplane mode and confirm before you rely on it.

### Alternatives to the self-signed cert

| Method | Tradeoff |
|---|---|
| Cloudflare quick tunnel | Free, no account, but needs internet to create the tunnel |
| Tailscale | Real CA-signed cert, keeps working if the WAN drops |
| Static host (Vercel / Netlify) | Easiest; only the first download needs internet |

`certs/` is gitignored. The certificate is valid for one year; rerun
`npm run cert` to renew.

## Loading your products

Catalog tab → Import CSV. Column headers are matched loosely, so `price`,
`unit price`, or `selling price` all work, as do `barcode` / `ean` / `sku` and
`stock` / `qty` / `quantity`.

`tools/product-import-template.csv` has the expected shape. Excel `.xlsx` files
work too.

```csv
barcode,name,price,stockQty,lowStockThreshold,category
6001234567892,Sugar 1kg,1500,40,10,Grocery
```

Prices are in Maluti. `1500` means M1500.00.

Rows that cannot be imported are listed with their row number and the reason,
so a bad file does not silently import half a catalog.

## Locking the till

Settings → App lock adds a launch gate. Choose a 4–8 digit PIN or a password of
at least 8 characters; only a salted PBKDF2-SHA-256 digest is stored, never the
secret. Fingerprint, face or Windows Hello can be added afterwards.

- The lock is asked for each time the app is opened or reloaded. It does **not**
  re-lock after an idle period, because a PWA can stay in memory for days — use
  **Lock now** in Settings before leaving the counter.
- Biometrics need HTTPS and a hostname; WebAuthn refuses numeric IP addresses,
  so on `https://192.168.x.x` the PIN/password is the only option. The secret is
  always kept as the fallback, so resetting the device's authenticator cannot
  lock you out.
- Five wrong tries start a 30-second cooldown; ten start five minutes. The
  count survives a reload.
- Forgot it? The lock screen offers a JSON backup of every table plus the
  catalog CSV, then a typed-confirmation erase. There is no recovery code and no
  server to ask. Erasing clears this device only; the cloud copy, if sync is on,
  is untouched.

This is a screen gate, not encryption. Anyone with the device and developer
tools can read or clear the site data; the lock is there to stop a customer or a
cashier at the counter, not a forensic attacker.

## How the numbers work

**Money is always an integer count of tambala (1/100 Maluti).** M100 is stored
as `10000`. No floats, anywhere. `0.1 + 0.2 !== 0.3` and a rounding error at a
till means the drawer never reconciles.

**Nothing is ever deleted.** Voids append a reversing stock movement and flag
the sale. The ledger stays auditable, and the ledger is the source of truth.

**Stock is a sum, not a number.** Every change is a row in `stock_movements`
(`sale`, `void`, `import`, `adjust`, `opening`). `products.stockQty` is only a
cache, rebuilt from the ledger on boot and available on demand from Settings.
That is why selling more than you have is allowed: stock goes negative and you
reconcile, rather than the app blocking a paying customer.

## Offline and sync

The device is the source of truth. IndexedDB holds the catalog, sales, and the
movement ledger; nothing needs a server to record a transaction.

Every mutation is also written to a local outbox, coalesced per record. Sync is
off by default and the app is fully functional that way.

Turn it on per device in **Settings → Cloud sync**: enter the Supabase project
URL and anon key, sign in with the shop's email and password, and give the
device a short label. See [`docs/sync-setup.md`](docs/sync-setup.md) for the
click-by-click version, including the SQL to run once.

How it behaves with sync on:

- **Push then pull.** Queued changes go up first, then everything newer than
  this device's cursor comes down. An interrupted run resumes where it stopped,
  because the cursor only advances on rows that arrived.
- **It never auto-fails a sale.** A sale is committed locally and queued, so a
  dead connection only delays the upload.
- **Conflicts resolve by newest edit**, on the timestamp the writing device
  stamped, with the revision and then the device id breaking a tie so every
  device reaches the same answer. A row with an unsynced local edit is never
  overwritten — that edit is this device's newest intent and wins on the next
  push. In practice almost nothing conflicts: sales, lines and the stock and
  cash ledgers are append-only.
- **Stock stays a sum.** `product.stockQty` is a cache of the movement ledger,
  recomputed after a pull, so two tills selling the same last item leave a
  ledger that adds up (and a negative balance to reconcile).
- **Receipt numbers carry the till's label** (`A-0001`), because two devices
  counting the same day would otherwise print the same number. A device with no
  label keeps the old plain numbering.
- **Shop-wide values sync; device secrets do not.** The shop name travels. The
  app lock, this device's session and its cursor never leave the phone.

Every row carries `id`, `createdAt`, `updatedAt`, `deletedAt`, `rev`,
`deviceId`, plus a server-assigned `serverSeq` on the cloud copy, which is what
makes a second device a configuration change rather than a rewrite.

## Layout

```
src/
  db/           Dexie schema, sync metadata, stock repair
  domain/       money and barcode rules (pure, tested)
  features/
    scanner/    camera + native/wasm decoding, 1.5s duplicate debounce
    catalog/    CSV/Excel import, product editor
    cart/       cart merge rules
    sell/       camera view, cart panel, checkout, ad-hoc capture
    sales/      sale commit, void, stock adjustment
    history/    per-day sales with void
    reports/    Z-report and CSV export
    settings/   device info, storage, cloud sync, receipt label
    security/   app lock, WebAuthn, recovery backup
  sync/         outbox, merge rules, Supabase client, sync engine/scheduler
  ui/           scan feedback
docs/           multi-device sync setup guide
supabase/       schema for the optional cloud copy
tools/          icon generator, logic smoke tests, CSV template
```

## Known gaps in v1

- No opening float or cash-in/out, so the Z-report's net cash assumes everything
  was taken in cash and nothing was paid in or out.
- Day boundaries use the device clock and local calendar.
- No tax or discounts.
- The app lock guards the screen, not the database: records are not encrypted
  at rest, and clearing the browser's site data removes both the lock and the
  ledger.
- The lock runs on launch only; it does not re-lock after an idle period.
- A Z-report counts what has reached that device. Sync before closing, or the
  report is missing the other tills' sales.
- Conflict resolution compares the writing device's clock. A phone with badly
  wrong time can win an edit it should have lost; keep the tills' clocks set to
  automatic.
- Ad-hoc lines create a real product at checkout, but the product has zero
  stock, so re-selling the same unknown barcode will not deduct anything.