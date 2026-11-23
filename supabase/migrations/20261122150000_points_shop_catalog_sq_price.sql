-- Points Shop admin list: use the Squarespace price (eBay only if the item isn't on Squarespace).
-- Previously it took the highest price across all channels, which was usually eBay's.
CREATE OR REPLACE FUNCTION public.points_shop_catalog(p_search text DEFAULT NULL::text)
 RETURNS TABLE(variant_id uuid, product_name text, options text, sku text, price numeric, cost numeric, stock integer, points_value integer, active boolean, flagged boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select v.id as variant_id,
         p.name as product_name,
         nullif(trim(concat_ws(' / ', v.option1, v.option2)), '') as options,
         v.internal_sku as sku,
         pr.price,
         coalesce(nullif(v.cost_price,0), nullif(p.cost_price,0)) as cost,
         coalesce(i.total_stock, 0) as stock,
         psi.points_value,
         coalesce(psi.active, false) as active,
         (psi.variant_id is not null) as flagged
  from variants v
  join products p on p.id = v.product_id
  left join inventory i on i.variant_id = v.id
  left join points_shop_items psi on psi.variant_id = v.id
  left join lateral (
    select coalesce(
      (select max(case when cl.sq_on_sale and coalesce(cl.sq_sale_price,0) > 0 then cl.sq_sale_price
                       else coalesce(nullif(cl.sq_base_price,0), cl.channel_price) end)
         from channel_listings cl where cl.variant_id = v.id and cl.channel = 'squarespace'),
      (select max(cl.channel_price) from channel_listings cl where cl.variant_id = v.id)
    ) as price
  ) pr on true
  where
    case
      when p_search is null or btrim(p_search) = '' then psi.variant_id is not null
      else (p.name ilike '%'||p_search||'%' or v.internal_sku ilike '%'||p_search||'%')
    end
  order by flagged desc, p.name, options
  limit 300;
$function$;
