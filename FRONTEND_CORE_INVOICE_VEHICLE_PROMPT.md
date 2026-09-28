# Frontend implementation prompt: vehicle selection for Car Service invoices

Update the existing Eastern Risen Core Admin frontend invoice create/edit/detail
flow to support the Core API's category-driven vehicle requirement. Use the
existing frontend architecture, API client, form library, components and styling.
Do not create a parallel invoice form or hard-code category names or HSN/SAC codes.

## API contract

- `GET /api/v1/core/service-categories` returns `requiresVehicle: boolean` on every
  category.
- `GET /api/v1/core/vehicles?page=1&pageSize=100` returns the shared vehicle catalog.
  Only vehicles with `status: "ACTIVE"` may be selected.
- Invoice create and full-update bodies accept `vehicleId?: string | null`.
- For a category with `requiresVehicle: true`, `vehicleId` is required.
- For every other category, `vehicleId` must be absent or `null`.
- Invoice list/detail responses contain top-level `vehicleId`, `details.vehicleId`,
  and `snapshot.vehicle`. A vehicle snapshot has `id`, `name`,
  `registrationNumber`, and `vehicleType`.
- Invalid category/vehicle combinations return the standard Core API error envelope
  with HTTP 422. A stale invoice version continues to return HTTP 409.

## Required form behaviour

1. Resolve the selected service-category object from the categories already loaded
   for the form. Use its `requiresVehicle` value as the only condition.
2. When `requiresVehicle` is true, show a required searchable Vehicle field directly
   after Service Category. Load active vehicles from the Core vehicles endpoint.
3. Render options as `registrationNumber — displayName (vehicleType)` so similarly
   named vehicles can be distinguished.
4. When `requiresVehicle` is false, hide the Vehicle field and set the submitted
   `vehicleId` to `null`. Clear any previous vehicle immediately when the category is
   changed from a vehicle-requiring category to another category.
5. Block save/issue client-side when a required vehicle is missing, while still
   displaying the server's 422 message if validation fails remotely.
6. While editing a draft, initialize the field from `details.vehicleId` and fall back
   to top-level `vehicleId` for compatibility. Never permit edits on issued or
   cancelled invoices.
7. On invoice detail and print-oriented views, show a Vehicle section only when
   `snapshot.vehicle` is non-null. Display its registration number, name and vehicle
   type from the snapshot—not from the current vehicle master.
8. Preserve all existing invoice totals, taxes, version handling, loading states,
   keyboard behaviour, validation and error presentation.

## Service-category administration

Add a `Requires vehicle` checkbox to service-category create/edit forms. Send its
boolean value as `requiresVehicle`. Show a compact indicator in the category list so
administrators can verify that Car Service is configured correctly. Do not infer or
silently change the flag when the category name is edited.

## Acceptance cases

- Car Service configured with `requiresVehicle: true` cannot be saved without a
  vehicle.
- Selecting an active vehicle saves successfully and reloads with the same vehicle.
- Changing the category to one that does not require a vehicle clears `vehicleId`
  before submission.
- Non-vehicle categories never submit a stale vehicle selection.
- Invoice detail uses the immutable snapshot after the vehicle master is renamed.
- Existing invoices without a vehicle continue to render without errors.
- Service-category create/edit accurately persists both true and false values.
