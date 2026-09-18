import { Static, Type } from "@sinclair/typebox";

const options = { additionalProperties: false } as const;
const patchOptions = { additionalProperties: false, minProperties: 1 } as const;

export const Uuid = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
export const DateString = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
export const DateTimeString = Type.String({ minLength: 1 });
export const DecimalInput = Type.Union([
  Type.Number(),
  Type.String({ pattern: "^-?(?:\\d+\\.?\\d*|\\.\\d+)$" }),
]);
export const NullableString = Type.Union([Type.String(), Type.Null()]);
export const NullableDecimal = Type.Union([DecimalInput, Type.Null()]);

export const RoastCheckpointSchema = Type.Object(
  {
    elapsed_seconds: Type.Integer({ minimum: 0 }),
    temperature_c: Type.Optional(NullableDecimal),
    airflow_setting: Type.Optional(NullableDecimal),
    gas_setting: Type.Optional(NullableDecimal),
    note: Type.Optional(NullableString),
  },
  options,
);

export const IdParams = Type.Object({ id: Uuid }, options);
const paginationProperties = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
};

export const PaginationQuery = Type.Object(paginationProperties, options);

const nameField = Type.Optional(Type.String({ minLength: 1, maxLength: 160 }));

export const ProviderListQuery = Type.Object({ ...paginationProperties, name: nameField }, options);

export const ProviderCreateSchema = Type.Object(
  {
    name: Type.String(),
    region: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  options,
);

export const ProviderPatchSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    region: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  patchOptions,
);

export const PurchaseCreateSchema = Type.Object(
  {
    provider_id: Uuid,
    green_coffee_lot_id: Uuid,
    purchased_at: Type.Optional(Type.Union([DateString, Type.Null()])),
    received_weight_kg: DecimalInput,
    total_amount: Type.Optional(NullableDecimal),
    currency: Type.Optional(Type.String({ default: "MXN" })),
    payment_method: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  options,
);

export const PurchaseWithGreenCoffeeLotCreateSchema = Type.Object(
  {
    provider_id: Uuid,
    purchased_at: Type.Optional(Type.Union([DateString, Type.Null()])),
    total_amount: DecimalInput,
    currency: Type.Optional(Type.String({ default: "MXN" })),
    payment_method: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
    green_coffee_lot_id: Type.Optional(Uuid),
    new_green_coffee_lot: Type.Optional(Type.Object(
      {
        name: Type.String(),
        origin: Type.Optional(NullableString),
        variety: Type.Optional(NullableString),
        notes: Type.Optional(NullableString),
      },
      options,
    )),
    received_weight_kg: DecimalInput,
  },
  options,
);

export const PurchasePatchSchema = Type.Object(
  {
    provider_id: Type.Optional(Uuid),
    green_coffee_lot_id: Type.Optional(Uuid),
    purchased_at: Type.Optional(Type.Union([DateString, Type.Null()])),
    received_weight_kg: Type.Optional(DecimalInput),
    total_amount: Type.Optional(NullableDecimal),
    currency: Type.Optional(Type.String()),
    payment_method: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  patchOptions,
);

export const GreenCoffeeCreateSchema = Type.Object(
  {
    name: Type.String(),
    origin: Type.Optional(NullableString),
    variety: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  options,
);

export const GreenCoffeePatchSchema = Type.Object(
  {
    name: Type.Optional(Type.String()),
    origin: Type.Optional(NullableString),
    variety: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  patchOptions,
);

export const RoastBatchCreateSchema = Type.Object(
  {
    green_coffee_lot_id: Uuid,
    name: Type.Optional(NullableString),
    roast_date: Type.Optional(Type.Union([DateString, Type.Null()])),
    roasted_at: Type.Optional(Type.Union([DateTimeString, Type.Null()])),
    green_input_kg: Type.Optional(NullableDecimal),
    roasted_output_kg: Type.Optional(NullableDecimal),
    duration_seconds: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    ),
    machine_settings: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    ),
    charge_temperature_c: Type.Optional(NullableDecimal),
    balance_point_temperature_c: Type.Optional(NullableDecimal),
    setup_notes: Type.Optional(NullableString),
    checkpoints: Type.Optional(Type.Array(RoastCheckpointSchema)),
    sensory_rating: Type.Optional(Type.Union([
      Type.Integer({ minimum: 1, maximum: 5 }),
      Type.Null(),
    ])),
    tasting_notes: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  options,
);

export const RoastBatchPatchSchema = Type.Object(
  {
    green_coffee_lot_id: Type.Optional(Uuid),
    name: Type.Optional(NullableString),
    roast_date: Type.Optional(Type.Union([DateString, Type.Null()])),
    roasted_at: Type.Optional(Type.Union([DateTimeString, Type.Null()])),
    green_input_kg: Type.Optional(NullableDecimal),
    roasted_output_kg: Type.Optional(NullableDecimal),
    duration_seconds: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    ),
    machine_settings: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    ),
    charge_temperature_c: Type.Optional(NullableDecimal),
    balance_point_temperature_c: Type.Optional(NullableDecimal),
    setup_notes: Type.Optional(NullableString),
    checkpoints: Type.Optional(Type.Array(RoastCheckpointSchema)),
    sensory_rating: Type.Optional(Type.Union([
      Type.Integer({ minimum: 1, maximum: 5 }),
      Type.Null(),
    ])),
    tasting_notes: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  patchOptions,
);

export const RoastBatchVoidSchema = Type.Object(
  {
    reason: Type.Optional(Type.String({ minLength: 1 })),
  },
  options,
);

export const PurchaseListQuery = Type.Object(
  {
    ...paginationProperties,
    provider_id: Type.Optional(Uuid),
    green_coffee_lot_id: Type.Optional(Uuid),
    purchased_at: Type.Optional(DateString),
  },
  options,
);

export const GreenCoffeeListQuery = Type.Object(
  { ...paginationProperties, name: nameField },
  options,
);

export const RoastBatchListQuery = Type.Object(
  {
    ...paginationProperties,
    name: nameField,
    green_coffee_lot_id: Type.Optional(Uuid),
  },
  options,
);

export type IdParamsType = Static<typeof IdParams>;
export type PaginationQueryType = Static<typeof PaginationQuery>;
export type ProviderListQueryType = Static<typeof ProviderListQuery>;
export type ProviderCreate = Static<typeof ProviderCreateSchema>;
export type ProviderPatch = Static<typeof ProviderPatchSchema>;
export type PurchaseCreate = Static<typeof PurchaseCreateSchema>;
export type PurchaseWithGreenCoffeeLotCreate = Static<
  typeof PurchaseWithGreenCoffeeLotCreateSchema
>;
export type PurchasePatch = Static<typeof PurchasePatchSchema>;
export type GreenCoffeeCreate = Static<typeof GreenCoffeeCreateSchema>;
export type GreenCoffeePatch = Static<typeof GreenCoffeePatchSchema>;
export type RoastBatchCreate = Static<typeof RoastBatchCreateSchema>;
export type RoastBatchPatch = Static<typeof RoastBatchPatchSchema>;
export type RoastBatchVoid = Static<typeof RoastBatchVoidSchema>;
export type PurchaseListQueryType = Static<typeof PurchaseListQuery>;
export type GreenCoffeeListQueryType = Static<typeof GreenCoffeeListQuery>;
export type RoastBatchListQueryType = Static<typeof RoastBatchListQuery>;
