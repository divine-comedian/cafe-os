export type Status = "draft" | "confirmed" | "void";

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
  status: Status;
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
  variety: string;
  notes: string | null;
  created_at: string;
}

export interface RoastBatch {
  id: string;
  green_coffee_lot_id: string;
  name: string | null;
  roasted_at: string | null;
  status: Status;
  green_input_kg: string | number | null;
  roasted_output_kg: string | number | null;
  duration_seconds: number | null;
  notes: string | null;
  created_at: string;
}

export interface OperationsData {
  providers: Provider[];
  purchases: Purchase[];
  lots: CoffeeLot[];
  roasts: RoastBatch[];
}

export type EntryKind = "provider" | "purchase" | "lot" | "roast";
export type View = "dashboard" | "providers" | "purchases" | "lots" | "roasts";
