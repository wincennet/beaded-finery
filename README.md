# Beaded Finery — storefront + owner admin

Single self-contained file: **`index.html`**. No build, no install, no internet needed for logic
(Tailwind + fonts load from CDN; product imagery is generated inline as SVG motifs).

## Run it
1. Double-click `index.html` (opens in browser), **or** serve the folder:
   ```bash
   python -m http.server 8777
   ```
   then open http://localhost:8777
2. Storefront loads by default.
3. Click **Owner Admin** (bottom-right floating button) to toggle the admin panel.

## What's built
- Announcement marquee, glass sticky header, split hero with auto image slider
- Shop Our Collections (2×3), Shop by Category carousel (8 categories)
- About / 4 value props, Why Choose Us checklist, Best Sellers, New Arrivals
- Instagram mosaic + newsletter footer
- Shop page with category filter chips (all 8 exact categories)
- Slide-out cart, real-time subtotal, auto **flat Rs. 300** shipping
- 3-step checkout: shipping form → payment methods (Easypaisa / JazzCash / Bank Transfer) → payment-proof screen
- Admin: product CRUD + stock toggle, order tracker with revenue + status toggles
- State persists in `localStorage` (key `beadedFinery_v1`). "Reset demo data" in admin clears it.

## Hero style
Hero uses the **"Custom Spaces"** layout from motionsites.ai: centered editorial headline
+ a curved, auto-scrolling 3D filmstrip (hairline-framed section, cursor-parallax, hover-to-pause,
click a panel to jump to that category). Panels show a jewel-tone motif now; they swap to real
photos automatically once products have image URLs.

## Placeholders that need your real content
See the chat message — logo file, product photos, bank transfer details, Instagram links,
about-us copy, and real order-notification wiring are all mocked for now.
