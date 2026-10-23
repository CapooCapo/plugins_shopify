import { Fragment, useState } from "react";
import { Form, Link } from "react-router";
import { formatStockhubMoney } from "../utils/stockhub-format.js";

export type ProductVariant = {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  inventoryQuantity: number | null;
};

export type ProductPageSize = 10 | 25 | 50;

type Money = { amount: string; currencyCode: string };

export type Product = {
  id: string;
  title: string;
  status: string;
  totalInventory: number | null;
  priceRangeV2: { minVariantPrice: Money; maxVariantPrice: Money };
  featuredImage: { url: string; altText: string | null } | null;
  variants: {
    edges: Array<{ node: ProductVariant }>;
    pageInfo: { hasNextPage: boolean };
  };
};

type PageInfo = {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
};

type Props = {
  products: Product[];
  pageInfo: PageInfo;
  search: string;
  searchBy: "name" | "sku";
  statusFilter: "all" | "active" | "draft" | "archived" | "unlisted";
  pageSize: ProductPageSize;
  shop: string;
  currencyCode: string | null;
  error: string | null;
  loading?: boolean;
};

function pageHref(
  search: Props["search"],
  searchBy: Props["searchBy"],
  statusFilter: Props["statusFilter"],
  pageSize: ProductPageSize,
  key?: "after" | "before",
  cursor?: string | null,
) {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (searchBy !== "name") params.set("searchBy", searchBy);
  if (statusFilter !== "all") params.set("status", statusFilter);
  if (pageSize !== 25) params.set("pageSize", String(pageSize));
  if (key && cursor) params.set(key, cursor);
  const query = params.toString();
  return query ? `/app/products?${query}` : "/app/products";
}

function productAdminUrl(shop: string, productId: string) {
  const numericId = productId.split("/").pop();
  if (!numericId) return null;
  return `https://${shop}/admin/products/${encodeURIComponent(numericId)}`;
}

function productStatusLabel(status: string) {
  return status === "ACTIVE" ? "Active" : status === "DRAFT" ? "Draft"
    : status === "ARCHIVED" ? "Archived" : status === "UNLISTED" ? "Unlisted"
      : status.toLowerCase();
}

function productStatusClass(status: string) {
  return status === "ACTIVE" ? "stockhub-product-status--active"
    : status === "UNLISTED" ? "stockhub-product-status--unlisted"
      : "stockhub-product-status--neutral";
}

function formatMoney(amount: string, currencyCode: string | null) {
  return formatStockhubMoney(amount, currencyCode);
}

function productPrice(product: Product) {
  const { minVariantPrice: min, maxVariantPrice: max } = product.priceRangeV2;
  const low = formatMoney(min.amount, min.currencyCode);
  return min.amount === max.amount ? low : `${low} – ${formatMoney(max.amount, max.currencyCode)}`;
}

function variantSummary(product: Product, matchedVariant: boolean) {
  if (matchedVariant) return "Matched variant";
  const loaded = product.variants.edges.length;
  return `${loaded}${product.variants.pageInfo.hasNextPage ? "+" : ""} variant${loaded === 1 && !product.variants.pageInfo.hasNextPage ? "" : "s"}`;
}

export function ProductsCatalog({
  products, pageInfo, search, searchBy, statusFilter, pageSize, shop, currencyCode, error, loading = false,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const matchedVariant = searchBy === "sku" && Boolean(search);
  const filtered = Boolean(search) || statusFilter !== "all";
  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return <main className="stockhub-page stockhub-products">
    <header className="stockhub-products-header">
      <div>
        <div className="stockhub-products-eyebrow">StockHub catalog</div>
        <h1>Products</h1>
        <p>Find products and inspect variants from your current Shopify store.</p>
        <div className="stockhub-products-shop"><span className="stockhub-current-shop-dot" /> Current store <strong>{shop}</strong></div>
      </div>
      <div className="stockhub-products-count" aria-label="Results on this page">
        <strong>{error ? "—" : products.length}</strong>
        <span>result{products.length === 1 ? "" : "s"} on this page</span>
      </div>
    </header>

    <section className="stockhub-products-filters" aria-label="Product filters">
      <Form method="get" className="stockhub-products-filter-form">
        <s-text-field
          label={searchBy === "sku" ? "Search SKU" : "Search product name"}
          name="q"
          value={search}
          placeholder={searchBy === "sku" ? "Enter SKU" : "Enter product name"}
        />
        <s-select label="Search by" name="searchBy" value={searchBy}>
          <s-option value="name">Product name</s-option>
          <s-option value="sku">SKU</s-option>
        </s-select>
        <s-select label="Product status" name="status" value={statusFilter}>
          <s-option value="all">All statuses</s-option>
          <s-option value="active">Active</s-option>
          <s-option value="draft">Draft</s-option>
          <s-option value="archived">Archived</s-option>
          <s-option value="unlisted">Unlisted</s-option>
        </s-select>
        <s-select label="Page size" name="pageSize" value={String(pageSize)}>
          <s-option value="10">10</s-option>
          <s-option value="25">25</s-option>
          <s-option value="50">50</s-option>
        </s-select>
        <s-button type="submit" variant="primary" loading={loading}>Search</s-button>
      </Form>
      {filtered ? <div className="stockhub-products-active-filter">Filters applied <Link to={pageHref("", "name", "all", pageSize)}>Clear filters</Link></div> : null}
    </section>

    {loading ? <div className="stockhub-route-pending" role="status" aria-live="polite"><s-spinner size="base" accessibilityLabel="Loading products" /> Loading products…</div> : null}

    {error ? <section className="stockhub-products-state" role="alert"><h2>Products unavailable</h2><p>{error}</p>
      <Link to={pageHref(search, searchBy, statusFilter, pageSize)}>Retry</Link></section>
      : products.length === 0 ? <section className="stockhub-products-state"><h2>No products found</h2>
        <p>{filtered ? `No products matched the current ${searchBy === "sku" ? "SKU" : "product name"} search and status filters.` : "This store does not have any products yet."}</p>
        {filtered ? <Link to={pageHref("", "name", "all", pageSize)}>Clear filters</Link> : null}
      </section> : <section className="stockhub-products-results" aria-labelledby="stockhub-products-results-title">
        <div className="stockhub-products-results-heading">
          <div><h2 id="stockhub-products-results-title">Catalog results</h2><p>Showing up to {pageSize} results per page</p></div>
          <span>Inventory is product total across locations</span>
        </div>
        <table className="stockhub-products-table">
          <thead><tr><th scope="col">Product</th><th scope="col">SKU / variants</th><th scope="col">Status</th><th scope="col">Price</th><th scope="col">Total inventory</th><th scope="col">Actions</th></tr></thead>
          <tbody>{products.map((product, index) => {
            const variant = product.variants.edges[0]?.node;
            const rowKey = matchedVariant ? `${product.id}:${variant?.id ?? index}` : product.id;
            const isExpanded = expanded.has(rowKey);
            const editUrl = productAdminUrl(shop, product.id);
            const singleVariant = product.variants.edges.length === 1 && !product.variants.pageInfo.hasNextPage;
            const sku = matchedVariant || singleVariant ? variant?.sku || "No SKU" : "Multiple SKUs";
            const price = matchedVariant && variant ? formatMoney(variant.price, currencyCode) : productPrice(product);
            return <Fragment key={rowKey}>
              <tr className="stockhub-product-row">
                <td data-label="Product"><div className="stockhub-product-identity">
                  {product.featuredImage ? <img src={product.featuredImage.url} alt={product.featuredImage.altText ?? ""} width="44" height="44" loading="lazy" />
                    : <span className="stockhub-product-placeholder" aria-hidden="true">P</span>}
                  <div className="stockhub-product-identity-text"><strong title={product.title}>{product.title}</strong><span>{variantSummary(product, matchedVariant)}{matchedVariant && variant?.title !== "Default Title" ? ` · ${variant?.title}` : ""}</span></div>
                </div></td>
                <td data-label="SKU / variants"><span className="stockhub-product-sku">{sku}</span>{!matchedVariant && !singleVariant ? <small>{variantSummary(product, false)}</small> : null}</td>
                <td data-label="Status"><span className={`stockhub-product-status ${productStatusClass(product.status)}`}>{productStatusLabel(product.status)}</span></td>
                <td data-label="Price" className="stockhub-product-price">{price}</td>
                <td data-label="Total inventory" className="stockhub-product-inventory">{product.totalInventory ?? "Unavailable"}</td>
                <td data-label="Actions"><div className="stockhub-product-actions">
                  {product.variants.edges.length ? <button type="button" aria-expanded={isExpanded} onClick={() => toggleExpanded(rowKey)}>{isExpanded ? "Hide details" : "Details"}</button> : null}
                  {editUrl ? <a href={editUrl} target="_top" aria-label={`Open ${product.title} in Shopify`}>Shopify ↗</a> : null}
                </div></td>
              </tr>
              {isExpanded ? <tr className="stockhub-product-detail-row"><td colSpan={6}>
                <div className="stockhub-product-detail-content"><h3>{product.title} — {matchedVariant ? "matched variant" : "variant details"}</h3>
                  <div className="stockhub-product-variant-list">{product.variants.edges.map(({ node: item }) => <div className="stockhub-product-variant" key={item.id}>
                    <strong>{item.title === "Default Title" ? "Default variant" : item.title}</strong>
                    <span>SKU: {item.sku || "No SKU"}</span>
                    <span>Price: {formatMoney(item.price, currencyCode)}</span>
                    <span>Total across locations: {item.inventoryQuantity ?? "Unavailable"}</span>
                  </div>)}</div>
                  {product.variants.pageInfo.hasNextPage ? <p>Only the first 10 variants are loaded. Open in Shopify for the complete list.</p> : null}
                </div>
              </td></tr> : null}
            </Fragment>;
          })}</tbody>
        </table>
      </section>}

    {!error && (pageInfo.hasPreviousPage || pageInfo.hasNextPage) ? <nav className="stockhub-products-pagination" aria-label="Product catalog pagination">
      <span>Up to {pageSize} results per page</span>
      <div>
        {pageInfo.hasPreviousPage ? <s-button href={pageHref(search, searchBy, statusFilter, pageSize, "before", pageInfo.startCursor)}>Previous page</s-button> : null}
        {pageInfo.hasNextPage ? <s-button href={pageHref(search, searchBy, statusFilter, pageSize, "after", pageInfo.endCursor)}>Next page</s-button> : null}
      </div>
    </nav> : null}
  </main>;
}
