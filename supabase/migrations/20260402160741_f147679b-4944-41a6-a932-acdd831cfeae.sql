
-- Timestamp update function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Products
CREATE TABLE public.products (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT,
  cost_price NUMERIC,
  status TEXT DEFAULT 'active',
  description TEXT,
  category TEXT,
  image_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to products" ON public.products FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Variants
CREATE TABLE public.variants (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  internal_sku TEXT,
  option1 TEXT,
  option2 TEXT,
  needs_sync BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to variants" ON public.variants FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER update_variants_updated_at BEFORE UPDATE ON public.variants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Inventory
CREATE TABLE public.inventory (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  variant_id UUID REFERENCES public.variants(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  total_stock INTEGER NOT NULL DEFAULT 0,
  reserved_stock INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER DEFAULT 5,
  location TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to inventory" ON public.inventory FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER update_inventory_updated_at BEFORE UPDATE ON public.inventory FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Channel listings
CREATE TABLE public.channel_listings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  variant_id UUID NOT NULL REFERENCES public.variants(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('ebay', 'squarespace')),
  channel_sku TEXT,
  channel_price NUMERIC,
  channel_product_id TEXT,
  channel_variant_id TEXT,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.channel_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to channel_listings" ON public.channel_listings FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER update_channel_listings_updated_at BEFORE UPDATE ON public.channel_listings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Orders
CREATE TABLE public.orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  platform TEXT,
  platform_order_id TEXT,
  product_id UUID REFERENCES public.products(id),
  sku TEXT,
  quantity INTEGER,
  unit_price NUMERIC,
  total_price NUMERIC,
  currency TEXT DEFAULT 'GBP',
  status TEXT,
  ordered_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  item_name TEXT,
  order_number TEXT,
  customer_name TEXT,
  customer_email TEXT,
  shipping_address TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  fulfillment_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to orders" ON public.orders FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Sync log
CREATE TABLE public.sync_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  details TEXT,
  error_message TEXT,
  source TEXT DEFAULT 'dashboard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to sync_log" ON public.sync_log FOR ALL USING (true) WITH CHECK (true);

-- Sync secrets (for rotating eBay refresh token)
CREATE TABLE public.sync_secrets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sync_secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to sync_secrets" ON public.sync_secrets FOR ALL USING (true) WITH CHECK (true);
CREATE TRIGGER update_sync_secrets_updated_at BEFORE UPDATE ON public.sync_secrets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Indexes
CREATE INDEX idx_variants_product_id ON public.variants(product_id);
CREATE INDEX idx_inventory_product_id ON public.inventory(product_id);
CREATE INDEX idx_inventory_variant_id ON public.inventory(variant_id);
CREATE INDEX idx_channel_listings_variant_id ON public.channel_listings(variant_id);
CREATE INDEX idx_channel_listings_channel ON public.channel_listings(channel);
CREATE INDEX idx_products_sku ON public.products(sku);
CREATE INDEX idx_products_active ON public.products(active);
CREATE INDEX idx_orders_platform ON public.orders(platform);
CREATE INDEX idx_sync_log_sync_type ON public.sync_log(sync_type);
