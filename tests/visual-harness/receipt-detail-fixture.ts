const createdAt = new Date("2026-10-28T08:00:00.000Z");
const updatedAt = new Date("2026-10-28T08:15:00.000Z");

type FixtureLine = {
  id: string;
  rowNumber: number;
  sku: string;
  title: string;
  matchedProductTitle: string | null;
  matchedVariantTitle: string | null;
  description: string;
  price: string | null;
  quantity: number;
  expectedQuantity: number | null;
  operationType: string;
  status: string;
  stage: string;
  errorCode: string | null;
  errorDetail: string | null;
  productId: string | null;
  variantId: string | null;
  inventoryItemId: string | null;
  imageUrl: string | null;
};

function line(rowNumber: number, input: Partial<FixtureLine> & Pick<FixtureLine, "sku" | "title">): FixtureLine {
  const operationType = input.operationType ?? "ADJUST";
  return {
    id: `fixture-line-${rowNumber}`,
    rowNumber,
    sku: input.sku,
    title: input.title,
    matchedProductTitle: input.matchedProductTitle ?? input.title,
    matchedVariantTitle: input.matchedVariantTitle ?? "Default variant",
    description: "Local visual-harness receipt row; no Shopify request is made.",
    price: "18.00",
    quantity: rowNumber + 2,
    expectedQuantity: operationType === "ADJUST" ? 4 : null,
    operationType,
    status: input.status ?? "PREVIEWED",
    stage: input.stage ?? "PREPARED",
    errorCode: input.errorCode ?? null,
    errorDetail: input.errorDetail ?? null,
    productId: operationType === "ADJUST" ? `gid://shopify/Product/${1000 + rowNumber}` : null,
    variantId: operationType === "ADJUST" ? `gid://shopify/ProductVariant/${2000 + rowNumber}` : null,
    inventoryItemId: operationType === "ADJUST" ? `gid://shopify/InventoryItem/${3000 + rowNumber}` : null,
    imageUrl: null,
  };
}

const readyLines = [
  line(1, { sku: "SKU-READY-ADJUST-01", title: "Alpine Merino Crewneck", operationType: "ADJUST" }),
  line(2, { sku: "SKU-READY-DRAFT-02", title: "Cedar Travel Pouch", operationType: "CREATE_DRAFT", matchedProductTitle: null, matchedVariantTitle: null }),
  line(3, { sku: "SKU-MISSING-03", title: "Northwind Parka", status: "BLOCKED", operationType: "BLOCKED", errorCode: "NEW_PRODUCT_FIELDS_MISSING", errorDetail: "Missing required title and price for this new SKU." }),
  line(4, { sku: "SKU-CSV-MISSING-04", title: "Canvas Market Tote", status: "BLOCKED", operationType: "BLOCKED", errorCode: "CSV_INVALID_ROW", errorDetail: "The SKU value is blank in this CSV row." }),
  line(5, { sku: "SKU-CSV-MISSING-05", title: "Canvas Market Tote - Small", status: "BLOCKED", operationType: "BLOCKED", errorCode: "CSV_INVALID_ROW", errorDetail: "  the SKU value is blank in this CSV row. " }),
  line(6, { sku: "SKU-CSV-QUANTITY-06", title: "Stoneware Mug", status: "BLOCKED", operationType: "BLOCKED", errorCode: "CSV_INVALID_ROW", errorDetail: "Quantity must be a positive integer." }),
  line(7, { sku: "SKU-CSV-QUANTITY-07", title: "Stoneware Mug - Large", status: "BLOCKED", operationType: "BLOCKED", errorCode: "CSV_INVALID_ROW", errorDetail: "Quantity must be a positive integer." }),
  line(8, { sku: "SKU-TRACKING-08", title: "Brass Desk Lamp", status: "BLOCKED", operationType: "BLOCKED", errorCode: "INVENTORY_NOT_TRACKED", errorDetail: "This matched Shopify variant is not tracking inventory." }),
  line(9, { sku: "SKU-TRACKING-09", title: "Brass Desk Lamp - Tall", status: "BLOCKED", operationType: "BLOCKED", errorCode: "INVENTORY_NOT_TRACKED", errorDetail: "This matched Shopify variant is not tracking inventory." }),
  line(10, { sku: "SKU-READY-ADJUST-10", title: "Harbor Cotton Towel", operationType: "ADJUST" }),
  line(11, { sku: "SKU-READY-ADJUST-11", title: "Juniper Serving Board", operationType: "ADJUST" }),
  line(12, { sku: "SKU-READY-DRAFT-12", title: "Sierra Ceramic Planter", operationType: "CREATE_DRAFT", matchedProductTitle: null, matchedVariantTitle: null }),
];

const zeroReadyLines = readyLines.map((item) => ({
  ...item,
  operationType: "BLOCKED",
  status: "BLOCKED",
}));

export function receiptDetailFixtureLoader({ params }: { params: { batchId?: string } }) {
  const fixture = new URLSearchParams(location.search).get("fixture");
  const lines = fixture === "zero" ? zeroReadyLines : readyLines;
  return {
    batch: {
      id: params.batchId ?? "fixture-receipt-001",
      receiptCode: "IMP-VISUAL-000001",
      status: "PREVIEWED",
      createdAt,
      updatedAt,
      locationName: "North warehouse",
      lines,
    },
    scopesVerified: true,
    missingReadScopes: [],
    missingWriteScopes: [],
    shop: "stockhub-visual-test.myshopify.com",
    historyHref: "/app/imports/history",
    draftNotice: null,
  };
}

export async function receiptDetailFixtureAction({ request }: { request: Request }) {
  const formData = await request.formData();
  const submission = Object.fromEntries(formData.entries());
  const windowWithSubmissions = window as Window & { __receiptFixtureSubmissions?: Array<Record<string, FormDataEntryValue>> };
  windowWithSubmissions.__receiptFixtureSubmissions ??= [];
  windowWithSubmissions.__receiptFixtureSubmissions.push(submission);
  return submission;
}
