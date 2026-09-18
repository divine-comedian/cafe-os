export interface Provider {
  id: string;
  name: string;
  region: string | null;
  notes: string | null;
  created_at: string;
}

export interface Purchase {
  id: string;
  provider_id: string;
  green_coffee_lot_id: string;
  purchased_at: string | null;
  received_weight_kg: string | number;
  total_amount: string | number | null;
  currency: string;
  payment_method: string | null;
  document_path: string | null;
  notes: string | null;
  created_at: string;
}

export interface CoffeeLot {
  id: string;
  name: string;
  origin: string | null;
  variety: string | null;
  notes: string | null;
  created_at: string;
}

export interface RoastBatch {
  id: string;
  green_coffee_lot_id: string;
  name: string | null;
  roast_date: string | null;
  roasted_at: string | null;
  green_input_kg: string | number | null;
  roasted_output_kg: string | number | null;
  duration_seconds: number | null;
  machine_settings: Record<string, unknown> | null;
  charge_temperature_c: string | number | null;
  balance_point_temperature_c: string | number | null;
  setup_notes: string | null;
  checkpoints: Array<{
    elapsed_seconds: number;
    temperature_c?: string | number | null;
    airflow_setting?: string | number | null;
    gas_setting?: string | number | null;
    note?: string | null;
  }>;
  sensory_rating: number | null;
  tasting_notes: string | null;
  notes: string | null;
  voided_at: string | null;
  void_reason: string | null;
  completion: { is_complete: boolean; missing_fields: string[] };
  created_at: string;
  updated_at: string;
}

export interface OperationsData {
  providers: Provider[];
  purchases: Purchase[];
  lots: CoffeeLot[];
  roasts: RoastBatch[];
}

export type EntryKind = "provider" | "purchase" | "lot" | "roast";
export type View = "dashboard" | "providers" | "purchases" | "lots" | "roasts";
