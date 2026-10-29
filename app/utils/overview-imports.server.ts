import prisma from "../db.server";
import type { ImportOverview, RecentImport } from "./overview-types";
import { summarizeCatalogExecution } from "./overview-import-status";

export async function loadRecentOverviewImports(shop: string): Promise<ImportOverview | null> {
  try {
    const [inventory, catalog] = await Promise.all([
      prisma.importBatch.findMany({
        where: { shop },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
        select: { id: true, receiptCode: true, locationName: true, createdAt: true, updatedAt: true, status: true },
      }),
      prisma.catalogImportBatch.findMany({
        where: { shop },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
        select: {
          id: true,
          fileName: true,
          createdAt: true,
          updatedAt: true,
          status: true,
          groups: { select: { executionOperations: { where: { shop }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 1, select: { status: true } } } },
        },
      }),
    ]);
    const rows: RecentImport[] = [
      ...inventory.map((batch) => ({
        id: batch.id,
        label: batch.receiptCode.trim() || "Receipt unavailable",
        kind: "inventory" as const,
        locationName: batch.locationName || null,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
        status: batch.status,
        detailHref: `/app/imports/history/${encodeURIComponent(batch.id)}`,
      })),
      ...catalog.map((batch) => ({
        id: batch.id,
        label: batch.fileName,
        kind: "catalog" as const,
        locationName: null,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
        status: summarizeCatalogExecution(batch.status, batch.groups.flatMap((group) => group.executionOperations.map((operation) => operation.status))),
        detailHref: `/app/imports/catalog/${encodeURIComponent(batch.id)}`,
      })),
    ];
    rows.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
    return { recent: rows.slice(0, 5), sample: false };
  } catch {
    return null;
  }
}
