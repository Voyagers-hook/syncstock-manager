---
name: Sync architecture
description: How eBay/Squarespace sync works via GitHub Actions, bugs fixed Apr 2026
type: feature
---
## Architecture
- Dashboard (Lovable React) reads/writes Supabase directly via anon key
- Sync scripts (Python) run as GitHub Actions with service_role key
- Hourly: sync-hourly.yml → python main.py --mode full
- Quick Sync: sync-quick.yml → python main.py --mode quick (workflow_dispatch)

## Sync flow
1. Dashboard edit → writes to Supabase + sets variants.needs_sync=TRUE
2. Hourly job picks up needs_sync=TRUE → pushes stock+price to eBay & Squarespace
3. Sets needs_sync=FALSE + last_synced_at

## Bugs fixed (Apr 2026)
1. Duplicate imports: sync_missing_ebay_listings() re-expanded ALL listings hourly → replaced with sync_new_ebay_listings_only() using StartTimeFrom
2. Stock push failures: channel_variant_id had broken placeholders like "12345-v0" → now calls refresh_ebay_variant_metadata() before every push
3. Price sync: dashboard wasn't setting needs_sync=TRUE → fixed in use-products.ts hooks
4. bulk_insert_rows: no ON CONFLICT handling → added ignore-duplicates resolution
5. 24h catalogue refresh: was only running on first run → now triggers every 24h
6. run_quick_check: was calling broken sync_missing_ebay_listings → now uses sync_product_catalogue

## GitHub secrets needed
SQUARESPACE_API_KEY, EBAY_APP_ID, EBAY_CERT_ID, EBAY_REFRESH_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
