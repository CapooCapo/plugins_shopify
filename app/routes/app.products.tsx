import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getGraphQLData } from "../utils/shopify-graphql.server";
import { ProductsCatalog, type Product, type ProductPageSize, type ProductVariant } from "../components/ProductsCatalog";

const PAGE_SIZES = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE: ProductPageSize = 25;
const VARIANTS_PER_PRODUCT = 10;
const PRODUCT_STATUS_FILTERS = ["active", "draft", "archived", "unlisted"] as const;
type ProductStatusFilter = "all" | (typeof PRODUCT_STATUS_FILTERS)[number];
type ProductSearchBy = "name" | "sku";

function parseStatusFilter(value: string | null): ProductStatusFilter {
  return PRODUCT_STATUS_FILTERS.some((status) => status === value)
    ? value as ProductStatusFilter
    : "all";
}

export function parsePageSize(value: string | null): ProductPageSize {
  return PAGE_SIZES.find((size) => String(size) === value) ?? DEFAULT_PAGE_SIZE;
}

type ProductsData = {
  shop: { currencyCode: string };
  products: {
    edges: Array<{ node: Product }>;
    pageInfo: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      startCursor: string | null;
      endCursor: string | null;
    };
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const searchBy: ProductSearchBy = url.searchParams.get("searchBy") === "sku" ? "sku" : "name";
  const statusFilter = parseStatusFilter(url.searchParams.get("status"));
  const pageSize = parsePageSize(url.searchParams.get("pageSize"));
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const movingBackward = Boolean(before);
  const useSkuSearch = searchBy === "sku" && Boolean(search);
  const queryTerms = useSkuSearch
    ? [
        search ? `sku:${JSON.stringify(search)}` : null,
        statusFilter === "all" ? null : `product_status:${statusFilter}`,
      ].filter((term): term is string => term !== null)
    : [
        search ? `title:${JSON.stringify(search)}` : null,
        statusFilter === "all" ? null : `status:${statusFilter}`,
      ].filter((term): term is string => term !== null);

  try {
    const variables = {
      first: movingBackward ? null : pageSize,
      after: movingBackward ? null : after,
      last: movingBackward ? pageSize : null,
      before: movingBackward ? before : null,
      query: queryTerms.length ? queryTerms.join(" AND ") : null,
    };

    if (useSkuSearch) {
      const response = await admin.graphql(
        `#graphql
          query StockHubProductsBySku(
            $first: Int
            $after: String
            $last: Int
            $before: String
            $query: String
          ) {
            shop { currencyCode }
            productVariants(
              first: $first
              after: $after
              last: $last
              before: $before
              query: $query
            ) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                  product {
                    id
                    title
                    status
                    totalInventory
                    priceRangeV2 {
                      minVariantPrice { amount currencyCode }
                      maxVariantPrice { amount currencyCode }
                    }
                    featuredImage { url altText }
                  }
                }
              }
              pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
            }
          }`,
        { variables },
      );
      const data = await getGraphQLData<{
        shop: { currencyCode: string };
        productVariants: {
          edges: Array<{ node: ProductVariant & { product: Omit<Product, "variants"> } }>;
          pageInfo: ProductsData["products"]["pageInfo"];
        };
      }>(response);

      return {
        products: data.productVariants.edges.map(({ node: variant }) => ({
          ...variant.product,
          variants: { edges: [{ node: variant }], pageInfo: { hasNextPage: false } },
        })),
        currencyCode: data.shop.currencyCode,
        pageInfo: data.productVariants.pageInfo,
        search,
        searchBy,
        statusFilter,
        pageSize,
        shop: session.shop,
        error: null,
      };
    }

    const response = await admin.graphql(
      `#graphql
        query StockHubProducts(
          $first: Int
          $after: String
          $last: Int
          $before: String
          $query: String
        ) {
          shop { currencyCode }
          products(
            first: $first
            after: $after
            last: $last
            before: $before
            query: $query
          ) {
            edges {
              node {
                id
                title
                status
                totalInventory
                priceRangeV2 {
                  minVariantPrice { amount currencyCode }
                  maxVariantPrice { amount currencyCode }
                }
                featuredImage { url altText }
                variants(first: ${VARIANTS_PER_PRODUCT}) {
                  edges {
                    node { id title sku price inventoryQuantity }
                  }
                  pageInfo { hasNextPage }
                }
              }
            }
            pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          }
        }`,
      { variables },
    );
    const data = await getGraphQLData<ProductsData>(response);

    return {
      products: data.products.edges.map(({ node }) => node),
      currencyCode: data.shop.currencyCode,
      pageInfo: data.products.pageInfo,
      search,
      searchBy,
      statusFilter,
      pageSize,
      shop: session.shop,
      error: null,
    };
  } catch {
    return {
      products: [],
      currencyCode: null,
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
      search,
      searchBy,
      statusFilter,
      pageSize,
      shop: session.shop,
      error:
        "Products could not be loaded from Shopify. Confirm read_products access and try again.",
    };
  }
};

export default function Products() {
  const { products, pageInfo, search, searchBy, statusFilter, pageSize, shop, currencyCode, error } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();

  return <s-page inlineSize="large">
    <ProductsCatalog
      products={products}
      pageInfo={pageInfo}
      search={search}
      searchBy={searchBy}
      statusFilter={statusFilter}
      pageSize={pageSize}
      shop={shop}
      currencyCode={currencyCode}
      error={error}
      loading={navigation.state === "loading"}
    />
  </s-page>;
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
