
DELETE FROM inventory WHERE variant_id IN (
  '4d258977-ee57-4a9c-b5aa-c831f33cbe8a',
  'd59cfcd8-6d0b-439d-a30b-ce10022207d2',
  'db84d910-9ebe-450a-bbb2-7258b7152285',
  'f86b4f94-9163-4381-a67c-fafddf33a980'
);

DELETE FROM variants WHERE id IN (
  '4d258977-ee57-4a9c-b5aa-c831f33cbe8a',
  'd59cfcd8-6d0b-439d-a30b-ce10022207d2',
  'db84d910-9ebe-450a-bbb2-7258b7152285',
  'f86b4f94-9163-4381-a67c-fafddf33a980'
);
