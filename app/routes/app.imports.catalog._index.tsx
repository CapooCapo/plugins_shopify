import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { randomUUID } from "node:crypto";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { checksumCatalogCsv, validateCatalogUpload } from "../utils/catalog-import.server";
import { MAX_CSV_BYTES } from "../utils/csv-limits.js";
import { readRequestBodyLimited } from "../utils/request-body.server";

const MAX_REQUEST_BYTES = MAX_CSV_BYTES + 64 * 1024;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const batches = await prisma.catalogImportBatch.findMany({
    where: { shop: session.shop }, orderBy: { createdAt: "desc" }, take: 100,
    select: { id: true, fileName: true, status: true, draftVersion: true, createdAt: true, _count: { select: { lines: true } } },
  });
  return { batches, shop: session.shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const body = await readRequestBodyLimited(request, MAX_REQUEST_BYTES);
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const form = await new Request(request.url, { method: request.method, headers, body }).formData();
    if (form.get("intent") === "prepare-import-draft") {
      const field = (name: string) => String(form.get(name) ?? "").trim();
      const productName = field("productName");
      const sku = field("sku");
      const price = field("price");
      const description = field("description");
      const imageUrl = field("imageUrl");
      const sourceReceiptCode = field("sourceReceiptCode").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
      const sourceRowNumber = Math.max(0, Number.parseInt(field("sourceRowNumber"), 10) || 0);
      const errors: string[] = [];
      if (!productName) errors.push("Product Name is required.");
      if (!sku) errors.push("SKU is required.");
      const priceValid = !price || /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(price);
      if (!priceValid) errors.push("Price must be a non-negative decimal with up to 14 integer digits and 6 fractional digits.");
      if (price && /^0(?:\.0{1,6})?$/.test(price)) errors.push("Confirm that zero price is intentional.");
      const originalCsv = ["Product Name,SKU,Price,Description,Image URL", [productName, sku, price, description, imageUrl].map((value) => `"${value.replaceAll('"', '""')}"`).join(",")].join("\n") + "\n";
      const id = randomUUID();
      await prisma.$transaction([
        prisma.catalogImportBatch.create({ data: {
          id, shop: session.shop, submissionId: randomUUID(), fileName: sourceReceiptCode ? `Inventory receipt ${sourceReceiptCode} row ${sourceRowNumber || "manual"} product draft.csv` : "Inventory import product draft.csv",
          fileChecksum: checksumCatalogCsv(originalCsv), originalCsv, sourceHeaders: ["Product Name", "SKU", "Price", "Description", "Image URL"],
          mapping: { 0: "productName", 1: "sku", 2: "price", 3: "description", 4: "imageUrl" }, status: "DRAFT", draftVersion: 0,
        } }),
        prisma.catalogImportLine.create({ data: {
          id: randomUUID(), shop: session.shop, batchId: id, rowNumber: 1, sourceRowNumber: sourceRowNumber || null,
          sourceValues: [productName, sku, price, description, imageUrl], productName: productName || null, sku: sku || null,
          price: priceValid && price ? price : null, description: description || null, imageUrl: imageUrl || null,
          status: errors.length ? "ERROR" : "READY", errors,
        } }),
      ]);
      return redirect(`/app/imports/catalog/${encodeURIComponent(id)}?prepared=inventory`);
    }
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return { error: "Choose a CSV file first." };
    if (file.size > MAX_CSV_BYTES) return { error: `Catalog CSVs are limited to ${MAX_CSV_BYTES.toLocaleString()} bytes.` };
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    const parsed = validateCatalogUpload(file.name, text);
    const id = randomUUID();
    await prisma.catalogImportBatch.create({ data: {
      id, shop: session.shop, submissionId: randomUUID(), fileName: file.name,
      fileChecksum: checksumCatalogCsv(text), originalCsv: text, sourceHeaders: parsed.headers,
      status: "MAPPING", draftVersion: 0,
    } });
    return redirect(`/app/imports/catalog/${encodeURIComponent(id)}`);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to save this catalog CSV." };
  }
};

export default function CatalogImports() {
  const { batches, shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <main className="stockhub-import-new stockhub-catalog-imports">
    <header className="stockhub-import-page-header"><div><div className="stockhub-overview-eyebrow">StockHub imports · Product Catalog</div><h1>Catalog CSV drafts</h1><p>Map supplier columns and review catalog data. Drafts are not sent to Shopify.</p></div></header>
    <p><strong>Store:</strong> {shop} · Inventory Update remains a separate workflow.</p>
    <section className="stockhub-panel"><s-section heading="Upload product catalog CSV">
      <p>Required fields: Product Name and SKU. Price is optional in a draft. Quantity is not part of catalog imports.</p>
      <Form method="post" encType="multipart/form-data"><label htmlFor="catalog-file">CSV file (maximum {MAX_CSV_BYTES.toLocaleString()} bytes)</label><br /><input id="catalog-file" name="file" type="file" accept=".csv,text/csv" required /> <button type="submit">Upload and map columns</button></Form>
      {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
    </s-section></section>
    <section className="stockhub-panel"><s-section heading="Recent catalog drafts">
      {batches.length ? <>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable region enables keyboard horizontal scrolling */}
        <div className="stockhub-catalog-table-wrap" role="region" aria-label="Recent catalog drafts table; scroll horizontally to see all columns" tabIndex={0}><table className="stockhub-catalog-table"><thead><tr><th>File</th><th>Status</th><th>Rows</th><th>Updated</th><th /></tr></thead><tbody>{batches.map((batch) => <tr key={batch.id}><td>{batch.fileName}</td><td>{batch.status}</td><td>{batch._count.lines}</td><td>{new Date(batch.createdAt).toLocaleString()}</td><td><Link to={`/app/imports/catalog/${encodeURIComponent(batch.id)}`}>Open draft</Link></td></tr>)}</tbody></table></div>
      </> : <p>No catalog drafts yet.</p>}
    </s-section></section>
  </main>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
