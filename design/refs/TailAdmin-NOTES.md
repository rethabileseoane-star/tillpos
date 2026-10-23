# Design reference — TailAdmin (free)

The template zip lives at `design templates/tailadmin-free-tailwind-dashboard-template-main.zip`
(extracted under `design templates/extracted/`).

- Source: https://github.com/TailAdmin/tailadmin-free-tailwind-dashboard-template
- License: **MIT** — free to use, including commercially. No attribution
  required, but credit is polite: *"Design language adapted from TailAdmin
  (github.com/TailAdmin), MIT."*

## What we learned and used

| Pattern | Where they do it | What we borrowed | Where it landed |
|---|---|---|---|
| Elevation tokens | `--shadow-theme-xs` / `--shadow-theme-xl` | `shadow-soft` (cards, buttons), `shadow-lift` (hero cards) | `tailwind.config.js`, `src/index.css` (`.card`, `.btn`) |
| Focus rings | `--shadow-focus-ring: 0 0 0 4px rgba(70,95,255,.12)` | green `focus-visible:ring-2` on buttons, `focus:ring-2` on fields | `.btn`, `.field` in `src/index.css` |
| Active menu state | `dark:bg-brand-500/[0.12]` menu item | tinted pill behind the active tab | `src/App.tsx` `TabBar` |
| Metric cards | `metric-group-01`: icon tile + label + big value | icon tile + lifted shadow on the drawer hero cards | `MoneyScreen`, `ReportsScreen` |
| Badges / chips | `badge-*` partials, rounded-full tinted | `.chip` utility; VOIDED / ad-hoc / receipt all use it now | `src/index.css`, History, Cart, Checkout |
| Motion | hover transitions only | `pop` spring on the checkout success check, pulsing "live" dot on the scanner pill, `prefers-reduced-motion` guard | `tailwind.config.js`, `CheckoutSheet`, `SellScreen`, `index.css` |

## What we deliberately did NOT copy

- The blue brand (`--color-brand-500: #465fff`) — this app's identity stays
  cash-green on ink.
- The Outfit font and light-mode stylesheet — Inter + dark-only is a till
  requirement (offline fonts, no LCD glare).
- The dashboard grid of non-interactive KPI cards — a mobile POS doesn't have
  that density; we kept the hierarchy for the two numbers that matter (till
  balance, cash drawer).