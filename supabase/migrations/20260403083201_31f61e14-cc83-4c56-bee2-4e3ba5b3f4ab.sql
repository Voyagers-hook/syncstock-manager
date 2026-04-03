
-- Delete inventory for orphan variants first
DELETE FROM inventory
WHERE variant_id IN (
  SELECT v1.id
  FROM variants v1
  JOIN products p ON p.id = v1.product_id
  WHERE p.active = true
    AND NOT EXISTS (SELECT 1 FROM channel_listings cl WHERE cl.variant_id = v1.id)
    AND EXISTS (
      SELECT 1 FROM variants v2
      JOIN channel_listings cl2 ON cl2.variant_id = v2.id
      WHERE v2.product_id = v1.product_id
        AND v2.id != v1.id
        AND LOWER(TRIM(COALESCE(v2.option1, ''))) = LOWER(TRIM(COALESCE(v1.option1, '')))
    )
);

-- Delete the orphan variants themselves
DELETE FROM variants
WHERE id IN (
  SELECT v1.id
  FROM variants v1
  JOIN products p ON p.id = v1.product_id
  WHERE p.active = true
    AND NOT EXISTS (SELECT 1 FROM channel_listings cl WHERE cl.variant_id = v1.id)
    AND EXISTS (
      SELECT 1 FROM variants v2
      JOIN channel_listings cl2 ON cl2.variant_id = v2.id
      WHERE v2.product_id = v1.product_id
        AND v2.id != v1.id
        AND LOWER(TRIM(COALESCE(v2.option1, ''))) = LOWER(TRIM(COALESCE(v1.option1, '')))
    )
);
