
-- Consolidate duplicate variants: when multiple variants on the same product
-- have the same simplified color name, keep one and move all listings to it.

CREATE TEMP TABLE variant_consolidation AS
WITH variant_groups AS (
  SELECT 
    v.id,
    v.product_id,
    LOWER(TRIM(
      CASE 
        WHEN v.option1 LIKE '% - %' 
        THEN split_part(v.option1, ' - ', array_length(string_to_array(v.option1, ' - '), 1))
        ELSE COALESCE(v.option1, '')
      END
    )) AS color_key,
    ROW_NUMBER() OVER (
      PARTITION BY v.product_id,
        LOWER(TRIM(
          CASE 
            WHEN v.option1 LIKE '% - %' 
            THEN split_part(v.option1, ' - ', array_length(string_to_array(v.option1, ' - '), 1))
            ELSE COALESCE(v.option1, '')
          END
        ))
      ORDER BY 
        CASE WHEN v.option1 NOT LIKE '% - %' THEN 0 ELSE 1 END,
        v.created_at
    ) AS rn
  FROM variants v
  JOIN products p ON p.id = v.product_id
  WHERE p.active = true
)
SELECT 
  vg.id AS dup_variant_id,
  vg.product_id,
  kv.id AS keep_variant_id
FROM variant_groups vg
JOIN (SELECT id, product_id, color_key FROM variant_groups WHERE rn = 1) kv
  ON kv.product_id = vg.product_id AND kv.color_key = vg.color_key
WHERE vg.rn > 1;

-- Move channel_listings from duplicate variants to the kept variant
UPDATE channel_listings 
SET variant_id = vc.keep_variant_id, updated_at = now()
FROM variant_consolidation vc
WHERE channel_listings.variant_id = vc.dup_variant_id;

-- Delete inventory for duplicate variants
DELETE FROM inventory 
USING variant_consolidation vc
WHERE inventory.variant_id = vc.dup_variant_id;

-- Delete duplicate variants
DELETE FROM variants 
USING variant_consolidation vc
WHERE variants.id = vc.dup_variant_id;

DROP TABLE variant_consolidation;
