# Beaded Finery — storefront + owner admin

Live storefront and owner admin panel for **Beaded Finery by Manahil** — handmade beaded jewelry, Pakistan.

- **Frontend:** one file, [`index.html`](index.html) — Tailwind (CDN) + vanilla JS, no build step.
- **Orders API:** [`api/orders.js`](api/orders.js) — Vercel serverless function (GET / POST / PATCH).
- **Images:** `images/instagram/*` are real photos pulled from
  [@beadedfineryby_manahil](https://www.instagram.com/beadedfineryby_manahil/); served via jsDelivr CDN.

## Run locally
```bash
python -m http.server 8777
```
Open http://localhost:8777 — click **Owner Admin** (bottom-right) for the dashboard.
(Orders fall back to local-only when there is no API / no database.)

## Deploy (Vercel)
Repo: https://github.com/wincennet/beaded-finery (public). Import it at vercel.com — framework
auto-detects as "Other" (static + `api/`). Every push to `main` redeploys.

### Orders database (so the owner sees orders from any device)
1. In the Vercel project → **Storage** → **Upstash for Redis** (free tier, no card).
2. Connect it to the project. Vercel injects `KV_REST_API_URL` + `KV_REST_API_TOKEN`
   (or `UPSTASH_REDIS_REST_URL` / `_TOKEN`) — `api/orders.js` reads either pair.
3. Redeploy. Done — checkout writes orders to Redis, the admin panel reads them back.

Until the store is connected the site still works; orders just stay in the shopper's browser.

## Brand
Palette (enforced): primary `#7A4667`, secondary `#B7A897`, bg `#F7F4EE`, text `#3A2A32`,
hover `#9B7A8E`, border `#E2D8CC`, card `#EFE8E1`, success `#A7A087`, error `#D7A9B2`.
Logo: script wordmark ("Beaded" in Sacramure/Sacramento + tracked "FINERY"); standalone
[`images/logo.svg`](images/logo.svg). Hero uses the motionsites.ai **Custom Spaces** layout —
editorial headline + curved auto-scrolling 3D filmstrip.

## Payments (shown at checkout)
- Easypaisa — Manahal Ahmed — 0334 4035732
- JazzCash — Manahal Ahmed — 0334 4035732
- Bank transfer — available on request
- Full advance payment confirms the order · payment proof → beadedfinerybymanahil@gmail.com
- Shipping: flat Rs. 300 across Pakistan, **free over Rs. 3000**, international varies.

## Still needed from the owner
- Clean product photos (the 8 Instagram reel-cover images are placeholders on ~7 products + the hero).
- Real logo file (current wordmark is rebuilt from the reference; typo "Beadead" → "Beaded" fixed).
- Bank transfer account details.
- Real product catalogue (names / prices / stock) — current data is representative.
- Custom `.com` domain → add in Vercel → Domains.
