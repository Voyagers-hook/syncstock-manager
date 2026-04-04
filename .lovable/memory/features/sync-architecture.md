---
name: Sync architecture v2
description: Edge function based sync - eBay/Squarespace import via Lovable Cloud, Apr 2026
type: feature
---
## Architecture v2 (Apr 2026)
- Dashboard reads/writes Lovable Cloud Supabase (czoppjnkjxmduldxlbqh)
- Sync runs as **edge functions** called directly from dashboard buttons
- No external Python scripts or GitHub Actions needed

## Edge Functions
- `ebay-import`: Fetches all eBay active listings via Trading API (GetMyeBaySelling), creates products/variants/inventory/channel_listings. Auto-rotates refresh token via sync_secrets table.
- `squarespace-import`: Fetches all Squarespace products via Commerce API, creates products/variants/inventory/channel_listings.

## Resumable design
- Both functions batch-fetch existing channel_product_ids first, then only insert new items
- Safe to re-run: won't duplicate, just picks up new listings

## Token rotation
- eBay refresh tokens are single-use. After each token exchange, the new refresh_token is stored in sync_secrets table (key: ebay_refresh_token)
- On next run, function checks sync_secrets first before using env var

## Secrets needed (Lovable Cloud)
SQUARESPACE_API_KEY, EBAY_APP_ID, EBAY_CERT_ID, EBAY_REFRESH_TOKEN
