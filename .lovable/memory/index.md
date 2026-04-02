# Project Memory

## Core
Fishing tackle inventory tracker. eBay + Squarespace sync. Single user auth.
External Supabase: czoppjnkjxmduldxlbqh.supabase.co. Anon key in client.ts.
Tables: products, variants, inventory, channel_listings, orders. DB wiped for reimport.
Dark warehouse theme. Primary teal. Inter font. £ GBP currency.
Sync scripts on GitHub: voyagers-hook/inventory-sync. Python on GitHub Actions.
Logo: https://voyagers-hook.github.io/images/logo%20trans.png
Dashboard edits set needs_sync=TRUE → hourly GitHub Action pushes to eBay/Squarespace.

## Memories
- [Supabase schema](mem://features/supabase-schema) — Full table structure and relationships
- [Sync architecture](mem://features/sync-architecture) — How sync scripts work, bug fixes applied
