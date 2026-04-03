
-- Remove orphan variants that have no channel listings when a sibling variant
-- on the same product with the same option1 DOES have listings.

CREATE TEMP TABLE orphan_variants AS
WITH variant_listing_count AS (
  SELECT 
    v.id AS variant_id,
    v.product_id,
    LOWER(TRIM(COALESCE(v.option1, ''))) AS color_key,
    COUNT(cl.id) AS listing_count
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN channel_listings cl ON cl.variant_id = v.id
  WHERE p.active = true
  GROUP BY v.id, v.product_id, v.option1
)
SELECT vlc.variant_id
FROM variant_listing_count vlc
WHERE vlc.listing_count = 0
  AND EXISTS (
    SELECT 1 FROM variant_listing_count sibling
    WHERE sibling.product_id = vlc.product_id
      AND sibling.color_key = vlc.color_key
      AND sibling.listing_count > 0
      AND sibling.variant_id != vlc.variant_id
  );

DELETE FROM inventory USING orphan_variants ov WHERE inventory.variant_id = ov.variant_id;
DELETE FROM variants USING orphan_variants ov WHERE variants.id = ov.variant_id;

DROP TABLE orphan_variants;
