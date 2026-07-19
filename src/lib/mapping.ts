export interface MappingConfig {
  locationName: string;
  locationDescription: string;
  itemName: string;
  itemDescription: string;
  itemAssetId: string;
  useExistingLocations: boolean;
  uploadImages: boolean;
}

export const DEFAULT_MAPPING: MappingConfig = {
  locationName: "{title}",
  locationDescription:
    "Totescan ID: {toteId}\nOriginal location: {location}\nProfile: {profile}\nLast updated: {dateUpdated}",
  itemName: "{name}",
  itemDescription: "{description}",
  itemAssetId: "",
  useExistingLocations: true,
  uploadImages: true,
};

export const TOTE_VARIABLES = ["toteId", "title", "location", "profile", "parentToteId", "dateUpdated"];
export const ITEM_VARIABLES = ["name", "itemNumber", "quantity", "description", "upc", "toteId", "title"];
