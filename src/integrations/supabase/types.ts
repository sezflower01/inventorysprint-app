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
    PostgrestVersion: "12.2.3 (519615d)"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      access_requests: {
        Row: {
          created_at: string
          email: string
          first_name: string
          id: string
          last_name: string
          notes: string | null
          processed_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          email: string
          first_name: string
          id?: string
          last_name: string
          notes?: string | null
          processed_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          email?: string
          first_name?: string
          id?: string
          last_name?: string
          notes?: string | null
          processed_at?: string | null
          status?: string
        }
        Relationships: []
      }
      admin_audit_log: {
        Row: {
          action: string
          actor_id: string
          created_at: string
          details: Json
          id: string
          target_user_id: string
        }
        Insert: {
          action: string
          actor_id: string
          created_at?: string
          details?: Json
          id?: string
          target_user_id: string
        }
        Update: {
          action?: string
          actor_id?: string
          created_at?: string
          details?: Json
          id?: string
          target_user_id?: string
        }
        Relationships: []
      }
      admin_profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_refresh_runs: {
        Row: {
          completed_at: string | null
          detail: Json | null
          error_message: string | null
          id: string
          scope: string
          skipped_reason: string | null
          source: string
          started_at: string
          status: string
          target_email: string | null
          target_user_id: string
          triggered_by_email: string | null
          triggered_by_user_id: string
        }
        Insert: {
          completed_at?: string | null
          detail?: Json | null
          error_message?: string | null
          id?: string
          scope?: string
          skipped_reason?: string | null
          source?: string
          started_at?: string
          status?: string
          target_email?: string | null
          target_user_id: string
          triggered_by_email?: string | null
          triggered_by_user_id: string
        }
        Update: {
          completed_at?: string | null
          detail?: Json | null
          error_message?: string | null
          id?: string
          scope?: string
          skipped_reason?: string | null
          source?: string
          started_at?: string
          status?: string
          target_email?: string | null
          target_user_id?: string
          triggered_by_email?: string | null
          triggered_by_user_id?: string
        }
        Relationships: []
      }
      admin_subscription_override: {
        Row: {
          id: string
          override_enabled: boolean
          override_plan_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          override_enabled?: boolean
          override_plan_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          override_enabled?: boolean
          override_plan_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_subscription_override_override_plan_id_fkey"
            columns: ["override_plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      amazon_categories: {
        Row: {
          children_count: number
          context_free_name: string | null
          created_at: string
          depth: number
          id: number
          is_active: boolean
          is_root: boolean
          marketplace: string
          name: string
          parent_id: number | null
          path: string | null
          product_count: number | null
          updated_at: string
        }
        Insert: {
          children_count?: number
          context_free_name?: string | null
          created_at?: string
          depth?: number
          id: number
          is_active?: boolean
          is_root?: boolean
          marketplace?: string
          name: string
          parent_id?: number | null
          path?: string | null
          product_count?: number | null
          updated_at?: string
        }
        Update: {
          children_count?: number
          context_free_name?: string | null
          created_at?: string
          depth?: number
          id?: number
          is_active?: boolean
          is_root?: boolean
          marketplace?: string
          name?: string
          parent_id?: number | null
          path?: string | null
          product_count?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "amazon_categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "amazon_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      amazon_oauth_states: {
        Row: {
          created_at: string
          marketplace_id: string
          origin: string | null
          state: string
          user_id: string
        }
        Insert: {
          created_at?: string
          marketplace_id?: string
          origin?: string | null
          state: string
          user_id: string
        }
        Update: {
          created_at?: string
          marketplace_id?: string
          origin?: string | null
          state?: string
          user_id?: string
        }
        Relationships: []
      }
      analyzer_decision_action: {
        Row: {
          acted_at: string
          action: string
          asin: string
          created_at: string
          decision_id: string
          id: string
          marketplace: string
          notes: string | null
          units: number | null
          user_id: string
        }
        Insert: {
          acted_at?: string
          action: string
          asin: string
          created_at?: string
          decision_id: string
          id?: string
          marketplace?: string
          notes?: string | null
          units?: number | null
          user_id: string
        }
        Update: {
          acted_at?: string
          action?: string
          asin?: string
          created_at?: string
          decision_id?: string
          id?: string
          marketplace?: string
          notes?: string | null
          units?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyzer_decision_action_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "analyzer_decision_log"
            referencedColumns: ["id"]
          },
        ]
      }
      analyzer_decision_log: {
        Row: {
          active_range_viewed: string | null
          ai_reasoning: string | null
          amazon_presence: string | null
          asin: string
          brand: string | null
          bsr: number | null
          buy_box: number | null
          category: string | null
          competition_level: string | null
          confidence: string | null
          cost: number | null
          created_at: string
          data_freshness: string | null
          eligibility: string | null
          est_sales_month: number | null
          fees: number | null
          final_decision: string | null
          hazmat: boolean | null
          id: string
          ip_risk: string | null
          lowest_fba: number | null
          lowest_fbm: number | null
          margin: number | null
          marketplace: string
          pl_risk: string | null
          prep_required: boolean | null
          profit: number | null
          raw_snapshot: Json | null
          retrieval_state: string | null
          roi: number | null
          sale_price: number | null
          scan_duration_ms: number | null
          scanned_at: string
          seller_count: number | null
          size_tier: string | null
          source: string
          source_surface: string | null
          swing_1y: number | null
          swing_3m: number | null
          swing_6m: number | null
          user_id: string
        }
        Insert: {
          active_range_viewed?: string | null
          ai_reasoning?: string | null
          amazon_presence?: string | null
          asin: string
          brand?: string | null
          bsr?: number | null
          buy_box?: number | null
          category?: string | null
          competition_level?: string | null
          confidence?: string | null
          cost?: number | null
          created_at?: string
          data_freshness?: string | null
          eligibility?: string | null
          est_sales_month?: number | null
          fees?: number | null
          final_decision?: string | null
          hazmat?: boolean | null
          id?: string
          ip_risk?: string | null
          lowest_fba?: number | null
          lowest_fbm?: number | null
          margin?: number | null
          marketplace?: string
          pl_risk?: string | null
          prep_required?: boolean | null
          profit?: number | null
          raw_snapshot?: Json | null
          retrieval_state?: string | null
          roi?: number | null
          sale_price?: number | null
          scan_duration_ms?: number | null
          scanned_at?: string
          seller_count?: number | null
          size_tier?: string | null
          source?: string
          source_surface?: string | null
          swing_1y?: number | null
          swing_3m?: number | null
          swing_6m?: number | null
          user_id: string
        }
        Update: {
          active_range_viewed?: string | null
          ai_reasoning?: string | null
          amazon_presence?: string | null
          asin?: string
          brand?: string | null
          bsr?: number | null
          buy_box?: number | null
          category?: string | null
          competition_level?: string | null
          confidence?: string | null
          cost?: number | null
          created_at?: string
          data_freshness?: string | null
          eligibility?: string | null
          est_sales_month?: number | null
          fees?: number | null
          final_decision?: string | null
          hazmat?: boolean | null
          id?: string
          ip_risk?: string | null
          lowest_fba?: number | null
          lowest_fbm?: number | null
          margin?: number | null
          marketplace?: string
          pl_risk?: string | null
          prep_required?: boolean | null
          profit?: number | null
          raw_snapshot?: Json | null
          retrieval_state?: string | null
          roi?: number | null
          sale_price?: number | null
          scan_duration_ms?: number | null
          scanned_at?: string
          seller_count?: number | null
          size_tier?: string | null
          source?: string
          source_surface?: string | null
          swing_1y?: number | null
          swing_3m?: number | null
          swing_6m?: number | null
          user_id?: string
        }
        Relationships: []
      }
      analyzer_notes: {
        Row: {
          asin: string
          created_at: string
          id: string
          marketplace: string
          notes: string | null
          tags: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          id?: string
          marketplace?: string
          notes?: string | null
          tags?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          id?: string
          marketplace?: string
          notes?: string | null
          tags?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      api_rate_limits: {
        Row: {
          bucket: string
          capacity: number
          last_refill_at: string
          refill_per_sec: number
          tokens_available: number
          updated_at: string
        }
        Insert: {
          bucket: string
          capacity: number
          last_refill_at?: string
          refill_per_sec: number
          tokens_available: number
          updated_at?: string
        }
        Update: {
          bucket?: string
          capacity?: number
          last_refill_at?: string
          refill_per_sec?: number
          tokens_available?: number
          updated_at?: string
        }
        Relationships: []
      }
      api_token_recent_consumption: {
        Row: {
          count: number
          feature: string
          flushed: boolean
          user_id: string
          window_start: string
        }
        Insert: {
          count?: number
          feature: string
          flushed?: boolean
          user_id: string
          window_start: string
        }
        Update: {
          count?: number
          feature?: string
          flushed?: boolean
          user_id?: string
          window_start?: string
        }
        Relationships: []
      }
      asin_batches: {
        Row: {
          created_at: string | null
          error: string | null
          file_path: string | null
          filename: string | null
          id: string
          processed: number | null
          skipped_duplicates: number | null
          status: string | null
          total: number | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          error?: string | null
          file_path?: string | null
          filename?: string | null
          id?: string
          processed?: number | null
          skipped_duplicates?: number | null
          status?: string | null
          total?: number | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          error?: string | null
          file_path?: string | null
          filename?: string | null
          id?: string
          processed?: number | null
          skipped_duplicates?: number | null
          status?: string | null
          total?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      asin_cost_overrides: {
        Row: {
          asin: string
          created_at: string
          created_by: string | null
          effective_from: string
          id: string
          note: string | null
          unit_cost: number
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          created_by?: string | null
          effective_from: string
          id?: string
          note?: string | null
          unit_cost: number
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          id?: string
          note?: string | null
          unit_cost?: number
          user_id?: string
        }
        Relationships: []
      }
      asin_dimensions_cache: {
        Row: {
          asin: string
          fetched_at: string
          item_dim_unit: string | null
          item_height: number | null
          item_length: number | null
          item_weight: number | null
          item_weight_unit: string | null
          item_width: number | null
          marketplace: string
          package_dim_unit: string | null
          package_height: number | null
          package_length: number | null
          package_weight: number | null
          package_weight_unit: string | null
          package_width: number | null
          source: string | null
        }
        Insert: {
          asin: string
          fetched_at?: string
          item_dim_unit?: string | null
          item_height?: number | null
          item_length?: number | null
          item_weight?: number | null
          item_weight_unit?: string | null
          item_width?: number | null
          marketplace?: string
          package_dim_unit?: string | null
          package_height?: number | null
          package_length?: number | null
          package_weight?: number | null
          package_weight_unit?: string | null
          package_width?: number | null
          source?: string | null
        }
        Update: {
          asin?: string
          fetched_at?: string
          item_dim_unit?: string | null
          item_height?: number | null
          item_length?: number | null
          item_weight?: number | null
          item_weight_unit?: string | null
          item_width?: number | null
          marketplace?: string
          package_dim_unit?: string | null
          package_height?: number | null
          package_length?: number | null
          package_weight?: number | null
          package_weight_unit?: string | null
          package_width?: number | null
          source?: string | null
        }
        Relationships: []
      }
      asin_fee_cache: {
        Row: {
          asin: string
          attempt_count: number
          created_at: string
          fba_fee_fixed: number
          fee_source: string | null
          history_sample_size: number | null
          id: string
          is_media: boolean
          last_attempt_at: string | null
          last_error: string | null
          last_verified_at: string | null
          marketplace: string
          next_retry_at: string | null
          referral_rate: number
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          attempt_count?: number
          created_at?: string
          fba_fee_fixed?: number
          fee_source?: string | null
          history_sample_size?: number | null
          id?: string
          is_media?: boolean
          last_attempt_at?: string | null
          last_error?: string | null
          last_verified_at?: string | null
          marketplace?: string
          next_retry_at?: string | null
          referral_rate?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          attempt_count?: number
          created_at?: string
          fba_fee_fixed?: number
          fee_source?: string | null
          history_sample_size?: number | null
          id?: string
          is_media?: boolean
          last_attempt_at?: string | null
          last_error?: string | null
          last_verified_at?: string | null
          marketplace?: string
          next_retry_at?: string | null
          referral_rate?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      asin_items: {
        Row: {
          amz_image: string | null
          amz_link: string | null
          amz_price: number | null
          amz_title: string | null
          asin: string
          batch_id: string | null
          category: string | null
          error: string | null
          fees_json: Json | null
          g_image: string | null
          g_link: string | null
          g_price: number | null
          g_store: string | null
          g_title: string | null
          id: string
          idx: number | null
          image_score: number | null
          margin_pct: number | null
          match_score: number | null
          roi: number | null
          source: string | null
          source_type: string | null
          status: string | null
          title_score: number | null
        }
        Insert: {
          amz_image?: string | null
          amz_link?: string | null
          amz_price?: number | null
          amz_title?: string | null
          asin: string
          batch_id?: string | null
          category?: string | null
          error?: string | null
          fees_json?: Json | null
          g_image?: string | null
          g_link?: string | null
          g_price?: number | null
          g_store?: string | null
          g_title?: string | null
          id?: string
          idx?: number | null
          image_score?: number | null
          margin_pct?: number | null
          match_score?: number | null
          roi?: number | null
          source?: string | null
          source_type?: string | null
          status?: string | null
          title_score?: number | null
        }
        Update: {
          amz_image?: string | null
          amz_link?: string | null
          amz_price?: number | null
          amz_title?: string | null
          asin?: string
          batch_id?: string | null
          category?: string | null
          error?: string | null
          fees_json?: Json | null
          g_image?: string | null
          g_link?: string | null
          g_price?: number | null
          g_store?: string | null
          g_title?: string | null
          id?: string
          idx?: number | null
          image_score?: number | null
          margin_pct?: number | null
          match_score?: number | null
          roi?: number | null
          source?: string | null
          source_type?: string | null
          status?: string | null
          title_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "asin_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "asin_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      asin_my_price_cache: {
        Row: {
          asin: string
          attempt_count: number | null
          created_at: string
          currency: string | null
          fetched_at: string
          id: string
          last_error: string | null
          marketplace_id: string
          my_price: number | null
          next_retry_at: string | null
          seller_sku: string
          source: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          attempt_count?: number | null
          created_at?: string
          currency?: string | null
          fetched_at?: string
          id?: string
          last_error?: string | null
          marketplace_id?: string
          my_price?: number | null
          next_retry_at?: string | null
          seller_sku?: string
          source?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          attempt_count?: number | null
          created_at?: string
          currency?: string | null
          fetched_at?: string
          id?: string
          last_error?: string | null
          marketplace_id?: string
          my_price?: number | null
          next_retry_at?: string | null
          seller_sku?: string
          source?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      asin_price_history: {
        Row: {
          asin: string
          buybox_price: number | null
          captured_at: string
          currency_code: string
          fx_rate: number | null
          id: string
          listing_price: number
          marketplace: string
          price_usd: number | null
          source: string
          user_id: string
        }
        Insert: {
          asin: string
          buybox_price?: number | null
          captured_at?: string
          currency_code: string
          fx_rate?: number | null
          id?: string
          listing_price: number
          marketplace: string
          price_usd?: number | null
          source?: string
          user_id: string
        }
        Update: {
          asin?: string
          buybox_price?: number | null
          captured_at?: string
          currency_code?: string
          fx_rate?: number | null
          id?: string
          listing_price?: number
          marketplace?: string
          price_usd?: number | null
          source?: string
          user_id?: string
        }
        Relationships: []
      }
      asin_sales_daily: {
        Row: {
          asin: string
          date: string
          last_updated_at: string
          marketplace: string
          revenue: number
          sku: string | null
          units: number
          user_id: string
        }
        Insert: {
          asin: string
          date: string
          last_updated_at?: string
          marketplace?: string
          revenue?: number
          sku?: string | null
          units?: number
          user_id: string
        }
        Update: {
          asin?: string
          date?: string
          last_updated_at?: string
          marketplace?: string
          revenue?: number
          sku?: string | null
          units?: number
          user_id?: string
        }
        Relationships: []
      }
      asin_upload: {
        Row: {
          asin: string
          created_at: string
          id: string
          updated_at: string
        }
        Insert: {
          asin: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Update: {
          asin?: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      auto_activate_runs: {
        Row: {
          activated: number
          auto_raised: number
          candidates: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          re_enabled: number
          skip_reasons: Json
          started_at: string
          user_id: string
        }
        Insert: {
          activated?: number
          auto_raised?: number
          candidates?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          re_enabled?: number
          skip_reasons?: Json
          started_at?: string
          user_id: string
        }
        Update: {
          activated?: number
          auto_raised?: number
          candidates?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          re_enabled?: number
          skip_reasons?: Json
          started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      auto_inventory_sync_runs: {
        Row: {
          attempted: number | null
          completed_at: string | null
          elapsed_ms: number | null
          error_message: string | null
          errors: number | null
          id: string
          ok: boolean | null
          skipped: number | null
          started_at: string
          summary: Json | null
          triggered_by: string | null
          updated: number | null
          users_count: number | null
        }
        Insert: {
          attempted?: number | null
          completed_at?: string | null
          elapsed_ms?: number | null
          error_message?: string | null
          errors?: number | null
          id?: string
          ok?: boolean | null
          skipped?: number | null
          started_at?: string
          summary?: Json | null
          triggered_by?: string | null
          updated?: number | null
          users_count?: number | null
        }
        Update: {
          attempted?: number | null
          completed_at?: string | null
          elapsed_ms?: number | null
          error_message?: string | null
          errors?: number | null
          id?: string
          ok?: boolean | null
          skipped?: number | null
          started_at?: string
          summary?: Json | null
          triggered_by?: string | null
          updated?: number | null
          users_count?: number | null
        }
        Relationships: []
      }
      auto_source_config: {
        Row: {
          allow_open_web_fallback: boolean
          daily_cap: number
          enabled: boolean
          notify_email: string | null
          search_needs_approval: boolean
          strict_min_fba_offers: number
          strict_min_monthly_sales: number
          strict_min_price_cents: number
          strict_mode: boolean
          strict_require_rank: boolean
          strict_require_seller_fba: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_open_web_fallback?: boolean
          daily_cap?: number
          enabled?: boolean
          notify_email?: string | null
          search_needs_approval?: boolean
          strict_min_fba_offers?: number
          strict_min_monthly_sales?: number
          strict_min_price_cents?: number
          strict_mode?: boolean
          strict_require_rank?: boolean
          strict_require_seller_fba?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          allow_open_web_fallback?: boolean
          daily_cap?: number
          enabled?: boolean
          notify_email?: string | null
          search_needs_approval?: boolean
          strict_min_fba_offers?: number
          strict_min_monthly_sales?: number
          strict_min_price_cents?: number
          strict_mode?: boolean
          strict_require_rank?: boolean
          strict_require_seller_fba?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      auto_source_daily_usage: {
        Row: {
          day: string
          search_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          day: string
          search_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          day?: string
          search_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      auto_sync_locks: {
        Row: {
          expires_at: string
          locked_at: string
          user_id: string
        }
        Insert: {
          expires_at: string
          locked_at?: string
          user_id: string
        }
        Update: {
          expires_at?: string
          locked_at?: string
          user_id?: string
        }
        Relationships: []
      }
      automation_results: {
        Row: {
          amz_asin: string | null
          amz_image: string | null
          amz_link: string | null
          amz_price: number | null
          amz_title: string | null
          catalog_id: string | null
          created_at: string | null
          error: string | null
          fees_json: Json | null
          g_image: string | null
          g_link: string | null
          g_price: number | null
          g_store: string | null
          g_title: string | null
          id: string
          image_score: number | null
          input_asin: string | null
          input_title: string | null
          margin_pct: number | null
          match_score: number | null
          roi: number | null
          run_id: string
          status: string | null
          title_score: number | null
        }
        Insert: {
          amz_asin?: string | null
          amz_image?: string | null
          amz_link?: string | null
          amz_price?: number | null
          amz_title?: string | null
          catalog_id?: string | null
          created_at?: string | null
          error?: string | null
          fees_json?: Json | null
          g_image?: string | null
          g_link?: string | null
          g_price?: number | null
          g_store?: string | null
          g_title?: string | null
          id?: string
          image_score?: number | null
          input_asin?: string | null
          input_title?: string | null
          margin_pct?: number | null
          match_score?: number | null
          roi?: number | null
          run_id: string
          status?: string | null
          title_score?: number | null
        }
        Update: {
          amz_asin?: string | null
          amz_image?: string | null
          amz_link?: string | null
          amz_price?: number | null
          amz_title?: string | null
          catalog_id?: string | null
          created_at?: string | null
          error?: string | null
          fees_json?: Json | null
          g_image?: string | null
          g_link?: string | null
          g_price?: number | null
          g_store?: string | null
          g_title?: string | null
          id?: string
          image_score?: number | null
          input_asin?: string | null
          input_title?: string | null
          margin_pct?: number | null
          match_score?: number | null
          roi?: number | null
          run_id?: string
          status?: string | null
          title_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_results_catalog_id_fkey"
            columns: ["catalog_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "automation_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_run_cursor: {
        Row: {
          last_seen_id: string | null
          last_updated: string | null
          run_id: string
        }
        Insert: {
          last_seen_id?: string | null
          last_updated?: string | null
          run_id: string
        }
        Update: {
          last_seen_id?: string | null
          last_updated?: string | null
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_run_cursor_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: true
            referencedRelation: "automation_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_runs: {
        Row: {
          avg_roi: number | null
          created_at: string | null
          error: string | null
          id: string
          matched: number | null
          name: string | null
          processed: number | null
          source_filter: Json | null
          status: string | null
          total: number | null
          user_id: string
        }
        Insert: {
          avg_roi?: number | null
          created_at?: string | null
          error?: string | null
          id?: string
          matched?: number | null
          name?: string | null
          processed?: number | null
          source_filter?: Json | null
          status?: string | null
          total?: number | null
          user_id: string
        }
        Update: {
          avg_roi?: number | null
          created_at?: string | null
          error?: string | null
          id?: string
          matched?: number | null
          name?: string | null
          processed?: number | null
          source_filter?: Json | null
          status?: string | null
          total?: number | null
          user_id?: string
        }
        Relationships: []
      }
      bb_price_alerts: {
        Row: {
          acted: boolean
          asin: string
          bb_before: number | null
          bb_now: number | null
          created_at: string
          dismissed: boolean
          drop_abs: number | null
          drop_pct: number | null
          id: string
          marketplace: string
          my_price: number | null
          seen: boolean
          sku: string | null
          snapshot_id: string | null
          user_id: string
        }
        Insert: {
          acted?: boolean
          asin: string
          bb_before?: number | null
          bb_now?: number | null
          created_at?: string
          dismissed?: boolean
          drop_abs?: number | null
          drop_pct?: number | null
          id?: string
          marketplace?: string
          my_price?: number | null
          seen?: boolean
          sku?: string | null
          snapshot_id?: string | null
          user_id: string
        }
        Update: {
          acted?: boolean
          asin?: string
          bb_before?: number | null
          bb_now?: number | null
          created_at?: string
          dismissed?: boolean
          drop_abs?: number | null
          drop_pct?: number | null
          id?: string
          marketplace?: string
          my_price?: number | null
          seen?: boolean
          sku?: string | null
          snapshot_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      business_health_issues: {
        Row: {
          affected_entities: Json
          auto_fix_action: string | null
          confidence: string
          created_at: string
          display_category: string
          fingerprint: string
          first_seen: string
          functions: string[]
          id: string
          ignored_until: string | null
          impact: string
          last_raw_message: string | null
          last_retry_at: string | null
          last_seen: string
          module: string
          next_retry_at: string | null
          occurrence_count: number
          recommended_fix: string
          resolved_at: string | null
          resolved_reason: string | null
          retry_attempts: number
          retryable: boolean
          routes: string[]
          severity: string
          sources: string[]
          status: string
          stuck_reason: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          affected_entities?: Json
          auto_fix_action?: string | null
          confidence?: string
          created_at?: string
          display_category?: string
          fingerprint: string
          first_seen?: string
          functions?: string[]
          id?: string
          ignored_until?: string | null
          impact?: string
          last_raw_message?: string | null
          last_retry_at?: string | null
          last_seen?: string
          module: string
          next_retry_at?: string | null
          occurrence_count?: number
          recommended_fix?: string
          resolved_at?: string | null
          resolved_reason?: string | null
          retry_attempts?: number
          retryable?: boolean
          routes?: string[]
          severity?: string
          sources?: string[]
          status?: string
          stuck_reason?: string | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          affected_entities?: Json
          auto_fix_action?: string | null
          confidence?: string
          created_at?: string
          display_category?: string
          fingerprint?: string
          first_seen?: string
          functions?: string[]
          id?: string
          ignored_until?: string | null
          impact?: string
          last_raw_message?: string | null
          last_retry_at?: string | null
          last_seen?: string
          module?: string
          next_retry_at?: string | null
          occurrence_count?: number
          recommended_fix?: string
          resolved_at?: string | null
          resolved_reason?: string | null
          retry_attempts?: number
          retryable?: boolean
          routes?: string[]
          severity?: string
          sources?: string[]
          status?: string
          stuck_reason?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      buy_box_cache: {
        Row: {
          asin: string
          fetched_at: string
          id: string
          marketplace_id: string
          price: number
          total_fees: number | null
        }
        Insert: {
          asin: string
          fetched_at?: string
          id?: string
          marketplace_id?: string
          price: number
          total_fees?: number | null
        }
        Update: {
          asin?: string
          fetched_at?: string
          id?: string
          marketplace_id?: string
          price?: number
          total_fees?: number | null
        }
        Relationships: []
      }
      categories: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      category_products: {
        Row: {
          availability: string | null
          availability_status: string
          category_confidence: string | null
          category_id: string
          category_source: string | null
          created_at: string
          current_currency: string | null
          current_image: string | null
          current_price: number | null
          current_title: string | null
          fingerprint: string | null
          first_seen_at: string
          id: string
          inferred_category_name: string | null
          inferred_category_path: string | null
          inferred_category_url: string | null
          last_checked_at: string
          last_pdp_refreshed_at: string | null
          last_seen_at: string
          miss_count: number
          pdp_refresh_reason: string | null
          pending_pdp_refresh: boolean
          product_url: string
          status: string
          supplier_domain: string
          supplier_product_id: string | null
          updated_at: string
          url_key: string
        }
        Insert: {
          availability?: string | null
          availability_status?: string
          category_confidence?: string | null
          category_id: string
          category_source?: string | null
          created_at?: string
          current_currency?: string | null
          current_image?: string | null
          current_price?: number | null
          current_title?: string | null
          fingerprint?: string | null
          first_seen_at?: string
          id?: string
          inferred_category_name?: string | null
          inferred_category_path?: string | null
          inferred_category_url?: string | null
          last_checked_at?: string
          last_pdp_refreshed_at?: string | null
          last_seen_at?: string
          miss_count?: number
          pdp_refresh_reason?: string | null
          pending_pdp_refresh?: boolean
          product_url: string
          status?: string
          supplier_domain: string
          supplier_product_id?: string | null
          updated_at?: string
          url_key: string
        }
        Update: {
          availability?: string | null
          availability_status?: string
          category_confidence?: string | null
          category_id?: string
          category_source?: string | null
          created_at?: string
          current_currency?: string | null
          current_image?: string | null
          current_price?: number | null
          current_title?: string | null
          fingerprint?: string | null
          first_seen_at?: string
          id?: string
          inferred_category_name?: string | null
          inferred_category_path?: string | null
          inferred_category_url?: string | null
          last_checked_at?: string
          last_pdp_refreshed_at?: string | null
          last_seen_at?: string
          miss_count?: number
          pdp_refresh_reason?: string | null
          pending_pdp_refresh?: boolean
          product_url?: string
          status?: string
          supplier_domain?: string
          supplier_product_id?: string | null
          updated_at?: string
          url_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "category_products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "scan_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      category_scan_jobs: {
        Row: {
          added_count: number
          category_id: string
          changed_count: number
          completed_at: string | null
          created_at: string
          duration_ms: number | null
          error: string | null
          estimated_cost: number
          extracted_count: number
          fetch_failed_count: number
          id: string
          lock_expires_at: string
          miss_pass_skip_reason: string | null
          miss_pass_skipped: boolean
          parse_failed_count: number
          pdp_queued_count: number
          previous_extracted_count: number | null
          removed_count: number
          scan_type: string
          scraper_provider: string | null
          started_at: string
          status: string
          triggered_by: string
          triggered_by_user: string | null
          unchanged_count: number
        }
        Insert: {
          added_count?: number
          category_id: string
          changed_count?: number
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          estimated_cost?: number
          extracted_count?: number
          fetch_failed_count?: number
          id?: string
          lock_expires_at?: string
          miss_pass_skip_reason?: string | null
          miss_pass_skipped?: boolean
          parse_failed_count?: number
          pdp_queued_count?: number
          previous_extracted_count?: number | null
          removed_count?: number
          scan_type: string
          scraper_provider?: string | null
          started_at?: string
          status?: string
          triggered_by?: string
          triggered_by_user?: string | null
          unchanged_count?: number
        }
        Update: {
          added_count?: number
          category_id?: string
          changed_count?: number
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          estimated_cost?: number
          extracted_count?: number
          fetch_failed_count?: number
          id?: string
          lock_expires_at?: string
          miss_pass_skip_reason?: string | null
          miss_pass_skipped?: boolean
          parse_failed_count?: number
          pdp_queued_count?: number
          previous_extracted_count?: number | null
          removed_count?: number
          scan_type?: string
          scraper_provider?: string | null
          started_at?: string
          status?: string
          triggered_by?: string
          triggered_by_user?: string | null
          unchanged_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "category_scan_jobs_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "scan_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          sender_id: string | null
          sender_role: string
          session_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          sender_id?: string | null
          sender_role?: string
          session_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          sender_id?: string | null
          sender_role?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_sessions: {
        Row: {
          accepted_at: string | null
          admin_id: string | null
          closed_at: string | null
          created_at: string
          id: string
          status: string
          updated_at: string
          user_email: string | null
          user_id: string
          user_name: string | null
        }
        Insert: {
          accepted_at?: string | null
          admin_id?: string | null
          closed_at?: string | null
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_email?: string | null
          user_id: string
          user_name?: string | null
        }
        Update: {
          accepted_at?: string | null
          admin_id?: string | null
          closed_at?: string | null
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_email?: string | null
          user_id?: string
          user_name?: string | null
        }
        Relationships: []
      }
      cogs_adjustments: {
        Row: {
          amount: number
          created_at: string
          id: string
          label: string
          notes: string | null
          period_end: string
          period_start: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount?: number
          created_at?: string
          id?: string
          label: string
          notes?: string | null
          period_end: string
          period_start: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          label?: string
          notes?: string | null
          period_end?: string
          period_start?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      cost_history: {
        Row: {
          asin: string | null
          cost: number
          effective_date: string
          id: string
          listing_id: string | null
          prev_cost: number | null
          recorded_at: string
          sku: string | null
          source: string
          user_id: string
        }
        Insert: {
          asin?: string | null
          cost: number
          effective_date: string
          id?: string
          listing_id?: string | null
          prev_cost?: number | null
          recorded_at?: string
          sku?: string | null
          source?: string
          user_id: string
        }
        Update: {
          asin?: string | null
          cost?: number
          effective_date?: string
          id?: string
          listing_id?: string | null
          prev_cost?: number | null
          recorded_at?: string
          sku?: string | null
          source?: string
          user_id?: string
        }
        Relationships: []
      }
      cost_repair_audit: {
        Row: {
          after_snapshot: Json | null
          applied: boolean
          applied_at: string | null
          asin: string | null
          batch_id: string | null
          before_snapshot: Json
          created_at: string
          dry_run: boolean
          id: string
          ledger_total: number | null
          ledger_unit_cost: number | null
          ledger_units: number | null
          notes: string | null
          repair_category: string
          row_id: string
          sku: string | null
          table_name: string
          user_id: string
        }
        Insert: {
          after_snapshot?: Json | null
          applied?: boolean
          applied_at?: string | null
          asin?: string | null
          batch_id?: string | null
          before_snapshot: Json
          created_at?: string
          dry_run?: boolean
          id?: string
          ledger_total?: number | null
          ledger_unit_cost?: number | null
          ledger_units?: number | null
          notes?: string | null
          repair_category: string
          row_id: string
          sku?: string | null
          table_name: string
          user_id: string
        }
        Update: {
          after_snapshot?: Json | null
          applied?: boolean
          applied_at?: string | null
          asin?: string | null
          batch_id?: string | null
          before_snapshot?: Json
          created_at?: string
          dry_run?: boolean
          id?: string
          ledger_total?: number | null
          ledger_unit_cost?: number | null
          ledger_units?: number | null
          notes?: string | null
          repair_category?: string
          row_id?: string
          sku?: string | null
          table_name?: string
          user_id?: string
        }
        Relationships: []
      }
      created_listing_purchases: {
        Row: {
          created_at: string
          id: string
          listing_id: string
          note: string | null
          purchase_date: string
          total_cost: number
          unit_cost: number
          units: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          listing_id: string
          note?: string | null
          purchase_date?: string
          total_cost?: number
          unit_cost?: number
          units?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          listing_id?: string
          note?: string | null
          purchase_date?: string
          total_cost?: number
          unit_cost?: number
          units?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "created_listing_purchases_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "active_created_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "created_listing_purchases_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "created_listings"
            referencedColumns: ["id"]
          },
        ]
      }
      created_listings: {
        Row: {
          amount: number | null
          asin: string
          cost: number | null
          created_at: string
          date_created: string | null
          fba_block_reason: string | null
          fba_blocked: boolean
          fnsku: string | null
          id: string
          image_url: string | null
          inbound_dry_run_at: string | null
          inbound_dry_run_error: string | null
          inbound_dry_run_plan_id: string | null
          inbound_dry_run_status: string
          notes: string | null
          price: number | null
          received_quantity: number | null
          sku: string
          supplier_links: Json | null
          title: string
          units: number | null
          updated_at: string
          user_id: string
          validation_attempts: number
          validation_completed_at: string | null
          validation_failure_code: string | null
          validation_failure_reason: string | null
          validation_started_at: string | null
          validation_status: string
          validation_warning: string | null
        }
        Insert: {
          amount?: number | null
          asin: string
          cost?: number | null
          created_at?: string
          date_created?: string | null
          fba_block_reason?: string | null
          fba_blocked?: boolean
          fnsku?: string | null
          id?: string
          image_url?: string | null
          inbound_dry_run_at?: string | null
          inbound_dry_run_error?: string | null
          inbound_dry_run_plan_id?: string | null
          inbound_dry_run_status?: string
          notes?: string | null
          price?: number | null
          received_quantity?: number | null
          sku: string
          supplier_links?: Json | null
          title: string
          units?: number | null
          updated_at?: string
          user_id: string
          validation_attempts?: number
          validation_completed_at?: string | null
          validation_failure_code?: string | null
          validation_failure_reason?: string | null
          validation_started_at?: string | null
          validation_status?: string
          validation_warning?: string | null
        }
        Update: {
          amount?: number | null
          asin?: string
          cost?: number | null
          created_at?: string
          date_created?: string | null
          fba_block_reason?: string | null
          fba_blocked?: boolean
          fnsku?: string | null
          id?: string
          image_url?: string | null
          inbound_dry_run_at?: string | null
          inbound_dry_run_error?: string | null
          inbound_dry_run_plan_id?: string | null
          inbound_dry_run_status?: string
          notes?: string | null
          price?: number | null
          received_quantity?: number | null
          sku?: string
          supplier_links?: Json | null
          title?: string
          units?: number | null
          updated_at?: string
          user_id?: string
          validation_attempts?: number
          validation_completed_at?: string | null
          validation_failure_code?: string | null
          validation_failure_reason?: string | null
          validation_started_at?: string | null
          validation_status?: string
          validation_warning?: string | null
        }
        Relationships: []
      }
      cron_job_runs: {
        Row: {
          finished_at: string | null
          id: number
          job_name: string
          notes: string | null
          rows_processed: number | null
          started_at: string
          status: string
        }
        Insert: {
          finished_at?: string | null
          id?: number
          job_name: string
          notes?: string | null
          rows_processed?: number | null
          started_at?: string
          status?: string
        }
        Update: {
          finished_at?: string | null
          id?: number
          job_name?: string
          notes?: string | null
          rows_processed?: number | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      cron_locks: {
        Row: {
          acquired_at: string
          expires_at: string
          holder: string
          lock_key: string
        }
        Insert: {
          acquired_at?: string
          expires_at: string
          holder: string
          lock_key: string
        }
        Update: {
          acquired_at?: string
          expires_at?: string
          holder?: string
          lock_key?: string
        }
        Relationships: []
      }
      cron_run_history: {
        Row: {
          detail: Json | null
          duration_ms: number | null
          error: string | null
          finished_at: string | null
          id: string
          items_processed: number | null
          job_name: string
          started_at: string
          status: string
        }
        Insert: {
          detail?: Json | null
          duration_ms?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          items_processed?: number | null
          job_name: string
          started_at?: string
          status: string
        }
        Update: {
          detail?: Json | null
          duration_ms?: number | null
          error?: string | null
          finished_at?: string | null
          id?: string
          items_processed?: number | null
          job_name?: string
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      cron_run_locks: {
        Row: {
          acquired_at: string
          expires_at: string
          job_name: string
        }
        Insert: {
          acquired_at?: string
          expires_at: string
          job_name: string
        }
        Update: {
          acquired_at?: string
          expires_at?: string
          job_name?: string
        }
        Relationships: []
      }
      customer_profiles: {
        Row: {
          buyer_email: string | null
          buyer_id: string | null
          buyer_name: string | null
          created_at: string
          customer_key: string
          distinct_asins: string[]
          distinct_asins_count: number
          first_seen_at: string | null
          flag_level: string
          id: string
          last_refreshed_at: string
          last_seen_at: string | null
          order_ids: string[]
          orders_count: number
          refund_amount_usd: number
          refund_orders_count: number
          replacement_orders_count: number
          revenue_usd: number
          units_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          buyer_email?: string | null
          buyer_id?: string | null
          buyer_name?: string | null
          created_at?: string
          customer_key: string
          distinct_asins?: string[]
          distinct_asins_count?: number
          first_seen_at?: string | null
          flag_level?: string
          id?: string
          last_refreshed_at?: string
          last_seen_at?: string | null
          order_ids?: string[]
          orders_count?: number
          refund_amount_usd?: number
          refund_orders_count?: number
          replacement_orders_count?: number
          revenue_usd?: number
          units_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          buyer_email?: string | null
          buyer_id?: string | null
          buyer_name?: string | null
          created_at?: string
          customer_key?: string
          distinct_asins?: string[]
          distinct_asins_count?: number
          first_seen_at?: string | null
          flag_level?: string
          id?: string
          last_refreshed_at?: string
          last_seen_at?: string | null
          order_ids?: string[]
          orders_count?: number
          refund_amount_usd?: number
          refund_orders_count?: number
          replacement_orders_count?: number
          revenue_usd?: number
          units_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      customers: {
        Row: {
          amount: number | null
          created_at: string
          email: string
          id: string
          license_key: string | null
          name: string
          payment_status: string | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          created_at?: string
          email: string
          id?: string
          license_key?: string | null
          name: string
          payment_status?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          created_at?: string
          email?: string
          id?: string
          license_key?: string | null
          name?: string
          payment_status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      data_cleanup_runs: {
        Row: {
          details: Json
          duration_ms: number | null
          error: string | null
          id: string
          ran_at: string
        }
        Insert: {
          details?: Json
          duration_ms?: number | null
          error?: string | null
          id?: string
          ran_at?: string
        }
        Update: {
          details?: Json
          duration_ms?: number | null
          error?: string | null
          id?: string
          ran_at?: string
        }
        Relationships: []
      }
      database_maintenance_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          context: Json
          created_at: string
          id: string
          kind: string
          message: string
          severity: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          context?: Json
          created_at?: string
          id?: string
          kind: string
          message: string
          severity: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          context?: Json
          created_at?: string
          id?: string
          kind?: string
          message?: string
          severity?: string
        }
        Relationships: []
      }
      database_maintenance_jobs: {
        Row: {
          action: string
          after_stats: Json | null
          after_total_bytes: number | null
          before_stats: Json | null
          before_total_bytes: number | null
          created_at: string
          duration_ms: number | null
          error_message: string | null
          finished_at: string | null
          id: string
          params: Json
          rows_affected: number | null
          started_at: string
          status: string
          triggered_by: string | null
          triggered_by_email: string | null
        }
        Insert: {
          action: string
          after_stats?: Json | null
          after_total_bytes?: number | null
          before_stats?: Json | null
          before_total_bytes?: number | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          params?: Json
          rows_affected?: number | null
          started_at?: string
          status?: string
          triggered_by?: string | null
          triggered_by_email?: string | null
        }
        Update: {
          action?: string
          after_stats?: Json | null
          after_total_bytes?: number | null
          before_stats?: Json | null
          before_total_bytes?: number | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          params?: Json
          rows_affected?: number | null
          started_at?: string
          status?: string
          triggered_by?: string | null
          triggered_by_email?: string | null
        }
        Relationships: []
      }
      database_maintenance_settings: {
        Row: {
          cleanup_rpc: string
          description: string | null
          enabled: boolean
          retention_days: number
          schema_name: string
          table_key: string
          table_name: string
          timestamp_column: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          cleanup_rpc: string
          description?: string | null
          enabled?: boolean
          retention_days?: number
          schema_name?: string
          table_key: string
          table_name: string
          timestamp_column?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          cleanup_rpc?: string
          description?: string | null
          enabled?: boolean
          retention_days?: number
          schema_name?: string
          table_key?: string
          table_name?: string
          timestamp_column?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      database_size_snapshots: {
        Row: {
          captured_at: string
          id: number
          per_table: Json
          total_db_bytes: number
        }
        Insert: {
          captured_at?: string
          id?: number
          per_table?: Json
          total_db_bytes: number
        }
        Update: {
          captured_at?: string
          id?: number
          per_table?: Json
          total_db_bytes?: number
        }
        Relationships: []
      }
      disposition_sync_state: {
        Row: {
          last_amazon_report_id: string | null
          last_error: string | null
          last_rows_inserted: number
          last_rows_skipped: number
          last_synced_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          last_amazon_report_id?: string | null
          last_error?: string | null
          last_rows_inserted?: number
          last_rows_skipped?: number
          last_synced_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          last_amazon_report_id?: string | null
          last_error?: string | null
          last_rows_inserted?: number
          last_rows_skipped?: number
          last_synced_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      downloads: {
        Row: {
          city: string | null
          country: string | null
          downloaded_at: string
          file_type: string
          id: string
          ip_address: string | null
          latitude: number | null
          longitude: number | null
          region: string | null
          user_agent: string | null
        }
        Insert: {
          city?: string | null
          country?: string | null
          downloaded_at?: string
          file_type?: string
          id?: string
          ip_address?: string | null
          latitude?: number | null
          longitude?: number | null
          region?: string | null
          user_agent?: string | null
        }
        Update: {
          city?: string | null
          country?: string | null
          downloaded_at?: string
          file_type?: string
          id?: string
          ip_address?: string | null
          latitude?: number | null
          longitude?: number | null
          region?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      enrichment_logs: {
        Row: {
          asin: string | null
          attempts: number
          completed_at: string | null
          created_at: string
          enrichment_type: string
          error_message: string | null
          id: string
          order_id: string | null
          seller_sku: string | null
          source: string | null
          status: string
          user_id: string
        }
        Insert: {
          asin?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          enrichment_type: string
          error_message?: string | null
          id?: string
          order_id?: string | null
          seller_sku?: string | null
          source?: string | null
          status: string
          user_id: string
        }
        Update: {
          asin?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          enrichment_type?: string
          error_message?: string | null
          id?: string
          order_id?: string | null
          seller_sku?: string | null
          source?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      error_logs: {
        Row: {
          app_version: string | null
          created_at: string
          id: string
          message: string | null
          module: string | null
          stacktrace: string | null
          timestamp: string
          user_id: string | null
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          id?: string
          message?: string | null
          module?: string | null
          stacktrace?: string | null
          timestamp?: string
          user_id?: string | null
        }
        Update: {
          app_version?: string | null
          created_at?: string
          id?: string
          message?: string | null
          module?: string | null
          stacktrace?: string | null
          timestamp?: string
          user_id?: string | null
        }
        Relationships: []
      }
      error_reports: {
        Row: {
          created_at: string
          error_context: string | null
          error_message: string
          id: string
          page_url: string | null
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          error_context?: string | null
          error_message: string
          id?: string
          page_url?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          error_context?: string | null
          error_message?: string
          id?: string
          page_url?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      expense_categories: {
        Row: {
          created_at: string
          id: string
          name: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          user_id?: string | null
        }
        Relationships: []
      }
      expenses: {
        Row: {
          amount: number
          amount_overrides: Json
          category: string
          created_at: string
          currency: string
          custom_category_id: string | null
          description: string | null
          end_date: string | null
          expense_date: string
          frequency: string
          id: string
          is_advertising_cost: boolean | null
          marketplace: string | null
          name: string | null
          product_asin: string | null
          product_sku: string | null
          skipped_months: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          amount_overrides?: Json
          category: string
          created_at?: string
          currency?: string
          custom_category_id?: string | null
          description?: string | null
          end_date?: string | null
          expense_date: string
          frequency?: string
          id?: string
          is_advertising_cost?: boolean | null
          marketplace?: string | null
          name?: string | null
          product_asin?: string | null
          product_sku?: string | null
          skipped_months?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          amount_overrides?: Json
          category?: string
          created_at?: string
          currency?: string
          custom_category_id?: string | null
          description?: string | null
          end_date?: string | null
          expense_date?: string
          frequency?: string
          id?: string
          is_advertising_cost?: boolean | null
          marketplace?: string | null
          name?: string | null
          product_asin?: string | null
          product_sku?: string | null
          skipped_months?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      extracted_product_data: {
        Row: {
          availability: string | null
          availability_status: string
          confidence_score: number | null
          created_at: string
          currency: string | null
          domain: string | null
          error: string | null
          extraction_method: string | null
          id: string
          image_url: string | null
          price_current: number | null
          price_original: number | null
          raw_payload: Json | null
          raw_price_text: string | null
          title: string | null
          updated_at: string
          url: string
          user_id: string
          variant: string | null
        }
        Insert: {
          availability?: string | null
          availability_status?: string
          confidence_score?: number | null
          created_at?: string
          currency?: string | null
          domain?: string | null
          error?: string | null
          extraction_method?: string | null
          id?: string
          image_url?: string | null
          price_current?: number | null
          price_original?: number | null
          raw_payload?: Json | null
          raw_price_text?: string | null
          title?: string | null
          updated_at?: string
          url: string
          user_id: string
          variant?: string | null
        }
        Update: {
          availability?: string | null
          availability_status?: string
          confidence_score?: number | null
          created_at?: string
          currency?: string | null
          domain?: string | null
          error?: string | null
          extraction_method?: string | null
          id?: string
          image_url?: string | null
          price_current?: number | null
          price_original?: number | null
          raw_payload?: Json | null
          raw_price_text?: string | null
          title?: string | null
          updated_at?: string
          url?: string
          user_id?: string
          variant?: string | null
        }
        Relationships: []
      }
      fba_eligibility_cache: {
        Row: {
          asin: string
          blocking_issues: Json
          checked_at: string
          created_at: string
          eligible: boolean
          fba_block_reason: string | null
          id: string
          marketplace_id: string
          raw: Json | null
          seller_id: string
          updated_at: string
          user_id: string
          warnings: Json
        }
        Insert: {
          asin: string
          blocking_issues?: Json
          checked_at?: string
          created_at?: string
          eligible: boolean
          fba_block_reason?: string | null
          id?: string
          marketplace_id: string
          raw?: Json | null
          seller_id: string
          updated_at?: string
          user_id: string
          warnings?: Json
        }
        Update: {
          asin?: string
          blocking_issues?: Json
          checked_at?: string
          created_at?: string
          eligible?: boolean
          fba_block_reason?: string | null
          id?: string
          marketplace_id?: string
          raw?: Json | null
          seller_id?: string
          updated_at?: string
          user_id?: string
          warnings?: Json
        }
        Relationships: []
      }
      fba_inbound_fees: {
        Row: {
          asin: string | null
          created_at: string
          currency: string | null
          event_description: string | null
          fee_amount: number
          fee_reason: string | null
          fee_type: string
          fnsku: string | null
          id: string
          posted_date: string
          posted_date_utc: string | null
          raw_event: Json | null
          shipment_day: string | null
          shipment_id: string | null
          sku: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin?: string | null
          created_at?: string
          currency?: string | null
          event_description?: string | null
          fee_amount?: number
          fee_reason?: string | null
          fee_type: string
          fnsku?: string | null
          id?: string
          posted_date: string
          posted_date_utc?: string | null
          raw_event?: Json | null
          shipment_day?: string | null
          shipment_id?: string | null
          sku?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string | null
          created_at?: string
          currency?: string | null
          event_description?: string | null
          fee_amount?: number
          fee_reason?: string | null
          fee_type?: string
          fnsku?: string | null
          id?: string
          posted_date?: string
          posted_date_utc?: string | null
          raw_event?: Json | null
          shipment_day?: string | null
          shipment_id?: string | null
          sku?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fba_readiness_audit: {
        Row: {
          asin: string
          created_at: string
          id: string
          marketplace: string
          raw: Json | null
          reason: string | null
          source: string | null
          stage: string
          status: string
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          id?: string
          marketplace?: string
          raw?: Json | null
          reason?: string | null
          source?: string | null
          stage: string
          status: string
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          id?: string
          marketplace?: string
          raw?: Json | null
          reason?: string | null
          source?: string | null
          stage?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      fba_readiness_cache: {
        Row: {
          asin: string
          checked_at: string
          id: string
          marketplace: string
          raw: Json | null
          reason: string | null
          stage: string
          status: string
          user_id: string
        }
        Insert: {
          asin: string
          checked_at?: string
          id?: string
          marketplace?: string
          raw?: Json | null
          reason?: string | null
          stage: string
          status: string
          user_id: string
        }
        Update: {
          asin?: string
          checked_at?: string
          id?: string
          marketplace?: string
          raw?: Json | null
          reason?: string | null
          stage?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      fba_shipment_items: {
        Row: {
          asin: string | null
          created_at: string
          fnsku: string | null
          id: string
          image_url: string | null
          quantity_in_case: number | null
          quantity_received: number | null
          quantity_shipped: number | null
          seller_sku: string
          shipment_id: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin?: string | null
          created_at?: string
          fnsku?: string | null
          id?: string
          image_url?: string | null
          quantity_in_case?: number | null
          quantity_received?: number | null
          quantity_shipped?: number | null
          seller_sku: string
          shipment_id: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string | null
          created_at?: string
          fnsku?: string | null
          id?: string
          image_url?: string | null
          quantity_in_case?: number | null
          quantity_received?: number | null
          quantity_shipped?: number | null
          seller_sku?: string
          shipment_id?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fba_shipments: {
        Row: {
          are_cases_required: boolean | null
          box_contents_source: string | null
          confirmed_need_by_date: string | null
          created_at: string
          dates_synced_at: string | null
          destination_fulfillment_center_id: string | null
          id: string
          label_prep_type: string | null
          last_updated_date: string | null
          received_date: string | null
          ship_date: string | null
          shipment_id: string
          shipment_name: string | null
          shipment_status: string | null
          unresolved_date: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          are_cases_required?: boolean | null
          box_contents_source?: string | null
          confirmed_need_by_date?: string | null
          created_at?: string
          dates_synced_at?: string | null
          destination_fulfillment_center_id?: string | null
          id?: string
          label_prep_type?: string | null
          last_updated_date?: string | null
          received_date?: string | null
          ship_date?: string | null
          shipment_id: string
          shipment_name?: string | null
          shipment_status?: string | null
          unresolved_date?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          are_cases_required?: boolean | null
          box_contents_source?: string | null
          confirmed_need_by_date?: string | null
          created_at?: string
          dates_synced_at?: string | null
          destination_fulfillment_center_id?: string | null
          id?: string
          label_prep_type?: string | null
          last_updated_date?: string | null
          received_date?: string | null
          ship_date?: string | null
          shipment_id?: string
          shipment_name?: string | null
          shipment_status?: string | null
          unresolved_date?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fbm_sync_runs: {
        Row: {
          active_listings: number | null
          created_at: string
          deletions: number | null
          elapsed_ms: number | null
          enriched: number | null
          error_message: string | null
          fba_rows: number | null
          fbm_rows: number | null
          finished_at: string | null
          id: string
          inactive_listings: number | null
          inserts: number | null
          report_id: string | null
          report_poll_ms: number | null
          report_status: string | null
          rows_in_report: number | null
          started_at: string
          status: string
          triggered_by: string
          updates: number | null
          user_id: string
        }
        Insert: {
          active_listings?: number | null
          created_at?: string
          deletions?: number | null
          elapsed_ms?: number | null
          enriched?: number | null
          error_message?: string | null
          fba_rows?: number | null
          fbm_rows?: number | null
          finished_at?: string | null
          id?: string
          inactive_listings?: number | null
          inserts?: number | null
          report_id?: string | null
          report_poll_ms?: number | null
          report_status?: string | null
          rows_in_report?: number | null
          started_at?: string
          status?: string
          triggered_by?: string
          updates?: number | null
          user_id: string
        }
        Update: {
          active_listings?: number | null
          created_at?: string
          deletions?: number | null
          elapsed_ms?: number | null
          enriched?: number | null
          error_message?: string | null
          fba_rows?: number | null
          fbm_rows?: number | null
          finished_at?: string | null
          id?: string
          inactive_listings?: number | null
          inserts?: number | null
          report_id?: string | null
          report_poll_ms?: number | null
          report_status?: string | null
          rows_in_report?: number | null
          started_at?: string
          status?: string
          triggered_by?: string
          updates?: number | null
          user_id?: string
        }
        Relationships: []
      }
      financial_events_cache: {
        Row: {
          amazon_order_id: string
          asin: string
          compensated_clawback: number | null
          created_at: string
          digital_services_fee: number | null
          event_date: string
          event_type: string
          fba_customer_return_fees: number | null
          fba_disposal_fees: number | null
          fba_fees: number | null
          fba_inbound_convenience_fee: number | null
          fba_inbound_fees: number | null
          fba_long_term_storage_fees: number | null
          fba_removal_fees: number | null
          fba_storage_fees: number | null
          fbm_shipping_label_fee: number
          fixed_closing_fees: number | null
          free_replacement_refund_items: number | null
          gift_wrap_credit_refunds: number | null
          gift_wrap_credits: number | null
          hrr_non_apparel: number | null
          id: string
          liquidations: number | null
          liquidations_brokerage_fee: number | null
          marketplace: string | null
          marketplace_facilitator_tax: number | null
          marketplace_facilitator_tax_refunds: number | null
          marketplace_id: string | null
          other_fees: number | null
          other_income: number | null
          promotional_rebate_refunds: number | null
          promotional_rebates: number | null
          raw_event: Json | null
          re_commerce_grading_charge: number | null
          referral_fees: number | null
          refunds: number | null
          reimbursements: number | null
          restocking_fee: number | null
          reversal_reimbursement: number | null
          sales: number | null
          sales_tax_collected: number | null
          sales_tax_refunds: number | null
          shipping_chargeback: number | null
          shipping_chargeback_refund: number | null
          shipping_credit_refunds: number | null
          shipping_credits: number | null
          source: string
          sync_trace_id: string | null
          updated_at: string
          user_id: string
          variable_closing_fees: number | null
          warehouse_damage: number | null
          warehouse_lost: number | null
        }
        Insert: {
          amazon_order_id?: string
          asin?: string
          compensated_clawback?: number | null
          created_at?: string
          digital_services_fee?: number | null
          event_date: string
          event_type: string
          fba_customer_return_fees?: number | null
          fba_disposal_fees?: number | null
          fba_fees?: number | null
          fba_inbound_convenience_fee?: number | null
          fba_inbound_fees?: number | null
          fba_long_term_storage_fees?: number | null
          fba_removal_fees?: number | null
          fba_storage_fees?: number | null
          fbm_shipping_label_fee?: number
          fixed_closing_fees?: number | null
          free_replacement_refund_items?: number | null
          gift_wrap_credit_refunds?: number | null
          gift_wrap_credits?: number | null
          hrr_non_apparel?: number | null
          id?: string
          liquidations?: number | null
          liquidations_brokerage_fee?: number | null
          marketplace?: string | null
          marketplace_facilitator_tax?: number | null
          marketplace_facilitator_tax_refunds?: number | null
          marketplace_id?: string | null
          other_fees?: number | null
          other_income?: number | null
          promotional_rebate_refunds?: number | null
          promotional_rebates?: number | null
          raw_event?: Json | null
          re_commerce_grading_charge?: number | null
          referral_fees?: number | null
          refunds?: number | null
          reimbursements?: number | null
          restocking_fee?: number | null
          reversal_reimbursement?: number | null
          sales?: number | null
          sales_tax_collected?: number | null
          sales_tax_refunds?: number | null
          shipping_chargeback?: number | null
          shipping_chargeback_refund?: number | null
          shipping_credit_refunds?: number | null
          shipping_credits?: number | null
          source?: string
          sync_trace_id?: string | null
          updated_at?: string
          user_id: string
          variable_closing_fees?: number | null
          warehouse_damage?: number | null
          warehouse_lost?: number | null
        }
        Update: {
          amazon_order_id?: string
          asin?: string
          compensated_clawback?: number | null
          created_at?: string
          digital_services_fee?: number | null
          event_date?: string
          event_type?: string
          fba_customer_return_fees?: number | null
          fba_disposal_fees?: number | null
          fba_fees?: number | null
          fba_inbound_convenience_fee?: number | null
          fba_inbound_fees?: number | null
          fba_long_term_storage_fees?: number | null
          fba_removal_fees?: number | null
          fba_storage_fees?: number | null
          fbm_shipping_label_fee?: number
          fixed_closing_fees?: number | null
          free_replacement_refund_items?: number | null
          gift_wrap_credit_refunds?: number | null
          gift_wrap_credits?: number | null
          hrr_non_apparel?: number | null
          id?: string
          liquidations?: number | null
          liquidations_brokerage_fee?: number | null
          marketplace?: string | null
          marketplace_facilitator_tax?: number | null
          marketplace_facilitator_tax_refunds?: number | null
          marketplace_id?: string | null
          other_fees?: number | null
          other_income?: number | null
          promotional_rebate_refunds?: number | null
          promotional_rebates?: number | null
          raw_event?: Json | null
          re_commerce_grading_charge?: number | null
          referral_fees?: number | null
          refunds?: number | null
          reimbursements?: number | null
          restocking_fee?: number | null
          reversal_reimbursement?: number | null
          sales?: number | null
          sales_tax_collected?: number | null
          sales_tax_refunds?: number | null
          shipping_chargeback?: number | null
          shipping_chargeback_refund?: number | null
          shipping_credit_refunds?: number | null
          shipping_credits?: number | null
          source?: string
          sync_trace_id?: string | null
          updated_at?: string
          user_id?: string
          variable_closing_fees?: number | null
          warehouse_damage?: number | null
          warehouse_lost?: number | null
        }
        Relationships: []
      }
      financial_sync_state: {
        Row: {
          created_at: string
          last_sync_at: string
          last_synced_date: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          last_sync_at?: string
          last_synced_date: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          last_sync_at?: string
          last_synced_date?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      find_source_usage: {
        Row: {
          month_key: string
          search_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          month_key: string
          search_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          month_key?: string
          search_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fnsku_map: {
        Row: {
          asin: string
          condition: string | null
          created_at: string | null
          fnsku: string
          id: string
          marketplace_id: string
          seller_id: string
          seller_sku: string | null
          updated_at: string | null
        }
        Insert: {
          asin: string
          condition?: string | null
          created_at?: string | null
          fnsku: string
          id?: string
          marketplace_id: string
          seller_id: string
          seller_sku?: string | null
          updated_at?: string | null
        }
        Update: {
          asin?: string
          condition?: string | null
          created_at?: string | null
          fnsku?: string
          id?: string
          marketplace_id?: string
          seller_id?: string
          seller_sku?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      fnsku_sync_history: {
        Row: {
          created_at: string
          cursor_offset: number | null
          cursor_total: number | null
          enrichment_processed: number | null
          enrichment_total: number | null
          error_message: string | null
          id: string
          last_heartbeat_at: string | null
          marketplace_id: string
          phase: string | null
          poll_attempts: number | null
          processed_rows: number | null
          report_id: string | null
          seller_id: string
          status: string
          sync_completed_at: string | null
          sync_started_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          cursor_offset?: number | null
          cursor_total?: number | null
          enrichment_processed?: number | null
          enrichment_total?: number | null
          error_message?: string | null
          id?: string
          last_heartbeat_at?: string | null
          marketplace_id: string
          phase?: string | null
          poll_attempts?: number | null
          processed_rows?: number | null
          report_id?: string | null
          seller_id: string
          status: string
          sync_completed_at?: string | null
          sync_started_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          cursor_offset?: number | null
          cursor_total?: number | null
          enrichment_processed?: number | null
          enrichment_total?: number | null
          error_message?: string | null
          id?: string
          last_heartbeat_at?: string | null
          marketplace_id?: string
          phase?: string | null
          poll_attempts?: number | null
          processed_rows?: number | null
          report_id?: string | null
          seller_id?: string
          status?: string
          sync_completed_at?: string | null
          sync_started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      fnsku_sync_report_rows: {
        Row: {
          applied: boolean
          asin: string
          available: number | null
          backfill_checked: boolean
          condition: string | null
          created_at: string
          enriched: boolean
          enrichment_image_url: string | null
          enrichment_price: number | null
          enrichment_title: string | null
          fnsku: string | null
          id: string
          inbound: number | null
          is_new: boolean | null
          report_type: string
          reserved: number | null
          sku: string
          sync_id: string
          title: string | null
          unfulfilled: number | null
          units: number | null
          user_id: string
        }
        Insert: {
          applied?: boolean
          asin: string
          available?: number | null
          backfill_checked?: boolean
          condition?: string | null
          created_at?: string
          enriched?: boolean
          enrichment_image_url?: string | null
          enrichment_price?: number | null
          enrichment_title?: string | null
          fnsku?: string | null
          id?: string
          inbound?: number | null
          is_new?: boolean | null
          report_type: string
          reserved?: number | null
          sku: string
          sync_id: string
          title?: string | null
          unfulfilled?: number | null
          units?: number | null
          user_id: string
        }
        Update: {
          applied?: boolean
          asin?: string
          available?: number | null
          backfill_checked?: boolean
          condition?: string | null
          created_at?: string
          enriched?: boolean
          enrichment_image_url?: string | null
          enrichment_price?: number | null
          enrichment_title?: string | null
          fnsku?: string | null
          id?: string
          inbound?: number | null
          is_new?: boolean | null
          report_type?: string
          reserved?: number | null
          sku?: string
          sync_id?: string
          title?: string | null
          unfulfilled?: number | null
          units?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fnsku_sync_report_rows_sync_id_fkey"
            columns: ["sync_id"]
            isOneToOne: false
            referencedRelation: "fnsku_sync_history"
            referencedColumns: ["id"]
          },
        ]
      }
      full_inventory_refresh_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          current_user_item_count: number | null
          error_message: string | null
          grand_checked: number
          grand_err: number
          grand_ok: number
          id: string
          item_cursor: number
          last_heartbeat_at: string | null
          run_tag: string
          scope: string
          started_at: string
          status: string
          user_cursor: number
          user_ids: Json
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_user_item_count?: number | null
          error_message?: string | null
          grand_checked?: number
          grand_err?: number
          grand_ok?: number
          id?: string
          item_cursor?: number
          last_heartbeat_at?: string | null
          run_tag: string
          scope: string
          started_at?: string
          status?: string
          user_cursor?: number
          user_ids: Json
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_user_item_count?: number | null
          error_message?: string | null
          grand_checked?: number
          grand_err?: number
          grand_ok?: number
          id?: string
          item_cursor?: number
          last_heartbeat_at?: string | null
          run_tag?: string
          scope?: string
          started_at?: string
          status?: string
          user_cursor?: number
          user_ids?: Json
        }
        Relationships: []
      }
      fx_rates: {
        Row: {
          as_of: string
          base: string
          created_at: string
          quote: string
          rate: number
          source: string | null
          updated_at: string
        }
        Insert: {
          as_of?: string
          base?: string
          created_at?: string
          quote: string
          rate?: number
          source?: string | null
          updated_at?: string
        }
        Update: {
          as_of?: string
          base?: string
          created_at?: string
          quote?: string
          rate?: number
          source?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      gemini_daily_usage: {
        Row: {
          call_count: number
          last_failure_at: string | null
          last_failure_caller: string | null
          last_failure_status: number | null
          other_failure_count: number
          quota_failure_count: number
          success_count: number
          updated_at: string
          usage_date: string
        }
        Insert: {
          call_count?: number
          last_failure_at?: string | null
          last_failure_caller?: string | null
          last_failure_status?: number | null
          other_failure_count?: number
          quota_failure_count?: number
          success_count?: number
          updated_at?: string
          usage_date?: string
        }
        Update: {
          call_count?: number
          last_failure_at?: string | null
          last_failure_caller?: string | null
          last_failure_status?: number | null
          other_failure_count?: number
          quota_failure_count?: number
          success_count?: number
          updated_at?: string
          usage_date?: string
        }
        Relationships: []
      }
      generated_invoices: {
        Row: {
          amount: number
          created_at: string
          currency: string
          due_date: string
          id: string
          invoice_number: string
          issued_at: string
          pdf_path: string | null
          period_end: string
          period_start: string
          product_name: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount?: number
          created_at?: string
          currency?: string
          due_date?: string
          id?: string
          invoice_number: string
          issued_at?: string
          pdf_path?: string | null
          period_end: string
          period_start: string
          product_name?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          due_date?: string
          id?: string
          invoice_number?: string
          issued_at?: string
          pdf_path?: string | null
          period_end?: string
          period_start?: string
          product_name?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ghost_cleanup_runs: {
        Row: {
          archived: number
          checked: number
          duration_ms: number | null
          errors: number
          finished_at: string | null
          id: string
          marketplace: string | null
          notes: Json
          skipped_active: number
          started_at: string
        }
        Insert: {
          archived?: number
          checked?: number
          duration_ms?: number | null
          errors?: number
          finished_at?: string | null
          id?: string
          marketplace?: string | null
          notes?: Json
          skipped_active?: number
          started_at?: string
        }
        Update: {
          archived?: number
          checked?: number
          duration_ms?: number | null
          errors?: number
          finished_at?: string | null
          id?: string
          marketplace?: string | null
          notes?: Json
          skipped_active?: number
          started_at?: string
        }
        Relationships: []
      }
      ghost_sku_quarantine: {
        Row: {
          archived_at: string
          asin: string
          fnsku: string | null
          id: string
          previous_available: number | null
          previous_inbound: number | null
          previous_listing_status: string | null
          previous_reserved: number | null
          raw: Json | null
          reason: string
          seller_sku: string
          source_function: string
          user_id: string
        }
        Insert: {
          archived_at?: string
          asin: string
          fnsku?: string | null
          id?: string
          previous_available?: number | null
          previous_inbound?: number | null
          previous_listing_status?: string | null
          previous_reserved?: number | null
          raw?: Json | null
          reason: string
          seller_sku: string
          source_function: string
          user_id: string
        }
        Update: {
          archived_at?: string
          asin?: string
          fnsku?: string | null
          id?: string
          previous_available?: number | null
          previous_inbound?: number | null
          previous_listing_status?: string | null
          previous_reserved?: number | null
          raw?: Json | null
          reason?: string
          seller_sku?: string
          source_function?: string
          user_id?: string
        }
        Relationships: []
      }
      gmail_connections: {
        Row: {
          access_token: string
          created_at: string
          email: string
          id: string
          refresh_token: string
          scope: string
          token_expires_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string
          email: string
          id?: string
          refresh_token: string
          scope: string
          token_expires_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string
          email?: string
          id?: string
          refresh_token?: string
          scope?: string
          token_expires_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      gmail_oauth_states: {
        Row: {
          created_at: string
          state: string
          user_id: string
        }
        Insert: {
          created_at?: string
          state: string
          user_id: string
        }
        Update: {
          created_at?: string
          state?: string
          user_id?: string
        }
        Relationships: []
      }
      gmail_saved_filters: {
        Row: {
          created_at: string
          id: string
          label: string
          query: string
          sort_order: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          query: string
          sort_order?: number
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          query?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: []
      }
      health_retry_runs: {
        Row: {
          advanced: number
          errors: number
          finished_at: string | null
          id: string
          moved_to_stuck: number
          notes: string | null
          processed: number
          resolved: number
          started_at: string
        }
        Insert: {
          advanced?: number
          errors?: number
          finished_at?: string | null
          id?: string
          moved_to_stuck?: number
          notes?: string | null
          processed?: number
          resolved?: number
          started_at?: string
        }
        Update: {
          advanced?: number
          errors?: number
          finished_at?: string | null
          id?: string
          moved_to_stuck?: number
          notes?: string | null
          processed?: number
          resolved?: number
          started_at?: string
        }
        Relationships: []
      }
      hijacker_alerts: {
        Row: {
          asin: string
          created_at: string
          dismissed: boolean
          id: string
          marketplace: string
          new_seller_count: number | null
          new_seller_id: string
          new_seller_name: string | null
          previous_seller_count: number | null
          seen: boolean
          sku: string | null
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          dismissed?: boolean
          id?: string
          marketplace?: string
          new_seller_count?: number | null
          new_seller_id: string
          new_seller_name?: string | null
          previous_seller_count?: number | null
          seen?: boolean
          sku?: string | null
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          dismissed?: boolean
          id?: string
          marketplace?: string
          new_seller_count?: number | null
          new_seller_id?: string
          new_seller_name?: string | null
          previous_seller_count?: number | null
          seen?: boolean
          sku?: string | null
          user_id?: string
        }
        Relationships: []
      }
      historical_sync_checkpoints: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          month_key: string
          orders_processed: number | null
          started_at: string | null
          status: string
          sync_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          month_key: string
          orders_processed?: number | null
          started_at?: string | null
          status?: string
          sync_type?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          month_key?: string
          orders_processed?: number | null
          started_at?: string | null
          status?: string
          sync_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      inbound_dry_run_alerts: {
        Row: {
          alert_type: string
          asin: string | null
          cancel_error: string | null
          created_at: string
          id: string
          inbound_plan_id: string
          listing_id: string | null
          marketplace: string | null
          raw: Json | null
          resolved: boolean
          resolved_at: string | null
          resolved_note: string | null
          sku: string | null
          user_id: string
        }
        Insert: {
          alert_type: string
          asin?: string | null
          cancel_error?: string | null
          created_at?: string
          id?: string
          inbound_plan_id: string
          listing_id?: string | null
          marketplace?: string | null
          raw?: Json | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_note?: string | null
          sku?: string | null
          user_id: string
        }
        Update: {
          alert_type?: string
          asin?: string | null
          cancel_error?: string | null
          created_at?: string
          id?: string
          inbound_plan_id?: string
          listing_id?: string | null
          marketplace?: string | null
          raw?: Json | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_note?: string | null
          sku?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_dry_run_alerts_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "active_created_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_dry_run_alerts_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "created_listings"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory: {
        Row: {
          age_confidence: string | null
          amazon_price: number | null
          amount: number | null
          asin: string
          available: number | null
          bsr: number | null
          cost: number | null
          created_at: string
          days_to_expiration: number | null
          deleted_by: string | null
          deleted_reason: string | null
          estimated_age_days: number | null
          expiration_date: string | null
          fba_block_reason: string | null
          fba_blocked: boolean
          fees_json: Json | null
          first_received_at: string | null
          fnsku: string | null
          ghost_reason: string | null
          ghost_source: string | null
          ghosted_at: string | null
          id: string
          image_url: string | null
          inbound: number | null
          inbound_receiving: number
          inbound_shipped: number
          inbound_working: number
          last_bsr_sync_at: string | null
          last_inventory_sync_at: string | null
          last_price_confirmed_at: string | null
          last_price_update_at: string | null
          last_price_update_status: string | null
          last_summaries_at: string | null
          listing_created_at: string | null
          listing_status: string | null
          manual_cost_reason: string | null
          manual_cost_source: string | null
          manual_cost_updated_at: string | null
          max_price: number | null
          min_price: number | null
          my_price: number | null
          preserved_since: string | null
          price: number | null
          requires_expiration: boolean | null
          reserved: number | null
          sku: string
          source: string | null
          supplier_links: Json | null
          title: string
          unfulfilled: number | null
          unit_cost_manual: boolean | null
          units: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          age_confidence?: string | null
          amazon_price?: number | null
          amount?: number | null
          asin: string
          available?: number | null
          bsr?: number | null
          cost?: number | null
          created_at?: string
          days_to_expiration?: number | null
          deleted_by?: string | null
          deleted_reason?: string | null
          estimated_age_days?: number | null
          expiration_date?: string | null
          fba_block_reason?: string | null
          fba_blocked?: boolean
          fees_json?: Json | null
          first_received_at?: string | null
          fnsku?: string | null
          ghost_reason?: string | null
          ghost_source?: string | null
          ghosted_at?: string | null
          id?: string
          image_url?: string | null
          inbound?: number | null
          inbound_receiving?: number
          inbound_shipped?: number
          inbound_working?: number
          last_bsr_sync_at?: string | null
          last_inventory_sync_at?: string | null
          last_price_confirmed_at?: string | null
          last_price_update_at?: string | null
          last_price_update_status?: string | null
          last_summaries_at?: string | null
          listing_created_at?: string | null
          listing_status?: string | null
          manual_cost_reason?: string | null
          manual_cost_source?: string | null
          manual_cost_updated_at?: string | null
          max_price?: number | null
          min_price?: number | null
          my_price?: number | null
          preserved_since?: string | null
          price?: number | null
          requires_expiration?: boolean | null
          reserved?: number | null
          sku: string
          source?: string | null
          supplier_links?: Json | null
          title: string
          unfulfilled?: number | null
          unit_cost_manual?: boolean | null
          units?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          age_confidence?: string | null
          amazon_price?: number | null
          amount?: number | null
          asin?: string
          available?: number | null
          bsr?: number | null
          cost?: number | null
          created_at?: string
          days_to_expiration?: number | null
          deleted_by?: string | null
          deleted_reason?: string | null
          estimated_age_days?: number | null
          expiration_date?: string | null
          fba_block_reason?: string | null
          fba_blocked?: boolean
          fees_json?: Json | null
          first_received_at?: string | null
          fnsku?: string | null
          ghost_reason?: string | null
          ghost_source?: string | null
          ghosted_at?: string | null
          id?: string
          image_url?: string | null
          inbound?: number | null
          inbound_receiving?: number
          inbound_shipped?: number
          inbound_working?: number
          last_bsr_sync_at?: string | null
          last_inventory_sync_at?: string | null
          last_price_confirmed_at?: string | null
          last_price_update_at?: string | null
          last_price_update_status?: string | null
          last_summaries_at?: string | null
          listing_created_at?: string | null
          listing_status?: string | null
          manual_cost_reason?: string | null
          manual_cost_source?: string | null
          manual_cost_updated_at?: string | null
          max_price?: number | null
          min_price?: number | null
          my_price?: number | null
          preserved_since?: string | null
          price?: number | null
          requires_expiration?: boolean | null
          reserved?: number | null
          sku?: string
          source?: string | null
          supplier_links?: Json | null
          title?: string
          unfulfilled?: number | null
          unit_cost_manual?: boolean | null
          units?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      inventory_dispositions: {
        Row: {
          amazon_order_id: string | null
          asin: string | null
          cost_adjustment: number
          created_at: string
          disposition_date: string
          disposition_type: Database["public"]["Enums"]["disposition_type"]
          fnsku: string | null
          id: string
          msku: string | null
          notes: string | null
          original_sellable_qty: number | null
          original_unsellable_qty: number | null
          outcome: Database["public"]["Enums"]["disposition_outcome"]
          outcome_recorded_at: string | null
          reclassified_at: string | null
          reclassified_reason: string | null
          recovery_amount: number
          recovery_channel: string | null
          recovery_notes: string | null
          removal_order_id: string | null
          returned_to_inventory_qty: number
          sellable_qty: number
          source: Database["public"]["Enums"]["disposition_source"]
          status: Database["public"]["Enums"]["disposition_status"]
          title: string | null
          total_qty: number
          unit_cost: number
          unsellable_qty: number
          updated_at: string
          user_id: string
        }
        Insert: {
          amazon_order_id?: string | null
          asin?: string | null
          cost_adjustment?: number
          created_at?: string
          disposition_date: string
          disposition_type: Database["public"]["Enums"]["disposition_type"]
          fnsku?: string | null
          id?: string
          msku?: string | null
          notes?: string | null
          original_sellable_qty?: number | null
          original_unsellable_qty?: number | null
          outcome?: Database["public"]["Enums"]["disposition_outcome"]
          outcome_recorded_at?: string | null
          reclassified_at?: string | null
          reclassified_reason?: string | null
          recovery_amount?: number
          recovery_channel?: string | null
          recovery_notes?: string | null
          removal_order_id?: string | null
          returned_to_inventory_qty?: number
          sellable_qty?: number
          source?: Database["public"]["Enums"]["disposition_source"]
          status?: Database["public"]["Enums"]["disposition_status"]
          title?: string | null
          total_qty?: number
          unit_cost?: number
          unsellable_qty?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          amazon_order_id?: string | null
          asin?: string | null
          cost_adjustment?: number
          created_at?: string
          disposition_date?: string
          disposition_type?: Database["public"]["Enums"]["disposition_type"]
          fnsku?: string | null
          id?: string
          msku?: string | null
          notes?: string | null
          original_sellable_qty?: number | null
          original_unsellable_qty?: number | null
          outcome?: Database["public"]["Enums"]["disposition_outcome"]
          outcome_recorded_at?: string | null
          reclassified_at?: string | null
          reclassified_reason?: string | null
          recovery_amount?: number
          recovery_channel?: string | null
          recovery_notes?: string | null
          removal_order_id?: string | null
          returned_to_inventory_qty?: number
          sellable_qty?: number
          source?: Database["public"]["Enums"]["disposition_source"]
          status?: Database["public"]["Enums"]["disposition_status"]
          title?: string | null
          total_qty?: number
          unit_cost?: number
          unsellable_qty?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      inventory_history: {
        Row: {
          asin: string
          available: number | null
          captured_at: string
          id: string
          inbound: number | null
          listing_status: string | null
          reserved: number | null
          sku: string
          source: string | null
          sync_trace_id: string | null
          user_id: string
        }
        Insert: {
          asin: string
          available?: number | null
          captured_at?: string
          id?: string
          inbound?: number | null
          listing_status?: string | null
          reserved?: number | null
          sku: string
          source?: string | null
          sync_trace_id?: string | null
          user_id: string
        }
        Update: {
          asin?: string
          available?: number | null
          captured_at?: string
          id?: string
          inbound?: number | null
          listing_status?: string | null
          reserved?: number | null
          sku?: string
          source?: string | null
          sync_trace_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      inventory_missing_review: {
        Row: {
          asin: string
          created_at: string
          detection_source: string
          first_missing_at: string
          id: string
          last_missing_at: string
          marketplace: string | null
          notes: string | null
          occurrences: number
          prior_available: number
          prior_inbound: number
          prior_reserved: number
          reason: string
          resolved_at: string | null
          resolved_by: string | null
          sku: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          detection_source: string
          first_missing_at?: string
          id?: string
          last_missing_at?: string
          marketplace?: string | null
          notes?: string | null
          occurrences?: number
          prior_available?: number
          prior_inbound?: number
          prior_reserved?: number
          reason: string
          resolved_at?: string | null
          resolved_by?: string | null
          sku: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          detection_source?: string
          first_missing_at?: string
          id?: string
          last_missing_at?: string
          marketplace?: string | null
          notes?: string | null
          occurrences?: number
          prior_available?: number
          prior_inbound?: number
          prior_reserved?: number
          reason?: string
          resolved_at?: string | null
          resolved_by?: string | null
          sku?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      inventory_refresh_queue: {
        Row: {
          asin: string
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          locked_at: string | null
          marketplace: string
          priority: number
          processed_at: string | null
          sku: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          marketplace?: string
          priority?: number
          processed_at?: string | null
          sku: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          marketplace?: string
          priority?: number
          processed_at?: string | null
          sku?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      inventory_valuation_summary: {
        Row: {
          available: number
          available_value: number
          compute_ms: number | null
          computed_at: string
          inbound: number
          inbound_value: number
          low_stock: number
          most_recent_sync: string | null
          reserved: number
          reserved_value: number
          rows_stale_24h: number
          skus: number
          source: string
          total_rows: number
          unfulfilled: number
          unfulfilled_value: number
          units: number
          user_id: string
          value: number
        }
        Insert: {
          available?: number
          available_value?: number
          compute_ms?: number | null
          computed_at?: string
          inbound?: number
          inbound_value?: number
          low_stock?: number
          most_recent_sync?: string | null
          reserved?: number
          reserved_value?: number
          rows_stale_24h?: number
          skus?: number
          source?: string
          total_rows?: number
          unfulfilled?: number
          unfulfilled_value?: number
          units?: number
          user_id: string
          value?: number
        }
        Update: {
          available?: number
          available_value?: number
          compute_ms?: number | null
          computed_at?: string
          inbound?: number
          inbound_value?: number
          low_stock?: number
          most_recent_sync?: string | null
          reserved?: number
          reserved_value?: number
          rows_stale_24h?: number
          skus?: number
          source?: string
          total_rows?: number
          unfulfilled?: number
          unfulfilled_value?: number
          units?: number
          user_id?: string
          value?: number
        }
        Relationships: []
      }
      inventory_valuation_summary_lock: {
        Row: {
          locked_at: string
          locked_by: string | null
          user_id: string
        }
        Insert: {
          locked_at?: string
          locked_by?: string | null
          user_id: string
        }
        Update: {
          locked_at?: string
          locked_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      inventory_writeoffs: {
        Row: {
          asin: string | null
          created_at: string
          id: string
          notes: string | null
          quantity: number
          reason: string
          sku: string | null
          title: string | null
          total_cost: number
          unit_cost: number
          updated_at: string
          user_id: string
          writeoff_date: string
        }
        Insert: {
          asin?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          quantity?: number
          reason?: string
          sku?: string | null
          title?: string | null
          total_cost?: number
          unit_cost?: number
          updated_at?: string
          user_id: string
          writeoff_date: string
        }
        Update: {
          asin?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          quantity?: number
          reason?: string
          sku?: string | null
          title?: string | null
          total_cost?: number
          unit_cost?: number
          updated_at?: string
          user_id?: string
          writeoff_date?: string
        }
        Relationships: []
      }
      keepa_batches: {
        Row: {
          created_at: string | null
          error: string | null
          filename: string | null
          id: string
          processed_rows: number | null
          status: string | null
          total_rows: number | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          error?: string | null
          filename?: string | null
          id?: string
          processed_rows?: number | null
          status?: string | null
          total_rows?: number | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          error?: string | null
          filename?: string | null
          id?: string
          processed_rows?: number | null
          status?: string | null
          total_rows?: number | null
          user_id?: string
        }
        Relationships: []
      }
      keepa_catalog_products: {
        Row: {
          amazon_on_listing: boolean | null
          asin: string
          brand: string | null
          buy_box_price: number | null
          category: string | null
          fba_offer_count: number | null
          image_url: string | null
          imported_at: string
          monthly_sold: number | null
          new_offer_count: number | null
          rating: number | null
          review_count: number | null
          sales_rank_current: number | null
          title: string | null
          updated_at: string
        }
        Insert: {
          amazon_on_listing?: boolean | null
          asin: string
          brand?: string | null
          buy_box_price?: number | null
          category?: string | null
          fba_offer_count?: number | null
          image_url?: string | null
          imported_at?: string
          monthly_sold?: number | null
          new_offer_count?: number | null
          rating?: number | null
          review_count?: number | null
          sales_rank_current?: number | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          amazon_on_listing?: boolean | null
          asin?: string
          brand?: string | null
          buy_box_price?: number | null
          category?: string | null
          fba_offer_count?: number | null
          image_url?: string | null
          imported_at?: string
          monthly_sold?: number | null
          new_offer_count?: number | null
          rating?: number | null
          review_count?: number | null
          sales_rank_current?: number | null
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      keepa_daily_usage: {
        Row: {
          cache_fallback_count: number
          call_count: number
          created_at: string | null
          keepa_429_count: number
          keepa_retry_success_count: number
          keepa_skipped_cache_fresh: number
          keepa_skipped_not_eligible: number
          keepa_skipped_token_budget: number
          keepa_success_count: number
          last_called_at: string | null
          sp_api_throttled_count: number
          usage_date: string
        }
        Insert: {
          cache_fallback_count?: number
          call_count?: number
          created_at?: string | null
          keepa_429_count?: number
          keepa_retry_success_count?: number
          keepa_skipped_cache_fresh?: number
          keepa_skipped_not_eligible?: number
          keepa_skipped_token_budget?: number
          keepa_success_count?: number
          last_called_at?: string | null
          sp_api_throttled_count?: number
          usage_date?: string
        }
        Update: {
          cache_fallback_count?: number
          call_count?: number
          created_at?: string | null
          keepa_429_count?: number
          keepa_retry_success_count?: number
          keepa_skipped_cache_fresh?: number
          keepa_skipped_not_eligible?: number
          keepa_skipped_token_budget?: number
          keepa_success_count?: number
          last_called_at?: string | null
          sp_api_throttled_count?: number
          usage_date?: string
        }
        Relationships: []
      }
      keepa_estimate_accuracy: {
        Row: {
          actual_price: number
          asin: string
          created_at: string
          delta_abs: number | null
          delta_pct: number | null
          flagged: boolean
          id: string
          keepa_estimate: number
          marketplace: string | null
          notes: string | null
          order_date: string | null
          order_id: string
          user_id: string
        }
        Insert: {
          actual_price: number
          asin: string
          created_at?: string
          delta_abs?: number | null
          delta_pct?: number | null
          flagged?: boolean
          id?: string
          keepa_estimate: number
          marketplace?: string | null
          notes?: string | null
          order_date?: string | null
          order_id: string
          user_id: string
        }
        Update: {
          actual_price?: number
          asin?: string
          created_at?: string
          delta_abs?: number | null
          delta_pct?: number | null
          flagged?: boolean
          id?: string
          keepa_estimate?: number
          marketplace?: string | null
          notes?: string | null
          order_date?: string | null
          order_id?: string
          user_id?: string
        }
        Relationships: []
      }
      keepa_items: {
        Row: {
          amz_asin: string | null
          amz_image: string | null
          amz_link: string | null
          amz_price: number | null
          amz_title: string | null
          asin: string | null
          batch_id: string
          category: string | null
          error: string | null
          fees_json: Json | null
          g_image: string | null
          g_link: string | null
          g_price: number | null
          g_store: string | null
          g_title: string | null
          id: string
          idx: number | null
          image_score: number | null
          margin_pct: number | null
          match_score: number | null
          roi: number | null
          status: string | null
          title: string | null
          title_score: number | null
        }
        Insert: {
          amz_asin?: string | null
          amz_image?: string | null
          amz_link?: string | null
          amz_price?: number | null
          amz_title?: string | null
          asin?: string | null
          batch_id: string
          category?: string | null
          error?: string | null
          fees_json?: Json | null
          g_image?: string | null
          g_link?: string | null
          g_price?: number | null
          g_store?: string | null
          g_title?: string | null
          id?: string
          idx?: number | null
          image_score?: number | null
          margin_pct?: number | null
          match_score?: number | null
          roi?: number | null
          status?: string | null
          title?: string | null
          title_score?: number | null
        }
        Update: {
          amz_asin?: string | null
          amz_image?: string | null
          amz_link?: string | null
          amz_price?: number | null
          amz_title?: string | null
          asin?: string | null
          batch_id?: string
          category?: string | null
          error?: string | null
          fees_json?: Json | null
          g_image?: string | null
          g_link?: string | null
          g_price?: number | null
          g_store?: string | null
          g_title?: string | null
          id?: string
          idx?: number | null
          image_score?: number | null
          margin_pct?: number | null
          match_score?: number | null
          roi?: number | null
          status?: string | null
          title?: string | null
          title_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "keepa_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "keepa_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      keepa_price_cache: {
        Row: {
          asin: string
          bucket_ts: string
          domain_id: number | null
          expires_at: string
          fetched_at: string
          id: string
          marketplace: string
          price_usd: number | null
          raw_price_cents: number | null
          source: string | null
        }
        Insert: {
          asin: string
          bucket_ts: string
          domain_id?: number | null
          expires_at?: string
          fetched_at?: string
          id?: string
          marketplace: string
          price_usd?: number | null
          raw_price_cents?: number | null
          source?: string | null
        }
        Update: {
          asin?: string
          bucket_ts?: string
          domain_id?: number | null
          expires_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          price_usd?: number | null
          raw_price_cents?: number | null
          source?: string | null
        }
        Relationships: []
      }
      keepa_price_history_cache: {
        Row: {
          asin: string
          days_range: number
          expires_at: string
          fetched_at: string
          id: string
          marketplace: string
          offers: Json | null
          series: Json
        }
        Insert: {
          asin: string
          days_range: number
          expires_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          offers?: Json | null
          series: Json
        }
        Update: {
          asin?: string
          days_range?: number
          expires_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          offers?: Json | null
          series?: Json
        }
        Relationships: []
      }
      keepa_price_stability_cache: {
        Row: {
          asin: string
          avg_price: number | null
          current_price: number | null
          days_covered: number | null
          drops_90: number | null
          expires_at: string
          fetched_at: string
          id: string
          marketplace: string
          max_price: number | null
          min_price: number | null
          raw: Json | null
          series_used: string | null
          swing_pct: number | null
          verdict: string
        }
        Insert: {
          asin: string
          avg_price?: number | null
          current_price?: number | null
          days_covered?: number | null
          drops_90?: number | null
          expires_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          max_price?: number | null
          min_price?: number | null
          raw?: Json | null
          series_used?: string | null
          swing_pct?: number | null
          verdict?: string
        }
        Update: {
          asin?: string
          avg_price?: number | null
          current_price?: number | null
          days_covered?: number | null
          drops_90?: number | null
          expires_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          max_price?: number | null
          min_price?: number | null
          raw?: Json | null
          series_used?: string | null
          swing_pct?: number | null
          verdict?: string
        }
        Relationships: []
      }
      keepa_products: {
        Row: {
          amazon_link: string | null
          amazon_price: number | null
          asin: string
          brand: string | null
          buy_box_price: number | null
          category: string | null
          category_id: number | null
          drops_30: number | null
          drops_90: number | null
          fba_offer_count: number | null
          fba_price: number | null
          fbm_offer_count: number | null
          fbm_price: number | null
          id: string
          image_url: string | null
          imported_at: string
          is_adult_product: boolean | null
          is_hazmat: boolean | null
          is_meltable: boolean | null
          manufacturer: string | null
          marketplace: string
          monthly_sold: number | null
          new_offer_count: number | null
          new_price: number | null
          rating: number | null
          rating_count: number | null
          sales_rank: number | null
          title: string | null
          updated_at: string
        }
        Insert: {
          amazon_link?: string | null
          amazon_price?: number | null
          asin: string
          brand?: string | null
          buy_box_price?: number | null
          category?: string | null
          category_id?: number | null
          drops_30?: number | null
          drops_90?: number | null
          fba_offer_count?: number | null
          fba_price?: number | null
          fbm_offer_count?: number | null
          fbm_price?: number | null
          id?: string
          image_url?: string | null
          imported_at?: string
          is_adult_product?: boolean | null
          is_hazmat?: boolean | null
          is_meltable?: boolean | null
          manufacturer?: string | null
          marketplace?: string
          monthly_sold?: number | null
          new_offer_count?: number | null
          new_price?: number | null
          rating?: number | null
          rating_count?: number | null
          sales_rank?: number | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          amazon_link?: string | null
          amazon_price?: number | null
          asin?: string
          brand?: string | null
          buy_box_price?: number | null
          category?: string | null
          category_id?: number | null
          drops_30?: number | null
          drops_90?: number | null
          fba_offer_count?: number | null
          fba_price?: number | null
          fbm_offer_count?: number | null
          fbm_price?: number | null
          id?: string
          image_url?: string | null
          imported_at?: string
          is_adult_product?: boolean | null
          is_hazmat?: boolean | null
          is_meltable?: boolean | null
          manufacturer?: string | null
          marketplace?: string
          monthly_sold?: number | null
          new_offer_count?: number | null
          new_price?: number | null
          rating?: number | null
          rating_count?: number | null
          sales_rank?: number | null
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      keepa_seller_name_cache: {
        Row: {
          business_name: string | null
          current_rating: number | null
          current_rating_count: number | null
          expires_at: string
          fetched_at: string
          is_amazon: boolean
          marketplace: string
          seller_id: string
          storefront_name: string | null
        }
        Insert: {
          business_name?: string | null
          current_rating?: number | null
          current_rating_count?: number | null
          expires_at?: string
          fetched_at?: string
          is_amazon?: boolean
          marketplace?: string
          seller_id: string
          storefront_name?: string | null
        }
        Update: {
          business_name?: string | null
          current_rating?: number | null
          current_rating_count?: number | null
          expires_at?: string
          fetched_at?: string
          is_amazon?: boolean
          marketplace?: string
          seller_id?: string
          storefront_name?: string | null
        }
        Relationships: []
      }
      keepa_simple_products: {
        Row: {
          asin: string
          brand: string | null
          category: string | null
          fba_offer_count: number | null
          fbm_offer_count: number | null
          image_url: string | null
          imported_at: string
          new_offer_count: number | null
          title: string | null
          updated_at: string
        }
        Insert: {
          asin: string
          brand?: string | null
          category?: string | null
          fba_offer_count?: number | null
          fbm_offer_count?: number | null
          image_url?: string | null
          imported_at?: string
          new_offer_count?: number | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          asin?: string
          brand?: string | null
          category?: string | null
          fba_offer_count?: number | null
          fbm_offer_count?: number | null
          image_url?: string | null
          imported_at?: string
          new_offer_count?: number | null
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      keepa_token_budget: {
        Row: {
          bucket_max: number
          denied_count: number
          id: boolean
          last_denied_at: string | null
          last_observed_at: string | null
          refill_observed_at: string | null
          refill_per_min: number
          tokens_left: number
          updated_at: string
        }
        Insert: {
          bucket_max?: number
          denied_count?: number
          id?: boolean
          last_denied_at?: string | null
          last_observed_at?: string | null
          refill_observed_at?: string | null
          refill_per_min?: number
          tokens_left?: number
          updated_at?: string
        }
        Update: {
          bucket_max?: number
          denied_count?: number
          id?: boolean
          last_denied_at?: string | null
          last_observed_at?: string | null
          refill_observed_at?: string | null
          refill_per_min?: number
          tokens_left?: number
          updated_at?: string
        }
        Relationships: []
      }
      learned_fee_multipliers: {
        Row: {
          confidence: string
          created_at: string
          fee_component: string
          id: string
          last_computed_at: string
          marketplace: string
          multiplier: number | null
          raw_actual_total: number | null
          raw_estimated_total: number | null
          sample_count: number
          sample_orders: Json
          updated_at: string
          user_id: string
          window_end: string | null
          window_start: string | null
        }
        Insert: {
          confidence?: string
          created_at?: string
          fee_component: string
          id?: string
          last_computed_at?: string
          marketplace: string
          multiplier?: number | null
          raw_actual_total?: number | null
          raw_estimated_total?: number | null
          sample_count?: number
          sample_orders?: Json
          updated_at?: string
          user_id: string
          window_end?: string | null
          window_start?: string | null
        }
        Update: {
          confidence?: string
          created_at?: string
          fee_component?: string
          id?: string
          last_computed_at?: string
          marketplace?: string
          multiplier?: number | null
          raw_actual_total?: number | null
          raw_estimated_total?: number | null
          sample_count?: number
          sample_orders?: Json
          updated_at?: string
          user_id?: string
          window_end?: string | null
          window_start?: string | null
        }
        Relationships: []
      }
      learned_fee_multipliers_asin: {
        Row: {
          asin: string
          confidence: string
          created_at: string
          fee_component: string
          id: string
          last_computed_at: string
          marketplace: string
          multiplier: number | null
          raw_actual_total: number | null
          raw_estimated_total: number | null
          sample_count: number
          sample_orders: Json
          updated_at: string
          user_id: string
          window_end: string | null
          window_start: string | null
        }
        Insert: {
          asin: string
          confidence?: string
          created_at?: string
          fee_component: string
          id?: string
          last_computed_at?: string
          marketplace: string
          multiplier?: number | null
          raw_actual_total?: number | null
          raw_estimated_total?: number | null
          sample_count?: number
          sample_orders?: Json
          updated_at?: string
          user_id: string
          window_end?: string | null
          window_start?: string | null
        }
        Update: {
          asin?: string
          confidence?: string
          created_at?: string
          fee_component?: string
          id?: string
          last_computed_at?: string
          marketplace?: string
          multiplier?: number | null
          raw_actual_total?: number | null
          raw_estimated_total?: number | null
          sample_count?: number
          sample_orders?: Json
          updated_at?: string
          user_id?: string
          window_end?: string | null
          window_start?: string | null
        }
        Relationships: []
      }
      listing_validation_audit: {
        Row: {
          asin: string | null
          created_at: string
          id: string
          listing_id: string | null
          marketplace: string | null
          raw: Json | null
          reason: string | null
          sku: string | null
          source: string | null
          stage: string
          status: string
          user_id: string
        }
        Insert: {
          asin?: string | null
          created_at?: string
          id?: string
          listing_id?: string | null
          marketplace?: string | null
          raw?: Json | null
          reason?: string | null
          sku?: string | null
          source?: string | null
          stage: string
          status: string
          user_id: string
        }
        Update: {
          asin?: string | null
          created_at?: string
          id?: string
          listing_id?: string | null
          marketplace?: string | null
          raw?: Json | null
          reason?: string | null
          sku?: string | null
          source?: string | null
          stage?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      listing_validation_queue: {
        Row: {
          asin: string
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          listing_id: string
          marketplace: string
          next_run_at: string
          next_stage: string
          sku: string
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          listing_id: string
          marketplace?: string
          next_run_at?: string
          next_stage?: string
          sku: string
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          listing_id?: string
          marketplace?: string
          next_run_at?: string
          next_stage?: string
          sku?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "listing_validation_queue_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "active_created_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listing_validation_queue_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "created_listings"
            referencedColumns: ["id"]
          },
        ]
      }
      listing_validations: {
        Row: {
          asin: string
          created_at: string
          id: string
          issues: Json
          issues_count: number
          marketplace: string
          mode: string
          raw_response: Json | null
          sku: string
          status: string | null
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          id?: string
          issues?: Json
          issues_count?: number
          marketplace?: string
          mode?: string
          raw_response?: Json | null
          sku: string
          status?: string | null
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          id?: string
          issues?: Json
          issues_count?: number
          marketplace?: string
          mode?: string
          raw_response?: Json | null
          sku?: string
          status?: string | null
          user_id?: string
        }
        Relationships: []
      }
      live_refunds_cache: {
        Row: {
          cached_at: string
          end_date: string
          error: string | null
          refunds: Json
          start_date: string
          status: string
          user_id: string
        }
        Insert: {
          cached_at?: string
          end_date: string
          error?: string | null
          refunds?: Json
          start_date: string
          status?: string
          user_id: string
        }
        Update: {
          cached_at?: string
          end_date?: string
          error?: string | null
          refunds?: Json
          start_date?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      live_sales_period_cache: {
        Row: {
          asin_rows: Json
          computed_at: string
          computed_duration_ms: number | null
          created_at: string
          marketplace: string
          notes: string | null
          period_end: string
          period_key: string
          period_start: string
          sales_sync_version: number
          source_row_count: number
          totals: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          asin_rows?: Json
          computed_at?: string
          computed_duration_ms?: number | null
          created_at?: string
          marketplace: string
          notes?: string | null
          period_end: string
          period_key: string
          period_start: string
          sales_sync_version?: number
          source_row_count?: number
          totals?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          asin_rows?: Json
          computed_at?: string
          computed_duration_ms?: number | null
          created_at?: string
          marketplace?: string
          notes?: string | null
          period_end?: string
          period_key?: string
          period_start?: string
          sales_sync_version?: number
          source_row_count?: number
          totals?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      live_sales_summary: {
        Row: {
          business_date: string
          computed_at: string
          confirmed_count: number
          cost: number
          cost_with_fallback: number
          fallback_count: number
          fees: number
          fees_with_fallback: number
          high_confidence_count: number
          low_confidence_count: number
          marketplace_id: string
          orders: number
          orders_with_fallback: number
          pending_estimate_revenue: number
          profit: number
          profit_with_fallback: number
          refund_amount: number
          refund_count: number
          revenue: number
          revenue_with_fallback: number
          roi: number
          source: string
          units: number
          units_with_fallback: number
          updated_at: string
          user_id: string
        }
        Insert: {
          business_date: string
          computed_at?: string
          confirmed_count?: number
          cost?: number
          cost_with_fallback?: number
          fallback_count?: number
          fees?: number
          fees_with_fallback?: number
          high_confidence_count?: number
          low_confidence_count?: number
          marketplace_id?: string
          orders?: number
          orders_with_fallback?: number
          pending_estimate_revenue?: number
          profit?: number
          profit_with_fallback?: number
          refund_amount?: number
          refund_count?: number
          revenue?: number
          revenue_with_fallback?: number
          roi?: number
          source?: string
          units?: number
          units_with_fallback?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          business_date?: string
          computed_at?: string
          confirmed_count?: number
          cost?: number
          cost_with_fallback?: number
          fallback_count?: number
          fees?: number
          fees_with_fallback?: number
          high_confidence_count?: number
          low_confidence_count?: number
          marketplace_id?: string
          orders?: number
          orders_with_fallback?: number
          pending_estimate_revenue?: number
          profit?: number
          profit_with_fallback?: number
          refund_amount?: number
          refund_count?: number
          revenue?: number
          revenue_with_fallback?: number
          roi?: number
          source?: string
          units?: number
          units_with_fallback?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      live_sales_summary_lock: {
        Row: {
          locked_at: string
          locked_by: string | null
          user_id: string
        }
        Insert: {
          locked_at?: string
          locked_by?: string | null
          user_id: string
        }
        Update: {
          locked_at?: string
          locked_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      live_sales_today_by_asin: {
        Row: {
          asin: string
          business_date: string
          computed_at: string
          created_at: string
          id: string
          marketplace: string
          orders: number
          pending_estimate_usd: number
          revenue_usd: number
          revenue_with_fallback_usd: number
          summary_version: number
          units: number
          units_with_fallback: number
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          business_date: string
          computed_at?: string
          created_at?: string
          id?: string
          marketplace: string
          orders?: number
          pending_estimate_usd?: number
          revenue_usd?: number
          revenue_with_fallback_usd?: number
          summary_version?: number
          units?: number
          units_with_fallback?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          business_date?: string
          computed_at?: string
          created_at?: string
          id?: string
          marketplace?: string
          orders?: number
          pending_estimate_usd?: number
          revenue_usd?: number
          revenue_with_fallback_usd?: number
          summary_version?: number
          units?: number
          units_with_fallback?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      live_verify_schedule: {
        Row: {
          active_sku_count: number | null
          avg_runtime_seconds: number | null
          computed_interval_hours: number
          created_at: string
          is_enabled: boolean
          is_running: boolean
          last_error: string | null
          last_run_at: string | null
          last_runtime_seconds: number | null
          next_run_at: string
          run_history_count: number
          run_started_at: string | null
          total_runs: number
          updated_at: string
          user_id: string
        }
        Insert: {
          active_sku_count?: number | null
          avg_runtime_seconds?: number | null
          computed_interval_hours?: number
          created_at?: string
          is_enabled?: boolean
          is_running?: boolean
          last_error?: string | null
          last_run_at?: string | null
          last_runtime_seconds?: number | null
          next_run_at?: string
          run_history_count?: number
          run_started_at?: string | null
          total_runs?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          active_sku_count?: number | null
          avg_runtime_seconds?: number | null
          computed_interval_hours?: number
          created_at?: string
          is_enabled?: boolean
          is_running?: boolean
          last_error?: string | null
          last_run_at?: string | null
          last_runtime_seconds?: number | null
          next_run_at?: string
          run_history_count?: number
          run_started_at?: string | null
          total_runs?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      mobile_scan_cost_memory: {
        Row: {
          asin: string | null
          barcode: string | null
          created_at: string
          id: string
          sale_price_override: number | null
          total_cost: number | null
          units: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin?: string | null
          barcode?: string | null
          created_at?: string
          id?: string
          sale_price_override?: number | null
          total_cost?: number | null
          units?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string | null
          barcode?: string | null
          created_at?: string
          id?: string
          sale_price_override?: number | null
          total_cost?: number | null
          units?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      mobile_scan_history: {
        Row: {
          asin: string | null
          barcode: string
          barcode_format: string | null
          brand: string | null
          created_at: string
          currency: string | null
          id: string
          image_url: string | null
          marketplace: string | null
          price: number | null
          raw: Json | null
          sale_price_override: number | null
          title: string | null
          total_cost: number | null
          units: number | null
          user_id: string
        }
        Insert: {
          asin?: string | null
          barcode: string
          barcode_format?: string | null
          brand?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          image_url?: string | null
          marketplace?: string | null
          price?: number | null
          raw?: Json | null
          sale_price_override?: number | null
          title?: string | null
          total_cost?: number | null
          units?: number | null
          user_id: string
        }
        Update: {
          asin?: string | null
          barcode?: string
          barcode_format?: string | null
          brand?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          image_url?: string | null
          marketplace?: string | null
          price?: number | null
          raw?: Json | null
          sale_price_override?: number | null
          title?: string | null
          total_cost?: number | null
          units?: number | null
          user_id?: string
        }
        Relationships: []
      }
      module_usage: {
        Row: {
          count: number
          created_at: string
          id: string
          label: string | null
          last_used: string
          path: string
          updated_at: string
          user_id: string
        }
        Insert: {
          count?: number
          created_at?: string
          id?: string
          label?: string | null
          last_used?: string
          path: string
          updated_at?: string
          user_id: string
        }
        Update: {
          count?: number
          created_at?: string
          id?: string
          label?: string | null
          last_used?: string
          path?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      order_price_snapshots: {
        Row: {
          asin: string
          captured_at: string
          created_at: string
          currency: string | null
          currency_code: string | null
          fx_rate_used: number | null
          id: string
          inventory_price_at_capture: number | null
          listing_api_price_at_capture: number | null
          marketplace_id: string | null
          order_id: string
          seller_sku: string | null
          snapshot_item_price: number | null
          snapshot_price: number
          snapshot_shipping_price: number | null
          snapshot_source: string
          user_id: string
        }
        Insert: {
          asin: string
          captured_at?: string
          created_at?: string
          currency?: string | null
          currency_code?: string | null
          fx_rate_used?: number | null
          id?: string
          inventory_price_at_capture?: number | null
          listing_api_price_at_capture?: number | null
          marketplace_id?: string | null
          order_id: string
          seller_sku?: string | null
          snapshot_item_price?: number | null
          snapshot_price: number
          snapshot_shipping_price?: number | null
          snapshot_source?: string
          user_id: string
        }
        Update: {
          asin?: string
          captured_at?: string
          created_at?: string
          currency?: string | null
          currency_code?: string | null
          fx_rate_used?: number | null
          id?: string
          inventory_price_at_capture?: number | null
          listing_api_price_at_capture?: number | null
          marketplace_id?: string | null
          order_id?: string
          seller_sku?: string | null
          snapshot_item_price?: number | null
          snapshot_price?: number
          snapshot_shipping_price?: number | null
          snapshot_source?: string
          user_id?: string
        }
        Relationships: []
      }
      organization_settings: {
        Row: {
          address: string | null
          created_at: string
          id: string
          logo_url: string | null
          organization_name: string | null
          phone_number: string | null
          tax_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          logo_url?: string | null
          organization_name?: string | null
          phone_number?: string | null
          tax_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          logo_url?: string | null
          organization_name?: string | null
          phone_number?: string | null
          tax_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      personalhour_orders: {
        Row: {
          amazon_fee_fbm: number | null
          amount_owed: number | null
          asin: string
          buyer_name: string | null
          commission: number | null
          cost: number | null
          created_at: string
          fnsku: string | null
          id: string
          image_url: string | null
          order_created_date: string
          price: number | null
          sales_tax: number | null
          settled: boolean | null
          shipping_cost: number | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amazon_fee_fbm?: number | null
          amount_owed?: number | null
          asin: string
          buyer_name?: string | null
          commission?: number | null
          cost?: number | null
          created_at?: string
          fnsku?: string | null
          id?: string
          image_url?: string | null
          order_created_date: string
          price?: number | null
          sales_tax?: number | null
          settled?: boolean | null
          shipping_cost?: number | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amazon_fee_fbm?: number | null
          amount_owed?: number | null
          asin?: string
          buyer_name?: string | null
          commission?: number | null
          cost?: number | null
          created_at?: string
          fnsku?: string | null
          id?: string
          image_url?: string | null
          order_created_date?: string
          price?: number | null
          sales_tax?: number | null
          settled?: boolean | null
          shipping_cost?: number | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      pl_month_summary: {
        Row: {
          compensated_clawback: number
          computed_at: string | null
          created_at: string
          digital_services_fee: number
          event_count: number
          fba_customer_return_fees: number
          fba_disposal_fees: number
          fba_fees: number
          fba_inbound_convenience_fee: number
          fba_inbound_fees: number
          fba_long_term_storage_fees: number
          fba_removal_fees: number
          fba_storage_fees: number
          fixed_closing_fees: number
          free_replacement_refund_items: number
          gift_wrap_credit_refunds: number
          gift_wrap_credits: number
          hrr_non_apparel: number
          liquidations: number
          liquidations_brokerage_fee: number
          marketplace_facilitator_tax: number
          marketplace_facilitator_tax_refunds: number
          month_key: string
          other_fees: number
          other_income: number
          promotional_rebate_refunds: number
          promotional_rebates: number
          re_commerce_grading_charge: number
          referral_fees: number
          refund_count: number
          refunds: number
          reimbursements_raw: number
          reversal_reimbursement: number
          sales: number
          sales_tax_collected: number
          sales_tax_refunds: number
          service_fee_count: number
          shipment_count: number
          shipping_chargeback: number
          shipping_chargeback_refund: number
          shipping_credit_refunds: number
          shipping_credits: number
          source: string | null
          stale_at: string | null
          updated_at: string
          user_id: string
          variable_closing_fees: number
          warehouse_damage: number
          warehouse_lost: number
        }
        Insert: {
          compensated_clawback?: number
          computed_at?: string | null
          created_at?: string
          digital_services_fee?: number
          event_count?: number
          fba_customer_return_fees?: number
          fba_disposal_fees?: number
          fba_fees?: number
          fba_inbound_convenience_fee?: number
          fba_inbound_fees?: number
          fba_long_term_storage_fees?: number
          fba_removal_fees?: number
          fba_storage_fees?: number
          fixed_closing_fees?: number
          free_replacement_refund_items?: number
          gift_wrap_credit_refunds?: number
          gift_wrap_credits?: number
          hrr_non_apparel?: number
          liquidations?: number
          liquidations_brokerage_fee?: number
          marketplace_facilitator_tax?: number
          marketplace_facilitator_tax_refunds?: number
          month_key: string
          other_fees?: number
          other_income?: number
          promotional_rebate_refunds?: number
          promotional_rebates?: number
          re_commerce_grading_charge?: number
          referral_fees?: number
          refund_count?: number
          refunds?: number
          reimbursements_raw?: number
          reversal_reimbursement?: number
          sales?: number
          sales_tax_collected?: number
          sales_tax_refunds?: number
          service_fee_count?: number
          shipment_count?: number
          shipping_chargeback?: number
          shipping_chargeback_refund?: number
          shipping_credit_refunds?: number
          shipping_credits?: number
          source?: string | null
          stale_at?: string | null
          updated_at?: string
          user_id: string
          variable_closing_fees?: number
          warehouse_damage?: number
          warehouse_lost?: number
        }
        Update: {
          compensated_clawback?: number
          computed_at?: string | null
          created_at?: string
          digital_services_fee?: number
          event_count?: number
          fba_customer_return_fees?: number
          fba_disposal_fees?: number
          fba_fees?: number
          fba_inbound_convenience_fee?: number
          fba_inbound_fees?: number
          fba_long_term_storage_fees?: number
          fba_removal_fees?: number
          fba_storage_fees?: number
          fixed_closing_fees?: number
          free_replacement_refund_items?: number
          gift_wrap_credit_refunds?: number
          gift_wrap_credits?: number
          hrr_non_apparel?: number
          liquidations?: number
          liquidations_brokerage_fee?: number
          marketplace_facilitator_tax?: number
          marketplace_facilitator_tax_refunds?: number
          month_key?: string
          other_fees?: number
          other_income?: number
          promotional_rebate_refunds?: number
          promotional_rebates?: number
          re_commerce_grading_charge?: number
          referral_fees?: number
          refund_count?: number
          refunds?: number
          reimbursements_raw?: number
          reversal_reimbursement?: number
          sales?: number
          sales_tax_collected?: number
          sales_tax_refunds?: number
          service_fee_count?: number
          shipment_count?: number
          shipping_chargeback?: number
          shipping_chargeback_refund?: number
          shipping_credit_refunds?: number
          shipping_credits?: number
          source?: string | null
          stale_at?: string | null
          updated_at?: string
          user_id?: string
          variable_closing_fees?: number
          warehouse_damage?: number
          warehouse_lost?: number
        }
        Relationships: []
      }
      pl_sync_progress: {
        Row: {
          cogs: number | null
          created_at: string
          current_chunk: number | null
          error: string | null
          id: string
          message: string | null
          net_profit: number | null
          status: string
          summary: Json | null
          total_chunks: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cogs?: number | null
          created_at?: string
          current_chunk?: number | null
          error?: string | null
          id?: string
          message?: string | null
          net_profit?: number | null
          status?: string
          summary?: Json | null
          total_chunks?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cogs?: number | null
          created_at?: string
          current_chunk?: number | null
          error?: string | null
          id?: string
          message?: string | null
          net_profit?: number | null
          status?: string
          summary?: Json | null
          total_chunks?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      prewarm_pl_runs: {
        Row: {
          created_at: string
          finished_at: string | null
          id: string
          last_heartbeat_at: string | null
          months_refreshed: number
          notes: string | null
          offset_idx: number
          started_at: string
          throttled: boolean
          timed_out: boolean
          user_ids: Json | null
          users_errored: number
          users_processed: number
        }
        Insert: {
          created_at?: string
          finished_at?: string | null
          id?: string
          last_heartbeat_at?: string | null
          months_refreshed?: number
          notes?: string | null
          offset_idx?: number
          started_at?: string
          throttled?: boolean
          timed_out?: boolean
          user_ids?: Json | null
          users_errored?: number
          users_processed?: number
        }
        Update: {
          created_at?: string
          finished_at?: string | null
          id?: string
          last_heartbeat_at?: string | null
          months_refreshed?: number
          notes?: string | null
          offset_idx?: number
          started_at?: string
          throttled?: boolean
          timed_out?: boolean
          user_ids?: Json | null
          users_errored?: number
          users_processed?: number
        }
        Relationships: []
      }
      price_alerts: {
        Row: {
          asin: string
          confirm_token: string
          confirmed_at: string | null
          created_at: string
          direction: string
          fired_at: string | null
          id: string
          last_checked_at: string | null
          last_price_seen: number | null
          marketplace: string
          notify_email: string
          status: string
          target_price: number
          user_id: string
        }
        Insert: {
          asin: string
          confirm_token?: string
          confirmed_at?: string | null
          created_at?: string
          direction?: string
          fired_at?: string | null
          id?: string
          last_checked_at?: string | null
          last_price_seen?: number | null
          marketplace?: string
          notify_email: string
          status?: string
          target_price: number
          user_id: string
        }
        Update: {
          asin?: string
          confirm_token?: string
          confirmed_at?: string | null
          created_at?: string
          direction?: string
          fired_at?: string | null
          id?: string
          last_checked_at?: string | null
          last_price_seen?: number | null
          marketplace?: string
          notify_email?: string
          status?: string
          target_price?: number
          user_id?: string
        }
        Relationships: []
      }
      pricing_suppression_check_queue: {
        Row: {
          asin: string | null
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          locked_at: string | null
          marketplace: string
          priority: number
          processed_at: string | null
          sku: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          asin?: string | null
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          marketplace?: string
          priority?: number
          processed_at?: string | null
          sku: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string | null
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          marketplace?: string
          priority?: number
          processed_at?: string | null
          sku?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      product_analyzer_snapshot_cache: {
        Row: {
          asin: string
          created_at: string
          expires_at: string
          fetched_at: string
          id: string
          marketplace: string
          snapshot: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          expires_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          snapshot: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          expires_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          snapshot?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      product_catalog: {
        Row: {
          asin: string | null
          brand: string | null
          created_at: string | null
          id: string
          image_url: string | null
          price: number | null
          title: string
          updated_at: string | null
        }
        Insert: {
          asin?: string | null
          brand?: string | null
          created_at?: string | null
          id?: string
          image_url?: string | null
          price?: number | null
          title: string
          updated_at?: string | null
        }
        Update: {
          asin?: string | null
          brand?: string | null
          created_at?: string | null
          id?: string
          image_url?: string | null
          price?: number | null
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      product_change_log: {
        Row: {
          category_id: string
          changed_field: string
          detected_at: string
          id: string
          new_value: string | null
          old_value: string | null
          product_id: string
          scan_job_id: string | null
        }
        Insert: {
          category_id: string
          changed_field: string
          detected_at?: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          product_id: string
          scan_job_id?: string | null
        }
        Update: {
          category_id?: string
          changed_field?: string
          detected_at?: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          product_id?: string
          scan_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_change_log_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "scan_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_change_log_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "category_products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_finder_run_items: {
        Row: {
          asin: string
          clicked: boolean
          created_at: string
          dismissed: boolean
          id: string
          marketplace: string
          position: number | null
          run_id: string
          saved: boolean
          score: number | null
          user_id: string
        }
        Insert: {
          asin: string
          clicked?: boolean
          created_at?: string
          dismissed?: boolean
          id?: string
          marketplace?: string
          position?: number | null
          run_id: string
          saved?: boolean
          score?: number | null
          user_id: string
        }
        Update: {
          asin?: string
          clicked?: boolean
          created_at?: string
          dismissed?: boolean
          id?: string
          marketplace?: string
          position?: number | null
          run_id?: string
          saved?: boolean
          score?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_finder_run_items_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "product_finder_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      product_finder_runs: {
        Row: {
          created_at: string
          daily_usage_date: string
          expires_at: string | null
          filters_json: Json | null
          id: string
          marketplace: string
          result_count: number
          run_status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          daily_usage_date?: string
          expires_at?: string | null
          filters_json?: Json | null
          id?: string
          marketplace?: string
          result_count?: number
          run_status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          daily_usage_date?: string
          expires_at?: string | null
          filters_json?: Json | null
          id?: string
          marketplace?: string
          result_count?: number
          run_status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          account_status: string
          account_status_changed_at: string | null
          account_status_changed_by: string | null
          account_status_reason: string | null
          address_line1: string | null
          address_line2: string | null
          approved_at: string | null
          approved_by: string | null
          business_name: string | null
          city: string | null
          contact_name: string | null
          country_code: string | null
          created_at: string
          credits: number | null
          email: string
          first_name: string
          id: string
          inventory_synced_at: string | null
          is_approved: boolean
          last_name: string
          phone: string | null
          plan: string | null
          postal_code: string | null
          primary_marketplace_id: string | null
          shipment_business_mode: string
          state_code: string | null
          ui_mode: string
          updated_at: string
        }
        Insert: {
          account_status?: string
          account_status_changed_at?: string | null
          account_status_changed_by?: string | null
          account_status_reason?: string | null
          address_line1?: string | null
          address_line2?: string | null
          approved_at?: string | null
          approved_by?: string | null
          business_name?: string | null
          city?: string | null
          contact_name?: string | null
          country_code?: string | null
          created_at?: string
          credits?: number | null
          email: string
          first_name: string
          id: string
          inventory_synced_at?: string | null
          is_approved?: boolean
          last_name: string
          phone?: string | null
          plan?: string | null
          postal_code?: string | null
          primary_marketplace_id?: string | null
          shipment_business_mode?: string
          state_code?: string | null
          ui_mode?: string
          updated_at?: string
        }
        Update: {
          account_status?: string
          account_status_changed_at?: string | null
          account_status_changed_by?: string | null
          account_status_reason?: string | null
          address_line1?: string | null
          address_line2?: string | null
          approved_at?: string | null
          approved_by?: string | null
          business_name?: string | null
          city?: string | null
          contact_name?: string | null
          country_code?: string | null
          created_at?: string
          credits?: number | null
          email?: string
          first_name?: string
          id?: string
          inventory_synced_at?: string | null
          is_approved?: boolean
          last_name?: string
          phone?: string | null
          plan?: string | null
          postal_code?: string | null
          primary_marketplace_id?: string | null
          shipment_business_mode?: string
          state_code?: string | null
          ui_mode?: string
          updated_at?: string
        }
        Relationships: []
      }
      rainforest_daily_usage: {
        Row: {
          cache_fallback_count: number
          call_count: number
          last_called_at: string | null
          rainforest_skipped_cache_fresh: number
          rainforest_skipped_not_priority: number
          rainforest_success_count: number
          sp_api_throttled_count: number
          usage_date: string
        }
        Insert: {
          cache_fallback_count?: number
          call_count?: number
          last_called_at?: string | null
          rainforest_skipped_cache_fresh?: number
          rainforest_skipped_not_priority?: number
          rainforest_success_count?: number
          sp_api_throttled_count?: number
          usage_date?: string
        }
        Update: {
          cache_fallback_count?: number
          call_count?: number
          last_called_at?: string | null
          rainforest_skipped_cache_fresh?: number
          rainforest_skipped_not_priority?: number
          rainforest_success_count?: number
          sp_api_throttled_count?: number
          usage_date?: string
        }
        Relationships: []
      }
      RegisterUser: {
        Row: {
          created_at: string
          id: number
          licensekey: string | null
          usedusername: string | null
          username: string | null
        }
        Insert: {
          created_at?: string
          id?: number
          licensekey?: string | null
          usedusername?: string | null
          username?: string | null
        }
        Update: {
          created_at?: string
          id?: number
          licensekey?: string | null
          usedusername?: string | null
          username?: string | null
        }
        Relationships: []
      }
      reorder_planning_settings: {
        Row: {
          amazon_receiving_days: number
          coverage_days: number
          created_at: string
          id: string
          prep_days: number
          safety_percent: number
          shipping_to_amazon_days: number
          supplier_lead_time_days: number
          updated_at: string
          user_id: string
        }
        Insert: {
          amazon_receiving_days?: number
          coverage_days?: number
          created_at?: string
          id?: string
          prep_days?: number
          safety_percent?: number
          shipping_to_amazon_days?: number
          supplier_lead_time_days?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          amazon_receiving_days?: number
          coverage_days?: number
          created_at?: string
          id?: string
          prep_days?: number
          safety_percent?: number
          shipping_to_amazon_days?: number
          supplier_lead_time_days?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      replacement_detection_audit: {
        Row: {
          asin: string | null
          cogs_impact: number | null
          created_at: string
          details: Json | null
          detection_source: string
          id: string
          order_id: string
          prior_is_replacement: boolean | null
          prior_sold_price: number | null
          quantity: number | null
          unit_cost: number | null
          user_id: string
        }
        Insert: {
          asin?: string | null
          cogs_impact?: number | null
          created_at?: string
          details?: Json | null
          detection_source: string
          id?: string
          order_id: string
          prior_is_replacement?: boolean | null
          prior_sold_price?: number | null
          quantity?: number | null
          unit_cost?: number | null
          user_id: string
        }
        Update: {
          asin?: string | null
          cogs_impact?: number | null
          created_at?: string
          details?: Json | null
          detection_source?: string
          id?: string
          order_id?: string
          prior_is_replacement?: boolean | null
          prior_sold_price?: number | null
          quantity?: number | null
          unit_cost?: number | null
          user_id?: string
        }
        Relationships: []
      }
      replenishment_order_items: {
        Row: {
          asin: string
          created_at: string
          id: string
          image_url: string | null
          listing_id: string | null
          packed: boolean
          quantity: number
          replenishment_order_id: string
          sku: string | null
          supplier_link: string | null
          title: string | null
          unit_cost: number | null
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          id?: string
          image_url?: string | null
          listing_id?: string | null
          packed?: boolean
          quantity?: number
          replenishment_order_id: string
          sku?: string | null
          supplier_link?: string | null
          title?: string | null
          unit_cost?: number | null
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          id?: string
          image_url?: string | null
          listing_id?: string | null
          packed?: boolean
          quantity?: number
          replenishment_order_id?: string
          sku?: string | null
          supplier_link?: string | null
          title?: string | null
          unit_cost?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "replenishment_order_items_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "active_created_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replenishment_order_items_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "created_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "replenishment_order_items_replenishment_order_id_fkey"
            columns: ["replenishment_order_id"]
            isOneToOne: false
            referencedRelation: "replenishment_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      replenishment_orders: {
        Row: {
          created_at: string
          id: string
          name: string
          notes: string | null
          status: string
          total_units: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          status?: string
          total_units?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          status?: string
          total_units?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_action_outcomes: {
        Row: {
          action_id: string | null
          action_type: string | null
          after_snapshot: Json | null
          age_improved: boolean | null
          asin: string
          bb_improved: boolean | null
          before_snapshot: Json | null
          confidence_score: number | null
          evaluated_at: string
          id: string
          margin_delta_pct: number | null
          marketplace: string
          notes: string | null
          outcome_label: string
          recommended_at: string
          revenue_delta_usd: number | null
          sales_improved: boolean | null
          user_id: string
        }
        Insert: {
          action_id?: string | null
          action_type?: string | null
          after_snapshot?: Json | null
          age_improved?: boolean | null
          asin: string
          bb_improved?: boolean | null
          before_snapshot?: Json | null
          confidence_score?: number | null
          evaluated_at?: string
          id?: string
          margin_delta_pct?: number | null
          marketplace: string
          notes?: string | null
          outcome_label?: string
          recommended_at: string
          revenue_delta_usd?: number | null
          sales_improved?: boolean | null
          user_id: string
        }
        Update: {
          action_id?: string | null
          action_type?: string | null
          after_snapshot?: Json | null
          age_improved?: boolean | null
          asin?: string
          bb_improved?: boolean | null
          before_snapshot?: Json | null
          confidence_score?: number | null
          evaluated_at?: string
          id?: string
          margin_delta_pct?: number | null
          marketplace?: string
          notes?: string | null
          outcome_label?: string
          recommended_at?: string
          revenue_delta_usd?: number | null
          sales_improved?: boolean | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_adaptations_log: {
        Row: {
          adaptation_type: string
          after_state: Json | null
          asin: string | null
          auto_applied: boolean | null
          before_state: Json | null
          business_reason: string
          confidence: number | null
          created_at: string
          id: string
          marketplace: string | null
          technical_reason: string | null
          user_id: string
        }
        Insert: {
          adaptation_type: string
          after_state?: Json | null
          asin?: string | null
          auto_applied?: boolean | null
          before_state?: Json | null
          business_reason: string
          confidence?: number | null
          created_at?: string
          id?: string
          marketplace?: string | null
          technical_reason?: string | null
          user_id: string
        }
        Update: {
          adaptation_type?: string
          after_state?: Json | null
          asin?: string | null
          auto_applied?: boolean | null
          before_state?: Json | null
          business_reason?: string
          confidence?: number | null
          created_at?: string
          id?: string
          marketplace?: string | null
          technical_reason?: string | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_ai_decisions: {
        Row: {
          ai_aggressiveness: number | null
          ai_model: string | null
          ai_note: string | null
          applied_at: string | null
          apply_status: string | null
          asin: string
          assignment_id: string | null
          buybox_price: number | null
          buybox_seller_type: string | null
          competitive_price: number | null
          cooldown_applied: boolean | null
          created_at: string
          current_price: number | null
          id: string
          is_backordered: boolean | null
          is_buybox_eligible: boolean | null
          is_buybox_suppressed: boolean | null
          is_only_seller: boolean | null
          lowest_fba_price: number | null
          lowest_fbm_price: number | null
          lowest_overall_price: number | null
          marketplace: string
          max_price_used: number | null
          max_step_applied: boolean | null
          min_gap_amount: number | null
          min_gap_percent: number | null
          min_price_clamped: boolean | null
          min_price_used: number | null
          mode: string
          new_price: number | null
          offers_count: number | null
          price_delta: number | null
          raise_blocked_cooldown: boolean
          raise_rejected_floor_support: boolean
          reason: string
          rule_id: string | null
          sku: string | null
          suggested_min_price: number | null
          user_id: string
        }
        Insert: {
          ai_aggressiveness?: number | null
          ai_model?: string | null
          ai_note?: string | null
          applied_at?: string | null
          apply_status?: string | null
          asin: string
          assignment_id?: string | null
          buybox_price?: number | null
          buybox_seller_type?: string | null
          competitive_price?: number | null
          cooldown_applied?: boolean | null
          created_at?: string
          current_price?: number | null
          id?: string
          is_backordered?: boolean | null
          is_buybox_eligible?: boolean | null
          is_buybox_suppressed?: boolean | null
          is_only_seller?: boolean | null
          lowest_fba_price?: number | null
          lowest_fbm_price?: number | null
          lowest_overall_price?: number | null
          marketplace?: string
          max_price_used?: number | null
          max_step_applied?: boolean | null
          min_gap_amount?: number | null
          min_gap_percent?: number | null
          min_price_clamped?: boolean | null
          min_price_used?: number | null
          mode: string
          new_price?: number | null
          offers_count?: number | null
          price_delta?: number | null
          raise_blocked_cooldown?: boolean
          raise_rejected_floor_support?: boolean
          reason: string
          rule_id?: string | null
          sku?: string | null
          suggested_min_price?: number | null
          user_id: string
        }
        Update: {
          ai_aggressiveness?: number | null
          ai_model?: string | null
          ai_note?: string | null
          applied_at?: string | null
          apply_status?: string | null
          asin?: string
          assignment_id?: string | null
          buybox_price?: number | null
          buybox_seller_type?: string | null
          competitive_price?: number | null
          cooldown_applied?: boolean | null
          created_at?: string
          current_price?: number | null
          id?: string
          is_backordered?: boolean | null
          is_buybox_eligible?: boolean | null
          is_buybox_suppressed?: boolean | null
          is_only_seller?: boolean | null
          lowest_fba_price?: number | null
          lowest_fbm_price?: number | null
          lowest_overall_price?: number | null
          marketplace?: string
          max_price_used?: number | null
          max_step_applied?: boolean | null
          min_gap_amount?: number | null
          min_gap_percent?: number | null
          min_price_clamped?: boolean | null
          min_price_used?: number | null
          mode?: string
          new_price?: number | null
          offers_count?: number | null
          price_delta?: number | null
          raise_blocked_cooldown?: boolean
          raise_rejected_floor_support?: boolean
          reason?: string
          rule_id?: string | null
          sku?: string | null
          suggested_min_price?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repricer_ai_decisions_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "repricer_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repricer_ai_decisions_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "repricer_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      repricer_asin_locks: {
        Row: {
          asin: string
          expires_at: string
          id: string
          lock_owner: string
          locked_at: string
          marketplace: string
          sku: string | null
          user_id: string
        }
        Insert: {
          asin: string
          expires_at?: string
          id?: string
          lock_owner: string
          locked_at?: string
          marketplace?: string
          sku?: string | null
          user_id: string
        }
        Update: {
          asin?: string
          expires_at?: string
          id?: string
          lock_owner?: string
          locked_at?: string
          marketplace?: string
          sku?: string | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_asin_strategy_memory: {
        Row: {
          asin: string
          avg_recovery_time_hours: number | null
          bb_retention_after_increase: number | null
          elasticity_class: string | null
          id: string
          last_built_at: string
          marketplace: string
          oscillation_tendency: number | null
          personality_profile: string | null
          profit_stability_score: number | null
          recent_outcome_score: number | null
          sample_size: number | null
          user_id: string
          win_rate_after_reduction: number | null
        }
        Insert: {
          asin: string
          avg_recovery_time_hours?: number | null
          bb_retention_after_increase?: number | null
          elasticity_class?: string | null
          id?: string
          last_built_at?: string
          marketplace: string
          oscillation_tendency?: number | null
          personality_profile?: string | null
          profit_stability_score?: number | null
          recent_outcome_score?: number | null
          sample_size?: number | null
          user_id: string
          win_rate_after_reduction?: number | null
        }
        Update: {
          asin?: string
          avg_recovery_time_hours?: number | null
          bb_retention_after_increase?: number | null
          elasticity_class?: string | null
          id?: string
          last_built_at?: string
          marketplace?: string
          oscillation_tendency?: number | null
          personality_profile?: string | null
          profit_stability_score?: number | null
          recent_outcome_score?: number | null
          sample_size?: number | null
          user_id?: string
          win_rate_after_reduction?: number | null
        }
        Relationships: []
      }
      repricer_assignments: {
        Row: {
          active_eval_mode: string
          amazon_bounds_synced_at: string | null
          amazon_listing_state: string | null
          amazon_max_price: number | null
          amazon_min_price: number | null
          anomaly_flags: Json | null
          anomaly_last_checked_at: string | null
          anomaly_score: number
          apply_error: string | null
          asin: string
          auto_activated_at: string | null
          auto_activated_by: string | null
          auto_activated_reason: string | null
          auto_apply_enabled: boolean
          auto_floor_consecutive_losses: number
          auto_floor_drop_count: number
          auto_floor_drop_day: string | null
          auto_floor_drops_on_day: number
          auto_lower_min_price: boolean | null
          auto_raise_max_price: boolean | null
          auto_resumed_at: string | null
          auto_set_minmax_if_missing: boolean | null
          auto_suspended_at: string | null
          auto_suspended_by: string | null
          auto_suspended_reason: string | null
          basic_rule_id: string | null
          bb_loss_after_raise_count: number
          bb_recovery_escalation: number | null
          bb_rotation_rate: number | null
          bounds_last_requested_at: string | null
          bounds_sync_attempts: number
          bounds_sync_status: string
          bounds_synced_at: string | null
          buybox_lost_at: string | null
          checks_today_count: number | null
          checks_today_date: string | null
          clamp_count_reset_at: string | null
          clamp_count_today: number
          competitor_churn_rate: number | null
          consecutive_failed_undercuts: number | null
          consecutive_failures: number
          consecutive_profit_guard_hits: number | null
          consecutive_zero_offers: number
          created_at: string
          delta_too_small_streak: number
          detected_offer_asin: string | null
          detected_offer_block_reason: string | null
          detected_offer_checked_at: string | null
          detected_offer_condition: string | null
          detected_offer_condition_match: boolean | null
          detected_offer_fulfillment: string | null
          detected_offer_fulfillment_match: boolean | null
          detected_offer_is_ambiguous: boolean
          detected_offer_mapping_source: string | null
          detected_offer_price: number | null
          detected_offer_seller_id: string | null
          detected_offer_sku: string | null
          detected_offer_sku_match: boolean | null
          direction_changed_at: string | null
          dispatch_reason: string | null
          dispatch_score: number | null
          eval_mode: string
          eval_mode_reason: string | null
          eval_mode_switched_at: string | null
          floor_blocked_cycles: number | null
          fulfillment_type: string
          id: string
          intl_available: number | null
          intl_inbound: number | null
          intl_listing_status: string | null
          intl_qty_confidence: string | null
          intl_qty_fetched_at: string | null
          intl_reserved: number | null
          inventory_confidence: string | null
          is_enabled: boolean
          is_listing_inactive_not_buyable: boolean
          is_manual_priority: boolean
          is_pricing_suppression: boolean
          is_priority: boolean
          is_restricted: boolean
          item_condition: string | null
          last_ack_reason: string | null
          last_ack_result: string | null
          last_applied_at: string | null
          last_applied_price: number | null
          last_bb_loss_after_raise_at: string | null
          last_bounds_sync_error: string | null
          last_buybox_price: number | null
          last_buybox_status: string | null
          last_data_source: string | null
          last_disabled_at: string | null
          last_disabled_by: string | null
          last_disabled_reason: string | null
          last_dispatch_at: string | null
          last_enabled_at: string | null
          last_enabled_by: string | null
          last_error_message: string | null
          last_error_type: string | null
          last_evaluated_at: string | null
          last_evaluation_attempt_at: string | null
          last_failure_at: string | null
          last_floor_price_cents: number | null
          last_listing_check_at: string | null
          last_max_price_on_amazon: number | null
          last_min_price_on_amazon: number | null
          last_position_gap_cents: number | null
          last_price_change_at: string | null
          last_price_direction: string | null
          last_priority_check_at: string | null
          last_raise_at: string | null
          last_recommendation_reason: string | null
          last_recommended_price: number | null
          last_repriced_at: string | null
          last_skip_details: string | null
          last_skip_lane: string | null
          last_skip_reason: string | null
          last_sp_api_check_at: string | null
          last_stable_price: number | null
          last_throttle_at: string | null
          last_trigger_source: string | null
          listing_inactive_cleared_at: string | null
          listing_inactive_detected_at: string | null
          listing_inactive_last_checked_at: string | null
          listing_inactive_statuses: string[] | null
          listing_issue_unknown_categories: string[] | null
          listing_issue_unknown_flagged: boolean
          manual_min_price: number | null
          manual_override_checks: number | null
          manual_override_started_at: string | null
          manual_paused: boolean
          market_state: string | null
          market_volatility_checked_at: string | null
          market_volatility_score: number | null
          market_volatility_signals: Json | null
          marketplace: string
          marketplace_checked_at: string | null
          marketplace_sellability_reason: string | null
          marketplace_sellable: boolean | null
          max_price_override: number | null
          min_fetch_interval_minutes: number | null
          min_price_override: number | null
          min_roi_override: number | null
          next_bounds_sync_at: string | null
          next_rainforest_check_at: string | null
          no_bb_progress_streak: number
          no_change_streak: number
          oscillation_cooldown_until: string | null
          oscillation_count: number
          oscillation_detected_at: string | null
          oscillation_last_mode_used: string | null
          oscillation_last_reason: string | null
          oscillation_reaction_count: number
          oscillation_state: string | null
          pause_reason: string | null
          paused_at: string | null
          paused_reason: string | null
          paused_until: string | null
          price_changes_reset_at: string | null
          price_changes_today: number | null
          pricing_suppression_categories: string[] | null
          pricing_suppression_cleared_at: string | null
          pricing_suppression_detected_at: string | null
          pricing_suppression_enforcement_actions: string[] | null
          pricing_suppression_last_checked_at: string | null
          pricing_suppression_pending_clear_at: string | null
          pricing_suppression_raw_code: string | null
          pricing_suppression_raw_message: string | null
          pricing_suppression_severity: string | null
          recent_prices: Json | null
          restock_reentry_at: string | null
          roi_at_max_percent: number | null
          roi_at_min_percent: number | null
          roi_range_updated_at: string | null
          rule_id: string | null
          sellability_review_hold: boolean
          sku: string
          sku_validation_checked_at: string | null
          sku_validation_message: string | null
          sku_validation_status: string | null
          snapshot_fetch_reason: string | null
          stale_promoted_at: string | null
          stale_promoted_from: string | null
          stale_promotion_evaluated: boolean | null
          status: string
          ui_edit_locked: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          active_eval_mode?: string
          amazon_bounds_synced_at?: string | null
          amazon_listing_state?: string | null
          amazon_max_price?: number | null
          amazon_min_price?: number | null
          anomaly_flags?: Json | null
          anomaly_last_checked_at?: string | null
          anomaly_score?: number
          apply_error?: string | null
          asin: string
          auto_activated_at?: string | null
          auto_activated_by?: string | null
          auto_activated_reason?: string | null
          auto_apply_enabled?: boolean
          auto_floor_consecutive_losses?: number
          auto_floor_drop_count?: number
          auto_floor_drop_day?: string | null
          auto_floor_drops_on_day?: number
          auto_lower_min_price?: boolean | null
          auto_raise_max_price?: boolean | null
          auto_resumed_at?: string | null
          auto_set_minmax_if_missing?: boolean | null
          auto_suspended_at?: string | null
          auto_suspended_by?: string | null
          auto_suspended_reason?: string | null
          basic_rule_id?: string | null
          bb_loss_after_raise_count?: number
          bb_recovery_escalation?: number | null
          bb_rotation_rate?: number | null
          bounds_last_requested_at?: string | null
          bounds_sync_attempts?: number
          bounds_sync_status?: string
          bounds_synced_at?: string | null
          buybox_lost_at?: string | null
          checks_today_count?: number | null
          checks_today_date?: string | null
          clamp_count_reset_at?: string | null
          clamp_count_today?: number
          competitor_churn_rate?: number | null
          consecutive_failed_undercuts?: number | null
          consecutive_failures?: number
          consecutive_profit_guard_hits?: number | null
          consecutive_zero_offers?: number
          created_at?: string
          delta_too_small_streak?: number
          detected_offer_asin?: string | null
          detected_offer_block_reason?: string | null
          detected_offer_checked_at?: string | null
          detected_offer_condition?: string | null
          detected_offer_condition_match?: boolean | null
          detected_offer_fulfillment?: string | null
          detected_offer_fulfillment_match?: boolean | null
          detected_offer_is_ambiguous?: boolean
          detected_offer_mapping_source?: string | null
          detected_offer_price?: number | null
          detected_offer_seller_id?: string | null
          detected_offer_sku?: string | null
          detected_offer_sku_match?: boolean | null
          direction_changed_at?: string | null
          dispatch_reason?: string | null
          dispatch_score?: number | null
          eval_mode?: string
          eval_mode_reason?: string | null
          eval_mode_switched_at?: string | null
          floor_blocked_cycles?: number | null
          fulfillment_type?: string
          id?: string
          intl_available?: number | null
          intl_inbound?: number | null
          intl_listing_status?: string | null
          intl_qty_confidence?: string | null
          intl_qty_fetched_at?: string | null
          intl_reserved?: number | null
          inventory_confidence?: string | null
          is_enabled?: boolean
          is_listing_inactive_not_buyable?: boolean
          is_manual_priority?: boolean
          is_pricing_suppression?: boolean
          is_priority?: boolean
          is_restricted?: boolean
          item_condition?: string | null
          last_ack_reason?: string | null
          last_ack_result?: string | null
          last_applied_at?: string | null
          last_applied_price?: number | null
          last_bb_loss_after_raise_at?: string | null
          last_bounds_sync_error?: string | null
          last_buybox_price?: number | null
          last_buybox_status?: string | null
          last_data_source?: string | null
          last_disabled_at?: string | null
          last_disabled_by?: string | null
          last_disabled_reason?: string | null
          last_dispatch_at?: string | null
          last_enabled_at?: string | null
          last_enabled_by?: string | null
          last_error_message?: string | null
          last_error_type?: string | null
          last_evaluated_at?: string | null
          last_evaluation_attempt_at?: string | null
          last_failure_at?: string | null
          last_floor_price_cents?: number | null
          last_listing_check_at?: string | null
          last_max_price_on_amazon?: number | null
          last_min_price_on_amazon?: number | null
          last_position_gap_cents?: number | null
          last_price_change_at?: string | null
          last_price_direction?: string | null
          last_priority_check_at?: string | null
          last_raise_at?: string | null
          last_recommendation_reason?: string | null
          last_recommended_price?: number | null
          last_repriced_at?: string | null
          last_skip_details?: string | null
          last_skip_lane?: string | null
          last_skip_reason?: string | null
          last_sp_api_check_at?: string | null
          last_stable_price?: number | null
          last_throttle_at?: string | null
          last_trigger_source?: string | null
          listing_inactive_cleared_at?: string | null
          listing_inactive_detected_at?: string | null
          listing_inactive_last_checked_at?: string | null
          listing_inactive_statuses?: string[] | null
          listing_issue_unknown_categories?: string[] | null
          listing_issue_unknown_flagged?: boolean
          manual_min_price?: number | null
          manual_override_checks?: number | null
          manual_override_started_at?: string | null
          manual_paused?: boolean
          market_state?: string | null
          market_volatility_checked_at?: string | null
          market_volatility_score?: number | null
          market_volatility_signals?: Json | null
          marketplace?: string
          marketplace_checked_at?: string | null
          marketplace_sellability_reason?: string | null
          marketplace_sellable?: boolean | null
          max_price_override?: number | null
          min_fetch_interval_minutes?: number | null
          min_price_override?: number | null
          min_roi_override?: number | null
          next_bounds_sync_at?: string | null
          next_rainforest_check_at?: string | null
          no_bb_progress_streak?: number
          no_change_streak?: number
          oscillation_cooldown_until?: string | null
          oscillation_count?: number
          oscillation_detected_at?: string | null
          oscillation_last_mode_used?: string | null
          oscillation_last_reason?: string | null
          oscillation_reaction_count?: number
          oscillation_state?: string | null
          pause_reason?: string | null
          paused_at?: string | null
          paused_reason?: string | null
          paused_until?: string | null
          price_changes_reset_at?: string | null
          price_changes_today?: number | null
          pricing_suppression_categories?: string[] | null
          pricing_suppression_cleared_at?: string | null
          pricing_suppression_detected_at?: string | null
          pricing_suppression_enforcement_actions?: string[] | null
          pricing_suppression_last_checked_at?: string | null
          pricing_suppression_pending_clear_at?: string | null
          pricing_suppression_raw_code?: string | null
          pricing_suppression_raw_message?: string | null
          pricing_suppression_severity?: string | null
          recent_prices?: Json | null
          restock_reentry_at?: string | null
          roi_at_max_percent?: number | null
          roi_at_min_percent?: number | null
          roi_range_updated_at?: string | null
          rule_id?: string | null
          sellability_review_hold?: boolean
          sku: string
          sku_validation_checked_at?: string | null
          sku_validation_message?: string | null
          sku_validation_status?: string | null
          snapshot_fetch_reason?: string | null
          stale_promoted_at?: string | null
          stale_promoted_from?: string | null
          stale_promotion_evaluated?: boolean | null
          status?: string
          ui_edit_locked?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          active_eval_mode?: string
          amazon_bounds_synced_at?: string | null
          amazon_listing_state?: string | null
          amazon_max_price?: number | null
          amazon_min_price?: number | null
          anomaly_flags?: Json | null
          anomaly_last_checked_at?: string | null
          anomaly_score?: number
          apply_error?: string | null
          asin?: string
          auto_activated_at?: string | null
          auto_activated_by?: string | null
          auto_activated_reason?: string | null
          auto_apply_enabled?: boolean
          auto_floor_consecutive_losses?: number
          auto_floor_drop_count?: number
          auto_floor_drop_day?: string | null
          auto_floor_drops_on_day?: number
          auto_lower_min_price?: boolean | null
          auto_raise_max_price?: boolean | null
          auto_resumed_at?: string | null
          auto_set_minmax_if_missing?: boolean | null
          auto_suspended_at?: string | null
          auto_suspended_by?: string | null
          auto_suspended_reason?: string | null
          basic_rule_id?: string | null
          bb_loss_after_raise_count?: number
          bb_recovery_escalation?: number | null
          bb_rotation_rate?: number | null
          bounds_last_requested_at?: string | null
          bounds_sync_attempts?: number
          bounds_sync_status?: string
          bounds_synced_at?: string | null
          buybox_lost_at?: string | null
          checks_today_count?: number | null
          checks_today_date?: string | null
          clamp_count_reset_at?: string | null
          clamp_count_today?: number
          competitor_churn_rate?: number | null
          consecutive_failed_undercuts?: number | null
          consecutive_failures?: number
          consecutive_profit_guard_hits?: number | null
          consecutive_zero_offers?: number
          created_at?: string
          delta_too_small_streak?: number
          detected_offer_asin?: string | null
          detected_offer_block_reason?: string | null
          detected_offer_checked_at?: string | null
          detected_offer_condition?: string | null
          detected_offer_condition_match?: boolean | null
          detected_offer_fulfillment?: string | null
          detected_offer_fulfillment_match?: boolean | null
          detected_offer_is_ambiguous?: boolean
          detected_offer_mapping_source?: string | null
          detected_offer_price?: number | null
          detected_offer_seller_id?: string | null
          detected_offer_sku?: string | null
          detected_offer_sku_match?: boolean | null
          direction_changed_at?: string | null
          dispatch_reason?: string | null
          dispatch_score?: number | null
          eval_mode?: string
          eval_mode_reason?: string | null
          eval_mode_switched_at?: string | null
          floor_blocked_cycles?: number | null
          fulfillment_type?: string
          id?: string
          intl_available?: number | null
          intl_inbound?: number | null
          intl_listing_status?: string | null
          intl_qty_confidence?: string | null
          intl_qty_fetched_at?: string | null
          intl_reserved?: number | null
          inventory_confidence?: string | null
          is_enabled?: boolean
          is_listing_inactive_not_buyable?: boolean
          is_manual_priority?: boolean
          is_pricing_suppression?: boolean
          is_priority?: boolean
          is_restricted?: boolean
          item_condition?: string | null
          last_ack_reason?: string | null
          last_ack_result?: string | null
          last_applied_at?: string | null
          last_applied_price?: number | null
          last_bb_loss_after_raise_at?: string | null
          last_bounds_sync_error?: string | null
          last_buybox_price?: number | null
          last_buybox_status?: string | null
          last_data_source?: string | null
          last_disabled_at?: string | null
          last_disabled_by?: string | null
          last_disabled_reason?: string | null
          last_dispatch_at?: string | null
          last_enabled_at?: string | null
          last_enabled_by?: string | null
          last_error_message?: string | null
          last_error_type?: string | null
          last_evaluated_at?: string | null
          last_evaluation_attempt_at?: string | null
          last_failure_at?: string | null
          last_floor_price_cents?: number | null
          last_listing_check_at?: string | null
          last_max_price_on_amazon?: number | null
          last_min_price_on_amazon?: number | null
          last_position_gap_cents?: number | null
          last_price_change_at?: string | null
          last_price_direction?: string | null
          last_priority_check_at?: string | null
          last_raise_at?: string | null
          last_recommendation_reason?: string | null
          last_recommended_price?: number | null
          last_repriced_at?: string | null
          last_skip_details?: string | null
          last_skip_lane?: string | null
          last_skip_reason?: string | null
          last_sp_api_check_at?: string | null
          last_stable_price?: number | null
          last_throttle_at?: string | null
          last_trigger_source?: string | null
          listing_inactive_cleared_at?: string | null
          listing_inactive_detected_at?: string | null
          listing_inactive_last_checked_at?: string | null
          listing_inactive_statuses?: string[] | null
          listing_issue_unknown_categories?: string[] | null
          listing_issue_unknown_flagged?: boolean
          manual_min_price?: number | null
          manual_override_checks?: number | null
          manual_override_started_at?: string | null
          manual_paused?: boolean
          market_state?: string | null
          market_volatility_checked_at?: string | null
          market_volatility_score?: number | null
          market_volatility_signals?: Json | null
          marketplace?: string
          marketplace_checked_at?: string | null
          marketplace_sellability_reason?: string | null
          marketplace_sellable?: boolean | null
          max_price_override?: number | null
          min_fetch_interval_minutes?: number | null
          min_price_override?: number | null
          min_roi_override?: number | null
          next_bounds_sync_at?: string | null
          next_rainforest_check_at?: string | null
          no_bb_progress_streak?: number
          no_change_streak?: number
          oscillation_cooldown_until?: string | null
          oscillation_count?: number
          oscillation_detected_at?: string | null
          oscillation_last_mode_used?: string | null
          oscillation_last_reason?: string | null
          oscillation_reaction_count?: number
          oscillation_state?: string | null
          pause_reason?: string | null
          paused_at?: string | null
          paused_reason?: string | null
          paused_until?: string | null
          price_changes_reset_at?: string | null
          price_changes_today?: number | null
          pricing_suppression_categories?: string[] | null
          pricing_suppression_cleared_at?: string | null
          pricing_suppression_detected_at?: string | null
          pricing_suppression_enforcement_actions?: string[] | null
          pricing_suppression_last_checked_at?: string | null
          pricing_suppression_pending_clear_at?: string | null
          pricing_suppression_raw_code?: string | null
          pricing_suppression_raw_message?: string | null
          pricing_suppression_severity?: string | null
          recent_prices?: Json | null
          restock_reentry_at?: string | null
          roi_at_max_percent?: number | null
          roi_at_min_percent?: number | null
          roi_range_updated_at?: string | null
          rule_id?: string | null
          sellability_review_hold?: boolean
          sku?: string
          sku_validation_checked_at?: string | null
          sku_validation_message?: string | null
          sku_validation_status?: string | null
          snapshot_fetch_reason?: string | null
          stale_promoted_at?: string | null
          stale_promoted_from?: string | null
          stale_promotion_evaluated?: boolean | null
          status?: string
          ui_edit_locked?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repricer_assignments_basic_rule_id_fkey"
            columns: ["basic_rule_id"]
            isOneToOne: false
            referencedRelation: "repricer_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "repricer_assignments_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "repricer_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      repricer_buybox_quality: {
        Row: {
          asin: string
          classification: string | null
          competitor_quality: number | null
          computed_at: string
          hold_duration_hours: number | null
          id: string
          margin_quality: number | null
          marketplace: string
          price_stability: number | null
          quality_score: number
          recovery_sustainability: number | null
          signals: Json | null
          user_id: string
          velocity_after_win: number | null
        }
        Insert: {
          asin: string
          classification?: string | null
          competitor_quality?: number | null
          computed_at?: string
          hold_duration_hours?: number | null
          id?: string
          margin_quality?: number | null
          marketplace: string
          price_stability?: number | null
          quality_score?: number
          recovery_sustainability?: number | null
          signals?: Json | null
          user_id: string
          velocity_after_win?: number | null
        }
        Update: {
          asin?: string
          classification?: string | null
          competitor_quality?: number | null
          computed_at?: string
          hold_duration_hours?: number | null
          id?: string
          margin_quality?: number | null
          marketplace?: string
          price_stability?: number | null
          quality_score?: number
          recovery_sustainability?: number | null
          signals?: Json | null
          user_id?: string
          velocity_after_win?: number | null
        }
        Relationships: []
      }
      repricer_competitor_profiles: {
        Row: {
          asin: string
          avg_reaction_minutes: number | null
          classification: string
          competitor_seller_id: string
          computed_at: string
          id: string
          last_seen: string | null
          marketplace: string
          observation_count: number | null
          signals: Json | null
          undercut_pattern_cents: number | null
          user_id: string
          volatility: number | null
        }
        Insert: {
          asin: string
          avg_reaction_minutes?: number | null
          classification?: string
          competitor_seller_id: string
          computed_at?: string
          id?: string
          last_seen?: string | null
          marketplace: string
          observation_count?: number | null
          signals?: Json | null
          undercut_pattern_cents?: number | null
          user_id: string
          volatility?: number | null
        }
        Update: {
          asin?: string
          avg_reaction_minutes?: number | null
          classification?: string
          competitor_seller_id?: string
          computed_at?: string
          id?: string
          last_seen?: string | null
          marketplace?: string
          observation_count?: number | null
          signals?: Json | null
          undercut_pattern_cents?: number | null
          user_id?: string
          volatility?: number | null
        }
        Relationships: []
      }
      repricer_competitor_snapshots: {
        Row: {
          asin: string
          buybox_is_fba: boolean | null
          buybox_price: number | null
          buybox_seller_id: string | null
          buybox_seller_name: string | null
          created_at: string
          credits_used: number | null
          error: string | null
          fetch_reason: string | null
          fetched_at: string
          id: string
          lowest_fba_price: number | null
          lowest_fbm_price: number | null
          lowest_overall_price: number | null
          marketplace: string
          offers_count: number | null
          offers_json: Json | null
          sku: string | null
          source: string
          user_id: string
        }
        Insert: {
          asin: string
          buybox_is_fba?: boolean | null
          buybox_price?: number | null
          buybox_seller_id?: string | null
          buybox_seller_name?: string | null
          created_at?: string
          credits_used?: number | null
          error?: string | null
          fetch_reason?: string | null
          fetched_at?: string
          id?: string
          lowest_fba_price?: number | null
          lowest_fbm_price?: number | null
          lowest_overall_price?: number | null
          marketplace?: string
          offers_count?: number | null
          offers_json?: Json | null
          sku?: string | null
          source?: string
          user_id: string
        }
        Update: {
          asin?: string
          buybox_is_fba?: boolean | null
          buybox_price?: number | null
          buybox_seller_id?: string | null
          buybox_seller_name?: string | null
          created_at?: string
          credits_used?: number | null
          error?: string | null
          fetch_reason?: string | null
          fetched_at?: string
          id?: string
          lowest_fba_price?: number | null
          lowest_fbm_price?: number | null
          lowest_overall_price?: number | null
          marketplace?: string
          offers_count?: number | null
          offers_json?: Json | null
          sku?: string | null
          source?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_dispatch_metrics: {
        Row: {
          active_in_stock_pct: number | null
          budget_utilization_pct: number | null
          cycle_ended_at: string | null
          cycle_started_at: string
          dispatch_ms: number | null
          duplicate_evals_within_5min: number | null
          duplicate_selections: number | null
          id: string
          inactive_filtered: number | null
          scoring_ms: number | null
          sp_api_budget_cap: number | null
          sp_api_calls_used: number | null
          top_reasons: Json | null
          total_applied: number | null
          total_dispatched: number | null
          total_eligible: number | null
          total_errors: number | null
          total_evaluated: number | null
          total_ms: number | null
          total_skipped: number | null
          user_id: string
          worker_id: string | null
        }
        Insert: {
          active_in_stock_pct?: number | null
          budget_utilization_pct?: number | null
          cycle_ended_at?: string | null
          cycle_started_at?: string
          dispatch_ms?: number | null
          duplicate_evals_within_5min?: number | null
          duplicate_selections?: number | null
          id?: string
          inactive_filtered?: number | null
          scoring_ms?: number | null
          sp_api_budget_cap?: number | null
          sp_api_calls_used?: number | null
          top_reasons?: Json | null
          total_applied?: number | null
          total_dispatched?: number | null
          total_eligible?: number | null
          total_errors?: number | null
          total_evaluated?: number | null
          total_ms?: number | null
          total_skipped?: number | null
          user_id: string
          worker_id?: string | null
        }
        Update: {
          active_in_stock_pct?: number | null
          budget_utilization_pct?: number | null
          cycle_ended_at?: string | null
          cycle_started_at?: string
          dispatch_ms?: number | null
          duplicate_evals_within_5min?: number | null
          duplicate_selections?: number | null
          id?: string
          inactive_filtered?: number | null
          scoring_ms?: number | null
          sp_api_budget_cap?: number | null
          sp_api_calls_used?: number | null
          top_reasons?: Json | null
          total_applied?: number | null
          total_dispatched?: number | null
          total_eligible?: number | null
          total_errors?: number | null
          total_evaluated?: number | null
          total_ms?: number | null
          total_skipped?: number | null
          user_id?: string
          worker_id?: string | null
        }
        Relationships: []
      }
      repricer_eligibility_audit: {
        Row: {
          asin: string
          assignment_id: string
          derived_eligible: boolean
          derived_reason: string | null
          factors: Json
          id: string
          is_enabled_actual: boolean
          marketplace_id: string | null
          matched: boolean
          observed_at: string
          user_id: string
        }
        Insert: {
          asin: string
          assignment_id: string
          derived_eligible: boolean
          derived_reason?: string | null
          factors?: Json
          id?: string
          is_enabled_actual: boolean
          marketplace_id?: string | null
          matched: boolean
          observed_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          assignment_id?: string
          derived_eligible?: boolean
          derived_reason?: string | null
          factors?: Json
          id?: string
          is_enabled_actual?: boolean
          marketplace_id?: string | null
          matched?: boolean
          observed_at?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_eval_acks: {
        Row: {
          acked_at: string
          applied_price: number | null
          asin: string
          before_price: number | null
          buybox_price: number | null
          constraint_applied: string | null
          evaluation_ms: number | null
          floor_relaxed: boolean | null
          floor_relaxed_reason: string | null
          floor_used: number | null
          id: string
          is_buybox_owner: boolean | null
          lowest_fba_price: number | null
          lowest_fbm_price: number | null
          marketplace: string
          my_price: number | null
          reason: string | null
          reason_business: string | null
          recommended_price: number | null
          result: string
          sku: string
          strategy_state:
            | Database["public"]["Enums"]["repricer_strategy_state"]
            | null
          target_price: number | null
          trigger_source: string | null
          user_id: string
        }
        Insert: {
          acked_at?: string
          applied_price?: number | null
          asin: string
          before_price?: number | null
          buybox_price?: number | null
          constraint_applied?: string | null
          evaluation_ms?: number | null
          floor_relaxed?: boolean | null
          floor_relaxed_reason?: string | null
          floor_used?: number | null
          id?: string
          is_buybox_owner?: boolean | null
          lowest_fba_price?: number | null
          lowest_fbm_price?: number | null
          marketplace?: string
          my_price?: number | null
          reason?: string | null
          reason_business?: string | null
          recommended_price?: number | null
          result?: string
          sku: string
          strategy_state?:
            | Database["public"]["Enums"]["repricer_strategy_state"]
            | null
          target_price?: number | null
          trigger_source?: string | null
          user_id: string
        }
        Update: {
          acked_at?: string
          applied_price?: number | null
          asin?: string
          before_price?: number | null
          buybox_price?: number | null
          constraint_applied?: string | null
          evaluation_ms?: number | null
          floor_relaxed?: boolean | null
          floor_relaxed_reason?: string | null
          floor_used?: number | null
          id?: string
          is_buybox_owner?: boolean | null
          lowest_fba_price?: number | null
          lowest_fbm_price?: number | null
          marketplace?: string
          my_price?: number | null
          reason?: string | null
          reason_business?: string | null
          recommended_price?: number | null
          result?: string
          sku?: string
          strategy_state?:
            | Database["public"]["Enums"]["repricer_strategy_state"]
            | null
          target_price?: number | null
          trigger_source?: string | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_executive_snapshots: {
        Row: {
          aged_inventory_value: number | null
          asins_needing_action: number | null
          assumptions: Json | null
          buybox_control_pct: number | null
          confidence: string | null
          created_at: string
          id: string
          recovered_products: number | null
          revenue_missed: number | null
          revenue_protected: number | null
          snapshot_date: string
          strategy_distribution: Json | null
          top_blockers: Json | null
          total_active_asins: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          aged_inventory_value?: number | null
          asins_needing_action?: number | null
          assumptions?: Json | null
          buybox_control_pct?: number | null
          confidence?: string | null
          created_at?: string
          id?: string
          recovered_products?: number | null
          revenue_missed?: number | null
          revenue_protected?: number | null
          snapshot_date?: string
          strategy_distribution?: Json | null
          top_blockers?: Json | null
          total_active_asins?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          aged_inventory_value?: number | null
          asins_needing_action?: number | null
          assumptions?: Json | null
          buybox_control_pct?: number | null
          confidence?: string | null
          created_at?: string
          id?: string
          recovered_products?: number | null
          revenue_missed?: number | null
          revenue_protected?: number | null
          snapshot_date?: string
          strategy_distribution?: Json | null
          top_blockers?: Json | null
          total_active_asins?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_feed_submissions: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          feed_document_id: string | null
          feed_id: string | null
          feed_payload: Json | null
          feed_result: Json | null
          id: string
          marketplace: string
          sku_count: number
          skus_failed: number | null
          skus_succeeded: number | null
          status: string
          submitted_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          feed_document_id?: string | null
          feed_id?: string | null
          feed_payload?: Json | null
          feed_result?: Json | null
          id?: string
          marketplace?: string
          sku_count?: number
          skus_failed?: number | null
          skus_succeeded?: number | null
          status?: string
          submitted_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          feed_document_id?: string | null
          feed_id?: string | null
          feed_payload?: Json | null
          feed_result?: Json | null
          id?: string
          marketplace?: string
          sku_count?: number
          skus_failed?: number | null
          skus_succeeded?: number | null
          status?: string
          submitted_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_idempotency: {
        Row: {
          asin: string
          expires_at: string
          id: string
          idempotency_key: string
          marketplace: string
          submitted_at: string
          target_price: number | null
          user_id: string
        }
        Insert: {
          asin: string
          expires_at?: string
          id?: string
          idempotency_key: string
          marketplace?: string
          submitted_at?: string
          target_price?: number | null
          user_id: string
        }
        Update: {
          asin?: string
          expires_at?: string
          id?: string
          idempotency_key?: string
          marketplace?: string
          submitted_at?: string
          target_price?: number | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_incidents: {
        Row: {
          category: string
          created_at: string
          id: string
          notes: string | null
          resolved_at: string | null
          severity: string
          status: string
          summary_snapshot: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          notes?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          summary_snapshot?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          notes?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          summary_snapshot?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_marketplace_intelligence: {
        Row: {
          avg_competitor_aggression: number | null
          bb_stability_score: number | null
          computed_at: string
          decision_churn_score: number | null
          floor_sensitivity: number | null
          marketplace: string
          recommended_aggression: string | null
          signals: Json | null
          user_id: string
          volatility_score: number | null
        }
        Insert: {
          avg_competitor_aggression?: number | null
          bb_stability_score?: number | null
          computed_at?: string
          decision_churn_score?: number | null
          floor_sensitivity?: number | null
          marketplace: string
          recommended_aggression?: string | null
          signals?: Json | null
          user_id: string
          volatility_score?: number | null
        }
        Update: {
          avg_competitor_aggression?: number | null
          bb_stability_score?: number | null
          computed_at?: string
          decision_churn_score?: number | null
          floor_sensitivity?: number | null
          marketplace?: string
          recommended_aggression?: string | null
          signals?: Json | null
          user_id?: string
          volatility_score?: number | null
        }
        Relationships: []
      }
      repricer_monitor_checks: {
        Row: {
          check_date: string
          checked_at: string | null
          created_at: string
          id: string
          is_checked: boolean
          notes: string | null
          step_key: string
          updated_at: string
          user_id: string
        }
        Insert: {
          check_date?: string
          checked_at?: string | null
          created_at?: string
          id?: string
          is_checked?: boolean
          notes?: string | null
          step_key: string
          updated_at?: string
          user_id: string
        }
        Update: {
          check_date?: string
          checked_at?: string | null
          created_at?: string
          id?: string
          is_checked?: boolean
          notes?: string | null
          step_key?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_monitor_snapshots: {
        Row: {
          bb_losing: number
          bb_winning: number
          captured_at: string
          constraint_market_stable: number
          constraint_min_bound: number
          constraint_other: number
          constraint_profit_guard: number
          coverage_pct: number
          eligible_checked_24h: number
          eligible_total: number
          evals_1h: number
          evals_24h: number
          health_score: number
          hot_blocked: number
          hot_dispatchable: number
          hot_eligible: number
          hot_p50_minutes: number
          hot_p90_minutes: number
          hot_truly_stale: number
          id: string
          user_id: string
          writes_1h: number
          writes_24h: number
        }
        Insert: {
          bb_losing?: number
          bb_winning?: number
          captured_at?: string
          constraint_market_stable?: number
          constraint_min_bound?: number
          constraint_other?: number
          constraint_profit_guard?: number
          coverage_pct?: number
          eligible_checked_24h?: number
          eligible_total?: number
          evals_1h?: number
          evals_24h?: number
          health_score?: number
          hot_blocked?: number
          hot_dispatchable?: number
          hot_eligible?: number
          hot_p50_minutes?: number
          hot_p90_minutes?: number
          hot_truly_stale?: number
          id?: string
          user_id: string
          writes_1h?: number
          writes_24h?: number
        }
        Update: {
          bb_losing?: number
          bb_winning?: number
          captured_at?: string
          constraint_market_stable?: number
          constraint_min_bound?: number
          constraint_other?: number
          constraint_profit_guard?: number
          coverage_pct?: number
          eligible_checked_24h?: number
          eligible_total?: number
          evals_1h?: number
          evals_24h?: number
          health_score?: number
          hot_blocked?: number
          hot_dispatchable?: number
          hot_eligible?: number
          hot_p50_minutes?: number
          hot_p90_minutes?: number
          hot_truly_stale?: number
          id?: string
          user_id?: string
          writes_1h?: number
          writes_24h?: number
        }
        Relationships: []
      }
      repricer_operator_actions: {
        Row: {
          action: string
          asin: string
          created_at: string
          id: string
          ignore_until: string | null
          marketplace: string
          notes: string | null
          operator_id: string | null
          suggested_action: string | null
          user_id: string
        }
        Insert: {
          action: string
          asin: string
          created_at?: string
          id?: string
          ignore_until?: string | null
          marketplace: string
          notes?: string | null
          operator_id?: string | null
          suggested_action?: string | null
          user_id: string
        }
        Update: {
          action?: string
          asin?: string
          created_at?: string
          id?: string
          ignore_until?: string | null
          marketplace?: string
          notes?: string | null
          operator_id?: string | null
          suggested_action?: string | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_opportunity_scores: {
        Row: {
          asin: string
          business_reason: string | null
          computed_at: string
          confidence: string | null
          expected_impact_usd: number | null
          factors: Json
          id: string
          marketplace: string
          priority_bucket: string
          score: number
          sku: string | null
          suggested_action: string | null
          user_id: string
        }
        Insert: {
          asin: string
          business_reason?: string | null
          computed_at?: string
          confidence?: string | null
          expected_impact_usd?: number | null
          factors?: Json
          id?: string
          marketplace: string
          priority_bucket?: string
          score?: number
          sku?: string | null
          suggested_action?: string | null
          user_id: string
        }
        Update: {
          asin?: string
          business_reason?: string | null
          computed_at?: string
          confidence?: string | null
          expected_impact_usd?: number | null
          factors?: Json
          id?: string
          marketplace?: string
          priority_bucket?: string
          score?: number
          sku?: string | null
          suggested_action?: string | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_price_actions: {
        Row: {
          action_type: string
          age_days: number | null
          amazon_accepted_price: number | null
          amazon_error_code: string | null
          amazon_max_from_api: number | null
          amazon_min_from_api: number | null
          amazon_response: Json | null
          asin: string
          assignment_id: string | null
          base_price: number | null
          created_at: string
          days_to_expiration: number | null
          effective_floor_cents: number | null
          error_message: string | null
          error_type: string | null
          feed_id: string | null
          floor_breakdown_json: Json | null
          id: string
          intelligence_factors: Json | null
          intended_price: number | null
          marketplace: string | null
          min_price_suggestion: Json | null
          new_max_price: number | null
          new_min_price: number | null
          new_price: number | null
          old_max_price: number | null
          old_min_price: number | null
          old_price: number | null
          overlay_tag: string | null
          reason: string | null
          recommended_action: string | null
          recon_converged_at: string | null
          recon_first_check_at: string | null
          recon_last_check_at: string | null
          recon_price_submitted: number | null
          recon_retry_count: number | null
          recon_root_cause: string | null
          recon_severity: string | null
          reconciliation_reason: string | null
          reconciliation_status: string | null
          rule_name: string | null
          sku: string | null
          submitted_price: number | null
          success: boolean | null
          trigger_source: string
          unnecessary_undercut_reason: string | null
          unnecessary_undercut_reasons: Json | null
          update_method: string | null
          user_id: string
          verified_at: string | null
          verified_live_price: number | null
          was_unnecessary_undercut: boolean
        }
        Insert: {
          action_type: string
          age_days?: number | null
          amazon_accepted_price?: number | null
          amazon_error_code?: string | null
          amazon_max_from_api?: number | null
          amazon_min_from_api?: number | null
          amazon_response?: Json | null
          asin: string
          assignment_id?: string | null
          base_price?: number | null
          created_at?: string
          days_to_expiration?: number | null
          effective_floor_cents?: number | null
          error_message?: string | null
          error_type?: string | null
          feed_id?: string | null
          floor_breakdown_json?: Json | null
          id?: string
          intelligence_factors?: Json | null
          intended_price?: number | null
          marketplace?: string | null
          min_price_suggestion?: Json | null
          new_max_price?: number | null
          new_min_price?: number | null
          new_price?: number | null
          old_max_price?: number | null
          old_min_price?: number | null
          old_price?: number | null
          overlay_tag?: string | null
          reason?: string | null
          recommended_action?: string | null
          recon_converged_at?: string | null
          recon_first_check_at?: string | null
          recon_last_check_at?: string | null
          recon_price_submitted?: number | null
          recon_retry_count?: number | null
          recon_root_cause?: string | null
          recon_severity?: string | null
          reconciliation_reason?: string | null
          reconciliation_status?: string | null
          rule_name?: string | null
          sku?: string | null
          submitted_price?: number | null
          success?: boolean | null
          trigger_source: string
          unnecessary_undercut_reason?: string | null
          unnecessary_undercut_reasons?: Json | null
          update_method?: string | null
          user_id: string
          verified_at?: string | null
          verified_live_price?: number | null
          was_unnecessary_undercut?: boolean
        }
        Update: {
          action_type?: string
          age_days?: number | null
          amazon_accepted_price?: number | null
          amazon_error_code?: string | null
          amazon_max_from_api?: number | null
          amazon_min_from_api?: number | null
          amazon_response?: Json | null
          asin?: string
          assignment_id?: string | null
          base_price?: number | null
          created_at?: string
          days_to_expiration?: number | null
          effective_floor_cents?: number | null
          error_message?: string | null
          error_type?: string | null
          feed_id?: string | null
          floor_breakdown_json?: Json | null
          id?: string
          intelligence_factors?: Json | null
          intended_price?: number | null
          marketplace?: string | null
          min_price_suggestion?: Json | null
          new_max_price?: number | null
          new_min_price?: number | null
          new_price?: number | null
          old_max_price?: number | null
          old_min_price?: number | null
          old_price?: number | null
          overlay_tag?: string | null
          reason?: string | null
          recommended_action?: string | null
          recon_converged_at?: string | null
          recon_first_check_at?: string | null
          recon_last_check_at?: string | null
          recon_price_submitted?: number | null
          recon_retry_count?: number | null
          recon_root_cause?: string | null
          recon_severity?: string | null
          reconciliation_reason?: string | null
          reconciliation_status?: string | null
          rule_name?: string | null
          sku?: string | null
          submitted_price?: number | null
          success?: boolean | null
          trigger_source?: string
          unnecessary_undercut_reason?: string | null
          unnecessary_undercut_reasons?: Json | null
          update_method?: string | null
          user_id?: string
          verified_at?: string | null
          verified_live_price?: number | null
          was_unnecessary_undercut?: boolean
        }
        Relationships: []
      }
      repricer_price_actions_daily: {
        Row: {
          action_type: string
          actions_count: number
          asins_touched: number
          avg_new_price: number | null
          avg_old_price: number | null
          created_at: string
          day: string
          marketplace: string
          user_id: string
        }
        Insert: {
          action_type: string
          actions_count?: number
          asins_touched?: number
          avg_new_price?: number | null
          avg_old_price?: number | null
          created_at?: string
          day: string
          marketplace?: string
          user_id: string
        }
        Update: {
          action_type?: string
          actions_count?: number
          asins_touched?: number
          avg_new_price?: number | null
          avg_old_price?: number | null
          created_at?: string
          day?: string
          marketplace?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_pricing_suppression_checks: {
        Row: {
          action_taken: string
          asin: string | null
          checked_at: string
          http_status: number
          id: string
          issues_seen: Json
          marketplace: string
          notes: string | null
          run_id: string
          sku: string
          summaries_non_empty: boolean
          trust_gate_passed: boolean
          user_id: string
        }
        Insert: {
          action_taken: string
          asin?: string | null
          checked_at?: string
          http_status: number
          id?: string
          issues_seen?: Json
          marketplace: string
          notes?: string | null
          run_id: string
          sku: string
          summaries_non_empty: boolean
          trust_gate_passed: boolean
          user_id: string
        }
        Update: {
          action_taken?: string
          asin?: string | null
          checked_at?: string
          http_status?: number
          id?: string
          issues_seen?: Json
          marketplace?: string
          notes?: string | null
          run_id?: string
          sku?: string
          summaries_non_empty?: boolean
          trust_gate_passed?: boolean
          user_id?: string
        }
        Relationships: []
      }
      repricer_pricing_suppression_history: {
        Row: {
          asin: string | null
          categories: string[] | null
          cleared_at: string
          created_at: string
          detected_at: string
          enforcement_actions: string[] | null
          id: string
          marketplace: string
          raw_code: string | null
          raw_message: string | null
          severity: string | null
          sku: string
          user_id: string
          was_pricing_suppression: boolean
        }
        Insert: {
          asin?: string | null
          categories?: string[] | null
          cleared_at: string
          created_at?: string
          detected_at: string
          enforcement_actions?: string[] | null
          id?: string
          marketplace: string
          raw_code?: string | null
          raw_message?: string | null
          severity?: string | null
          sku: string
          user_id: string
          was_pricing_suppression?: boolean
        }
        Update: {
          asin?: string | null
          categories?: string[] | null
          cleared_at?: string
          created_at?: string
          detected_at?: string
          enforcement_actions?: string[] | null
          id?: string
          marketplace?: string
          raw_code?: string | null
          raw_message?: string | null
          severity?: string | null
          sku?: string
          user_id?: string
          was_pricing_suppression?: boolean
        }
        Relationships: []
      }
      repricer_reaction_log: {
        Row: {
          asin: string
          competitor_price_after: number | null
          competitor_price_before: number | null
          competitor_type: string | null
          created_at: string | null
          detected_at: string | null
          id: string
          marketplace: string
          our_new_price: number | null
          our_old_price: number | null
          our_price_change_at: string
          reaction_time_seconds: number | null
          user_id: string
        }
        Insert: {
          asin: string
          competitor_price_after?: number | null
          competitor_price_before?: number | null
          competitor_type?: string | null
          created_at?: string | null
          detected_at?: string | null
          id?: string
          marketplace?: string
          our_new_price?: number | null
          our_old_price?: number | null
          our_price_change_at: string
          reaction_time_seconds?: number | null
          user_id: string
        }
        Update: {
          asin?: string
          competitor_price_after?: number | null
          competitor_price_before?: number | null
          competitor_type?: string | null
          created_at?: string | null
          detected_at?: string | null
          id?: string
          marketplace?: string
          our_new_price?: number | null
          our_old_price?: number | null
          our_price_change_at?: string
          reaction_time_seconds?: number | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_recommendation_fatigue: {
        Row: {
          action_kind: string
          asin: string
          dismiss_count: number
          failure_count: number
          fatigue_score: number
          id: string
          last_dismissed_at: string | null
          last_seen_at: string
          marketplace: string | null
          success_count: number
          user_id: string
        }
        Insert: {
          action_kind: string
          asin: string
          dismiss_count?: number
          failure_count?: number
          fatigue_score?: number
          id?: string
          last_dismissed_at?: string | null
          last_seen_at?: string
          marketplace?: string | null
          success_count?: number
          user_id: string
        }
        Update: {
          action_kind?: string
          asin?: string
          dismiss_count?: number
          failure_count?: number
          fatigue_score?: number
          id?: string
          last_dismissed_at?: string | null
          last_seen_at?: string
          marketplace?: string | null
          success_count?: number
          user_id?: string
        }
        Relationships: []
      }
      repricer_rule_marketplace_settings: {
        Row: {
          cooldown_minutes: number | null
          created_at: string
          currency: string
          id: string
          is_enabled: boolean
          marketplace: string
          max_price: number | null
          max_step_amount: number | null
          min_price: number | null
          rule_id: string
          undercut_amount: number
          updated_at: string
        }
        Insert: {
          cooldown_minutes?: number | null
          created_at?: string
          currency?: string
          id?: string
          is_enabled?: boolean
          marketplace?: string
          max_price?: number | null
          max_step_amount?: number | null
          min_price?: number | null
          rule_id: string
          undercut_amount?: number
          updated_at?: string
        }
        Update: {
          cooldown_minutes?: number | null
          created_at?: string
          currency?: string
          id?: string
          is_enabled?: boolean
          marketplace?: string
          max_price?: number | null
          max_step_amount?: number | null
          min_price?: number | null
          rule_id?: string
          undercut_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "repricer_rule_marketplace_settings_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "repricer_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      repricer_rules: {
        Row: {
          auto_lower_min_anchor: string
          auto_lower_min_interval_minutes: number
          auto_lower_min_last_run_at: string | null
          auto_lower_min_marketplaces: string[]
          auto_lower_min_max_drops_per_day: number
          auto_lower_min_undercut: number
          age_overlay_enabled: boolean | null
          age_overlay_mode: string | null
          ai_settings: Json | null
          block_auto_apply_if_cost_missing: boolean | null
          compete_with_amazon: boolean | null
          compete_with_fba: boolean | null
          compete_with_fbm: boolean | null
          competitor_quality_preset: string | null
          condition_scope: Database["public"]["Enums"]["repricer_condition_scope"]
          cooldown_minutes: number | null
          cooldown_minutes_losing_bb: number | null
          cooldown_minutes_on_floor: number | null
          cooldown_minutes_winning_bb: number | null
          created_at: string
          dump_age_days: number | null
          enable_auto_exit_reenter: boolean | null
          enable_auto_floor: boolean
          enable_dynamic_floor_relaxation: boolean
          enable_dynamic_roi: boolean | null
          enable_monopoly_mode: boolean | null
          enable_profit_guard: boolean | null
          enable_smart_raise: boolean | null
          excluded_sellers: string[] | null
          expiration_undercut_14: number | null
          expiration_undercut_30: number | null
          expiration_undercut_7: number | null
          extra_undercut_181: number | null
          extra_undercut_271: number | null
          extra_undercut_365: number | null
          fbm_competition_mode: string | null
          fbm_undercut_amount: number | null
          floor_source: Database["public"]["Enums"]["repricer_floor_source"]
          fulfillment_scope: Database["public"]["Enums"]["repricer_fulfillment_scope"]
          high_risk_seller_count_threshold: number | null
          id: string
          ignore_fbm_unless_buybox_owner: boolean | null
          include_fees_in_floor: boolean | null
          is_default: boolean
          is_enabled: boolean
          marketplace_schedule: Json | null
          marketplaces: string[]
          max_change_percent: number | null
          max_drop_per_run_cents: number | null
          max_handling_days: number | null
          max_price: number | null
          max_raise_step_dollars: number | null
          max_raise_step_percent: number | null
          max_step_amount: number | null
          max_step_percent: number | null
          min_change_threshold: number | null
          min_floor_support_ratio: number | null
          min_price: number | null
          min_profit: number | null
          min_profit_dollars: number | null
          min_roi: number | null
          min_roi_enabled: boolean
          min_roi_enabled_marketplace_overrides: Json
          min_roi_marketplace_overrides: Json
          min_roi_percent: number | null
          min_roi_percent_base: number | null
          min_roi_percent_high_risk: number | null
          min_seller_rating: number | null
          monopoly_cooldown_minutes: number | null
          monopoly_mode_type: string | null
          monopoly_raise_step_dollars: number | null
          monopoly_raise_step_percent: number | null
          name: string
          only_raise_when_buybox_owner: boolean | null
          oscillation_bb_loss_limit: number
          oscillation_cooldown_minutes: number
          oscillation_max_reactions: number
          oscillation_mode: string
          post_raise_cooldown_hours: number | null
          profit_guard_mode: string
          raise_trigger_percent: number | null
          reenter_buffer_percent: number | null
          require_market_supported_raise: boolean
          rule_type: string | null
          ships_from_filter: string | null
          skip_lower_when_bb_owner: boolean
          smart_profile: string
          snapshot_ttl_minutes: number | null
          stock_modifier_critical: number
          stock_modifier_heavy: number
          stock_modifier_low: number
          stock_modifier_normal: number
          stock_modifier_overstock: number
          stock_overlay_enabled: boolean
          stock_threshold_critical: number
          stock_threshold_healthy_max: number
          stock_threshold_heavy: number
          stock_threshold_low: number
          strategy: Database["public"]["Enums"]["repricer_strategy"]
          suppressed_bb_undercut: number | null
          target_anchor: string
          target_seller_ids: string[] | null
          top_n_competitors: number | null
          undercut_amount: number
          undercut_amount_fbm: number | null
          updated_at: string
          use_ai_tuning: boolean | null
          user_id: string
          velocity_weight_30d: number
          velocity_weight_7d: number
          war_protection_minutes: number | null
          when_backordered: string | null
          when_below_min_price: string | null
          when_buybox_suppressed: string | null
          when_condition_used: string | null
          when_not_buybox_eligible: string | null
          when_only_seller: string | null
        }
        Insert: {
          auto_lower_min_anchor?: string
          auto_lower_min_interval_minutes?: number
          auto_lower_min_last_run_at?: string | null
          auto_lower_min_marketplaces?: string[]
          auto_lower_min_max_drops_per_day?: number
          auto_lower_min_undercut?: number
          age_overlay_enabled?: boolean | null
          age_overlay_mode?: string | null
          ai_settings?: Json | null
          block_auto_apply_if_cost_missing?: boolean | null
          compete_with_amazon?: boolean | null
          compete_with_fba?: boolean | null
          compete_with_fbm?: boolean | null
          competitor_quality_preset?: string | null
          condition_scope?: Database["public"]["Enums"]["repricer_condition_scope"]
          cooldown_minutes?: number | null
          cooldown_minutes_losing_bb?: number | null
          cooldown_minutes_on_floor?: number | null
          cooldown_minutes_winning_bb?: number | null
          created_at?: string
          dump_age_days?: number | null
          enable_auto_exit_reenter?: boolean | null
          enable_auto_floor?: boolean
          enable_dynamic_floor_relaxation?: boolean
          enable_dynamic_roi?: boolean | null
          enable_monopoly_mode?: boolean | null
          enable_profit_guard?: boolean | null
          enable_smart_raise?: boolean | null
          excluded_sellers?: string[] | null
          expiration_undercut_14?: number | null
          expiration_undercut_30?: number | null
          expiration_undercut_7?: number | null
          extra_undercut_181?: number | null
          extra_undercut_271?: number | null
          extra_undercut_365?: number | null
          fbm_competition_mode?: string | null
          fbm_undercut_amount?: number | null
          floor_source?: Database["public"]["Enums"]["repricer_floor_source"]
          fulfillment_scope?: Database["public"]["Enums"]["repricer_fulfillment_scope"]
          high_risk_seller_count_threshold?: number | null
          id?: string
          ignore_fbm_unless_buybox_owner?: boolean | null
          include_fees_in_floor?: boolean | null
          is_default?: boolean
          is_enabled?: boolean
          marketplace_schedule?: Json | null
          marketplaces?: string[]
          max_change_percent?: number | null
          max_drop_per_run_cents?: number | null
          max_handling_days?: number | null
          max_price?: number | null
          max_raise_step_dollars?: number | null
          max_raise_step_percent?: number | null
          max_step_amount?: number | null
          max_step_percent?: number | null
          min_change_threshold?: number | null
          min_floor_support_ratio?: number | null
          min_price?: number | null
          min_profit?: number | null
          min_profit_dollars?: number | null
          min_roi?: number | null
          min_roi_enabled?: boolean
          min_roi_enabled_marketplace_overrides?: Json
          min_roi_marketplace_overrides?: Json
          min_roi_percent?: number | null
          min_roi_percent_base?: number | null
          min_roi_percent_high_risk?: number | null
          min_seller_rating?: number | null
          monopoly_cooldown_minutes?: number | null
          monopoly_mode_type?: string | null
          monopoly_raise_step_dollars?: number | null
          monopoly_raise_step_percent?: number | null
          name: string
          only_raise_when_buybox_owner?: boolean | null
          oscillation_bb_loss_limit?: number
          oscillation_cooldown_minutes?: number
          oscillation_max_reactions?: number
          oscillation_mode?: string
          post_raise_cooldown_hours?: number | null
          profit_guard_mode?: string
          raise_trigger_percent?: number | null
          reenter_buffer_percent?: number | null
          require_market_supported_raise?: boolean
          rule_type?: string | null
          ships_from_filter?: string | null
          skip_lower_when_bb_owner?: boolean
          smart_profile?: string
          snapshot_ttl_minutes?: number | null
          stock_modifier_critical?: number
          stock_modifier_heavy?: number
          stock_modifier_low?: number
          stock_modifier_normal?: number
          stock_modifier_overstock?: number
          stock_overlay_enabled?: boolean
          stock_threshold_critical?: number
          stock_threshold_healthy_max?: number
          stock_threshold_heavy?: number
          stock_threshold_low?: number
          strategy?: Database["public"]["Enums"]["repricer_strategy"]
          suppressed_bb_undercut?: number | null
          target_anchor?: string
          target_seller_ids?: string[] | null
          top_n_competitors?: number | null
          undercut_amount?: number
          undercut_amount_fbm?: number | null
          updated_at?: string
          use_ai_tuning?: boolean | null
          user_id: string
          velocity_weight_30d?: number
          velocity_weight_7d?: number
          war_protection_minutes?: number | null
          when_backordered?: string | null
          when_below_min_price?: string | null
          when_buybox_suppressed?: string | null
          when_condition_used?: string | null
          when_not_buybox_eligible?: string | null
          when_only_seller?: string | null
        }
        Update: {
          auto_lower_min_anchor?: string
          auto_lower_min_interval_minutes?: number
          auto_lower_min_last_run_at?: string | null
          auto_lower_min_marketplaces?: string[]
          auto_lower_min_max_drops_per_day?: number
          auto_lower_min_undercut?: number
          age_overlay_enabled?: boolean | null
          age_overlay_mode?: string | null
          ai_settings?: Json | null
          block_auto_apply_if_cost_missing?: boolean | null
          compete_with_amazon?: boolean | null
          compete_with_fba?: boolean | null
          compete_with_fbm?: boolean | null
          competitor_quality_preset?: string | null
          condition_scope?: Database["public"]["Enums"]["repricer_condition_scope"]
          cooldown_minutes?: number | null
          cooldown_minutes_losing_bb?: number | null
          cooldown_minutes_on_floor?: number | null
          cooldown_minutes_winning_bb?: number | null
          created_at?: string
          dump_age_days?: number | null
          enable_auto_exit_reenter?: boolean | null
          enable_auto_floor?: boolean
          enable_dynamic_floor_relaxation?: boolean
          enable_dynamic_roi?: boolean | null
          enable_monopoly_mode?: boolean | null
          enable_profit_guard?: boolean | null
          enable_smart_raise?: boolean | null
          excluded_sellers?: string[] | null
          expiration_undercut_14?: number | null
          expiration_undercut_30?: number | null
          expiration_undercut_7?: number | null
          extra_undercut_181?: number | null
          extra_undercut_271?: number | null
          extra_undercut_365?: number | null
          fbm_competition_mode?: string | null
          fbm_undercut_amount?: number | null
          floor_source?: Database["public"]["Enums"]["repricer_floor_source"]
          fulfillment_scope?: Database["public"]["Enums"]["repricer_fulfillment_scope"]
          high_risk_seller_count_threshold?: number | null
          id?: string
          ignore_fbm_unless_buybox_owner?: boolean | null
          include_fees_in_floor?: boolean | null
          is_default?: boolean
          is_enabled?: boolean
          marketplace_schedule?: Json | null
          marketplaces?: string[]
          max_change_percent?: number | null
          max_drop_per_run_cents?: number | null
          max_handling_days?: number | null
          max_price?: number | null
          max_raise_step_dollars?: number | null
          max_raise_step_percent?: number | null
          max_step_amount?: number | null
          max_step_percent?: number | null
          min_change_threshold?: number | null
          min_floor_support_ratio?: number | null
          min_price?: number | null
          min_profit?: number | null
          min_profit_dollars?: number | null
          min_roi?: number | null
          min_roi_enabled?: boolean
          min_roi_enabled_marketplace_overrides?: Json
          min_roi_marketplace_overrides?: Json
          min_roi_percent?: number | null
          min_roi_percent_base?: number | null
          min_roi_percent_high_risk?: number | null
          min_seller_rating?: number | null
          monopoly_cooldown_minutes?: number | null
          monopoly_mode_type?: string | null
          monopoly_raise_step_dollars?: number | null
          monopoly_raise_step_percent?: number | null
          name?: string
          only_raise_when_buybox_owner?: boolean | null
          oscillation_bb_loss_limit?: number
          oscillation_cooldown_minutes?: number
          oscillation_max_reactions?: number
          oscillation_mode?: string
          post_raise_cooldown_hours?: number | null
          profit_guard_mode?: string
          raise_trigger_percent?: number | null
          reenter_buffer_percent?: number | null
          require_market_supported_raise?: boolean
          rule_type?: string | null
          ships_from_filter?: string | null
          skip_lower_when_bb_owner?: boolean
          smart_profile?: string
          snapshot_ttl_minutes?: number | null
          stock_modifier_critical?: number
          stock_modifier_heavy?: number
          stock_modifier_low?: number
          stock_modifier_normal?: number
          stock_modifier_overstock?: number
          stock_overlay_enabled?: boolean
          stock_threshold_critical?: number
          stock_threshold_healthy_max?: number
          stock_threshold_heavy?: number
          stock_threshold_low?: number
          strategy?: Database["public"]["Enums"]["repricer_strategy"]
          suppressed_bb_undercut?: number | null
          target_anchor?: string
          target_seller_ids?: string[] | null
          top_n_competitors?: number | null
          undercut_amount?: number
          undercut_amount_fbm?: number | null
          updated_at?: string
          use_ai_tuning?: boolean | null
          user_id?: string
          velocity_weight_30d?: number
          velocity_weight_7d?: number
          war_protection_minutes?: number | null
          when_backordered?: string | null
          when_below_min_price?: string | null
          when_buybox_suppressed?: string | null
          when_condition_used?: string | null
          when_not_buybox_eligible?: string | null
          when_only_seller?: string | null
        }
        Relationships: []
      }
      repricer_setting_changes: {
        Row: {
          asin: string
          change_type: string
          created_at: string
          device_info: string | null
          field_changed: string
          id: string
          ip_address: string | null
          marketplace: string
          new_value: number | null
          old_value: number | null
          reason: string | null
          sku: string | null
          source: string | null
          user_id: string
        }
        Insert: {
          asin: string
          change_type?: string
          created_at?: string
          device_info?: string | null
          field_changed: string
          id?: string
          ip_address?: string | null
          marketplace?: string
          new_value?: number | null
          old_value?: number | null
          reason?: string | null
          sku?: string | null
          source?: string | null
          user_id: string
        }
        Update: {
          asin?: string
          change_type?: string
          created_at?: string
          device_info?: string | null
          field_changed?: string
          id?: string
          ip_address?: string | null
          marketplace?: string
          new_value?: number | null
          old_value?: number | null
          reason?: string | null
          sku?: string | null
          source?: string | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_settings: {
        Row: {
          absolute_min_price_floor: number | null
          auto_apply: boolean
          auto_turbo_current_batch: Json | null
          auto_turbo_duration_minutes: number
          auto_turbo_enabled: boolean
          auto_turbo_last_rotation_at: string | null
          auto_turbo_rotation_cursor: number | null
          auto_turbo_rotation_pool: Json | null
          auto_turbo_rule_id: string | null
          circuit_breaker_error_count: number
          circuit_breaker_last_trigger: string | null
          circuit_breaker_window_start: string | null
          continuous_mode: boolean
          created_at: string
          credits_reset_at: string
          credits_used_today: number
          daily_credit_cap: number
          dispatch_worker_shard: string | null
          home_currency: string
          last_scheduler_run_at: string | null
          marketplace_roles: Json | null
          max_minmax_changes_per_day: number | null
          max_price_change_percent_per_day: number | null
          momentum_check_enabled: boolean
          momentum_threshold_pct: number
          primary_marketplace: string | null
          primary_marketplace_detected_at: string | null
          primary_marketplace_detection_method: string | null
          primary_marketplace_manual_override: boolean
          priority_auto_resume_at: string | null
          priority_backoff_seconds: number
          priority_pause_reason: string | null
          priority_paused: boolean
          queue_auto_resume_at: string | null
          queue_consecutive_failures: number
          queue_last_error_message: string | null
          queue_last_error_type: string | null
          queue_last_failure_at: string | null
          queue_pause_reason: string | null
          queue_paused: boolean
          queue_paused_at: string | null
          rainforest_snapshot_ttl_minutes: number
          rate_limit_backoff_seconds: number | null
          require_cost_for_min_calc: boolean | null
          safe_mode_activated_at: string | null
          safe_mode_active: boolean
          safe_mode_auto_resume_at: string | null
          safe_mode_reason: string | null
          schedule_timezone: string
          scheduler_batch_size: number
          scheduler_enabled: boolean
          scheduler_status: string | null
          sequential_sweep_batch_size: number
          sequential_sweep_checked_this_pass: number
          sequential_sweep_enabled: boolean
          sequential_sweep_interval_minutes: number
          sequential_sweep_last_run_at: string | null
          sequential_sweep_pass_started_at: string | null
          sequential_sweep_passes_completed: number
          sequential_sweep_total_eligible: number
          sp_api_calls_per_minute_cap: number
          sp_api_calls_this_window: number
          sp_api_check_interval_minutes: number
          sp_api_lane_usage: Json | null
          sp_api_lane_usage_date: string | null
          sp_api_window_start: string | null
          updated_at: string
          user_id: string
          writes_cycle_start: string | null
          writes_this_cycle: number
        }
        Insert: {
          absolute_min_price_floor?: number | null
          auto_apply?: boolean
          auto_turbo_current_batch?: Json | null
          auto_turbo_duration_minutes?: number
          auto_turbo_enabled?: boolean
          auto_turbo_last_rotation_at?: string | null
          auto_turbo_rotation_cursor?: number | null
          auto_turbo_rotation_pool?: Json | null
          auto_turbo_rule_id?: string | null
          circuit_breaker_error_count?: number
          circuit_breaker_last_trigger?: string | null
          circuit_breaker_window_start?: string | null
          continuous_mode?: boolean
          created_at?: string
          credits_reset_at?: string
          credits_used_today?: number
          daily_credit_cap?: number
          dispatch_worker_shard?: string | null
          home_currency?: string
          last_scheduler_run_at?: string | null
          marketplace_roles?: Json | null
          max_minmax_changes_per_day?: number | null
          max_price_change_percent_per_day?: number | null
          momentum_check_enabled?: boolean
          momentum_threshold_pct?: number
          primary_marketplace?: string | null
          primary_marketplace_detected_at?: string | null
          primary_marketplace_detection_method?: string | null
          primary_marketplace_manual_override?: boolean
          priority_auto_resume_at?: string | null
          priority_backoff_seconds?: number
          priority_pause_reason?: string | null
          priority_paused?: boolean
          queue_auto_resume_at?: string | null
          queue_consecutive_failures?: number
          queue_last_error_message?: string | null
          queue_last_error_type?: string | null
          queue_last_failure_at?: string | null
          queue_pause_reason?: string | null
          queue_paused?: boolean
          queue_paused_at?: string | null
          rainforest_snapshot_ttl_minutes?: number
          rate_limit_backoff_seconds?: number | null
          require_cost_for_min_calc?: boolean | null
          safe_mode_activated_at?: string | null
          safe_mode_active?: boolean
          safe_mode_auto_resume_at?: string | null
          safe_mode_reason?: string | null
          schedule_timezone?: string
          scheduler_batch_size?: number
          scheduler_enabled?: boolean
          scheduler_status?: string | null
          sequential_sweep_batch_size?: number
          sequential_sweep_checked_this_pass?: number
          sequential_sweep_enabled?: boolean
          sequential_sweep_interval_minutes?: number
          sequential_sweep_last_run_at?: string | null
          sequential_sweep_pass_started_at?: string | null
          sequential_sweep_passes_completed?: number
          sequential_sweep_total_eligible?: number
          sp_api_calls_per_minute_cap?: number
          sp_api_calls_this_window?: number
          sp_api_check_interval_minutes?: number
          sp_api_lane_usage?: Json | null
          sp_api_lane_usage_date?: string | null
          sp_api_window_start?: string | null
          updated_at?: string
          user_id: string
          writes_cycle_start?: string | null
          writes_this_cycle?: number
        }
        Update: {
          absolute_min_price_floor?: number | null
          auto_apply?: boolean
          auto_turbo_current_batch?: Json | null
          auto_turbo_duration_minutes?: number
          auto_turbo_enabled?: boolean
          auto_turbo_last_rotation_at?: string | null
          auto_turbo_rotation_cursor?: number | null
          auto_turbo_rotation_pool?: Json | null
          auto_turbo_rule_id?: string | null
          circuit_breaker_error_count?: number
          circuit_breaker_last_trigger?: string | null
          circuit_breaker_window_start?: string | null
          continuous_mode?: boolean
          created_at?: string
          credits_reset_at?: string
          credits_used_today?: number
          daily_credit_cap?: number
          dispatch_worker_shard?: string | null
          home_currency?: string
          last_scheduler_run_at?: string | null
          marketplace_roles?: Json | null
          max_minmax_changes_per_day?: number | null
          max_price_change_percent_per_day?: number | null
          momentum_check_enabled?: boolean
          momentum_threshold_pct?: number
          primary_marketplace?: string | null
          primary_marketplace_detected_at?: string | null
          primary_marketplace_detection_method?: string | null
          primary_marketplace_manual_override?: boolean
          priority_auto_resume_at?: string | null
          priority_backoff_seconds?: number
          priority_pause_reason?: string | null
          priority_paused?: boolean
          queue_auto_resume_at?: string | null
          queue_consecutive_failures?: number
          queue_last_error_message?: string | null
          queue_last_error_type?: string | null
          queue_last_failure_at?: string | null
          queue_pause_reason?: string | null
          queue_paused?: boolean
          queue_paused_at?: string | null
          rainforest_snapshot_ttl_minutes?: number
          rate_limit_backoff_seconds?: number | null
          require_cost_for_min_calc?: boolean | null
          safe_mode_activated_at?: string | null
          safe_mode_active?: boolean
          safe_mode_auto_resume_at?: string | null
          safe_mode_reason?: string | null
          schedule_timezone?: string
          scheduler_batch_size?: number
          scheduler_enabled?: boolean
          scheduler_status?: string | null
          sequential_sweep_batch_size?: number
          sequential_sweep_checked_this_pass?: number
          sequential_sweep_enabled?: boolean
          sequential_sweep_interval_minutes?: number
          sequential_sweep_last_run_at?: string | null
          sequential_sweep_pass_started_at?: string | null
          sequential_sweep_passes_completed?: number
          sequential_sweep_total_eligible?: number
          sp_api_calls_per_minute_cap?: number
          sp_api_calls_this_window?: number
          sp_api_check_interval_minutes?: number
          sp_api_lane_usage?: Json | null
          sp_api_lane_usage_date?: string | null
          sp_api_window_start?: string | null
          updated_at?: string
          user_id?: string
          writes_cycle_start?: string | null
          writes_this_cycle?: number
        }
        Relationships: [
          {
            foreignKeyName: "repricer_settings_auto_turbo_rule_id_fkey"
            columns: ["auto_turbo_rule_id"]
            isOneToOne: false
            referencedRelation: "repricer_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      repricer_simulation_items: {
        Row: {
          asin: string
          bb_price: number | null
          became_hot_at: string | null
          block_reason: string | null
          constraint_reason: string | null
          created_at: string
          current_price: number | null
          eval_result: string | null
          id: string
          is_bb_owner: boolean
          is_dispatchable: boolean
          last_evaluated_at: string | null
          marketplace: string
          max_price: number | null
          min_price: number | null
          next_competitor_price: number | null
          run_id: string
          tier: string
          user_id: string
        }
        Insert: {
          asin: string
          bb_price?: number | null
          became_hot_at?: string | null
          block_reason?: string | null
          constraint_reason?: string | null
          created_at?: string
          current_price?: number | null
          eval_result?: string | null
          id?: string
          is_bb_owner?: boolean
          is_dispatchable?: boolean
          last_evaluated_at?: string | null
          marketplace?: string
          max_price?: number | null
          min_price?: number | null
          next_competitor_price?: number | null
          run_id: string
          tier?: string
          user_id: string
        }
        Update: {
          asin?: string
          bb_price?: number | null
          became_hot_at?: string | null
          block_reason?: string | null
          constraint_reason?: string | null
          created_at?: string
          current_price?: number | null
          eval_result?: string | null
          id?: string
          is_bb_owner?: boolean
          is_dispatchable?: boolean
          last_evaluated_at?: string | null
          marketplace?: string
          max_price?: number | null
          min_price?: number | null
          next_competitor_price?: number | null
          run_id?: string
          tier?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repricer_simulation_items_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "repricer_simulation_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      repricer_simulation_runs: {
        Row: {
          created_at: string
          id: string
          item_count: number
          name: string | null
          scenario: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_count?: number
          name?: string | null
          scenario?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          item_count?: number
          name?: string | null
          scenario?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_strategic_insights: {
        Row: {
          acknowledged_at: string | null
          affected_asins: number | null
          body: string
          category: string
          dedupe_key: string | null
          expected_impact_usd: number | null
          generated_at: string
          headline: string
          id: string
          impact_tier: string
          marketplace: string | null
          severity: string
          source_data: Json | null
          suppressed: boolean
          user_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          affected_asins?: number | null
          body: string
          category?: string
          dedupe_key?: string | null
          expected_impact_usd?: number | null
          generated_at?: string
          headline: string
          id?: string
          impact_tier?: string
          marketplace?: string | null
          severity?: string
          source_data?: Json | null
          suppressed?: boolean
          user_id: string
        }
        Update: {
          acknowledged_at?: string | null
          affected_asins?: number | null
          body?: string
          category?: string
          dedupe_key?: string | null
          expected_impact_usd?: number | null
          generated_at?: string
          headline?: string
          id?: string
          impact_tier?: string
          marketplace?: string | null
          severity?: string
          source_data?: Json | null
          suppressed?: boolean
          user_id?: string
        }
        Relationships: []
      }
      repricer_strategy_states: {
        Row: {
          asin: string
          entered_at: string
          expires_at: string
          id: string
          marketplace_id: string
          reason_business: string | null
          reason_technical: string | null
          signals: Json | null
          state: Database["public"]["Enums"]["repricer_strategy_state"]
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          entered_at?: string
          expires_at?: string
          id?: string
          marketplace_id?: string
          reason_business?: string | null
          reason_technical?: string | null
          signals?: Json | null
          state?: Database["public"]["Enums"]["repricer_strategy_state"]
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          entered_at?: string
          expires_at?: string
          id?: string
          marketplace_id?: string
          reason_business?: string | null
          reason_technical?: string | null
          signals?: Json | null
          state?: Database["public"]["Enums"]["repricer_strategy_state"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      repricer_suggestion_log: {
        Row: {
          applied_min: number | null
          asin: string
          assignment_id: string | null
          bb_status: string | null
          created_at: string
          decision: string
          id: string
          marketplace: string
          new_price: number | null
          old_min: number | null
          old_price: number | null
          roi_after: number | null
          roi_before: number | null
          rule_name: string | null
          skip_reason: string | null
          sku: string | null
          source: string | null
          suggested_min: number | null
          title: string | null
          user_id: string
        }
        Insert: {
          applied_min?: number | null
          asin: string
          assignment_id?: string | null
          bb_status?: string | null
          created_at?: string
          decision?: string
          id?: string
          marketplace?: string
          new_price?: number | null
          old_min?: number | null
          old_price?: number | null
          roi_after?: number | null
          roi_before?: number | null
          rule_name?: string | null
          skip_reason?: string | null
          sku?: string | null
          source?: string | null
          suggested_min?: number | null
          title?: string | null
          user_id: string
        }
        Update: {
          applied_min?: number | null
          asin?: string
          assignment_id?: string | null
          bb_status?: string | null
          created_at?: string
          decision?: string
          id?: string
          marketplace?: string
          new_price?: number | null
          old_min?: number | null
          old_price?: number | null
          roi_after?: number | null
          roi_before?: number | null
          rule_name?: string | null
          skip_reason?: string | null
          sku?: string | null
          source?: string | null
          suggested_min?: number | null
          title?: string | null
          user_id?: string
        }
        Relationships: []
      }
      repricer_user_automation_preferences: {
        Row: {
          allow_auto_fix: boolean
          allow_autonomous_recovery: boolean
          automation_tier: string
          escalation_threshold: number
          recovery_speed: string
          updated_at: string
          user_id: string
        }
        Insert: {
          allow_auto_fix?: boolean
          allow_autonomous_recovery?: boolean
          automation_tier?: string
          escalation_threshold?: number
          recovery_speed?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          allow_auto_fix?: boolean
          allow_autonomous_recovery?: boolean
          automation_tier?: string
          escalation_threshold?: number
          recovery_speed?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      research_leads: {
        Row: {
          asin: string
          cost: number | null
          created_at: string
          date_found: string
          decision: Database["public"]["Enums"]["research_lead_decision"]
          expected_roi: number | null
          expected_sell_price: number | null
          id: string
          image_url: string | null
          notes: string | null
          processed: boolean
          retail_url: string | null
          source: string | null
          supplier_name: string | null
          tags: string[] | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          cost?: number | null
          created_at?: string
          date_found?: string
          decision?: Database["public"]["Enums"]["research_lead_decision"]
          expected_roi?: number | null
          expected_sell_price?: number | null
          id?: string
          image_url?: string | null
          notes?: string | null
          processed?: boolean
          retail_url?: string | null
          source?: string | null
          supplier_name?: string | null
          tags?: string[] | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          cost?: number | null
          created_at?: string
          date_found?: string
          decision?: Database["public"]["Enums"]["research_lead_decision"]
          expected_roi?: number | null
          expected_sell_price?: number | null
          id?: string
          image_url?: string | null
          notes?: string | null
          processed?: boolean
          retail_url?: string | null
          source?: string | null
          supplier_name?: string | null
          tags?: string[] | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      retailers: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      roi_alerts: {
        Row: {
          asin: string
          cog_total: number
          created_at: string
          email_sent: boolean
          fees_total: number
          id: string
          ignored: boolean
          image_url: string | null
          order_date: string
          order_ids: string[] | null
          roi: number
          sales_total: number
          seen: boolean
          status: string
          title: string | null
          units: number
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          cog_total?: number
          created_at?: string
          email_sent?: boolean
          fees_total?: number
          id?: string
          ignored?: boolean
          image_url?: string | null
          order_date: string
          order_ids?: string[] | null
          roi?: number
          sales_total?: number
          seen?: boolean
          status?: string
          title?: string | null
          units?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          cog_total?: number
          created_at?: string
          email_sent?: boolean
          fees_total?: number
          id?: string
          ignored?: boolean
          image_url?: string | null
          order_date?: string
          order_ids?: string[] | null
          roi?: number
          sales_total?: number
          seen?: boolean
          status?: string
          title?: string | null
          units?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sales_correction_history: {
        Row: {
          asin: string
          corrected_at: string
          correction_type: string
          created_at: string
          fee_delta: number | null
          id: string
          marketplace: string | null
          new_fee_source: string | null
          new_price_source: string | null
          new_profit: number | null
          new_total_fees: number | null
          new_unit_price: number | null
          order_id: string
          previous_fee_source: string | null
          previous_price_source: string | null
          previous_profit: number | null
          previous_total_fees: number | null
          previous_unit_price: number | null
          profit_delta: number | null
          revenue_delta: number | null
          sku: string | null
          sync_trace_id: string | null
          user_id: string
        }
        Insert: {
          asin?: string
          corrected_at?: string
          correction_type: string
          created_at?: string
          fee_delta?: number | null
          id?: string
          marketplace?: string | null
          new_fee_source?: string | null
          new_price_source?: string | null
          new_profit?: number | null
          new_total_fees?: number | null
          new_unit_price?: number | null
          order_id: string
          previous_fee_source?: string | null
          previous_price_source?: string | null
          previous_profit?: number | null
          previous_total_fees?: number | null
          previous_unit_price?: number | null
          profit_delta?: number | null
          revenue_delta?: number | null
          sku?: string | null
          sync_trace_id?: string | null
          user_id: string
        }
        Update: {
          asin?: string
          corrected_at?: string
          correction_type?: string
          created_at?: string
          fee_delta?: number | null
          id?: string
          marketplace?: string | null
          new_fee_source?: string | null
          new_price_source?: string | null
          new_profit?: number | null
          new_total_fees?: number | null
          new_unit_price?: number | null
          order_id?: string
          previous_fee_source?: string | null
          previous_price_source?: string | null
          previous_profit?: number | null
          previous_total_fees?: number | null
          previous_unit_price?: number | null
          profit_delta?: number | null
          revenue_delta?: number | null
          sku?: string | null
          sync_trace_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      sales_orders: {
        Row: {
          asin: string
          asin_source: string | null
          bb_estimate_buybox_is_fba: boolean | null
          bb_estimate_captured_at: string | null
          bb_estimate_marketplace: string | null
          bb_estimate_owner_match: boolean | null
          bb_estimate_price: number | null
          bb_estimate_qualified: boolean | null
          bb_estimate_snapshot_age_seconds: number | null
          bb_estimate_snapshot_fetched_at: string | null
          bb_estimate_snapshot_id: string | null
          buyer_email: string | null
          buyer_id: string | null
          buyer_name: string | null
          cancelled_at: string | null
          closing_fee: number | null
          cost_invalid: boolean
          cost_locked: boolean
          cost_locked_at: string | null
          cost_source_at_sale: string | null
          created_at: string
          customer_key: string | null
          enrich_attempts: number | null
          estimated_price: number | null
          fba_fee: number | null
          fec_refund_key: string | null
          fees_invalid: boolean
          fees_missing: boolean | null
          fees_source: string | null
          fulfillment_channel: string | null
          id: string
          image_url: string | null
          is_cancelled: boolean | null
          is_multi_item_order: boolean | null
          is_replacement: boolean
          item_price: number | null
          last_enrich_at: string | null
          last_enrich_attempt_at: string | null
          last_enrich_error: string | null
          last_status_sync_at: string | null
          locked_est_price: number | null
          locked_from: string | null
          marketplace: string | null
          needs_fee_enrich: boolean | null
          needs_price_enrich: boolean | null
          next_enrich_after: string | null
          order_date: string
          order_id: string
          order_status: string | null
          order_type: string | null
          pending_enrich_attempts: number | null
          pending_enrich_last_attempt_at: string | null
          pending_enrich_last_error: string | null
          price_attempt_count: number | null
          price_calc_mode: string | null
          price_confidence: string | null
          price_enrich_status: string | null
          price_last_attempt_at: string | null
          price_last_error: string | null
          price_locked_at: string | null
          price_source: string | null
          promotion_discount: number | null
          promotion_discount_captured_at: string | null
          promotion_discount_currency: string | null
          promotion_discount_native: number | null
          promotion_discount_source: string | null
          purchase_timestamp_utc: string | null
          quantity: number
          referral_fee: number | null
          refund_amount: number | null
          refund_quantity: number | null
          related_order_id: string | null
          replacement_reason: string | null
          roi: number | null
          roi_source: string | null
          seller_sku: string | null
          settlement_date: string | null
          ship_to_hash: string | null
          shipping_label_fee: number | null
          shipping_label_fee_last_polled_at: string | null
          shipping_label_fee_poll_attempts: number
          shipping_label_fee_source: string | null
          shipping_label_fee_synced_at: string | null
          shipping_price: number | null
          sku: string | null
          sold_price: number
          status: string | null
          status_source: string | null
          sync_trace_id: string | null
          title: string | null
          total_cost: number | null
          total_fees: number | null
          total_sale_amount: number
          unit_cost: number | null
          unit_cost_at_sale: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          asin_source?: string | null
          bb_estimate_buybox_is_fba?: boolean | null
          bb_estimate_captured_at?: string | null
          bb_estimate_marketplace?: string | null
          bb_estimate_owner_match?: boolean | null
          bb_estimate_price?: number | null
          bb_estimate_qualified?: boolean | null
          bb_estimate_snapshot_age_seconds?: number | null
          bb_estimate_snapshot_fetched_at?: string | null
          bb_estimate_snapshot_id?: string | null
          buyer_email?: string | null
          buyer_id?: string | null
          buyer_name?: string | null
          cancelled_at?: string | null
          closing_fee?: number | null
          cost_invalid?: boolean
          cost_locked?: boolean
          cost_locked_at?: string | null
          cost_source_at_sale?: string | null
          created_at?: string
          customer_key?: string | null
          enrich_attempts?: number | null
          estimated_price?: number | null
          fba_fee?: number | null
          fec_refund_key?: string | null
          fees_invalid?: boolean
          fees_missing?: boolean | null
          fees_source?: string | null
          fulfillment_channel?: string | null
          id?: string
          image_url?: string | null
          is_cancelled?: boolean | null
          is_multi_item_order?: boolean | null
          is_replacement?: boolean
          item_price?: number | null
          last_enrich_at?: string | null
          last_enrich_attempt_at?: string | null
          last_enrich_error?: string | null
          last_status_sync_at?: string | null
          locked_est_price?: number | null
          locked_from?: string | null
          marketplace?: string | null
          needs_fee_enrich?: boolean | null
          needs_price_enrich?: boolean | null
          next_enrich_after?: string | null
          order_date: string
          order_id: string
          order_status?: string | null
          order_type?: string | null
          pending_enrich_attempts?: number | null
          pending_enrich_last_attempt_at?: string | null
          pending_enrich_last_error?: string | null
          price_attempt_count?: number | null
          price_calc_mode?: string | null
          price_confidence?: string | null
          price_enrich_status?: string | null
          price_last_attempt_at?: string | null
          price_last_error?: string | null
          price_locked_at?: string | null
          price_source?: string | null
          promotion_discount?: number | null
          promotion_discount_captured_at?: string | null
          promotion_discount_currency?: string | null
          promotion_discount_native?: number | null
          promotion_discount_source?: string | null
          purchase_timestamp_utc?: string | null
          quantity?: number
          referral_fee?: number | null
          refund_amount?: number | null
          refund_quantity?: number | null
          related_order_id?: string | null
          replacement_reason?: string | null
          roi?: number | null
          roi_source?: string | null
          seller_sku?: string | null
          settlement_date?: string | null
          ship_to_hash?: string | null
          shipping_label_fee?: number | null
          shipping_label_fee_last_polled_at?: string | null
          shipping_label_fee_poll_attempts?: number
          shipping_label_fee_source?: string | null
          shipping_label_fee_synced_at?: string | null
          shipping_price?: number | null
          sku?: string | null
          sold_price: number
          status?: string | null
          status_source?: string | null
          sync_trace_id?: string | null
          title?: string | null
          total_cost?: number | null
          total_fees?: number | null
          total_sale_amount: number
          unit_cost?: number | null
          unit_cost_at_sale?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          asin_source?: string | null
          bb_estimate_buybox_is_fba?: boolean | null
          bb_estimate_captured_at?: string | null
          bb_estimate_marketplace?: string | null
          bb_estimate_owner_match?: boolean | null
          bb_estimate_price?: number | null
          bb_estimate_qualified?: boolean | null
          bb_estimate_snapshot_age_seconds?: number | null
          bb_estimate_snapshot_fetched_at?: string | null
          bb_estimate_snapshot_id?: string | null
          buyer_email?: string | null
          buyer_id?: string | null
          buyer_name?: string | null
          cancelled_at?: string | null
          closing_fee?: number | null
          cost_invalid?: boolean
          cost_locked?: boolean
          cost_locked_at?: string | null
          cost_source_at_sale?: string | null
          created_at?: string
          customer_key?: string | null
          enrich_attempts?: number | null
          estimated_price?: number | null
          fba_fee?: number | null
          fec_refund_key?: string | null
          fees_invalid?: boolean
          fees_missing?: boolean | null
          fees_source?: string | null
          fulfillment_channel?: string | null
          id?: string
          image_url?: string | null
          is_cancelled?: boolean | null
          is_multi_item_order?: boolean | null
          is_replacement?: boolean
          item_price?: number | null
          last_enrich_at?: string | null
          last_enrich_attempt_at?: string | null
          last_enrich_error?: string | null
          last_status_sync_at?: string | null
          locked_est_price?: number | null
          locked_from?: string | null
          marketplace?: string | null
          needs_fee_enrich?: boolean | null
          needs_price_enrich?: boolean | null
          next_enrich_after?: string | null
          order_date?: string
          order_id?: string
          order_status?: string | null
          order_type?: string | null
          pending_enrich_attempts?: number | null
          pending_enrich_last_attempt_at?: string | null
          pending_enrich_last_error?: string | null
          price_attempt_count?: number | null
          price_calc_mode?: string | null
          price_confidence?: string | null
          price_enrich_status?: string | null
          price_last_attempt_at?: string | null
          price_last_error?: string | null
          price_locked_at?: string | null
          price_source?: string | null
          promotion_discount?: number | null
          promotion_discount_captured_at?: string | null
          promotion_discount_currency?: string | null
          promotion_discount_native?: number | null
          promotion_discount_source?: string | null
          purchase_timestamp_utc?: string | null
          quantity?: number
          referral_fee?: number | null
          refund_amount?: number | null
          refund_quantity?: number | null
          related_order_id?: string | null
          replacement_reason?: string | null
          roi?: number | null
          roi_source?: string | null
          seller_sku?: string | null
          settlement_date?: string | null
          ship_to_hash?: string | null
          shipping_label_fee?: number | null
          shipping_label_fee_last_polled_at?: string | null
          shipping_label_fee_poll_attempts?: number
          shipping_label_fee_source?: string | null
          shipping_label_fee_synced_at?: string | null
          shipping_price?: number | null
          sku?: string | null
          sold_price?: number
          status?: string | null
          status_source?: string | null
          sync_trace_id?: string | null
          title?: string | null
          total_cost?: number | null
          total_fees?: number | null
          total_sale_amount?: number
          unit_cost?: number | null
          unit_cost_at_sale?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sales_period_totals_cache: {
        Row: {
          amazon_fees_total: number
          closing_fee_total: number
          cogs_total: number
          created_at: string
          date_end: string
          date_start: string
          fba_fee_total: number
          gross_profit: number
          hide_deferred: boolean
          id: string
          include_settled: boolean
          marketplace_id: string
          net_profit: number
          referral_fee_total: number
          refund_cost_total: number
          row_count: number
          sales_total: number
          seller_id: string
          timezone_cutoff: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amazon_fees_total?: number
          closing_fee_total?: number
          cogs_total?: number
          created_at?: string
          date_end: string
          date_start: string
          fba_fee_total?: number
          gross_profit?: number
          hide_deferred?: boolean
          id?: string
          include_settled?: boolean
          marketplace_id?: string
          net_profit?: number
          referral_fee_total?: number
          refund_cost_total?: number
          row_count?: number
          sales_total?: number
          seller_id: string
          timezone_cutoff?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amazon_fees_total?: number
          closing_fee_total?: number
          cogs_total?: number
          created_at?: string
          date_end?: string
          date_start?: string
          fba_fee_total?: number
          gross_profit?: number
          hide_deferred?: boolean
          id?: string
          include_settled?: boolean
          marketplace_id?: string
          net_profit?: number
          referral_fee_total?: number
          refund_cost_total?: number
          row_count?: number
          sales_total?: number
          seller_id?: string
          timezone_cutoff?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sales_reconciliation_audit: {
        Row: {
          asin: string | null
          correction_type: string
          created_at: string
          fec_event_date: string | null
          fec_settled_amount: number | null
          id: string
          new_price_source: string | null
          new_sold_price: number | null
          new_total_sale_amount: number | null
          order_id: string
          previous_price_source: string | null
          previous_sold_price: number | null
          previous_total_sale_amount: number | null
          quantity: number | null
          reconciliation_run_id: string
          seller_sku: string | null
          user_id: string
        }
        Insert: {
          asin?: string | null
          correction_type: string
          created_at?: string
          fec_event_date?: string | null
          fec_settled_amount?: number | null
          id?: string
          new_price_source?: string | null
          new_sold_price?: number | null
          new_total_sale_amount?: number | null
          order_id: string
          previous_price_source?: string | null
          previous_sold_price?: number | null
          previous_total_sale_amount?: number | null
          quantity?: number | null
          reconciliation_run_id: string
          seller_sku?: string | null
          user_id: string
        }
        Update: {
          asin?: string | null
          correction_type?: string
          created_at?: string
          fec_event_date?: string | null
          fec_settled_amount?: number | null
          id?: string
          new_price_source?: string | null
          new_sold_price?: number | null
          new_total_sale_amount?: number | null
          order_id?: string
          previous_price_source?: string | null
          previous_sold_price?: number | null
          previous_total_sale_amount?: number | null
          quantity?: number | null
          reconciliation_run_id?: string
          seller_sku?: string | null
          user_id?: string
        }
        Relationships: []
      }
      sales_sync_state: {
        Row: {
          backfill_complete: boolean | null
          backfill_cursor_date: string | null
          created_at: string | null
          historical_sync_in_progress: boolean | null
          historical_sync_progress: string | null
          historical_sync_started_at: string | null
          last_backfill_stats: Json | null
          last_events_sync_at: string | null
          last_orders_sync_at: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          backfill_complete?: boolean | null
          backfill_cursor_date?: string | null
          created_at?: string | null
          historical_sync_in_progress?: boolean | null
          historical_sync_progress?: string | null
          historical_sync_started_at?: string | null
          last_backfill_stats?: Json | null
          last_events_sync_at?: string | null
          last_orders_sync_at?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          backfill_complete?: boolean | null
          backfill_cursor_date?: string | null
          created_at?: string | null
          historical_sync_in_progress?: boolean | null
          historical_sync_progress?: string | null
          historical_sync_started_at?: string | null
          last_backfill_stats?: Json | null
          last_events_sync_at?: string | null
          last_orders_sync_at?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      saved_sources: {
        Row: {
          asin: string
          candidate_id: string | null
          created_at: string
          currency: string | null
          domain: string | null
          id: string
          is_preferred: boolean
          is_trusted: boolean
          last_checked_at: string | null
          last_confidence: number | null
          last_resolution: string | null
          last_status: string | null
          manual_cost: number | null
          manual_cost_currency: string | null
          manual_cost_note: string | null
          notes: string | null
          price: number | null
          run_id: string | null
          source_image: string | null
          source_title: string | null
          source_url: string
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          candidate_id?: string | null
          created_at?: string
          currency?: string | null
          domain?: string | null
          id?: string
          is_preferred?: boolean
          is_trusted?: boolean
          last_checked_at?: string | null
          last_confidence?: number | null
          last_resolution?: string | null
          last_status?: string | null
          manual_cost?: number | null
          manual_cost_currency?: string | null
          manual_cost_note?: string | null
          notes?: string | null
          price?: number | null
          run_id?: string | null
          source_image?: string | null
          source_title?: string | null
          source_url: string
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          candidate_id?: string | null
          created_at?: string
          currency?: string | null
          domain?: string | null
          id?: string
          is_preferred?: boolean
          is_trusted?: boolean
          last_checked_at?: string | null
          last_confidence?: number | null
          last_resolution?: string | null
          last_status?: string | null
          manual_cost?: number | null
          manual_cost_currency?: string | null
          manual_cost_note?: string | null
          notes?: string | null
          price?: number | null
          run_id?: string | null
          source_image?: string | null
          source_title?: string | null
          source_url?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scan_categories: {
        Row: {
          created_at: string
          created_by: string
          detected_from_url: string | null
          detection_confidence: string | null
          detection_path: string | null
          detection_source: string | null
          id: string
          is_active: boolean
          last_scanned_at: string | null
          last_successful_scan_at: string | null
          name: string
          next_scan_due_at: string | null
          scan_tier: string
          supplier_domain: string
          updated_at: string
          urls: string[]
        }
        Insert: {
          created_at?: string
          created_by: string
          detected_from_url?: string | null
          detection_confidence?: string | null
          detection_path?: string | null
          detection_source?: string | null
          id?: string
          is_active?: boolean
          last_scanned_at?: string | null
          last_successful_scan_at?: string | null
          name: string
          next_scan_due_at?: string | null
          scan_tier?: string
          supplier_domain: string
          updated_at?: string
          urls?: string[]
        }
        Update: {
          created_at?: string
          created_by?: string
          detected_from_url?: string | null
          detection_confidence?: string | null
          detection_path?: string | null
          detection_source?: string | null
          id?: string
          is_active?: boolean
          last_scanned_at?: string | null
          last_successful_scan_at?: string | null
          name?: string
          next_scan_due_at?: string | null
          scan_tier?: string
          supplier_domain?: string
          updated_at?: string
          urls?: string[]
        }
        Relationships: []
      }
      scrape_cache: {
        Row: {
          cached_at: string
          query: string
          results: Json
        }
        Insert: {
          cached_at?: string
          query: string
          results: Json
        }
        Update: {
          cached_at?: string
          query?: string
          results?: Json
        }
        Relationships: []
      }
      scrape_logs: {
        Row: {
          asin: string | null
          error: string | null
          finished_at: string | null
          id: string
          mode: string
          query: string
          result_count: number | null
          started_at: string
          status: string
        }
        Insert: {
          asin?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          mode: string
          query: string
          result_count?: number | null
          started_at?: string
          status: string
        }
        Update: {
          asin?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          mode?: string
          query?: string
          result_count?: number | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      scrape_state: {
        Row: {
          blocked_until: string | null
          key: string
          updated_at: string
        }
        Insert: {
          blocked_until?: string | null
          key: string
          updated_at?: string
        }
        Update: {
          blocked_until?: string | null
          key?: string
          updated_at?: string
        }
        Relationships: []
      }
      search_api_daily_usage: {
        Row: {
          call_count: number
          empty_count: number
          error_count: number
          last_error_at: string | null
          last_error_status: number | null
          provider: string
          updated_at: string
          usage_date: string
        }
        Insert: {
          call_count?: number
          empty_count?: number
          error_count?: number
          last_error_at?: string | null
          last_error_status?: number | null
          provider: string
          updated_at?: string
          usage_date?: string
        }
        Update: {
          call_count?: number
          empty_count?: number
          error_count?: number
          last_error_at?: string | null
          last_error_status?: number | null
          provider?: string
          updated_at?: string
          usage_date?: string
        }
        Relationships: []
      }
      seller_authorizations: {
        Row: {
          access_token: string | null
          created_at: string
          deactivated_at: string | null
          deactivation_reason: string | null
          id: string
          is_active: boolean
          marketplace_id: string
          mws_auth_token: string | null
          refresh_token: string
          seller_id: string
          selling_partner_id: string | null
          token_expires_at: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          access_token?: string | null
          created_at?: string
          deactivated_at?: string | null
          deactivation_reason?: string | null
          id?: string
          is_active?: boolean
          marketplace_id: string
          mws_auth_token?: string | null
          refresh_token: string
          seller_id: string
          selling_partner_id?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          access_token?: string | null
          created_at?: string
          deactivated_at?: string | null
          deactivation_reason?: string | null
          id?: string
          is_active?: boolean
          marketplace_id?: string
          mws_auth_token?: string | null
          refresh_token?: string
          seller_id?: string
          selling_partner_id?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      seller_storefront_cache: {
        Row: {
          asin_list: Json
          created_at: string
          fetched_at: string
          id: string
          marketplace: string
          seller_id: string
          store: Json
          top_brands: Json
          top_categories: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          asin_list?: Json
          created_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          seller_id: string
          store: Json
          top_brands?: Json
          top_categories?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          asin_list?: Json
          created_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          seller_id?: string
          store?: Json
          top_brands?: Json
          top_categories?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      seller_storefront_page_cache: {
        Row: {
          created_at: string
          fetched_at: string
          id: string
          marketplace: string
          page: number
          page_items: Json
          page_size: number
          seller_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          page: number
          page_items?: Json
          page_size: number
          seller_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          fetched_at?: string
          id?: string
          marketplace?: string
          page?: number
          page_items?: Json
          page_size?: number
          seller_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      seller_watch_new_listings: {
        Row: {
          amazon_price_cents: number | null
          asin: string
          brand: string | null
          candidates: Json | null
          created_at: string
          detected_at: string
          disqualified_reason: string | null
          fba_fee_cents: number | null
          fba_offer_count: number | null
          fbm_offer_count: number | null
          fees_captured_at: string | null
          id: string
          image_url: string | null
          last_searched_at: string | null
          marketplace: string
          new_price_cents: number | null
          offers_captured_at: string | null
          price_captured_at: string | null
          product_group: string | null
          qualified: boolean | null
          referral_fee_cents: number | null
          rejected_candidate_urls: Json
          sales_rank: number | null
          seller_id: string
          seller_offer_is_fba: boolean | null
          source_status: string
          sourced_at: string | null
          sourced_candidate: Json | null
          strict_reason: string | null
          title: string | null
          total_fees_cents: number | null
          upc: string | null
          user_id: string
          watch_id: string
        }
        Insert: {
          amazon_price_cents?: number | null
          asin: string
          brand?: string | null
          candidates?: Json | null
          created_at?: string
          detected_at?: string
          disqualified_reason?: string | null
          fba_fee_cents?: number | null
          fba_offer_count?: number | null
          fbm_offer_count?: number | null
          fees_captured_at?: string | null
          id?: string
          image_url?: string | null
          last_searched_at?: string | null
          marketplace?: string
          new_price_cents?: number | null
          offers_captured_at?: string | null
          price_captured_at?: string | null
          product_group?: string | null
          qualified?: boolean | null
          referral_fee_cents?: number | null
          rejected_candidate_urls?: Json
          sales_rank?: number | null
          seller_id: string
          seller_offer_is_fba?: boolean | null
          source_status?: string
          sourced_at?: string | null
          sourced_candidate?: Json | null
          strict_reason?: string | null
          title?: string | null
          total_fees_cents?: number | null
          upc?: string | null
          user_id: string
          watch_id: string
        }
        Update: {
          amazon_price_cents?: number | null
          asin?: string
          brand?: string | null
          candidates?: Json | null
          created_at?: string
          detected_at?: string
          disqualified_reason?: string | null
          fba_fee_cents?: number | null
          fba_offer_count?: number | null
          fbm_offer_count?: number | null
          fees_captured_at?: string | null
          id?: string
          image_url?: string | null
          last_searched_at?: string | null
          marketplace?: string
          new_price_cents?: number | null
          offers_captured_at?: string | null
          price_captured_at?: string | null
          product_group?: string | null
          qualified?: boolean | null
          referral_fee_cents?: number | null
          rejected_candidate_urls?: Json
          sales_rank?: number | null
          seller_id?: string
          seller_offer_is_fba?: boolean | null
          source_status?: string
          sourced_at?: string | null
          sourced_candidate?: Json | null
          strict_reason?: string | null
          title?: string | null
          total_fees_cents?: number | null
          upc?: string | null
          user_id?: string
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seller_watch_new_listings_watch_id_fkey"
            columns: ["watch_id"]
            isOneToOne: false
            referencedRelation: "seller_watchlist"
            referencedColumns: ["id"]
          },
        ]
      }
      seller_watchlist: {
        Row: {
          cancelled_at: string | null
          confirmed_at: string | null
          created_at: string
          id: string
          known_asin_list: Json | null
          last_alert_at: string | null
          last_checked_at: string | null
          marketplace: string
          notify_email: string
          seller_id: string
          seller_name: string | null
          status: string
          user_id: string
        }
        Insert: {
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          id?: string
          known_asin_list?: Json | null
          last_alert_at?: string | null
          last_checked_at?: string | null
          marketplace?: string
          notify_email: string
          seller_id: string
          seller_name?: string | null
          status?: string
          user_id: string
        }
        Update: {
          cancelled_at?: string | null
          confirmed_at?: string | null
          created_at?: string
          id?: string
          known_asin_list?: Json | null
          last_alert_at?: string | null
          last_checked_at?: string | null
          marketplace?: string
          notify_email?: string
          seller_id?: string
          seller_name?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      settlement_category_totals: {
        Row: {
          category: string
          created_at: string
          id: string
          last_recomputed_at: string
          marketplace: string
          period_month: number
          period_year: number
          row_count: number
          total_amount: number
          updated_at: string
          user_id: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          last_recomputed_at?: string
          marketplace?: string
          period_month: number
          period_year: number
          row_count?: number
          total_amount?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          last_recomputed_at?: string
          marketplace?: string
          period_month?: number
          period_year?: number
          row_count?: number
          total_amount?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      settlement_line_items: {
        Row: {
          amazon_report_id: string
          amount: number | null
          amount_description: string | null
          amount_type: string | null
          asin: string | null
          category: string | null
          created_at: string
          fee_type: string | null
          fulfillment_id: string | null
          id: string
          marketplace_name: string | null
          order_id: string | null
          posted_date: string | null
          quantity_purchased: number | null
          raw_row: Json | null
          settlement_report_id: string
          shipment_id: string | null
          sku: string | null
          transaction_type: string | null
          user_id: string
        }
        Insert: {
          amazon_report_id: string
          amount?: number | null
          amount_description?: string | null
          amount_type?: string | null
          asin?: string | null
          category?: string | null
          created_at?: string
          fee_type?: string | null
          fulfillment_id?: string | null
          id?: string
          marketplace_name?: string | null
          order_id?: string | null
          posted_date?: string | null
          quantity_purchased?: number | null
          raw_row?: Json | null
          settlement_report_id: string
          shipment_id?: string | null
          sku?: string | null
          transaction_type?: string | null
          user_id: string
        }
        Update: {
          amazon_report_id?: string
          amount?: number | null
          amount_description?: string | null
          amount_type?: string | null
          asin?: string | null
          category?: string | null
          created_at?: string
          fee_type?: string | null
          fulfillment_id?: string | null
          id?: string
          marketplace_name?: string | null
          order_id?: string | null
          posted_date?: string | null
          quantity_purchased?: number | null
          raw_row?: Json | null
          settlement_report_id?: string
          shipment_id?: string | null
          sku?: string | null
          transaction_type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "settlement_line_items_settlement_report_id_fkey"
            columns: ["settlement_report_id"]
            isOneToOne: false
            referencedRelation: "settlement_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      settlement_reports: {
        Row: {
          amazon_report_document_id: string | null
          amazon_report_id: string
          created_at: string
          currency: string | null
          deposit_date: string | null
          error_message: string | null
          id: string
          marketplace: string | null
          marketplace_id: string | null
          parsed_at: string | null
          raw_metadata: Json | null
          rows_parsed: number | null
          settlement_end_date: string | null
          settlement_id: string | null
          settlement_start_date: string | null
          status: string
          total_amount: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amazon_report_document_id?: string | null
          amazon_report_id: string
          created_at?: string
          currency?: string | null
          deposit_date?: string | null
          error_message?: string | null
          id?: string
          marketplace?: string | null
          marketplace_id?: string | null
          parsed_at?: string | null
          raw_metadata?: Json | null
          rows_parsed?: number | null
          settlement_end_date?: string | null
          settlement_id?: string | null
          settlement_start_date?: string | null
          status?: string
          total_amount?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amazon_report_document_id?: string | null
          amazon_report_id?: string
          created_at?: string
          currency?: string | null
          deposit_date?: string | null
          error_message?: string | null
          id?: string
          marketplace?: string | null
          marketplace_id?: string | null
          parsed_at?: string | null
          raw_metadata?: Json | null
          rows_parsed?: number | null
          settlement_end_date?: string | null
          settlement_id?: string | null
          settlement_start_date?: string | null
          status?: string
          total_amount?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      shipment_backfill_progress: {
        Row: {
          backfill_year: number
          completed_at: string | null
          created_at: string
          id: string
          items_upserted: number
          last_error: string | null
          next_page: number
          next_token: string | null
          pages_processed: number
          shipment_status: string
          shipments_found: number
          shipments_upserted: number
          started_at: string | null
          state: string
          updated_at: string
          user_id: string
          window_end: string
          window_start: string
        }
        Insert: {
          backfill_year: number
          completed_at?: string | null
          created_at?: string
          id?: string
          items_upserted?: number
          last_error?: string | null
          next_page?: number
          next_token?: string | null
          pages_processed?: number
          shipment_status: string
          shipments_found?: number
          shipments_upserted?: number
          started_at?: string | null
          state?: string
          updated_at?: string
          user_id: string
          window_end: string
          window_start: string
        }
        Update: {
          backfill_year?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          items_upserted?: number
          last_error?: string | null
          next_page?: number
          next_token?: string | null
          pages_processed?: number
          shipment_status?: string
          shipments_found?: number
          shipments_upserted?: number
          started_at?: string | null
          state?: string
          updated_at?: string
          user_id?: string
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      shipment_box_defaults: {
        Row: {
          created_at: string
          dimension_unit: string
          height: number
          length: number
          updated_at: string
          user_id: string
          weight: number
          weight_unit: string
          width: number
        }
        Insert: {
          created_at?: string
          dimension_unit?: string
          height?: number
          length?: number
          updated_at?: string
          user_id: string
          weight?: number
          weight_unit?: string
          width?: number
        }
        Update: {
          created_at?: string
          dimension_unit?: string
          height?: number
          length?: number
          updated_at?: string
          user_id?: string
          weight?: number
          weight_unit?: string
          width?: number
        }
        Relationships: []
      }
      shipment_builder_drafts: {
        Row: {
          amazon_operation_id: string | null
          amazon_plan_status: string | null
          amazon_shipment_id: string | null
          archived_at: string | null
          completed_at: string | null
          continued_to_amazon_at: string | null
          created_at: string
          creation_mode: string
          draft_id: string
          id: string
          inbound_plan_id: string | null
          note: string
          payload: Json
          placement_option_id: string | null
          shipment_name: string
          status: string
          step: number
          synced_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amazon_operation_id?: string | null
          amazon_plan_status?: string | null
          amazon_shipment_id?: string | null
          archived_at?: string | null
          completed_at?: string | null
          continued_to_amazon_at?: string | null
          created_at?: string
          creation_mode?: string
          draft_id: string
          id?: string
          inbound_plan_id?: string | null
          note?: string
          payload?: Json
          placement_option_id?: string | null
          shipment_name?: string
          status?: string
          step?: number
          synced_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amazon_operation_id?: string | null
          amazon_plan_status?: string | null
          amazon_shipment_id?: string | null
          archived_at?: string | null
          completed_at?: string | null
          continued_to_amazon_at?: string | null
          created_at?: string
          creation_mode?: string
          draft_id?: string
          id?: string
          inbound_plan_id?: string | null
          note?: string
          payload?: Json
          placement_option_id?: string | null
          shipment_name?: string
          status?: string
          step?: number
          synced_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      shipment_costs: {
        Row: {
          amount: number
          cost_date: string
          created_at: string
          id: string
          note: string | null
          shipment_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          cost_date?: string
          created_at?: string
          id?: string
          note?: string | null
          shipment_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          cost_date?: string
          created_at?: string
          id?: string
          note?: string | null
          shipment_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      shipment_outcomes: {
        Row: {
          actual_placement_fees: number | null
          amazon_split_count: number | null
          box_count: number | null
          business_mode: string | null
          captured_at: string
          draft_id: string | null
          id: string
          identical_pct: number | null
          max_delta_lb: number | null
          metadata: Json
          notes: string | null
          placement_risk: boolean | null
          sku_count: number | null
          split_risk: boolean | null
          total_units: number | null
          updated_at: string
          user_id: string
          variance_pct: number | null
          weight_warn: boolean | null
        }
        Insert: {
          actual_placement_fees?: number | null
          amazon_split_count?: number | null
          box_count?: number | null
          business_mode?: string | null
          captured_at?: string
          draft_id?: string | null
          id?: string
          identical_pct?: number | null
          max_delta_lb?: number | null
          metadata?: Json
          notes?: string | null
          placement_risk?: boolean | null
          sku_count?: number | null
          split_risk?: boolean | null
          total_units?: number | null
          updated_at?: string
          user_id: string
          variance_pct?: number | null
          weight_warn?: boolean | null
        }
        Update: {
          actual_placement_fees?: number | null
          amazon_split_count?: number | null
          box_count?: number | null
          business_mode?: string | null
          captured_at?: string
          draft_id?: string | null
          id?: string
          identical_pct?: number | null
          max_delta_lb?: number | null
          metadata?: Json
          notes?: string | null
          placement_risk?: boolean | null
          sku_count?: number | null
          split_risk?: boolean | null
          total_units?: number | null
          updated_at?: string
          user_id?: string
          variance_pct?: number | null
          weight_warn?: boolean | null
        }
        Relationships: []
      }
      shipment_purchase_allocations: {
        Row: {
          asin: string
          created_at: string
          created_listing_id: string
          draft_id: string
          id: string
          notes: string | null
          shipment_id: string | null
          sku: string | null
          units_allocated: number
          units_shipped: number
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          created_at?: string
          created_listing_id: string
          draft_id: string
          id?: string
          notes?: string | null
          shipment_id?: string | null
          sku?: string | null
          units_allocated?: number
          units_shipped?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          created_at?: string
          created_listing_id?: string
          draft_id?: string
          id?: string
          notes?: string | null
          shipment_id?: string | null
          sku?: string | null
          units_allocated?: number
          units_shipped?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_purchase_allocations_created_listing_id_fkey"
            columns: ["created_listing_id"]
            isOneToOne: false
            referencedRelation: "active_created_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_purchase_allocations_created_listing_id_fkey"
            columns: ["created_listing_id"]
            isOneToOne: false
            referencedRelation: "created_listings"
            referencedColumns: ["id"]
          },
        ]
      }
      smart_engine_activity_events: {
        Row: {
          action_type: string | null
          asin: string
          buy_box_price: number | null
          confidence_score: number | null
          constraints_json: Json | null
          created_at: string
          current_price: number | null
          decision_label: string | null
          engine_mode: string | null
          event_type: string
          id: string
          lowest_fba_price: number | null
          marketplace: string
          max_price: number | null
          min_price: number | null
          next_competitor_price: number | null
          profit_floor: number | null
          sku: string | null
          snapshot_json: Json | null
          target_price: number | null
          tuning_signal: string | null
          user_id: string
          was_bb_owner: boolean | null
          was_price_changed: boolean | null
        }
        Insert: {
          action_type?: string | null
          asin: string
          buy_box_price?: number | null
          confidence_score?: number | null
          constraints_json?: Json | null
          created_at?: string
          current_price?: number | null
          decision_label?: string | null
          engine_mode?: string | null
          event_type: string
          id?: string
          lowest_fba_price?: number | null
          marketplace?: string
          max_price?: number | null
          min_price?: number | null
          next_competitor_price?: number | null
          profit_floor?: number | null
          sku?: string | null
          snapshot_json?: Json | null
          target_price?: number | null
          tuning_signal?: string | null
          user_id: string
          was_bb_owner?: boolean | null
          was_price_changed?: boolean | null
        }
        Update: {
          action_type?: string | null
          asin?: string
          buy_box_price?: number | null
          confidence_score?: number | null
          constraints_json?: Json | null
          created_at?: string
          current_price?: number | null
          decision_label?: string | null
          engine_mode?: string | null
          event_type?: string
          id?: string
          lowest_fba_price?: number | null
          marketplace?: string
          max_price?: number | null
          min_price?: number | null
          next_competitor_price?: number | null
          profit_floor?: number | null
          sku?: string | null
          snapshot_json?: Json | null
          target_price?: number | null
          tuning_signal?: string | null
          user_id?: string
          was_bb_owner?: boolean | null
          was_price_changed?: boolean | null
        }
        Relationships: []
      }
      smart_engine_ai_review_batches: {
        Row: {
          ai_model: string | null
          ai_summary: string | null
          created_at: string
          flash_count: number
          id: string
          pro_count: number
          prompt_version: string | null
          recommendation_count: number | null
          selected_case_count: number
          selection_strategy: string | null
          skip_count: number
          source_window: string | null
          token_estimate: number | null
          total_signals_seen: number | null
          user_id: string
        }
        Insert: {
          ai_model?: string | null
          ai_summary?: string | null
          created_at?: string
          flash_count?: number
          id?: string
          pro_count?: number
          prompt_version?: string | null
          recommendation_count?: number | null
          selected_case_count?: number
          selection_strategy?: string | null
          skip_count?: number
          source_window?: string | null
          token_estimate?: number | null
          total_signals_seen?: number | null
          user_id: string
        }
        Update: {
          ai_model?: string | null
          ai_summary?: string | null
          created_at?: string
          flash_count?: number
          id?: string
          pro_count?: number
          prompt_version?: string | null
          recommendation_count?: number | null
          selected_case_count?: number
          selection_strategy?: string | null
          skip_count?: number
          source_window?: string | null
          token_estimate?: number | null
          total_signals_seen?: number | null
          user_id?: string
        }
        Relationships: []
      }
      smart_engine_ai_reviews: {
        Row: {
          accepted_status: string | null
          ai_confidence: string | null
          ai_judgment: string | null
          ai_reasoning_summary: string | null
          ai_tuning_suggestion: string | null
          asin: string
          batch_id: string | null
          constraints_json: Json | null
          created_at: string
          decision_label: string | null
          escalation_reasons: string[] | null
          event_type: string | null
          id: string
          marketplace: string
          model_tier: string | null
          model_used: string | null
          pricing_context: Json | null
          prompt_version: string | null
          selection_reason: string | null
          sku: string | null
          user_id: string
        }
        Insert: {
          accepted_status?: string | null
          ai_confidence?: string | null
          ai_judgment?: string | null
          ai_reasoning_summary?: string | null
          ai_tuning_suggestion?: string | null
          asin: string
          batch_id?: string | null
          constraints_json?: Json | null
          created_at?: string
          decision_label?: string | null
          escalation_reasons?: string[] | null
          event_type?: string | null
          id?: string
          marketplace?: string
          model_tier?: string | null
          model_used?: string | null
          pricing_context?: Json | null
          prompt_version?: string | null
          selection_reason?: string | null
          sku?: string | null
          user_id: string
        }
        Update: {
          accepted_status?: string | null
          ai_confidence?: string | null
          ai_judgment?: string | null
          ai_reasoning_summary?: string | null
          ai_tuning_suggestion?: string | null
          asin?: string
          batch_id?: string | null
          constraints_json?: Json | null
          created_at?: string
          decision_label?: string | null
          escalation_reasons?: string[] | null
          event_type?: string | null
          id?: string
          marketplace?: string
          model_tier?: string | null
          model_used?: string | null
          pricing_context?: Json | null
          prompt_version?: string | null
          selection_reason?: string | null
          sku?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "smart_engine_ai_reviews_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "smart_engine_ai_review_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      smart_engine_cron_runs: {
        Row: {
          actions_scanned: number | null
          created_at: string
          duration_ms: number | null
          error_sample: string | null
          errors_count: number | null
          finished_at: string | null
          id: string
          job_name: string
          payload: Json | null
          snapshots_inserted: number | null
          snapshots_skipped: number | null
          started_at: string
          status: string
        }
        Insert: {
          actions_scanned?: number | null
          created_at?: string
          duration_ms?: number | null
          error_sample?: string | null
          errors_count?: number | null
          finished_at?: string | null
          id?: string
          job_name: string
          payload?: Json | null
          snapshots_inserted?: number | null
          snapshots_skipped?: number | null
          started_at?: string
          status?: string
        }
        Update: {
          actions_scanned?: number | null
          created_at?: string
          duration_ms?: number | null
          error_sample?: string | null
          errors_count?: number | null
          finished_at?: string | null
          id?: string
          job_name?: string
          payload?: Json | null
          snapshots_inserted?: number | null
          snapshots_skipped?: number | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      smart_engine_learning_signals: {
        Row: {
          affected_asin_count: number
          avg_bb_gap: number | null
          avg_days_of_stock: number | null
          avg_margin_gap: number | null
          confidence_score: number | null
          created_at: string
          first_seen_at: string
          id: string
          last_seen_at: string
          marketplace: string
          metadata_json: Json | null
          notes: string | null
          occurrence_count: number
          recommendation_status: string
          signal_key: string
          signal_label: string
          updated_at: string
          user_id: string
        }
        Insert: {
          affected_asin_count?: number
          avg_bb_gap?: number | null
          avg_days_of_stock?: number | null
          avg_margin_gap?: number | null
          confidence_score?: number | null
          created_at?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          marketplace?: string
          metadata_json?: Json | null
          notes?: string | null
          occurrence_count?: number
          recommendation_status?: string
          signal_key: string
          signal_label: string
          updated_at?: string
          user_id: string
        }
        Update: {
          affected_asin_count?: number
          avg_bb_gap?: number | null
          avg_days_of_stock?: number | null
          avg_margin_gap?: number | null
          confidence_score?: number | null
          created_at?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          marketplace?: string
          metadata_json?: Json | null
          notes?: string | null
          occurrence_count?: number
          recommendation_status?: string
          signal_key?: string
          signal_label?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      smart_engine_outcome_snapshots: {
        Row: {
          asin: string
          bb_win_rate_pct: number | null
          captured_at: string
          floor_hits: number
          group_label: string
          hours_to_bb_regain: number | null
          hours_to_no_further_cuts: number | null
          hours_to_price_stability: number | null
          id: string
          marketplace: string
          notes: string | null
          oscillation_events: number
          price_changes_count: number
          realized_margin_avg: number | null
          sample_size: number
          snapshot_phase: string
          tuning_action_id: string
          unnecessary_undercut_breakdown: Json
          unnecessary_undercut_count: number
          user_id: string
          window_end: string
          window_start: string
        }
        Insert: {
          asin: string
          bb_win_rate_pct?: number | null
          captured_at?: string
          floor_hits?: number
          group_label: string
          hours_to_bb_regain?: number | null
          hours_to_no_further_cuts?: number | null
          hours_to_price_stability?: number | null
          id?: string
          marketplace: string
          notes?: string | null
          oscillation_events?: number
          price_changes_count?: number
          realized_margin_avg?: number | null
          sample_size?: number
          snapshot_phase: string
          tuning_action_id: string
          unnecessary_undercut_breakdown?: Json
          unnecessary_undercut_count?: number
          user_id: string
          window_end: string
          window_start: string
        }
        Update: {
          asin?: string
          bb_win_rate_pct?: number | null
          captured_at?: string
          floor_hits?: number
          group_label?: string
          hours_to_bb_regain?: number | null
          hours_to_no_further_cuts?: number | null
          hours_to_price_stability?: number | null
          id?: string
          marketplace?: string
          notes?: string | null
          oscillation_events?: number
          price_changes_count?: number
          realized_margin_avg?: number | null
          sample_size?: number
          snapshot_phase?: string
          tuning_action_id?: string
          unnecessary_undercut_breakdown?: Json
          unnecessary_undercut_count?: number
          user_id?: string
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "smart_engine_outcome_snapshots_tuning_action_id_fkey"
            columns: ["tuning_action_id"]
            isOneToOne: false
            referencedRelation: "smart_engine_tuning_actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "smart_engine_outcome_snapshots_tuning_action_id_fkey"
            columns: ["tuning_action_id"]
            isOneToOne: false
            referencedRelation: "smart_engine_tuning_lift"
            referencedColumns: ["tuning_action_id"]
          },
        ]
      }
      smart_engine_pro_budget: {
        Row: {
          budget_date: string
          created_at: string
          id: string
          last_review_at: string | null
          pro_reviews_cap: number
          pro_reviews_used: number
          updated_at: string
          user_id: string
        }
        Insert: {
          budget_date?: string
          created_at?: string
          id?: string
          last_review_at?: string | null
          pro_reviews_cap?: number
          pro_reviews_used?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          budget_date?: string
          created_at?: string
          id?: string
          last_review_at?: string | null
          pro_reviews_cap?: number
          pro_reviews_used?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      smart_engine_review_batches: {
        Row: {
          asin_count: number
          created_at: string
          id: string
          optimal_count: number
          review_needed_count: number
          top_signal: string | null
          trigger_type: string
          user_id: string
        }
        Insert: {
          asin_count?: number
          created_at?: string
          id?: string
          optimal_count?: number
          review_needed_count?: number
          top_signal?: string | null
          trigger_type?: string
          user_id: string
        }
        Update: {
          asin_count?: number
          created_at?: string
          id?: string
          optimal_count?: number
          review_needed_count?: number
          top_signal?: string | null
          trigger_type?: string
          user_id?: string
        }
        Relationships: []
      }
      smart_engine_review_items: {
        Row: {
          asin: string
          batch_id: string
          bb_owner: boolean | null
          buy_box_price: number | null
          confidence_score: number | null
          constraints_json: Json | null
          created_at: string
          current_price: number | null
          decision_type: string
          id: string
          judgment: string
          judgment_reason: string
          lowest_fba_price: number | null
          marketplace: string
          max_price: number | null
          min_price: number | null
          next_competitor_price: number | null
          profit_floor: number | null
          sku: string | null
          tuning_signals: string[]
          user_id: string
        }
        Insert: {
          asin: string
          batch_id: string
          bb_owner?: boolean | null
          buy_box_price?: number | null
          confidence_score?: number | null
          constraints_json?: Json | null
          created_at?: string
          current_price?: number | null
          decision_type: string
          id?: string
          judgment: string
          judgment_reason: string
          lowest_fba_price?: number | null
          marketplace?: string
          max_price?: number | null
          min_price?: number | null
          next_competitor_price?: number | null
          profit_floor?: number | null
          sku?: string | null
          tuning_signals?: string[]
          user_id: string
        }
        Update: {
          asin?: string
          batch_id?: string
          bb_owner?: boolean | null
          buy_box_price?: number | null
          confidence_score?: number | null
          constraints_json?: Json | null
          created_at?: string
          current_price?: number | null
          decision_type?: string
          id?: string
          judgment?: string
          judgment_reason?: string
          lowest_fba_price?: number | null
          marketplace?: string
          max_price?: number | null
          min_price?: number | null
          next_competitor_price?: number | null
          profit_floor?: number | null
          sku?: string | null
          tuning_signals?: string[]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "smart_engine_review_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "smart_engine_review_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      smart_engine_tuning_actions: {
        Row: {
          applied_at: string
          applied_by: string
          control_asins: string[] | null
          control_assignment_seed: string | null
          control_group_pct: number
          created_at: string
          experiment_start_at: string | null
          id: string
          is_observational: boolean
          min_sample_size: number | null
          new_value: string | null
          old_value: string | null
          outcome_summary: string | null
          parameter_key: string
          recommendation_id: string | null
          rolled_back_at: string | null
          scope_asins: string[] | null
          treatment_asins: string[] | null
          user_id: string
        }
        Insert: {
          applied_at?: string
          applied_by?: string
          control_asins?: string[] | null
          control_assignment_seed?: string | null
          control_group_pct?: number
          created_at?: string
          experiment_start_at?: string | null
          id?: string
          is_observational?: boolean
          min_sample_size?: number | null
          new_value?: string | null
          old_value?: string | null
          outcome_summary?: string | null
          parameter_key: string
          recommendation_id?: string | null
          rolled_back_at?: string | null
          scope_asins?: string[] | null
          treatment_asins?: string[] | null
          user_id: string
        }
        Update: {
          applied_at?: string
          applied_by?: string
          control_asins?: string[] | null
          control_assignment_seed?: string | null
          control_group_pct?: number
          created_at?: string
          experiment_start_at?: string | null
          id?: string
          is_observational?: boolean
          min_sample_size?: number | null
          new_value?: string | null
          old_value?: string | null
          outcome_summary?: string | null
          parameter_key?: string
          recommendation_id?: string | null
          rolled_back_at?: string | null
          scope_asins?: string[] | null
          treatment_asins?: string[] | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "smart_engine_tuning_actions_recommendation_id_fkey"
            columns: ["recommendation_id"]
            isOneToOne: false
            referencedRelation: "smart_engine_tuning_recommendations"
            referencedColumns: ["id"]
          },
        ]
      }
      smart_engine_tuning_recommendations: {
        Row: {
          admin_approved: boolean
          admin_approved_at: string | null
          admin_approved_by: string | null
          admin_rejection_reason: string | null
          applied_at: string | null
          auto_graduated: boolean
          confidence_bucket: string | null
          confidence_score: number | null
          created_at: string
          current_value: string | null
          id: string
          model_tier: string | null
          outcome_direction: string | null
          outcome_evaluated_at: string | null
          outcome_notes: Json | null
          parameter_key: string
          reason: string
          recommendation_type: string
          safety_bound_json: Json | null
          signal_id: string | null
          status: string
          suggested_value: string | null
          supporting_signal_count: number
          updated_at: string
          user_id: string
          was_applied: boolean
        }
        Insert: {
          admin_approved?: boolean
          admin_approved_at?: string | null
          admin_approved_by?: string | null
          admin_rejection_reason?: string | null
          applied_at?: string | null
          auto_graduated?: boolean
          confidence_bucket?: string | null
          confidence_score?: number | null
          created_at?: string
          current_value?: string | null
          id?: string
          model_tier?: string | null
          outcome_direction?: string | null
          outcome_evaluated_at?: string | null
          outcome_notes?: Json | null
          parameter_key: string
          reason: string
          recommendation_type: string
          safety_bound_json?: Json | null
          signal_id?: string | null
          status?: string
          suggested_value?: string | null
          supporting_signal_count?: number
          updated_at?: string
          user_id: string
          was_applied?: boolean
        }
        Update: {
          admin_approved?: boolean
          admin_approved_at?: string | null
          admin_approved_by?: string | null
          admin_rejection_reason?: string | null
          applied_at?: string | null
          auto_graduated?: boolean
          confidence_bucket?: string | null
          confidence_score?: number | null
          created_at?: string
          current_value?: string | null
          id?: string
          model_tier?: string | null
          outcome_direction?: string | null
          outcome_evaluated_at?: string | null
          outcome_notes?: Json | null
          parameter_key?: string
          reason?: string
          recommendation_type?: string
          safety_bound_json?: Json | null
          signal_id?: string | null
          status?: string
          suggested_value?: string | null
          supporting_signal_count?: number
          updated_at?: string
          user_id?: string
          was_applied?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "smart_engine_tuning_recommendations_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "smart_engine_learning_signals"
            referencedColumns: ["id"]
          },
        ]
      }
      source_candidates: {
        Row: {
          asin: string
          availability: string | null
          block_provider: string | null
          confidence_score: number | null
          created_at: string
          currency: string | null
          current_price: number | null
          domain: string | null
          extracted_at: string | null
          extraction_method: string | null
          final_resolution: string | null
          id: string
          image_url: string | null
          last_checked_at: string | null
          match_reason: string | null
          match_score: number
          needs_review: boolean | null
          original_price: number | null
          phase1_status: string | null
          phase2_status: string | null
          review_reasons: Json | null
          run_id: string
          source_snippet: string | null
          source_title: string | null
          source_type: string
          source_url: string
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          availability?: string | null
          block_provider?: string | null
          confidence_score?: number | null
          created_at?: string
          currency?: string | null
          current_price?: number | null
          domain?: string | null
          extracted_at?: string | null
          extraction_method?: string | null
          final_resolution?: string | null
          id?: string
          image_url?: string | null
          last_checked_at?: string | null
          match_reason?: string | null
          match_score?: number
          needs_review?: boolean | null
          original_price?: number | null
          phase1_status?: string | null
          phase2_status?: string | null
          review_reasons?: Json | null
          run_id: string
          source_snippet?: string | null
          source_title?: string | null
          source_type?: string
          source_url: string
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          availability?: string | null
          block_provider?: string | null
          confidence_score?: number | null
          created_at?: string
          currency?: string | null
          current_price?: number | null
          domain?: string | null
          extracted_at?: string | null
          extraction_method?: string | null
          final_resolution?: string | null
          id?: string
          image_url?: string | null
          last_checked_at?: string | null
          match_reason?: string | null
          match_score?: number
          needs_review?: boolean | null
          original_price?: number | null
          phase1_status?: string | null
          phase2_status?: string | null
          review_reasons?: Json | null
          run_id?: string
          source_snippet?: string | null
          source_title?: string | null
          source_type?: string
          source_url?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_candidates_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "source_discovery_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      source_discovery_runs: {
        Row: {
          amazon_title: string | null
          asin: string
          blocked_count: number
          brand: string | null
          created_at: string
          error: string | null
          extracted_count: number
          id: string
          invalid_count: number
          model_number: string | null
          needs_review_count: number
          previous_run_id: string | null
          qa_batch_id: string | null
          quality_badge: string | null
          run_type: string
          status: string
          top_valid_domain: string | null
          top_valid_price: number | null
          top_valid_url: string | null
          total_candidates: number
          unresolved_count: number
          upc: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amazon_title?: string | null
          asin: string
          blocked_count?: number
          brand?: string | null
          created_at?: string
          error?: string | null
          extracted_count?: number
          id?: string
          invalid_count?: number
          model_number?: string | null
          needs_review_count?: number
          previous_run_id?: string | null
          qa_batch_id?: string | null
          quality_badge?: string | null
          run_type?: string
          status?: string
          top_valid_domain?: string | null
          top_valid_price?: number | null
          top_valid_url?: string | null
          total_candidates?: number
          unresolved_count?: number
          upc?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amazon_title?: string | null
          asin?: string
          blocked_count?: number
          brand?: string | null
          created_at?: string
          error?: string | null
          extracted_count?: number
          id?: string
          invalid_count?: number
          model_number?: string | null
          needs_review_count?: number
          previous_run_id?: string | null
          qa_batch_id?: string | null
          quality_badge?: string | null
          run_type?: string
          status?: string
          top_valid_domain?: string | null
          top_valid_price?: number | null
          top_valid_url?: string | null
          total_candidates?: number
          unresolved_count?: number
          upc?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_discovery_runs_previous_run_id_fkey"
            columns: ["previous_run_id"]
            isOneToOne: false
            referencedRelation: "source_discovery_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      source_excluded_domains: {
        Row: {
          created_at: string
          domain: string
          id: string
          label: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          domain: string
          id?: string
          label?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          domain?: string
          id?: string
          label?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      source_excluded_terms: {
        Row: {
          created_at: string
          id: string
          kind: string
          label: string | null
          user_id: string
          value: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          label?: string | null
          user_id: string
          value: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          label?: string | null
          user_id?: string
          value?: string
        }
        Relationships: []
      }
      source_retailers: {
        Row: {
          created_at: string
          domain: string
          enabled: boolean
          id: string
          label: string | null
          price_attempts: number
          price_success: number
          search_hits: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          domain: string
          enabled?: boolean
          id?: string
          label?: string | null
          price_attempts?: number
          price_success?: number
          search_hits?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          domain?: string
          enabled?: boolean
          id?: string
          label?: string | null
          price_attempts?: number
          price_success?: number
          search_hits?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sp_api_rate_limit_state: {
        Row: {
          created_at: string | null
          last_called_at: string | null
          operation: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          last_called_at?: string | null
          operation: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          last_called_at?: string | null
          operation?: string
          user_id?: string
        }
        Relationships: []
      }
      spapi_health_alerts: {
        Row: {
          created_at: string
          error_message: string | null
          first_detected_at: string
          id: string
          issue_type: string
          last_detected_at: string
          last_notified_at: string | null
          notify_count: number
          resolved_at: string | null
          status: string
          updated_at: string
          user_email: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          first_detected_at?: string
          id?: string
          issue_type: string
          last_detected_at?: string
          last_notified_at?: string | null
          notify_count?: number
          resolved_at?: string | null
          status?: string
          updated_at?: string
          user_email?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          first_detected_at?: string
          id?: string
          issue_type?: string
          last_detected_at?: string
          last_notified_at?: string | null
          notify_count?: number
          resolved_at?: string | null
          status?: string
          updated_at?: string
          user_email?: string | null
          user_id?: string
        }
        Relationships: []
      }
      still_thinking_listings: {
        Row: {
          asin: string
          converted_at: string | null
          created_at: string
          discount_code: string | null
          id: string
          image_url: string | null
          linked_created_listing_id: string | null
          marketplace: string | null
          notes: string | null
          status: string
          supplier_domain: string | null
          supplier_id: string | null
          supplier_url: string | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          converted_at?: string | null
          created_at?: string
          discount_code?: string | null
          id?: string
          image_url?: string | null
          linked_created_listing_id?: string | null
          marketplace?: string | null
          notes?: string | null
          status?: string
          supplier_domain?: string | null
          supplier_id?: string | null
          supplier_url?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          converted_at?: string | null
          created_at?: string
          discount_code?: string | null
          id?: string
          image_url?: string | null
          linked_created_listing_id?: string | null
          marketplace?: string | null
          notes?: string | null
          status?: string
          supplier_domain?: string | null
          supplier_id?: string | null
          supplier_url?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "still_thinking_listings_linked_created_listing_id_fkey"
            columns: ["linked_created_listing_id"]
            isOneToOne: false
            referencedRelation: "active_created_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "still_thinking_listings_linked_created_listing_id_fkey"
            columns: ["linked_created_listing_id"]
            isOneToOne: false
            referencedRelation: "created_listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "still_thinking_listings_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      store_scan_ai_verifications: {
        Row: {
          amazon_fingerprint: string | null
          asin: string
          confidence: number
          created_at: string
          evidence: Json
          id: string
          model_used: string
          prompt_version: number
          reason: string | null
          rule_block: string | null
          source_fingerprint: string | null
          source_url: string
          source_url_norm: string
          updated_at: string
          verdict: string
          verification_version: number
          verified_at: string
        }
        Insert: {
          amazon_fingerprint?: string | null
          asin: string
          confidence?: number
          created_at?: string
          evidence?: Json
          id?: string
          model_used: string
          prompt_version?: number
          reason?: string | null
          rule_block?: string | null
          source_fingerprint?: string | null
          source_url: string
          source_url_norm: string
          updated_at?: string
          verdict: string
          verification_version?: number
          verified_at?: string
        }
        Update: {
          amazon_fingerprint?: string | null
          asin?: string
          confidence?: number
          created_at?: string
          evidence?: Json
          id?: string
          model_used?: string
          prompt_version?: number
          reason?: string | null
          rule_block?: string | null
          source_fingerprint?: string | null
          source_url?: string
          source_url_norm?: string
          updated_at?: string
          verdict?: string
          verification_version?: number
          verified_at?: string
        }
        Relationships: []
      }
      store_scan_items: {
        Row: {
          amz_candidates: Json | null
          amz_image_url: string | null
          amz_price: number | null
          amz_title: string | null
          confidence_band: string | null
          confidence_score: number | null
          created_at: string
          error: string | null
          fees_json: Json | null
          id: string
          is_new: boolean
          last_refresh_at: string | null
          last_refresh_error: string | null
          last_refresh_status: string | null
          margin_pct: number | null
          match_confidence: string | null
          match_method: string | null
          match_quality_signals: Json | null
          match_score: number | null
          matched_asin: string | null
          normalized_query: string | null
          price_sanity: string | null
          product_id: string | null
          review_required: boolean
          roi: number | null
          run_id: string
          source_availability: string | null
          source_availability_status: string
          source_brand: string | null
          source_currency: string | null
          source_image_url: string | null
          source_price: number | null
          source_title: string | null
          source_upc: string | null
          source_url: string
          status: string
          url_key: string | null
          user_id: string
        }
        Insert: {
          amz_candidates?: Json | null
          amz_image_url?: string | null
          amz_price?: number | null
          amz_title?: string | null
          confidence_band?: string | null
          confidence_score?: number | null
          created_at?: string
          error?: string | null
          fees_json?: Json | null
          id?: string
          is_new?: boolean
          last_refresh_at?: string | null
          last_refresh_error?: string | null
          last_refresh_status?: string | null
          margin_pct?: number | null
          match_confidence?: string | null
          match_method?: string | null
          match_quality_signals?: Json | null
          match_score?: number | null
          matched_asin?: string | null
          normalized_query?: string | null
          price_sanity?: string | null
          product_id?: string | null
          review_required?: boolean
          roi?: number | null
          run_id: string
          source_availability?: string | null
          source_availability_status?: string
          source_brand?: string | null
          source_currency?: string | null
          source_image_url?: string | null
          source_price?: number | null
          source_title?: string | null
          source_upc?: string | null
          source_url: string
          status?: string
          url_key?: string | null
          user_id: string
        }
        Update: {
          amz_candidates?: Json | null
          amz_image_url?: string | null
          amz_price?: number | null
          amz_title?: string | null
          confidence_band?: string | null
          confidence_score?: number | null
          created_at?: string
          error?: string | null
          fees_json?: Json | null
          id?: string
          is_new?: boolean
          last_refresh_at?: string | null
          last_refresh_error?: string | null
          last_refresh_status?: string | null
          margin_pct?: number | null
          match_confidence?: string | null
          match_method?: string | null
          match_quality_signals?: Json | null
          match_score?: number | null
          matched_asin?: string | null
          normalized_query?: string | null
          price_sanity?: string | null
          product_id?: string | null
          review_required?: boolean
          roi?: number | null
          run_id?: string
          source_availability?: string | null
          source_availability_status?: string
          source_brand?: string | null
          source_currency?: string | null
          source_image_url?: string | null
          source_price?: number | null
          source_title?: string | null
          source_upc?: string | null
          source_url?: string
          status?: string
          url_key?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_scan_items_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "store_scan_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      store_scan_runs: {
        Row: {
          category_id: string | null
          chunk_lease_until: string | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          failure_reasons: Json
          id: string
          max_products_cap: number
          pages_crawled: number
          products_blocked: number
          products_extracted: number
          products_failed: number
          products_found: number
          products_matched: number
          products_new: number
          products_unmatched: number
          profile_id: string | null
          scope_type: string
          scope_urls: string[]
          started_at: string | null
          status: string
          supplier_domain: string
          updated_at: string
          user_id: string
        }
        Insert: {
          category_id?: string | null
          chunk_lease_until?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          failure_reasons?: Json
          id?: string
          max_products_cap?: number
          pages_crawled?: number
          products_blocked?: number
          products_extracted?: number
          products_failed?: number
          products_found?: number
          products_matched?: number
          products_new?: number
          products_unmatched?: number
          profile_id?: string | null
          scope_type?: string
          scope_urls?: string[]
          started_at?: string | null
          status?: string
          supplier_domain: string
          updated_at?: string
          user_id: string
        }
        Update: {
          category_id?: string | null
          chunk_lease_until?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          failure_reasons?: Json
          id?: string
          max_products_cap?: number
          pages_crawled?: number
          products_blocked?: number
          products_extracted?: number
          products_failed?: number
          products_found?: number
          products_matched?: number
          products_new?: number
          products_unmatched?: number
          profile_id?: string | null
          scope_type?: string
          scope_urls?: string[]
          started_at?: string | null
          status?: string
          supplier_domain?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "store_scan_runs_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "scan_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_scan_runs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "supplier_scan_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_events: {
        Row: {
          created_at: string
          details: Json | null
          event_type: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          event_type: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          event_type?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      subscription_plans: {
        Row: {
          annual_price: number
          id: string
          listing_limit: number
          monthly_price: number
          name: string
          priority_star_cap: number
          sort_order: number
          sp_api_calls_per_minute_cap: number
          stripe_annual_price_id: string | null
          stripe_price_id: string | null
          stripe_product_id: string | null
        }
        Insert: {
          annual_price: number
          id: string
          listing_limit: number
          monthly_price: number
          name: string
          priority_star_cap?: number
          sort_order?: number
          sp_api_calls_per_minute_cap?: number
          stripe_annual_price_id?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
        }
        Update: {
          annual_price?: number
          id?: string
          listing_limit?: number
          monthly_price?: number
          name?: string
          priority_star_cap?: number
          sort_order?: number
          sp_api_calls_per_minute_cap?: number
          stripe_annual_price_id?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
        }
        Relationships: []
      }
      supplier_qa_batches: {
        Row: {
          aggregate_metrics: Json | null
          asin_list: string[] | null
          completed_asins: number
          created_at: string
          id: string
          name: string | null
          run_ids: string[] | null
          status: string
          total_asins: number
          updated_at: string
          user_id: string
        }
        Insert: {
          aggregate_metrics?: Json | null
          asin_list?: string[] | null
          completed_asins?: number
          created_at?: string
          id?: string
          name?: string | null
          run_ids?: string[] | null
          status?: string
          total_asins?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          aggregate_metrics?: Json | null
          asin_list?: string[] | null
          completed_asins?: number
          created_at?: string
          id?: string
          name?: string | null
          run_ids?: string[] | null
          status?: string
          total_asins?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      supplier_scan_profiles: {
        Row: {
          category_urls: string[] | null
          created_at: string
          display_name: string
          domain: string
          id: string
          is_enabled: boolean
          max_pages_per_run: number
          max_products_per_run: number
          notes: string | null
          pagination_param: string | null
          pagination_type: string
          product_image_selector: string | null
          product_link_selector: string | null
          product_price_selector: string | null
          product_title_selector: string | null
          product_upc_selector: string | null
          sitemap_urls: string[] | null
          updated_at: string
        }
        Insert: {
          category_urls?: string[] | null
          created_at?: string
          display_name: string
          domain: string
          id?: string
          is_enabled?: boolean
          max_pages_per_run?: number
          max_products_per_run?: number
          notes?: string | null
          pagination_param?: string | null
          pagination_type?: string
          product_image_selector?: string | null
          product_link_selector?: string | null
          product_price_selector?: string | null
          product_title_selector?: string | null
          product_upc_selector?: string | null
          sitemap_urls?: string[] | null
          updated_at?: string
        }
        Update: {
          category_urls?: string[] | null
          created_at?: string
          display_name?: string
          domain?: string
          id?: string
          is_enabled?: boolean
          max_pages_per_run?: number
          max_products_per_run?: number
          notes?: string | null
          pagination_param?: string | null
          pagination_type?: string
          product_image_selector?: string | null
          product_link_selector?: string | null
          product_price_selector?: string | null
          product_title_selector?: string | null
          product_upc_selector?: string | null
          sitemap_urls?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      suppliers: {
        Row: {
          created_at: string
          domain: string
          id: string
          notes: string | null
          source_origin: string
          supplier_name: string | null
          supplier_type: string
          supports_scraping: boolean
          trust_level: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          domain: string
          id?: string
          notes?: string | null
          source_origin?: string
          supplier_name?: string | null
          supplier_type?: string
          supports_scraping?: boolean
          trust_level?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          domain?: string
          id?: string
          notes?: string | null
          source_origin?: string
          supplier_name?: string | null
          supplier_type?: string
          supports_scraping?: boolean
          trust_level?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sync_locks: {
        Row: {
          expires_at: string
          lock_name: string
          locked_at: string
          locked_by: string | null
        }
        Insert: {
          expires_at: string
          lock_name: string
          locked_at?: string
          locked_by?: string | null
        }
        Update: {
          expires_at?: string
          lock_name?: string
          locked_at?: string
          locked_by?: string | null
        }
        Relationships: []
      }
      sync_parity_log: {
        Row: {
          check_date: string
          created_at: string
          fec_count: number
          gap_type: string | null
          id: string
          marketplace: string
          repair_status: string
          repair_triggered_at: string | null
          repaired_at: string | null
          so_count: number
          user_id: string
          validation_so_count: number | null
        }
        Insert: {
          check_date: string
          created_at?: string
          fec_count?: number
          gap_type?: string | null
          id?: string
          marketplace?: string
          repair_status?: string
          repair_triggered_at?: string | null
          repaired_at?: string | null
          so_count?: number
          user_id: string
          validation_so_count?: number | null
        }
        Update: {
          check_date?: string
          created_at?: string
          fec_count?: number
          gap_type?: string | null
          id?: string
          marketplace?: string
          repair_status?: string
          repair_triggered_at?: string | null
          repaired_at?: string | null
          so_count?: number
          user_id?: string
          validation_so_count?: number | null
        }
        Relationships: []
      }
      sync_traces: {
        Row: {
          completed_at: string | null
          created_at: string
          duplicates_skipped: number | null
          error_count: number | null
          error_message: string | null
          id: string
          metadata: Json | null
          phase: string | null
          retry_count: number | null
          rows_corrected: number | null
          rows_fetched: number | null
          rows_inserted: number | null
          rows_missing_fees: number | null
          rows_missing_price: number | null
          rows_updated: number | null
          started_at: string
          status: string
          sync_type: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          duplicates_skipped?: number | null
          error_count?: number | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          phase?: string | null
          retry_count?: number | null
          rows_corrected?: number | null
          rows_fetched?: number | null
          rows_inserted?: number | null
          rows_missing_fees?: number | null
          rows_missing_price?: number | null
          rows_updated?: number | null
          started_at?: string
          status?: string
          sync_type: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          duplicates_skipped?: number | null
          error_count?: number | null
          error_message?: string | null
          id?: string
          metadata?: Json | null
          phase?: string | null
          retry_count?: number | null
          rows_corrected?: number | null
          rows_fetched?: number | null
          rows_inserted?: number | null
          rows_missing_fees?: number | null
          rows_missing_price?: number | null
          rows_updated?: number | null
          started_at?: string
          status?: string
          sync_type?: string
          user_id?: string
        }
        Relationships: []
      }
      system_load_snapshot: {
        Row: {
          active_connections: number
          avg_query_ms_5m: number | null
          captured_at: string
          id: number
          waiting_queries: number
        }
        Insert: {
          active_connections: number
          avg_query_ms_5m?: number | null
          captured_at?: string
          id?: number
          waiting_queries: number
        }
        Update: {
          active_connections?: number
          avg_query_ms_5m?: number | null
          captured_at?: string
          id?: number
          waiting_queries?: number
        }
        Relationships: []
      }
      team_members: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          id: string
          invited_at: string
          member_user_id: string | null
          owner_id: string
          role: Database["public"]["Enums"]["team_role"]
          status: Database["public"]["Enums"]["team_invite_status"]
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          id?: string
          invited_at?: string
          member_user_id?: string | null
          owner_id: string
          role?: Database["public"]["Enums"]["team_role"]
          status?: Database["public"]["Enums"]["team_invite_status"]
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          id?: string
          invited_at?: string
          member_user_id?: string | null
          owner_id?: string
          role?: Database["public"]["Enums"]["team_role"]
          status?: Database["public"]["Enums"]["team_invite_status"]
          updated_at?: string
        }
        Relationships: []
      }
      trusted_domains: {
        Row: {
          created_at: string
          domain: string
          id: string
          notes: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          domain: string
          id?: string
          notes?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          domain?: string
          id?: string
          notes?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_approved_products: {
        Row: {
          approval_status: string
          asin: string
          batch_no: number | null
          checked_at: string | null
          created_at: string
          hidden: boolean
          id: string
          marketplace: string
          saved: boolean
          score: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          approval_status?: string
          asin: string
          batch_no?: number | null
          checked_at?: string | null
          created_at?: string
          hidden?: boolean
          id?: string
          marketplace?: string
          saved?: boolean
          score?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          approval_status?: string
          asin?: string
          batch_no?: number | null
          checked_at?: string | null
          created_at?: string
          hidden?: boolean
          id?: string
          marketplace?: string
          saved?: boolean
          score?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_module_access: {
        Row: {
          action: Database["public"]["Enums"]["app_action"]
          granted_at: string
          granted_by: string | null
          id: string
          module: Database["public"]["Enums"]["app_module"]
          notes: string | null
          user_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["app_action"]
          granted_at?: string
          granted_by?: string | null
          id?: string
          module: Database["public"]["Enums"]["app_module"]
          notes?: string | null
          user_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["app_action"]
          granted_at?: string
          granted_by?: string | null
          id?: string
          module?: Database["public"]["Enums"]["app_module"]
          notes?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_owned_products: {
        Row: {
          asin: string
          brand: string | null
          buy_box_price: number | null
          category: string | null
          created_at: string
          delivered_at: string
          eligibility_checked_at: string | null
          eligibility_status: string | null
          id: string
          image_url: string | null
          marketplace: string
          monthly_sold: number | null
          run_id: string | null
          sales_rank: number | null
          score: number | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          asin: string
          brand?: string | null
          buy_box_price?: number | null
          category?: string | null
          created_at?: string
          delivered_at?: string
          eligibility_checked_at?: string | null
          eligibility_status?: string | null
          id?: string
          image_url?: string | null
          marketplace?: string
          monthly_sold?: number | null
          run_id?: string | null
          sales_rank?: number | null
          score?: number | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          asin?: string
          brand?: string | null
          buy_box_price?: number | null
          category?: string | null
          created_at?: string
          delivered_at?: string
          eligibility_checked_at?: string | null
          eligibility_status?: string | null
          id?: string
          image_url?: string | null
          marketplace?: string
          monthly_sold?: number | null
          run_id?: string | null
          sales_rank?: number | null
          score?: number | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_owned_products_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "product_finder_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          auto_assign_enabled: boolean
          auto_assign_require_inbound: boolean
          auto_assign_require_price: boolean
          auto_assign_rule_id: string | null
          auto_assign_skip_existing: boolean
          auto_max_buffer_pct: number
          auto_max_strategy: string
          auto_min_buffer_pct: number
          auto_min_strategy: string
          auto_minmax_enabled: boolean
          auto_raise_roi_floor_br: boolean
          auto_raise_roi_floor_ca: boolean
          auto_raise_roi_floor_mx: boolean
          auto_raise_roi_floor_us: boolean
          auto_require_cost: boolean
          auto_skip_manual_minmax: boolean
          created_at: string
          intl_learned_fees_br: boolean
          intl_learned_fees_ca: boolean
          intl_learned_fees_enabled: boolean
          intl_learned_fees_mx: boolean
          roi_alert_threshold: number
          updated_at: string
          user_id: string
        }
        Insert: {
          auto_assign_enabled?: boolean
          auto_assign_require_inbound?: boolean
          auto_assign_require_price?: boolean
          auto_assign_rule_id?: string | null
          auto_assign_skip_existing?: boolean
          auto_max_buffer_pct?: number
          auto_max_strategy?: string
          auto_min_buffer_pct?: number
          auto_min_strategy?: string
          auto_minmax_enabled?: boolean
          auto_raise_roi_floor_br?: boolean
          auto_raise_roi_floor_ca?: boolean
          auto_raise_roi_floor_mx?: boolean
          auto_raise_roi_floor_us?: boolean
          auto_require_cost?: boolean
          auto_skip_manual_minmax?: boolean
          created_at?: string
          intl_learned_fees_br?: boolean
          intl_learned_fees_ca?: boolean
          intl_learned_fees_enabled?: boolean
          intl_learned_fees_mx?: boolean
          roi_alert_threshold?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          auto_assign_enabled?: boolean
          auto_assign_require_inbound?: boolean
          auto_assign_require_price?: boolean
          auto_assign_rule_id?: string | null
          auto_assign_skip_existing?: boolean
          auto_max_buffer_pct?: number
          auto_max_strategy?: string
          auto_min_buffer_pct?: number
          auto_min_strategy?: string
          auto_minmax_enabled?: boolean
          auto_raise_roi_floor_br?: boolean
          auto_raise_roi_floor_ca?: boolean
          auto_raise_roi_floor_mx?: boolean
          auto_raise_roi_floor_us?: boolean
          auto_require_cost?: boolean
          auto_skip_manual_minmax?: boolean
          created_at?: string
          intl_learned_fees_br?: boolean
          intl_learned_fees_ca?: boolean
          intl_learned_fees_enabled?: boolean
          intl_learned_fees_mx?: boolean
          roi_alert_threshold?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_settings_auto_assign_rule_id_fkey"
            columns: ["auto_assign_rule_id"]
            isOneToOne: false
            referencedRelation: "repricer_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      user_spapi_credentials: {
        Row: {
          created_at: string
          last_test_at: string | null
          last_test_error: string | null
          last_test_marketplaces: Json | null
          last_test_seller_id: string | null
          last_test_status: string | null
          lwa_client_id_enc: string | null
          lwa_client_id_last4: string | null
          lwa_client_secret_enc: string | null
          marketplace: string
          refresh_token_enc: string | null
          refresh_token_last4: string | null
          region: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          last_test_at?: string | null
          last_test_error?: string | null
          last_test_marketplaces?: Json | null
          last_test_seller_id?: string | null
          last_test_status?: string | null
          lwa_client_id_enc?: string | null
          lwa_client_id_last4?: string | null
          lwa_client_secret_enc?: string | null
          marketplace?: string
          refresh_token_enc?: string | null
          refresh_token_last4?: string | null
          region?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          last_test_at?: string | null
          last_test_error?: string | null
          last_test_marketplaces?: Json | null
          last_test_seller_id?: string | null
          last_test_status?: string | null
          lwa_client_id_enc?: string | null
          lwa_client_id_last4?: string | null
          lwa_client_secret_enc?: string | null
          marketplace?: string
          refresh_token_enc?: string | null
          refresh_token_last4?: string | null
          region?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_subscriptions: {
        Row: {
          billing_interval: string
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          expires_at: string | null
          id: string
          plan_id: string
          started_at: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          trial_end_date: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          billing_interval?: string
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          expires_at?: string | null
          id?: string
          plan_id?: string
          started_at?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_end_date?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          billing_interval?: string
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          expires_at?: string | null
          id?: string
          plan_id?: string
          started_at?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          trial_end_date?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      user_sync_status: {
        Row: {
          amazon_connected: boolean
          created_at: string
          fee_cache_seeded: boolean
          fnsku_mapped: boolean
          history_complete: boolean
          history_syncing: boolean
          inventory_sync_completed_at: string | null
          inventory_sync_started_at: string | null
          inventory_synced: boolean
          last_error: string | null
          pl_ready: boolean
          recent_sales_synced: boolean
          repricer_assignments_created: boolean
          repricer_ready: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          amazon_connected?: boolean
          created_at?: string
          fee_cache_seeded?: boolean
          fnsku_mapped?: boolean
          history_complete?: boolean
          history_syncing?: boolean
          inventory_sync_completed_at?: string | null
          inventory_sync_started_at?: string | null
          inventory_synced?: boolean
          last_error?: string | null
          pl_ready?: boolean
          recent_sales_synced?: boolean
          repricer_assignments_created?: boolean
          repricer_ready?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          amazon_connected?: boolean
          created_at?: string
          fee_cache_seeded?: boolean
          fnsku_mapped?: boolean
          history_complete?: boolean
          history_syncing?: boolean
          inventory_sync_completed_at?: string | null
          inventory_sync_started_at?: string | null
          inventory_synced?: boolean
          last_error?: string | null
          pl_ready?: boolean
          recent_sales_synced?: boolean
          repricer_assignments_created?: boolean
          repricer_ready?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      asin_cog_for_repricer: {
        Row: {
          asin: string | null
          reviewed_at: string | null
          source: string | null
          unit_cost: number | null
          updated_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
      active_created_listings: {
        Row: {
          amount: number | null
          asin: string | null
          cost: number | null
          created_at: string | null
          date_created: string | null
          fba_block_reason: string | null
          fba_blocked: boolean | null
          fnsku: string | null
          id: string | null
          image_url: string | null
          inbound_dry_run_at: string | null
          inbound_dry_run_error: string | null
          inbound_dry_run_plan_id: string | null
          inbound_dry_run_status: string | null
          notes: string | null
          price: number | null
          sku: string | null
          supplier_links: Json | null
          title: string | null
          units: number | null
          updated_at: string | null
          user_id: string | null
          validation_attempts: number | null
          validation_completed_at: string | null
          validation_failure_code: string | null
          validation_failure_reason: string | null
          validation_started_at: string | null
          validation_status: string | null
          validation_warning: string | null
        }
        Relationships: []
      }
      active_inventory: {
        Row: {
          age_confidence: string | null
          amazon_price: number | null
          amount: number | null
          asin: string | null
          available: number | null
          bsr: number | null
          cost: number | null
          created_at: string | null
          days_to_expiration: number | null
          estimated_age_days: number | null
          expiration_date: string | null
          fba_block_reason: string | null
          fba_blocked: boolean | null
          fees_json: Json | null
          first_received_at: string | null
          fnsku: string | null
          id: string | null
          image_url: string | null
          inbound: number | null
          inbound_receiving: number | null
          inbound_shipped: number | null
          inbound_working: number | null
          last_bsr_sync_at: string | null
          last_inventory_sync_at: string | null
          last_price_confirmed_at: string | null
          last_price_update_at: string | null
          last_price_update_status: string | null
          last_summaries_at: string | null
          listing_created_at: string | null
          listing_status: string | null
          manual_cost_reason: string | null
          manual_cost_source: string | null
          manual_cost_updated_at: string | null
          max_price: number | null
          min_price: number | null
          my_price: number | null
          preserved_since: string | null
          price: number | null
          requires_expiration: boolean | null
          reserved: number | null
          sku: string | null
          source: string | null
          supplier_links: Json | null
          title: string | null
          unfulfilled: number | null
          unit_cost_manual: boolean | null
          units: number | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          age_confidence?: string | null
          amazon_price?: number | null
          amount?: number | null
          asin?: string | null
          available?: number | null
          bsr?: number | null
          cost?: number | null
          created_at?: string | null
          days_to_expiration?: number | null
          estimated_age_days?: number | null
          expiration_date?: string | null
          fba_block_reason?: string | null
          fba_blocked?: boolean | null
          fees_json?: Json | null
          first_received_at?: string | null
          fnsku?: string | null
          id?: string | null
          image_url?: string | null
          inbound?: number | null
          inbound_receiving?: number | null
          inbound_shipped?: number | null
          inbound_working?: number | null
          last_bsr_sync_at?: string | null
          last_inventory_sync_at?: string | null
          last_price_confirmed_at?: string | null
          last_price_update_at?: string | null
          last_price_update_status?: string | null
          last_summaries_at?: string | null
          listing_created_at?: string | null
          listing_status?: string | null
          manual_cost_reason?: string | null
          manual_cost_source?: string | null
          manual_cost_updated_at?: string | null
          max_price?: number | null
          min_price?: number | null
          my_price?: number | null
          preserved_since?: string | null
          price?: number | null
          requires_expiration?: boolean | null
          reserved?: number | null
          sku?: string | null
          source?: string | null
          supplier_links?: Json | null
          title?: string | null
          unfulfilled?: number | null
          unit_cost_manual?: boolean | null
          units?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          age_confidence?: string | null
          amazon_price?: number | null
          amount?: number | null
          asin?: string | null
          available?: number | null
          bsr?: number | null
          cost?: number | null
          created_at?: string | null
          days_to_expiration?: number | null
          estimated_age_days?: number | null
          expiration_date?: string | null
          fba_block_reason?: string | null
          fba_blocked?: boolean | null
          fees_json?: Json | null
          first_received_at?: string | null
          fnsku?: string | null
          id?: string | null
          image_url?: string | null
          inbound?: number | null
          inbound_receiving?: number | null
          inbound_shipped?: number | null
          inbound_working?: number | null
          last_bsr_sync_at?: string | null
          last_inventory_sync_at?: string | null
          last_price_confirmed_at?: string | null
          last_price_update_at?: string | null
          last_price_update_status?: string | null
          last_summaries_at?: string | null
          listing_created_at?: string | null
          listing_status?: string | null
          manual_cost_reason?: string | null
          manual_cost_source?: string | null
          manual_cost_updated_at?: string | null
          max_price?: number | null
          min_price?: number | null
          my_price?: number | null
          preserved_since?: string | null
          price?: number | null
          requires_expiration?: boolean | null
          reserved?: number | null
          sku?: string | null
          source?: string | null
          supplier_links?: Json | null
          title?: string | null
          unfulfilled?: number | null
          unit_cost_manual?: boolean | null
          units?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      smart_engine_tuning_lift: {
        Row: {
          applied_at: string | null
          causal_bb_win_lift_pct: number | null
          causal_margin_lift: number | null
          control_bb_win_baseline: number | null
          control_bb_win_lift_pct: number | null
          control_bb_win_measured: number | null
          control_count: number | null
          control_floor_hits: number | null
          control_group_pct: number | null
          control_margin_baseline: number | null
          control_margin_lift: number | null
          control_margin_measured: number | null
          new_value: string | null
          old_value: string | null
          parameter_key: string | null
          rolled_back_at: string | null
          treatment_bb_win_baseline: number | null
          treatment_bb_win_lift_pct: number | null
          treatment_bb_win_measured: number | null
          treatment_count: number | null
          treatment_floor_hits: number | null
          treatment_hours_to_bb_regain: number | null
          treatment_hours_to_no_further_cuts: number | null
          treatment_hours_to_price_stability: number | null
          treatment_margin_baseline: number | null
          treatment_margin_lift: number | null
          treatment_margin_measured: number | null
          treatment_undercuts_baseline: number | null
          treatment_undercuts_measured: number | null
          tuning_action_id: string | null
          user_id: string | null
        }
        Relationships: []
      }
      user_approved_products_view: {
        Row: {
          amazon_on_listing: boolean | null
          approval_status: string | null
          asin: string | null
          batch_no: number | null
          brand: string | null
          buy_box_price: number | null
          category: string | null
          checked_at: string | null
          created_at: string | null
          fba_offer_count: number | null
          hidden: boolean | null
          id: string | null
          image_url: string | null
          marketplace: string | null
          monthly_sold: number | null
          new_offer_count: number | null
          rating: number | null
          review_count: number | null
          sales_rank_current: number | null
          saved: boolean | null
          score: number | null
          title: string | null
          updated_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
      v_pl_reconciliation: {
        Row: {
          authoritative_source: string | null
          category: string | null
          difference: number | null
          fec_total: number | null
          period_month: number | null
          period_year: number | null
          settlement_total: number | null
          user_id: string | null
        }
        Relationships: []
      }
      v_repricer_eligibility_mismatches: {
        Row: {
          asin: string | null
          assignment_id: string | null
          derived_eligible: boolean | null
          derived_reason: string | null
          factors: Json | null
          is_enabled_actual: boolean | null
          marketplace_id: string | null
          matched: boolean | null
          observed_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _log_maintenance_job: {
        Args: {
          _action: string
          _after_bytes: number
          _before_bytes: number
          _error: string
          _params: Json
          _rows_affected: number
          _started_at: string
          _status: string
        }
        Returns: string
      }
      _raise_maintenance_alert: {
        Args: { _ctx: Json; _kind: string; _msg: string; _severity: string }
        Returns: undefined
      }
      _spapi_decrypt: { Args: { p_cipher: string }; Returns: string }
      _spapi_encrypt: { Args: { p_plain: string }; Returns: string }
      acknowledge_maintenance_alert: {
        Args: { _id: string }
        Returns: undefined
      }
      acquire_repricer_lock: {
        Args: {
          p_asin: string
          p_lock_owner: string
          p_marketplace: string
          p_ttl_seconds?: number
          p_user_id: string
        }
        Returns: boolean
      }
      acquire_sync_lock: {
        Args: {
          p_lock_name: string
          p_locked_by?: string
          p_ttl_seconds?: number
        }
        Returns: boolean
      }
      admin_approve_user: { Args: { _user_id: string }; Returns: undefined }
      admin_clean_dead_inventory: {
        Args: never
        Returns: {
          deleted_count: number
        }[]
      }
      admin_list_pending_users: {
        Args: never
        Returns: {
          created_at: string
          email: string
          first_name: string
          id: string
          last_name: string
        }[]
      }
      admin_reset_pg_stat_statements: { Args: never; Returns: Json }
      admin_retention_status: {
        Args: never
        Returns: {
          last_prune_at: string
          last_prune_status: string
          next_prune_at: string
          oldest_raw: string
          prune_active: boolean
          retention_days: number
          rows_over_retention: number
          table_name: string
        }[]
      }
      admin_revoke_user: { Args: { _user_id: string }; Returns: undefined }
      admin_table_size_estimates: {
        Args: { table_names: string[] }
        Returns: {
          estimated_rows: number
          last_analyze: string
          last_vacuum: string
          table_name: string
          total_bytes: number
        }[]
      }
      auto_resolve_business_health_issues: {
        Args: { _user_id?: string }
        Returns: number
      }
      bulk_apply_ship_to_hash: {
        Args: { p_pairs: Json; p_user_id: string }
        Returns: number
      }
      bump_source_retailer_stats: {
        Args: { p_stats: Json; p_user_id: string }
        Returns: undefined
      }
      capture_database_size_snapshot: { Args: never; Returns: undefined }
      capture_system_load: { Args: never; Returns: undefined }
      check_sync_parity: {
        Args: { p_days?: number; p_user_id: string }
        Returns: {
          check_date: string
          fec_count: number
          gap_type: string
          marketplace: string
          so_count: number
        }[]
      }
      claim_auto_source_budget: {
        Args: { p_user_id: string; p_wanted: number }
        Returns: number
      }
      claim_due_health_retries: {
        Args: { _limit?: number }
        Returns: {
          affected_entities: Json
          auto_fix_action: string
          display_category: string
          fingerprint: string
          id: string
          module: string
          retry_attempts: number
          user_id: string
        }[]
      }
      claim_keepa_tokens: {
        Args: { p_min_reserve?: number; p_tokens: number }
        Returns: {
          allowed: boolean
          tokens_left: number
          wait_seconds: number
        }[]
      }
      classify_health_display_category: {
        Args: { _fingerprint: string; _stuck_reason: string }
        Returns: string
      }
      classify_health_stuck_reason: {
        Args: { _fingerprint: string; _pattern_hint: string }
        Returns: string
      }
      cleanup_cron_history: { Args: { cutoff_ts: string }; Returns: number }
      cleanup_inventory_refresh_queue: { Args: never; Returns: number }
      cleanup_old_monitor_snapshots: { Args: never; Returns: number }
      cleanup_pg_cron_history: { Args: { _keep_days?: number }; Returns: Json }
      cleanup_pricing_suppression_check_queue: { Args: never; Returns: number }
      cleanup_repricer_ai_decisions: {
        Args: { _keep_days?: number }
        Returns: Json
      }
      cleanup_repricer_competitor_snapshots: {
        Args: { _keep_days?: number }
        Returns: Json
      }
      cleanup_repricer_dispatch_metrics: {
        Args: { _keep_days?: number }
        Returns: Json
      }
      cleanup_repricer_price_actions: {
        Args: { _keep_days?: number }
        Returns: Json
      }
      cleanup_repricer_simulation_items: {
        Args: { _keep_days?: number }
        Returns: Json
      }
      cleanup_repricer_suggestion_log: {
        Args: { _keep_days?: number }
        Returns: Json
      }
      compute_next_retry_at: { Args: { _attempt: number }; Returns: string }
      consume_api_token: {
        Args: { p_bucket: string; p_count?: number }
        Returns: {
          allowed: boolean
          tokens_left: number
          wait_ms: number
        }[]
      }
      count_active_repricer_users_1h: { Args: never; Returns: number }
      count_shipments_missing_items: { Args: never; Returns: number }
      count_unresolved_shipment_dates: { Args: never; Returns: number }
      debug_cron_jobs: {
        Args: never
        Returns: {
          active: boolean
          command: string
          jobid: number
          jobname: string
          schedule: string
        }[]
      }
      debug_cron_run_details: {
        Args: { p_jobid: number; p_limit?: number }
        Returns: {
          end_time: string
          jobid: number
          return_message: string
          runid: number
          start_time: string
          status: string
        }[]
      }
      debug_last_sale_dates: {
        Args: { p_asins: string[]; p_user_id: string }
        Returns: {
          asin: string
          last_order_date: string
          marketplace: string
        }[]
      }
      deduct_credits: {
        Args: { amount: number; user_id: string }
        Returns: undefined
      }
      delete_all_keepa_simple_products: { Args: never; Returns: number }
      dequeue_inventory_refresh: {
        Args: { p_limit?: number }
        Returns: {
          asin: string
          attempts: number
          id: string
          marketplace: string
          sku: string
          user_id: string
        }[]
      }
      dequeue_pricing_suppression_check: {
        Args: { p_limit?: number }
        Returns: {
          asin: string
          attempts: number
          id: string
          marketplace: string
          sku: string
          user_id: string
        }[]
      }
      derive_health_severity: {
        Args: {
          _attempt: number
          _display_category: string
          _emitted_severity: string
          _is_stuck: boolean
        }
        Returns: string
      }
      derive_repricer_eligibility: {
        Args: { _assignment_id: string }
        Returns: {
          asin: string
          assignment_id: string
          confidence: string
          current_is_enabled: boolean
          derived_reason: string
          derived_repricer_eligible: boolean
          derived_status_kind: string
          factors: Json
          marketplace: string
          sku: string
          source_timestamps: Json
        }[]
      }
      enqueue_full_inventory_refresh: {
        Args: { p_user_id: string }
        Returns: Json
      }
      enqueue_full_inventory_refresh_all_users: { Args: never; Returns: Json }
      enqueue_pricing_suppression_check: {
        Args: { p_user_id: string }
        Returns: Json
      }
      enqueue_pricing_suppression_check_all_users: {
        Args: never
        Returns: Json
      }
      estimate_cleanup: {
        Args: { _keep_days: number; _table_key: string }
        Returns: Json
      }
      evaluate_health_alerts: { Args: never; Returns: Json }
      expire_stale_new_listings: { Args: { p_days?: number }; Returns: number }
      flush_api_token_recent_consumption: { Args: never; Returns: number }
      get_active_strategy_state: {
        Args: { _asin: string; _marketplace_id?: string; _user_id: string }
        Returns: Database["public"]["Enums"]["repricer_strategy_state"]
      }
      get_authoritative_period_totals: {
        Args: { end_ts: string; start_ts: string }
        Returns: {
          cogs: number
          compensated_clawback_total: number
          customer_return_fees_total: number
          digital_services_fee_total: number
          disposal_fees_total: number
          fba_fees_total: number
          fixed_closing_fees_total: number
          free_replacement_total: number
          gift_wrap_credit_refunds_total: number
          gift_wrap_credits_total: number
          hrr_non_apparel_total: number
          inbound_convenience_fee_total: number
          inbound_fees_total: number
          liquidations_brokerage_total: number
          liquidations_total: number
          long_term_storage_fees_total: number
          marketplace_tax_refunds_total: number
          marketplace_tax_total: number
          other_fees_total: number
          other_income_total: number
          promotional_rebate_refunds_total: number
          promotional_rebates_total: number
          re_commerce_grading_total: number
          referral_fees_total: number
          refund_count: number
          refunds: number
          removal_fees_total: number
          reversal_reimbursement_total: number
          row_count: number
          sales: number
          shipping_credit_refunds_total: number
          shipping_credits_total: number
          storage_fees_total: number
          total_fees: number
          total_units: number
          unique_orders: number
          variable_closing_fees_total: number
          warehouse_damage_total: number
          warehouse_lost_total: number
        }[]
      }
      get_cleanup_savings: { Args: never; Returns: Json }
      get_cogs_for_range:
        | {
            Args: { p_end: string; p_start: string }
            Returns: {
              cogs_by_source: Json
              orders_with_cost: number
              total_cogs: number
              total_orders: number
              units_by_source: Json
              units_sold: number
            }[]
          }
        | {
            Args: { p_end: string; p_marketplace: string; p_start: string }
            Returns: {
              cogs_by_source: Json
              orders_with_cost: number
              total_cogs: number
              total_orders: number
              units_by_source: Json
              units_sold: number
            }[]
          }
      get_database_health: { Args: never; Returns: Json }
      get_db_growth_stats: { Args: never; Returns: Json }
      get_db_health_score: { Args: never; Returns: Json }
      get_db_performance_snapshot: { Args: never; Returns: Json }
      get_db_size_history: { Args: { _days?: number }; Returns: Json }
      get_fec_daily_shipment_totals: {
        Args: { p_end: string; p_marketplace?: string; p_start: string }
        Returns: {
          event_day: string
          marketplace: string
          sales: number
          units: number
        }[]
      }
      get_fec_month_counts: {
        Args: { p_end_date: string; p_start_date: string; p_user_id: string }
        Returns: {
          month_key: string
          sf_cnt: number
          ship_cnt: number
          total_cnt: number
        }[]
      }
      get_last_vacuum_full_per_table: { Args: never; Returns: Json }
      get_managed_listings_counts: {
        Args: { p_user_id: string }
        Returns: Json
      }
      get_monitor_assignment_stats: {
        Args: { p_today_start?: string; p_user_id: string }
        Returns: Json
      }
      get_monthly_cogs:
        | {
            Args: { p_year: number }
            Returns: {
              asins_missing_cost: number
              cogs: number
              month_num: number
              orders_missing_cost: number
              units_missing_cost: number
              units_sold: number
              units_with_cost: number
            }[]
          }
        | {
            Args: { p_marketplace: string; p_year: number }
            Returns: {
              asins_missing_cost: number
              cogs: number
              month_num: number
              orders_missing_cost: number
              units_missing_cost: number
              units_sold: number
              units_with_cost: number
            }[]
          }
      get_monthly_pl_breakdown:
        | {
            Args: { p_year: number }
            Returns: {
              compensated_clawback: number
              digital_services_fee: number
              fba_customer_return_fees: number
              fba_disposal_fees: number
              fba_fees: number
              fba_inbound_convenience_fee: number
              fba_inbound_fees: number
              fba_long_term_storage_fees: number
              fba_removal_fees: number
              fba_storage_fees: number
              fixed_closing_fees: number
              free_replacement_refund_items: number
              gift_wrap_credit_refunds: number
              gift_wrap_credits: number
              hrr_non_apparel: number
              intl_markets: number
              liquidations: number
              liquidations_brokerage_fee: number
              marketplace_facilitator_tax: number
              marketplace_facilitator_tax_refunds: number
              month_num: number
              other_fees: number
              other_income: number
              promotional_rebate_refunds: number
              promotional_rebates: number
              re_commerce_grading_charge: number
              referral_fees: number
              refunds: number
              reimbursements: number
              restocking_fee: number
              reversal_reimbursement: number
              sales: number
              sales_tax_collected: number
              sales_tax_refunds: number
              shipping_chargeback: number
              shipping_chargeback_refund: number
              shipping_credit_refunds: number
              shipping_credits: number
              variable_closing_fees: number
              warehouse_damage: number
              warehouse_lost: number
            }[]
          }
        | {
            Args: { p_marketplace: string; p_year: number }
            Returns: {
              compensated_clawback: number
              digital_services_fee: number
              fba_customer_return_fees: number
              fba_disposal_fees: number
              fba_fees: number
              fba_inbound_convenience_fee: number
              fba_inbound_fees: number
              fba_long_term_storage_fees: number
              fba_removal_fees: number
              fba_storage_fees: number
              fixed_closing_fees: number
              free_replacement_refund_items: number
              gift_wrap_credit_refunds: number
              gift_wrap_credits: number
              hrr_non_apparel: number
              intl_markets: number
              liquidations: number
              liquidations_brokerage_fee: number
              marketplace_facilitator_tax: number
              marketplace_facilitator_tax_refunds: number
              month_num: number
              other_fees: number
              other_income: number
              promotional_rebate_refunds: number
              promotional_rebates: number
              re_commerce_grading_charge: number
              referral_fees: number
              refunds: number
              reimbursements: number
              restocking_fee: number
              reversal_reimbursement: number
              sales: number
              sales_tax_collected: number
              sales_tax_refunds: number
              shipping_chargeback: number
              shipping_chargeback_refund: number
              shipping_credit_refunds: number
              shipping_credits: number
              variable_closing_fees: number
              warehouse_damage: number
              warehouse_lost: number
            }[]
          }
      get_nightly_maintenance_status: { Args: never; Returns: Json }
      get_pl_live_summary:
        | {
            Args: { end_ts: string; start_ts: string }
            Returns: {
              compensated_clawback: number
              digital_services_fee: number
              fba_customer_return_fees: number
              fba_disposal_fees: number
              fba_fees: number
              fba_inbound_convenience_fee: number
              fba_inbound_fees: number
              fba_long_term_storage_fees: number
              fba_removal_fees: number
              fba_storage_fees: number
              fixed_closing_fees: number
              free_replacement_refund_items: number
              gift_wrap_credit_refunds: number
              gift_wrap_credits: number
              hrr_non_apparel: number
              liquidations: number
              liquidations_brokerage_fee: number
              marketplace_facilitator_tax: number
              marketplace_facilitator_tax_refunds: number
              other_fees: number
              other_income: number
              promotional_rebate_refunds: number
              promotional_rebates: number
              re_commerce_grading_charge: number
              referral_fees: number
              refunds: number
              reimbursements: number
              reversal_reimbursement: number
              sales: number
              sales_tax_collected: number
              sales_tax_refunds: number
              shipping_credit_refunds: number
              shipping_credits: number
              total_expenses: number
              total_income: number
              variable_closing_fees: number
              warehouse_damage: number
              warehouse_lost: number
            }[]
          }
        | {
            Args: { end_ts: string; p_marketplace: string; start_ts: string }
            Returns: {
              compensated_clawback: number
              digital_services_fee: number
              fba_customer_return_fees: number
              fba_disposal_fees: number
              fba_fees: number
              fba_inbound_convenience_fee: number
              fba_inbound_fees: number
              fba_long_term_storage_fees: number
              fba_removal_fees: number
              fba_storage_fees: number
              fixed_closing_fees: number
              free_replacement_refund_items: number
              gift_wrap_credit_refunds: number
              gift_wrap_credits: number
              hrr_non_apparel: number
              liquidations: number
              liquidations_brokerage_fee: number
              marketplace_facilitator_tax: number
              marketplace_facilitator_tax_refunds: number
              other_fees: number
              other_income: number
              promotional_rebate_refunds: number
              promotional_rebates: number
              re_commerce_grading_charge: number
              referral_fees: number
              refunds: number
              reimbursements: number
              reversal_reimbursement: number
              sales: number
              sales_tax_collected: number
              sales_tax_refunds: number
              shipping_credit_refunds: number
              shipping_credits: number
              total_expenses: number
              total_income: number
              variable_closing_fees: number
              warehouse_damage: number
              warehouse_lost: number
            }[]
          }
      get_recommended_retentions: { Args: never; Returns: Json }
      get_reimbursement_pl_debug: {
        Args: { p_year: number }
        Returns: {
          final_displayed_reimbursements: number
          free_replacement_refund_items: number
          generic_reimbursements: number
          month_num: number
          reversal_reimbursement: number
        }[]
      }
      get_sellerboard_period_totals: {
        Args: { end_ts: string; start_ts: string }
        Returns: {
          cogs: number
          refund_count: number
          refunds: number
          row_count: number
          sales: number
          total_fees: number
          total_units: number
          unique_orders: number
        }[]
      }
      get_settled_period_totals: {
        Args: { end_ts: string; start_ts: string }
        Returns: {
          cogs: number
          gift_wrap_credits_total: number
          promotional_rebates_total: number
          refund_count: number
          refunds: number
          row_count: number
          sales: number
          shipment_units: number
          shipping_credits_total: number
          total_fees: number
          unique_orders: number
        }[]
      }
      get_shipment_accounting_period: {
        Args: { p_end: string; p_include_unresolved?: boolean; p_start: string }
        Returns: {
          amazon_inbound_fee: number
          cogs: number
          estimated_profit: number
          estimated_revenue: number
          manual_cost: number
          revenue_confidence: string
          shipment_date: string
          shipment_id: string
          shipment_name: string
          shipment_status: string
          total_cost: number
          units_received: number
          units_shipped: number
          unresolved_date: boolean
        }[]
      }
      get_shipment_backfill_status: {
        Args: { p_year: number }
        Returns: {
          completed_at: string
          items_upserted: number
          last_error: string
          next_page: number
          pages_processed: number
          shipment_status: string
          shipments_found: number
          shipments_upserted: number
          state: string
          updated_at: string
          window_end: string
          window_start: string
        }[]
      }
      get_smart_fallback_daily_totals: {
        Args: { end_ts: string; start_ts: string }
        Returns: {
          day: string
          fec_fees: number
          fec_gift_wrap_credits: number
          fec_orders: number
          fec_promo_rebates: number
          fec_refunds: number
          fec_sales: number
          fec_shipping_credits: number
          fec_units: number
          so_cogs: number
          so_fees: number
          so_orders: number
          so_promo_rebates: number
          so_refunds: number
          so_sales: number
          so_units: number
        }[]
      }
      get_spapi_credentials_decrypted: {
        Args: { p_user_id: string }
        Returns: {
          lwa_client_id: string
          lwa_client_secret: string
          marketplace: string
          refresh_token: string
          region: string
        }[]
      }
      get_year_cache_status: { Args: { p_year: number }; Returns: Json }
      has_any_module_access: {
        Args: {
          _module: Database["public"]["Enums"]["app_module"]
          _user_id: string
        }
        Returns: boolean
      }
      has_module_access: {
        Args: {
          _action: Database["public"]["Enums"]["app_action"]
          _module: Database["public"]["Enums"]["app_module"]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      ignore_business_health_pattern: {
        Args: { _hours?: number; _id: string }
        Returns: undefined
      }
      insert_download_record: {
        Args: {
          city: string
          country: string
          downloaded_at: string
          file_type: string
          ip_address: string
          latitude: number
          longitude: number
          region: string
          user_agent: string
        }
        Returns: boolean
      }
      is_active_created_listing: {
        Args: { _validation_status: string }
        Returns: boolean
      }
      is_ghost_inventory_row: {
        Args: {
          p_available: number
          p_inbound: number
          p_listing_status: string
          p_reserved: number
          p_sku: string
          p_unfulfilled: number
        }
        Returns: boolean
      }
      is_listing_validated: { Args: { _status: string }; Returns: boolean }
      is_self_approved: { Args: never; Returns: boolean }
      list_shipments_missing_items: {
        Args: { p_limit?: number }
        Returns: {
          created_at: string
          shipment_id: string
          shipment_name: string
          shipment_status: string
        }[]
      }
      list_shipments_needing_date_sync: {
        Args: { p_limit?: number; p_user_id: string }
        Returns: {
          shipment_id: string
        }[]
      }
      list_unresolved_shipments: {
        Args: { p_limit?: number }
        Returns: {
          confirmed_need_by_date: string
          created_at: string
          shipment_id: string
          shipment_name: string
          shipment_status: string
          units_shipped: number
        }[]
      }
      mark_inventory_refresh_error: {
        Args: { p_error: string; p_id: string; p_max_attempts?: number }
        Returns: undefined
      }
      mark_inventory_refresh_success: {
        Args: { p_id: string }
        Returns: undefined
      }
      mark_pricing_suppression_check_error: {
        Args: { p_error: string; p_id: string; p_max_attempts?: number }
        Returns: undefined
      }
      mark_pricing_suppression_check_success: {
        Args: { p_id: string }
        Returns: undefined
      }
      marketplace_to_currency: {
        Args: { p_marketplace: string }
        Returns: string
      }
      nextval_generated_invoice_seq: { Args: never; Returns: number }
      nightly_data_cleanup: { Args: never; Returns: Json }
      normalize_availability_text: { Args: { raw: string }; Returns: string }
      normalize_store_scan_scope_url: { Args: { raw: string }; Returns: string }
      observe_keepa_tokens:
        | { Args: { p_tokens_left: number }; Returns: undefined }
        | {
            Args: { p_refill_rate?: number; p_tokens_left: number }
            Returns: undefined
          }
      propagate_ship_to_hash_to_refunds: {
        Args: { p_user_id: string }
        Returns: number
      }
      prune_repricer_price_actions: {
        Args: { p_keep_days?: number }
        Returns: Json
      }
      purge_excluded_only_listings: {
        Args: { p_dry_run?: boolean }
        Returns: number
      }
      qualification_exclusion_preview: { Args: never; Returns: Json }
      recompute_pl_month_summary: {
        Args: { p_month_key: string; p_source?: string; p_user_id: string }
        Returns: undefined
      }
      reconcile_pending_revenue_review: {
        Args: never
        Returns: {
          open_after: number
          open_before: number
          repaired: number
          resolved: number
        }[]
      }
      record_cron_run: {
        Args: {
          p_detail?: Json
          p_duration_ms: number
          p_error: string
          p_items_processed: number
          p_job_name: string
          p_status: string
        }
        Returns: string
      }
      record_cron_run_finish: {
        Args: {
          p_id: number
          p_notes?: string
          p_rows?: number
          p_status?: string
        }
        Returns: undefined
      }
      record_cron_run_start: {
        Args: { p_job: string; p_overlap_window_minutes?: number }
        Returns: number
      }
      record_gemini_call: {
        Args: { p_caller?: string; p_ok: boolean; p_status?: number }
        Returns: undefined
      }
      record_health_retry_outcome: {
        Args: { _issue_id: string; _note?: string; _success: boolean }
        Returns: undefined
      }
      record_module_usage: {
        Args: { _label?: string; _path: string }
        Returns: undefined
      }
      record_search_api_call: {
        Args: {
          p_empty?: boolean
          p_ok: boolean
          p_provider: string
          p_status?: number
        }
        Returns: undefined
      }
      record_spapi_test_result: {
        Args: {
          p_error: string
          p_marketplaces: Json
          p_seller_id: string
          p_status: string
          p_user_id: string
        }
        Returns: undefined
      }
      refresh_customer_profile: {
        Args: { _customer_key: string; _user_id: string }
        Returns: undefined
      }
      release_all_repricer_locks: {
        Args: { p_lock_owner: string; p_user_id: string }
        Returns: undefined
      }
      release_auto_source_budget: {
        Args: { p_count: number; p_user_id: string }
        Returns: undefined
      }
      release_cron_lock:
        | { Args: { p_job_name: string }; Returns: undefined }
        | { Args: { p_holder: string; p_key: string }; Returns: undefined }
      release_inv_valuation_summary_lock: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      release_live_sales_summary_lock: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      release_repricer_lock: {
        Args: {
          p_asin: string
          p_lock_owner: string
          p_marketplace: string
          p_user_id: string
        }
        Returns: undefined
      }
      release_sync_lock: {
        Args: { p_lock_name: string; p_locked_by: string }
        Returns: undefined
      }
      release_user_sync_lock: { Args: { uid: string }; Returns: boolean }
      repair_sales_orders_asin_for_user: {
        Args: { p_days?: number; p_user_id: string }
        Returns: {
          deleted_duplicate_count: number
          repaired_count: number
        }[]
      }
      report_pending_revenue_review_weekly: { Args: never; Returns: number }
      repricer_asin_bb_days: {
        Args: {
          p_asins: string[]
          p_seller_ids: Json
          p_since: string
          p_user_id: string
        }
        Returns: {
          asin: string
          marketplace: string
          snapshot_day: string
          total_snapshots: number
          winning_snapshots: number
        }[]
      }
      repricer_asin_profile_days: {
        Args: {
          p_rule_id: string
          p_since: string
          p_user_id: string
          p_v2_cutover: string
        }
        Returns: {
          asin: string
          before_cutover: boolean
          cooldown_blocks: number
          decision_count: number
          first_seen: string
          floor_rejects: number
          last_seen: string
          marketplace: string
          raise_attempts: number
          rule_id: string
        }[]
      }
      repricer_asin_raises: {
        Args: {
          p_asins: string[]
          p_limit?: number
          p_since: string
          p_user_id: string
        }
        Returns: {
          asin: string
          created_at: string
          marketplace: string
          new_price: number
          old_price: number
          sku: string
        }[]
      }
      repricer_asin_sales_days: {
        Args: { p_asins: string[]; p_since: string; p_user_id: string }
        Returns: {
          asin: string
          cost: number
          fees: number
          marketplace: string
          order_count: number
          order_day: string
          revenue: number
          units: number
        }[]
      }
      repricer_cooldown_multiplier: {
        Args: { _state: Database["public"]["Enums"]["repricer_strategy_state"] }
        Returns: number
      }
      repricer_floor_relaxation_factor: {
        Args: {
          _days_since_sale?: number
          _state: Database["public"]["Enums"]["repricer_strategy_state"]
        }
        Returns: number
      }
      repricer_rule_perf_raise_safety: {
        Args: { p_since: string; p_user_id: string }
        Returns: {
          cooldown_blocks: number
          decision_day: string
          floor_rejects: number
          raise_attempts: number
          smart_profile: string
        }[]
      }
      repricer_rule_perf_raises: {
        Args: { p_limit?: number; p_since: string; p_user_id: string }
        Returns: {
          asin: string
          created_at: string
          marketplace: string
          new_price: number
          old_price: number
          sku: string
        }[]
      }
      repricer_rule_perf_sales: {
        Args: { p_since: string; p_user_id: string }
        Returns: {
          cost: number
          fees: number
          order_count: number
          order_day: string
          revenue: number
          smart_profile: string
          units: number
        }[]
      }
      repricer_translate_reason: { Args: { _reason: string }; Returns: string }
      resolve_business_health_issue: {
        Args: { _id: string; _reason?: string }
        Returns: undefined
      }
      resolve_cog_for_date: {
        Args: { p_asin: string; p_on_date: string; p_user_id: string }
        Returns: number
      }
      resolve_customer_key: {
        Args: {
          _buyer_email: string
          _buyer_id: string
          _buyer_name: string
          _ship_to_hash: string
        }
        Returns: string
      }
      resolve_unit_cost_v1: {
        Args: {
          p_asin: string
          p_order_date: string
          p_sku: string
          p_snapshot_unit_cost?: number
          p_user_id: string
        }
        Returns: {
          source: string
          unit_cost: number
        }[]
      }
      run_analytics_query: { Args: { query_text: string }; Returns: Json }
      run_nightly_maintenance: { Args: never; Returns: Json }
      run_nightly_maintenance_now: { Args: never; Returns: Json }
      save_mobile_scan_cost_memory: {
        Args: {
          _asin: string
          _barcode?: string
          _sale_price_override?: number
          _total_cost?: number
          _units?: number
        }
        Returns: {
          asin: string | null
          barcode: string | null
          created_at: string
          id: string
          sale_price_override: number | null
          total_cost: number | null
          units: number | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "mobile_scan_cost_memory"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_spapi_credentials: {
        Args: {
          p_lwa_client_id: string
          p_lwa_client_secret: string
          p_marketplace?: string
          p_refresh_token: string
          p_region?: string
          p_user_id: string
        }
        Returns: undefined
      }
      set_shipment_manual_ship_date: {
        Args: { p_ship_date: string; p_shipment_id: string }
        Returns: undefined
      }
      should_throttle_now: { Args: never; Returns: string }
      snapshot_repricer_eligibility: {
        Args: { _limit?: number }
        Returns: {
          inserted_count: number
          mismatch_count: number
          scanned_count: number
        }[]
      }
      try_acquire_cron_lock:
        | {
            Args: { p_job_name: string; p_ttl_seconds?: number }
            Returns: boolean
          }
        | {
            Args: { p_holder: string; p_key: string; p_ttl_seconds?: number }
            Returns: boolean
          }
      try_acquire_inv_valuation_summary_lock: {
        Args: {
          p_caller: string
          p_max_age_seconds?: number
          p_user_id: string
        }
        Returns: boolean
      }
      try_acquire_live_sales_summary_lock: {
        Args: {
          p_caller: string
          p_max_age_seconds?: number
          p_user_id: string
        }
        Returns: boolean
      }
      try_user_sync_lock: {
        Args: { ttl_seconds?: number; uid: string }
        Returns: boolean
      }
      update_maintenance_setting: {
        Args: { _enabled: boolean; _retention_days: number; _table_key: string }
        Returns: {
          cleanup_rpc: string
          description: string | null
          enabled: boolean
          retention_days: number
          schema_name: string
          table_key: string
          table_name: string
          timestamp_column: string
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "database_maintenance_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_business_health_issue: {
        Args: {
          _auto_fix_action: string
          _confidence: string
          _entity: Json
          _fingerprint: string
          _function_name: string
          _impact: string
          _module: string
          _raw_message: string
          _recommended_fix: string
          _route: string
          _severity: string
          _source: string
          _title: string
          _user_id: string
        }
        Returns: string
      }
    }
    Enums: {
      app_action: "view" | "run" | "edit" | "admin"
      app_module:
        | "repricer"
        | "inventory"
        | "reports"
        | "supplier_discovery"
        | "product_library"
        | "personalhour"
        | "settings"
        | "admin_panel"
        | "fba_builder"
        | "profit_loss"
        | "buy_again"
        | "still_thinking"
        | "mobile_live_sales"
        | "mobile_inventory_valuation"
        | "upc_scanner"
        | "scan_history"
      app_role: "admin" | "user" | "monitor" | "viewer"
      disposition_outcome:
        | "pending"
        | "returned_to_inventory"
        | "sold_elsewhere"
        | "disposed"
        | "partial_recovery"
        | "restricted_unsold"
      disposition_source: "amazon_report" | "manual" | "csv_import"
      disposition_status: "pending_review" | "accepted" | "ignored" | "adjusted"
      disposition_type: "removal" | "disposal" | "liquidation" | "mfn_return"
      repricer_action_status: "queued" | "applied" | "failed" | "skipped"
      repricer_condition_scope: "New" | "Used" | "Any"
      repricer_floor_source: "manual" | "cost_plus" | "roi_based"
      repricer_fulfillment_scope: "FBA" | "FBM" | "BOTH"
      repricer_strategy:
        | "MATCH_LOWEST_FBA_MINUS"
        | "MATCH_LOWEST_OVERALL_MINUS"
        | "STAY_WITHIN_BUYBOX_RANGE"
        | "BEAT_BUYBOX_MINUS"
        | "BEAT_SPECIFIC_SELLER_MINUS"
        | "MIN_PROFIT_GUARD"
        | "AI_WIN_SALES_BOOSTER"
      repricer_strategy_state:
        | "profit_max"
        | "competitive_recovery"
        | "inventory_liquidation"
        | "buybox_defense"
        | "velocity_boost"
        | "aged_pressure"
        | "clearance"
      research_lead_decision: "UNDECIDED" | "BUY" | "SKIP" | "MAYBE"
      team_invite_status: "pending" | "accepted" | "revoked"
      team_role: "owner" | "admin" | "manager" | "viewer"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_action: ["view", "run", "edit", "admin"],
      app_module: [
        "repricer",
        "inventory",
        "reports",
        "supplier_discovery",
        "product_library",
        "personalhour",
        "settings",
        "admin_panel",
        "fba_builder",
        "profit_loss",
        "buy_again",
        "still_thinking",
        "mobile_live_sales",
        "mobile_inventory_valuation",
        "upc_scanner",
        "scan_history",
      ],
      app_role: ["admin", "user", "monitor", "viewer"],
      disposition_outcome: [
        "pending",
        "returned_to_inventory",
        "sold_elsewhere",
        "disposed",
        "partial_recovery",
        "restricted_unsold",
      ],
      disposition_source: ["amazon_report", "manual", "csv_import"],
      disposition_status: ["pending_review", "accepted", "ignored", "adjusted"],
      disposition_type: ["removal", "disposal", "liquidation", "mfn_return"],
      repricer_action_status: ["queued", "applied", "failed", "skipped"],
      repricer_condition_scope: ["New", "Used", "Any"],
      repricer_floor_source: ["manual", "cost_plus", "roi_based"],
      repricer_fulfillment_scope: ["FBA", "FBM", "BOTH"],
      repricer_strategy: [
        "MATCH_LOWEST_FBA_MINUS",
        "MATCH_LOWEST_OVERALL_MINUS",
        "STAY_WITHIN_BUYBOX_RANGE",
        "BEAT_BUYBOX_MINUS",
        "BEAT_SPECIFIC_SELLER_MINUS",
        "MIN_PROFIT_GUARD",
        "AI_WIN_SALES_BOOSTER",
      ],
      repricer_strategy_state: [
        "profit_max",
        "competitive_recovery",
        "inventory_liquidation",
        "buybox_defense",
        "velocity_boost",
        "aged_pressure",
        "clearance",
      ],
      research_lead_decision: ["UNDECIDED", "BUY", "SKIP", "MAYBE"],
      team_invite_status: ["pending", "accepted", "revoked"],
      team_role: ["owner", "admin", "manager", "viewer"],
    },
  },
} as const
