export interface CustomFieldMapping {
  name: string;
  template: string;
}

export interface MappingConfig {
  locationName: string;
  locationDescription: string;
  itemName: string;
  itemDescription: string;
  itemNotes: string;
  itemQuantity: string;
  itemTags: string;
  itemAssetId: string;
  customFields: CustomFieldMapping[];
  useExistingLocations: boolean;
  uploadImages: boolean;
  createMissingTags: boolean;
  skipExistingByImportRef: boolean;
}

export const DEFAULT_MAPPING: MappingConfig = {
  locationName: "{title}",
  locationDescription:
    "Totescan ID: {toteId}\nOriginal location: {location}\nProfile: {profile}\nLast updated: {dateUpdated}",
  itemName: "{name}",
  itemDescription: "{description}",
  itemNotes: "Converted from ToteScan. Created {created}, Updated {updated}.",
  itemQuantity: "{quantity}",
  itemTags: "{profile}",
  itemAssetId: "",
  customFields: [
    { name: "Scan Code", template: "{toteId}" },
    { name: "UPC", template: "{upc}" },
  ],
  useExistingLocations: true,
  uploadImages: true,
  createMissingTags: true,
  skipExistingByImportRef: true,
};

export const TOTE_VARIABLES = ["toteId", "title", "location", "profile", "parentToteId", "dateUpdated"];
export const ITEM_VARIABLES = [
  "name",
  "itemNumber",
  "quantity",
  "description",
  "upc",
  "created",
  "updated",
  "toteId",
  "title",
  "profile",
  "location",
];

// Stable import_ref key used for idempotent re-runs.
export function buildImportRef(toteId: string, itemNumber: number): string {
  return `totescan-${toteId}-${itemNumber}`;
}
