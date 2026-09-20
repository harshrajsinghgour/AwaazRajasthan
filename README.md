# आवाज़ राजस्थान

Production-oriented Rajasthan news platform with a mobile-first React frontend, Express/MongoDB API and owner-controlled admin console.

## Structure

- `frontend/` — Vite + React public website and PWA
- `frontend/public/admin/` — integrated admin console
- `backend/` — Express + MongoDB production API
- `render.yaml` — Render deployment blueprint

## Backend

1. Configure the variables in `backend/.env.example` in Render.
2. Set a strong `JWT_SECRET`, MongoDB connection string and the real Vercel frontend URL.
3. Set `OWNER_EMAIL` and a strong `OWNER_PASSWORD`. The owner is bootstrapped once if that email does not already exist.
4. Generate VAPID keys and configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` for push notifications.
5. Deploy `backend/` as the Render web service. Health check: `/api/health`.
6. Deploy the `awaaz-rajasthan-push-worker` worker from the same `backend/` directory with `npm run push-worker`.

## Frontend

Set these Vercel environment variables:

- `VITE_API_URL` — deployed Render API origin, without a trailing slash.
- `VITE_E_PAPER_URL` — optional e-paper URL.
- `VITE_VAPID_PUBLIC_KEY` — the same public VAPID key used by the backend.

Build command: `npm run build`
Output directory: `dist`

## Admin

Open `/admin` on the Vercel site. Enter the Render API URL on first login; it is stored locally in the browser. Advertising and admin-management authorization is enforced by the backend, not merely hidden in the UI.

## Production checklist

- Configure all Vercel/Render environment variables; never commit real secrets.
- Use the exact deployed Vercel origin in `FRONTEND_URL`.
- Use the exact deployed Render origin in `VITE_API_URL`.
- Keep `COOKIE_SECURE=true` when both services use HTTPS.
- Configure the VAPID public key on Vercel and both VAPID keys plus subject on Render.
- Verify `/api/health` after deployment.
- Log in at `/admin` and publish a test news item.
- Verify an owner can create/schedule an ad and that non-owners cannot access ad-management endpoints.
- Verify push permission from the public site and then publish a test breaking item.
- Verify article links use `/news/<slug-or-id>` and direct refreshes resolve through Vercel.
- Review the first ad impression/click and admin dashboard counters after a test visit.
- Keep MongoDB backups enabled before real production traffic.

## Security model

- HttpOnly signed JWT cookie for admin sessions
- bcrypt password hashing
- role and permission middleware
- owner-only advertising and admin management
- rate limiting
- Helmet security headers
- CORS allow-list
- upload size/type restrictions
- production cookie configuration
- session-version invalidation for password changes/logout-all

## Important production step

Do not commit real secrets. Configure them in Vercel/Render environment settings. The repository contains example values only.
