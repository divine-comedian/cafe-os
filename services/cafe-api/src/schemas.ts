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

export const IdParams = Type.Object({ id: Uuid }, options);
export const PaginationQuery = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  },
  options,
);

const paginationFields = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
};
const nameField = Type.Optional(Type.String({ minLength: 1, maxLength: 160 }));

export const ProviderListQuery = Type.Object({ ...paginationFields, name: nameField }, options);

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
    purchased_at: DateString,
    total_amount: Type.Optional(NullableDecimal),
    currency: Type.Optional(Type.String({ default: "MXN" })),
    payment_method: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  options,
);

export const PurchasePatchSchema = Type.Object(
  {
    provider_id: Type.Optional(Uuid),
    purchased_at: Type.Optional(DateString),
    total_amount: Type.Optional(NullableDecimal),
    currency: Type.Optional(Type.String()),
    payment_method: Type.Optional(NullableString),
    notes: Type.Optional(NullableString),
  },
  patchOptions,
);

export const GreenCoffeeCreateSchema = Type.Object(
  {
    purchase_id: Uuid,
    name: Type.Optional(NullableString),
    origin: Type.Optional(NullableString),
    variety: Type.Optional(NullableString),
    received_weight_kg: DecimalInput,
    unit_cost_per_kg: DecimalInput,
    notes: Type.Optional(NullableString),
  },
  options,
);

export const GreenCoffeePatchSchema = Type.Object(
  {
    purchase_id: Type.Optional(Uuid),
    name: Type.Optional(NullableString),
    origin: Type.Optional(NullableString),
    variety: Type.Optional(NullableString),
    received_weight_kg: Type.Optional(DecimalInput),
    unit_cost_per_kg: Type.Optional(DecimalInput),
    notes: Type.Optional(NullableString),
  },
  patchOptions,
);

export const RoastBatchCreateSchema = Type.Object(
  {
    green_coffee_lot_id: Uuid,
    name: Type.Optional(NullableString),
    roasted_at: Type.Optional(Type.Union([DateTimeString, Type.Null()])),
    green_input_kg: Type.Optional(NullableDecimal),
    roasted_output_kg: Type.Optional(NullableDecimal),
    duration_seconds: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    ),
    machine_settings: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    ),
    notes: Type.Optional(NullableString),
  },
  options,
);

export const RoastBatchPatchSchema = Type.Object(
  {
    green_coffee_lot_id: Type.Optional(Uuid),
    name: Type.Optional(NullableString),
    roasted_at: Type.Optional(Type.Union([DateTimeString, Type.Null()])),
    green_input_kg: Type.Optional(NullableDecimal),
    roasted_output_kg: Type.Optional(NullableDecimal),
    duration_seconds: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    ),
    machine_settings: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    ),
    notes: Type.Optional(NullableString),
  },
  patchOptions,
);

export const PurchaseListQuery = Type.Object(
  {
    ...paginationFields,
    provider_id: Type.Optional(Uuid),
    purchased_at: Type.Optional(DateString),
    status: Type.Optional(Type.Union([
      Type.Literal("draft"),
      Type.Literal("confirmed"),
      Type.Literal("void"),
    ])),
  },
  options,
);

export const GreenCoffeeListQuery = Type.Object(
  { ...paginationFields, name: nameField, purchase_id: Type.Optional(Uuid) },
  options,
);

export const RoastBatchListQuery = Type.Object(
  {
    ...paginationFields,
    name: nameField,
    green_coffee_lot_id: Type.Optional(Uuid),
    status: Type.Optional(Type.Union([
      Type.Literal("draft"),
      Type.Literal("confirmed"),
      Type.Literal("void"),
    ])),
  },
  options,
);

export type IdParamsType = Static<typeof IdParams>;
export type PaginationQueryType = Static<typeof PaginationQuery>;
export type ProviderListQueryType = Static<typeof ProviderListQuery>;
export type ProviderCreate = Static<typeof ProviderCreateSchema>;
export type ProviderPatch = Static<typeof ProviderPatchSchema>;
export type PurchaseCreate = Static<typeof PurchaseCreateSchema>;
export type PurchasePatch = Static<typeof PurchasePatchSchema>;
export type GreenCoffeeCreate = Static<typeof GreenCoffeeCreateSchema>;
export type GreenCoffeePatch = Static<typeof GreenCoffeePatchSchema>;
export type RoastBatchCreate = Static<typeof RoastBatchCreateSchema>;
export type RoastBatchPatch = Static<typeof RoastBatchPatchSchema>;
export type PurchaseListQueryType = Static<typeof PurchaseListQuery>;
export type GreenCoffeeListQueryType = Static<typeof GreenCoffeeListQuery>;
export type RoastBatchListQueryType = Static<typeof RoastBatchListQuery>;
