// Key names in the shared store (no imports: the migration script loads this file directly).
export const storeKeys = {
  business: (id: string) => `biz:${id}`,
  shared: "shared",
  owner: (ownerHash: string) => `owner:${ownerHash}`,
  slug: (slug: string) => `slug:${slug}`,
};
