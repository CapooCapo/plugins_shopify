export const CATALOG_FIELDS = [
  "productName", "sku", "price", "description", "productGroupCode", "size", "color", "vendor", "productType", "imageUrl",
] as const;
export type CatalogField = (typeof CATALOG_FIELDS)[number];

const aliases: Record<CatalogField, string[]> = {
  productName: ["product name", "name", "title", "ten san pham", "ten sp", "san pham"],
  sku: ["sku", "item sku", "product sku", "ma sku", "ma san pham", "ma hang"],
  price: ["price", "unit price", "gia", "don gia", "gia ban"],
  description: ["description", "product description", "mo ta", "mo ta san pham"],
  productGroupCode: ["product group code", "group code", "style code", "ma nhom san pham", "ma mau hang"],
  size: ["size", "kich thuoc", "co"], color: ["color", "colour", "mau sac", "mau"],
  vendor: ["vendor", "brand", "supplier", "thuong hieu", "nha cung cap"],
  productType: ["product type", "type", "loai san pham"],
  imageUrl: ["image url", "image", "image link", "anh", "url hinh anh", "duong dan hinh anh"],
};

function normalizeHeader(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/đ/g, "d").replace(/[^a-z0-9]+/g, " ").trim();
}

export function suggestCatalogField(header: string): CatalogField | null {
  const normalized = normalizeHeader(header);
  if (!normalized || /\b(quantity|qty|inventory|stock)\b/.test(normalized)) return null;
  return CATALOG_FIELDS.find((field) => aliases[field].some((alias) => normalizeHeader(alias) === normalized)) ?? null;
}
