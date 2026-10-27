import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getGraphQLData } from "../utils/shopify-graphql.server";
import { OverviewDashboard } from "../components/OverviewDashboard";

export type ProductCount = { count: number; precision: "EXACT" | "AT_LEAST" };

export type OverviewData = {
  shop: { name: string; myshopifyDomain: string };
  all: ProductCount;
  active: ProductCount;
  draft: ProductCount;
};

export type RecentImport = {
  id: string;
  receiptCode: string;
  locationName: string;
  createdAt: Date;
  updatedAt?: Date;
  status: string;
};

export type ImportOverview = {
  batchCount: number;
  attentionBatchCount: number;
  recent: RecentImport[];
  attention: RecentImport[];
};

type ImportBatchStatusCount = { status: string; _count: { _all: number } };

export function summarizeImportBatchStatusCounts(groups: ImportBatchStatusCount[]) {
  return groups.reduce(
    (counts, group) => ({
      batchCount: counts.batchCount + group._count._all,
      attentionBatchCount:
        counts.attentionBatchCount +
        (["FAILED", "UNCERTAIN", "PARTIAL"].includes(group.status) ? group._count._all : 0),
    }),
    { batchCount: 0, attentionBatchCount: 0 },
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const importsPromise: Promise<ImportOverview | null> = Promise.all([
    prisma.importBatch.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: { _all: true },
    }),
    prisma.importBatch.findMany({
      where: { shop: session.shop },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5,
      select: {
        id: true,
        receiptCode: true,
        locationName: true,
        createdAt: true,
        status: true,
      },
    }),
    prisma.importBatch.findMany({
      where: { shop: session.shop, status: { in: ["FAILED", "UNCERTAIN", "PARTIAL"] } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 5,
      select: { id: true, receiptCode: true, locationName: true, createdAt: true, updatedAt: true, status: true },
    }),
  ]).then(([statusCounts, recent, attention]) => ({
    ...summarizeImportBatchStatusCounts(statusCounts),
    recent,
    attention,
  })).catch(() => null);

  try {
    const response = await admin.graphql(
      `#graphql
        query StockHubOverview {
          shop {
            name
            myshopifyDomain
          }
          all: productsCount(limit: null) {
            count
            precision
          }
          active: productsCount(query: "status:active", limit: null) {
            count
            precision
          }
          draft: productsCount(query: "status:draft", limit: null) {
            count
            precision
          }
        }`,
    );
    const data = await getGraphQLData<OverviewData>(response);
    return { data, error: null, imports: await importsPromise };
  } catch {
    return {
      data: null,
      imports: await importsPromise,
      error:
        "Shopify product data could not be loaded. Confirm the app has read_products access and try again.",
    };
  }
};

export default function Overview() {
  const { data, error, imports } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  return (
    <s-page inlineSize="large">
      <OverviewDashboard data={data} error={error} imports={imports} loading={navigation.state === "loading"} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
