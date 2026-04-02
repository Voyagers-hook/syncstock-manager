export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      channel_listings: {
        Row: {
          channel: string
          channel_price: number | null
          channel_product_id: string | null
          channel_sku: string | null
          channel_variant_id: string | null
          id: string
          last_synced_at: string | null
          updated_at: string
          variant_id: string
        }
        Insert: {
          channel: string
          channel_price?: number | null
          channel_product_id?: string | null
          channel_sku?: string | null
          channel_variant_id?: string | null
          id?: string
          last_synced_at?: string | null
          updated_at?: string
          variant_id: string
        }
        Update: {
          channel?: string
          channel_price?: number | null
          channel_product_id?: string | null
          channel_sku?: string | null
          channel_variant_id?: string | null
          id?: string
          last_synced_at?: string | null
          updated_at?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_listings_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "variants"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory: {
        Row: {
          id: string
          location: string | null
          low_stock_threshold: number | null
          product_id: string
          reserved_stock: number
          total_stock: number
          updated_at: string
          variant_id: string | null
        }
        Insert: {
          id?: string
          location?: string | null
          low_stock_threshold?: number | null
          product_id: string
          reserved_stock?: number
          total_stock?: number
          updated_at?: string
          variant_id?: string | null
        }
        Update: {
          id?: string
          location?: string | null
          low_stock_threshold?: number | null
          product_id?: string
          reserved_stock?: number
          total_stock?: number
          updated_at?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "variants"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          currency: string | null
          customer_email: string | null
          customer_name: string | null
          fulfillment_status: string | null
          id: string
          item_name: string | null
          order_number: string | null
          ordered_at: string | null
          platform: string | null
          platform_order_id: string | null
          product_id: string | null
          quantity: number | null
          shipping_address: string | null
          sku: string | null
          status: string | null
          synced_at: string | null
          total_price: number | null
          tracking_number: string | null
          tracking_url: string | null
          unit_price: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          fulfillment_status?: string | null
          id?: string
          item_name?: string | null
          order_number?: string | null
          ordered_at?: string | null
          platform?: string | null
          platform_order_id?: string | null
          product_id?: string | null
          quantity?: number | null
          shipping_address?: string | null
          sku?: string | null
          status?: string | null
          synced_at?: string | null
          total_price?: number | null
          tracking_number?: string | null
          tracking_url?: string | null
          unit_price?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          fulfillment_status?: string | null
          id?: string
          item_name?: string | null
          order_number?: string | null
          ordered_at?: string | null
          platform?: string | null
          platform_order_id?: string | null
          product_id?: string | null
          quantity?: number | null
          shipping_address?: string | null
          sku?: string | null
          status?: string | null
          synced_at?: string | null
          total_price?: number | null
          tracking_number?: string | null
          tracking_url?: string | null
          unit_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          active: boolean
          category: string | null
          cost_price: number | null
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          name: string
          sku: string | null
          status: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          category?: string | null
          cost_price?: number | null
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          name: string
          sku?: string | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          category?: string | null
          cost_price?: number | null
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          name?: string
          sku?: string | null
          status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      sync_log: {
        Row: {
          completed_at: string | null
          created_at: string
          details: string | null
          error_message: string | null
          id: string
          source: string | null
          started_at: string | null
          status: string
          sync_type: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          details?: string | null
          error_message?: string | null
          id?: string
          source?: string | null
          started_at?: string | null
          status?: string
          sync_type: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          details?: string | null
          error_message?: string | null
          id?: string
          source?: string | null
          started_at?: string | null
          status?: string
          sync_type?: string
        }
        Relationships: []
      }
      sync_secrets: {
        Row: {
          id: string
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      variants: {
        Row: {
          created_at: string
          id: string
          internal_sku: string | null
          needs_sync: boolean
          option1: string | null
          option2: string | null
          product_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          internal_sku?: string | null
          needs_sync?: boolean
          option1?: string | null
          option2?: string | null
          product_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          internal_sku?: string | null
          needs_sync?: boolean
          option1?: string | null
          option2?: string | null
          product_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
