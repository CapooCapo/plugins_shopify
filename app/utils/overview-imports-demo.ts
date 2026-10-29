import type { ImportOverview } from "./overview-types";

const SAMPLE_TIME = new Date("2026-10-29T12:00:00.000Z");

/** Illustrative receipt lifecycle rows; these IDs are not persisted or navigable. */
export function createSampleOverviewImports(): ImportOverview {
  const rows = [
    { id: "sample-inventory-1", label: "SAMPLE-INV-024", kind: "inventory" as const, locationName: "North warehouse", status: "COMPLETED", daysAgo: 1 },
    { id: "sample-catalog-1", label: "Autumn supplier catalog.csv", kind: "catalog" as const, locationName: null, status: "DRAFT", daysAgo: 2 },
    { id: "sample-inventory-2", label: "SAMPLE-INV-023", kind: "inventory" as const, locationName: "North warehouse", status: "PREVIEWED", daysAgo: 3 },
    { id: "sample-catalog-2", label: "Winter collection.csv", kind: "catalog" as const, locationName: null, status: "MAPPING", daysAgo: 4 },
    { id: "sample-inventory-3", label: "SAMPLE-INV-021", kind: "inventory" as const, locationName: "East store", status: "PARTIAL", daysAgo: 5 },
  ];
  return {
    sample: true,
    recent: rows.map((row) => {
      const createdAt = new Date(SAMPLE_TIME.getTime() - row.daysAgo * 86_400_000);
      return { ...row, createdAt, updatedAt: createdAt, detailHref: null };
    }),
  };
}
