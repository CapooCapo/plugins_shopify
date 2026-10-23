# StockHub Design System

## Egyptian Blue tokens

| Token | Value | Intended use |
|---|---|---|
| `--stockhub-brand-primary` | `#0A369D` | App-owned primary emphasis and links; white text on filled surfaces |
| `--stockhub-brand-secondary` | `#4472CA` | Supporting emphasis and visible focus rings |
| `--stockhub-brand-accent` | `#5E7CE2` | Small accents and progress cues; not for normal-size white text |
| `--stockhub-brand-highlight` | `#92B4F4` | Focus/selection support with dark text |
| `--stockhub-brand-soft` | `#CFDEE7` | Dividers and subtle panels |
| `--stockhub-canvas` | `#F7F9FC` | App document canvas |
| `--stockhub-surface` | `#FFFFFF` | Native form and disclosure surfaces |
| `--stockhub-ink` | `#0F172A` | Primary text |
| `--stockhub-muted` | `#475569` | Supporting text |
| `--stockhub-border` | `#DCE5EF` | Native control and disclosure borders |

## Component and platform boundary

- Shopify `s-*` Polaris web components and App Bridge navigation remain the UI primitives. Their internal styling is owned by Shopify and merchant theme; StockHub does not override Polaris shadow internals or Admin chrome.
- The inspected lockfile resolves React Router / `@react-router/dev` to **7.18.2**, `@shopify/app-bridge-react` to **4.2.13**, and `@shopify/polaris-types` to **1.1.0**. These are the local package versions; the Polaris browser runtime is independently loaded from the CDN below.
- The current lockfile resolves `@shopify/shopify-app-react-router` to **3.0.2**. Its `AppProvider` injects Polaris Web Components from the default, unpinned `https://cdn.shopify.com/shopifycloud/polaris.js` URL. The app does not override the provider URL or pin a Polaris runtime version.
- Because Polaris primary-button color follows the Shopify Admin/merchant theme and the component internals are not app-overridable, the Egyptian Blue palette is applied to StockHub-owned page accents, wrappers, native controls, and links. Polaris primary buttons remain Admin/theme controlled and are not claimed to match Egyptian Blue.
- App-owned wrappers provide page grids and responsive composition on Overview, Products, Stores/Store Detail, New Import, History, Receipt Detail/Verify, and unavailable Activity History. Polaris `s-section` retains its own card surface; wrappers add layout and narrow accent rules only, avoiding nested card borders/backgrounds.
- The app-owned accent stripe, import page navigation container, native upload surface, links, labels, inputs, selects, textareas, and disclosure elements use the StockHub tokens in `app/styles/stockhub.css`.
- The existing Polaris variants/tones remain responsible for button and status semantics. Status colors are not replaced with brand blue.
- Status badges pair readable labels with Polaris icons: success uses `check-circle`, failures/blocks use `alert-circle`, partial/uncertain uses `alert-triangle`, progress uses `clock`, and informational/unknown states use `info`. Labels remain present so icons are not the sole signal.
- Typography uses Inter when available, with system fallbacks. Native form controls have a 40px minimum height, visible focus treatment, and responsive max-width behavior.
- Reduced-motion preference is respected. The narrow import tab container may scroll horizontally on small screens; form content remains in normal document flow.

## Use and contrast notes

Use primary blue with white text for app-owned filled controls, and dark text on highlight/soft blue. Avoid white text on Glaucous (`#5E7CE2`). Semantic status colors remain distinct from brand colors. Validate final contrast in the Shopify Admin theme because Polaris components follow merchant branding and are not recolored by this stylesheet.
