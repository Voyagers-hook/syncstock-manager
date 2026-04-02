-- Remove duplicate squarespace listings, keeping the one most recently synced per channel_variant_id
DELETE FROM channel_listings
WHERE channel = 'squarespace'
  AND id NOT IN (
    SELECT DISTINCT ON (channel_variant_id) id
    FROM channel_listings
    WHERE channel = 'squarespace'
    ORDER BY channel_variant_id, last_synced_at DESC NULLS LAST
  );