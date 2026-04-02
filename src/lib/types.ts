export interface Product {
  id: string;
  name: string;
  sku: string | null;
  cost_price: number | null;
  status: string;
  description: string | null;
  category: string | null;
  image_url: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Variant {
  id: string;
  product_id: string;
  internal_sku: string | null;
  option1: string | null;
  option2: string | null;
  needs_sync: boolean;
  created_at: string;
  updated_at: string;
}

export interface Inventory {
  id: string;
  variant_id: string;
  product_id: string;
  total_stock: number;
  reserved_stock: number;
  low_stock_threshold: number;
  location: string | null;
  updated_at: string;
}

export interface ChannelListing {
  id: string;
  variant_id: string;
  channel: "ebay" | "squarespace";
  channel_sku: string | null;
  channel_price: number | null;
  channel_product_id: string | null;
  channel_variant_id: string | null;
  last_synced_at: string | null;
  updated_at: string;
}

export interface Order {
  id: string;
  platform: string;
  platform_order_id: string;
  product_id: string | null;
  sku: string | null;
  quantity: number;
  unit_price: number;
  total_price: number | null;
  currency: string;
  status: string;
  ordered_at: string;
  synced_at: string;
  item_name: string | null;
  order_number: string | null;
}

// Joined type for dashboard display
export interface ProductWithDetails {
  id: string;
  name: string;
  sku: string | null;
  cost_price: number | null;
  status: string;
  total_stock: number;
  ebay_price: number | null;
  squarespace_price: number | null;
  variants: Variant[];
  inventory: Inventory[];
  channel_listings: ChannelListing[];
}
