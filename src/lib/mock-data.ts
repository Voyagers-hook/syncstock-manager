export interface ProductVariant {
  id: string;
  name: string;
  value: string;
}

export interface Product {
  id: string;
  sku: string;
  title: string;
  stock: number;
  ebayPrice: number;
  squarespacePrice: number;
  costPrice: number;
  variants: ProductVariant[];
  ebayListed: boolean;
  squarespaceListed: boolean;
  lastSynced: string;
}

export const mockProducts: Product[] = [
  {
    id: "1",
    sku: "VNT-001",
    title: "Vintage Leather Messenger Bag",
    stock: 12,
    ebayPrice: 89.99,
    squarespacePrice: 95.00,
    costPrice: 35.00,
    variants: [
      { id: "v1", name: "Color", value: "Brown" },
      { id: "v2", name: "Color", value: "Black" },
    ],
    ebayListed: true,
    squarespaceListed: true,
    lastSynced: "2026-04-02T10:30:00Z",
  },
  {
    id: "2",
    sku: "VNT-002",
    title: "Handmade Ceramic Mug Set (4pc)",
    stock: 28,
    ebayPrice: 42.50,
    squarespacePrice: 48.00,
    costPrice: 14.00,
    variants: [
      { id: "v3", name: "Pattern", value: "Speckled" },
      { id: "v4", name: "Pattern", value: "Glazed" },
    ],
    ebayListed: true,
    squarespaceListed: true,
    lastSynced: "2026-04-02T09:15:00Z",
  },
  {
    id: "3",
    sku: "VNT-003",
    title: "Brass Desk Lamp - Art Deco",
    stock: 5,
    ebayPrice: 125.00,
    squarespacePrice: 139.00,
    costPrice: 52.00,
    variants: [],
    ebayListed: true,
    squarespaceListed: false,
    lastSynced: "2026-04-01T18:00:00Z",
  },
  {
    id: "4",
    sku: "TEX-001",
    title: "Organic Cotton Throw Blanket",
    stock: 0,
    ebayPrice: 65.00,
    squarespacePrice: 72.00,
    costPrice: 22.00,
    variants: [
      { id: "v5", name: "Size", value: "Single" },
      { id: "v6", name: "Size", value: "Double" },
    ],
    ebayListed: true,
    squarespaceListed: true,
    lastSynced: "2026-04-02T11:00:00Z",
  },
  {
    id: "5",
    sku: "TEX-002",
    title: "Linen Table Runner",
    stock: 34,
    ebayPrice: 28.00,
    squarespacePrice: 32.00,
    costPrice: 9.50,
    variants: [
      { id: "v7", name: "Color", value: "Natural" },
      { id: "v8", name: "Color", value: "Sage" },
      { id: "v9", name: "Color", value: "Terracotta" },
    ],
    ebayListed: false,
    squarespaceListed: true,
    lastSynced: "2026-04-02T08:45:00Z",
  },
  {
    id: "6",
    sku: "ACC-001",
    title: "Silver Pendant Necklace",
    stock: 18,
    ebayPrice: 55.00,
    squarespacePrice: 62.00,
    costPrice: 18.00,
    variants: [
      { id: "v10", name: "Chain Length", value: '16"' },
      { id: "v11", name: "Chain Length", value: '18"' },
    ],
    ebayListed: true,
    squarespaceListed: true,
    lastSynced: "2026-04-02T10:00:00Z",
  },
];
