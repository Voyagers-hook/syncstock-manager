-- Fix remaining squarespace listings that still have the old /100 prices
-- These are the ones from the broken import that weren't matched by the corrected re-import
UPDATE channel_listings 
SET channel_price = channel_price * 100
WHERE channel = 'squarespace' 
  AND channel_price IS NOT NULL
  AND last_synced_at < '2026-04-02T17:00:00Z';