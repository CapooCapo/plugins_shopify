import { createRoot } from "react-dom/client";
import { createMemoryRouter, data, redirect, RouterProvider, useLoaderData } from "react-router";
import { SizeGuideManager } from "../../app/components/SizeGuideManager";
import { validateSizeGuideDraft, type SizeGuideColumn } from "../../app/utils/size-guides.shared";
import "../../app/styles/stockhub.css";

type Guide = {
  id: string; shop: string; title: string; unit: "cm" | "in" | "mm";
  columns: SizeGuideColumn[]; rows: string[][]; updatedAt: string;
};
type Assignment = {
  id: string; shop: string; guideId: string; productId: string; productTitle: string;
  syncStatus: "SYNCED" | "PENDING"; syncedGuideUpdatedAt: string | null; lastError: null;
};
type State = { guides: Guide[]; assignments: Assignment[] };
type PickerProduct = { id: string; title: string; images: Array<{ originalSrc: string }>; status: string };
type PickerOptions = { type: "product"; action: "select"; multiple: number; filter: { draft: boolean; archived: boolean; hidden: boolean; variants: boolean } };
type FixtureControl = { pickerCalls: PickerOptions[]; actionCalls: Array<{ intent: string; productIds: string[] }>; lastActionResult: string | null };
declare global { interface Window { __sizeGuideVisualFixture?: FixtureControl } }
const storageKey = "stockhub-size-guide-visual-fixture-v1";
const shirtThumbnail = (fabric: string, seam: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="16" fill="#f0eee9"/><path d="M31 18 18 24 9 44l14 7 7-10v37h36V41l7 10 14-7-9-20-13-6-8 10H39l-8-10Z" fill="${fabric}" stroke="${seam}" stroke-width="2.5" stroke-linejoin="round"/><path d="M39 28c1 8 17 8 18 0" fill="none" stroke="${seam}" stroke-width="2.5" stroke-linecap="round"/><path d="M31 42v32m34-32v32" stroke="${seam}" stroke-width="1.5" opacity=".45"/></svg>`)}`;
const products = [
  { id: "gid://shopify/Product/101", title: "Essential Cotton T-Shirt", images: [{ originalSrc: shirtThumbnail("#dfc9a7", "#8b765c") }], status: "DRAFT" },
  { id: "gid://shopify/Product/102", title: "Oversized Tee", images: [{ originalSrc: shirtThumbnail("#6b8396", "#344b5d") }], status: "ACTIVE" },
  { id: "gid://shopify/Product/103", title: "Basic Logo Tee", images: [{ originalSrc: shirtThumbnail("#536c58", "#344837") }], status: "ACTIVE" },
];

function pickerFixtureState(): State {
  const shop = "local-fixture.myshopify.com";
  const now = "2026-10-30T00:00:00.000Z";
  const columns: SizeGuideColumn[] = [
    { name: "Size", kind: "label" }, { name: "Chest", kind: "measurement" },
    { name: "Shoulder", kind: "measurement" }, { name: "Length", kind: "measurement" },
  ];
  const primaryGuide: Guide = {
    id: "fixture-guide-primary", shop, title: "Everyday Tee Size Guide", unit: "cm", columns,
    rows: [["S", "104", "47", "68"], ["M", "108", "49", "70"], ["L", "112", "51", "72"]], updatedAt: now,
  };
  const otherGuide: Guide = {
    id: "fixture-guide-other", shop, title: "Relaxed Fit Guide", unit: "cm", columns,
    rows: [["S", "108", "49", "70"]], updatedAt: now,
  };
  return {
    guides: [primaryGuide, otherGuide],
    assignments: [
      { id: "fixture-assignment-current", shop, guideId: primaryGuide.id, productId: products[2].id,
        productTitle: products[2].title, syncStatus: "SYNCED", syncedGuideUpdatedAt: now, lastError: null },
      { id: "fixture-assignment-other", shop, guideId: otherGuide.id, productId: products[1].id,
        productTitle: products[1].title, syncStatus: "SYNCED", syncedGuideUpdatedAt: now, lastError: null },
    ],
  };
}

function state(): State {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as State | null;
    if (value && Array.isArray(value.guides) && Array.isArray(value.assignments)) return value;
  } catch { /* fixture resets below */ }
  const fixtureMode = new URLSearchParams(location.search).get("fixture");
  const fresh = fixtureMode === "picker" ? pickerFixtureState() : { guides: [], assignments: [] };
  localStorage.setItem(storageKey, JSON.stringify(fresh));
  return fresh;
}
function persist(value: State) { localStorage.setItem(storageKey, JSON.stringify(value)); }

async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const current = state();
  const guideId = url.searchParams.get("guide");
  const query = (url.searchParams.get("q") ?? "").trim();
  const guides = current.guides.map((guide) => ({
    ...guide,
    updatedAt: new Date(guide.updatedAt),
    products: current.assignments.filter((item) => item.guideId === guide.id).map((item) => ({
      ...item,
      syncedGuideUpdatedAt: item.syncedGuideUpdatedAt ? new Date(item.syncedGuideUpdatedAt) : null,
    })),
  }));
  return {
    guides,
    selectedGuideId: guides.some((guide) => guide.id === guideId) ? guideId : guides[0]?.id ?? null,
    query,
    products: query.length >= 2 ? products.filter((product) => product.title.toLowerCase().includes(query.toLowerCase())) : [],
    productError: null,
    storageError: null,
    actionError: null,
  };
}

async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const current = state();
  const guideId = String(form.get("guideId") ?? "");
  const productIds = [...new Set(form.getAll("productIds").map(String))];
  if (window.__sizeGuideVisualFixture) window.__sizeGuideVisualFixture.actionCalls.push({ intent, productIds });
  if (intent === "save") {
    let columns: unknown;
    let rows: unknown;
    try {
      columns = JSON.parse(String(form.get("columns") ?? ""));
      rows = JSON.parse(String(form.get("rows") ?? ""));
    } catch { return data({ error: "Invalid fixture chart." }, { status: 400 }); }
    const validated = validateSizeGuideDraft({
      title: form.get("title"), unit: form.get("unit"), columns, rows,
    });
    if (!validated.ok) return data({ error: validated.errors[0] }, { status: 400 });
    const id = String(form.get("id") ?? "") || crypto.randomUUID();
    const next = { id, shop: "local-fixture.myshopify.com", ...validated.value, updatedAt: new Date().toISOString() };
    const exists = current.guides.some((guide) => guide.id === id);
    current.guides = exists ? current.guides.map((guide) => guide.id === id ? next : guide) : [next, ...current.guides];
    current.assignments = current.assignments.map((item) => item.guideId === id ? { ...item, syncStatus: "PENDING", syncedGuideUpdatedAt: null } : item);
    persist(current);
    return redirect(`/app/size-guides?guide=${encodeURIComponent(id)}`);
  }
  if (intent === "assignProducts") {
    if (!productIds.length) return data({ error: "Choose at least one fixture product." }, { status: 400 });
    const selected = productIds.map((id) => products.find((item) => item.id === id));
    if (selected.some((item) => !item)) return data({ error: "Unknown fixture product." }, { status: 400 });
    const replacements = new Set(form.getAll("replaceProductIds").map(String));
    const conflicts = current.assignments.filter((item) => productIds.includes(item.productId) && item.guideId !== guideId);
    const confirmed = form.get("confirmReplacements") === "yes";
    if (conflicts.length && (!confirmed || conflicts.some((item) => !replacements.has(item.productId)))) {
      if (window.__sizeGuideVisualFixture) window.__sizeGuideVisualFixture.lastActionResult = "replacement_required";
      return data({ error: "Confirm each replacement in the local fixture." }, { status: 409 });
    }
    const guide = current.guides.find((item) => item.id === guideId);
    if (!guide) return data({ error: "Unknown fixture guide." }, { status: 400 });
    for (const product of selected) {
      const existing = current.assignments.find((item) => item.productId === product!.id);
      if (existing) {
        existing.guideId = guideId;
        existing.productTitle = product!.title;
        existing.syncStatus = "PENDING";
        existing.syncedGuideUpdatedAt = null;
      } else {
        current.assignments.push({ id: crypto.randomUUID(), shop: guide.shop, guideId, productId: product!.id,
          productTitle: product!.title, syncStatus: "PENDING", syncedGuideUpdatedAt: null, lastError: null });
      }
    }
    persist(current);
    if (window.__sizeGuideVisualFixture) window.__sizeGuideVisualFixture.lastActionResult = "assigned";
    return redirect(`/app/size-guides?guide=${encodeURIComponent(guideId)}`);
  }
  if (intent === "assign") {
    const productId = String(form.get("productId") ?? "");
    const product = products.find((item) => item.id === productId);
    if (!current.guides.some((guide) => guide.id === guideId) || !product) return data({ error: "Unknown fixture product or guide." }, { status: 400 });
    if (current.assignments.some((item) => item.productId === productId)) return data({ error: "Product is already assigned." }, { status: 409 });
    const guide = current.guides.find((item) => item.id === guideId)!;
    current.assignments.push({
      id: crypto.randomUUID(), shop: guide.shop, guideId, productId, productTitle: product.title,
      syncStatus: "SYNCED", syncedGuideUpdatedAt: guide.updatedAt, lastError: null,
    });
  } else if (intent === "unassign") {
    const productId = String(form.get("productId") ?? "");
    current.assignments = current.assignments.filter((item) => !(item.guideId === guideId && item.productId === productId));
  } else if (intent === "delete") {
    current.guides = current.guides.filter((guide) => guide.id !== String(form.get("guideId") ?? ""));
    current.assignments = current.assignments.filter((item) => item.guideId !== guideId);
    persist(current);
    return redirect("/app/size-guides");
  } else return data({ error: "Unsupported fixture action." }, { status: 400 });

  persist(current);
  return redirect(`/app/size-guides?guide=${encodeURIComponent(guideId)}`);
}

function FixturePage() {
  const props = useLoaderData<typeof loader>();
  return <>
    <div className="visual-fixture-badge" role="note">LOCAL ADMIN COMPONENT FIXTURE · NOT LIVE SHOPIFY DATA</div>
    <s-page inlineSize="large"><SizeGuideManager {...props} resourcePicker={fixtureResourcePicker} /></s-page>
  </>;
}

async function fixtureResourcePicker(options: PickerOptions): Promise<PickerProduct[] | undefined> {
  window.__sizeGuideVisualFixture?.pickerCalls.push(options);
  const mode = new URLSearchParams(location.search).get("picker") ?? "selected";
  if (mode === "cancel") return undefined;
  if (mode === "permissionError") throw Object.assign(new Error("Access denied"), { status: 403 });
  if (mode === "apiError") throw new Error("network request failed");
  if (mode === "loading") await new Promise((resolve) => setTimeout(resolve, 500));
  if (mode === "duplicate") return [products[0], products[0]];
  return [products[0], products[1]];
}

const initial = new URLSearchParams(location.search).get("reset") === "1" ? "/app/size-guides" : `/app/size-guides${location.search}`;
if (new URLSearchParams(location.search).get("reset") === "1") localStorage.removeItem(storageKey);
window.__sizeGuideVisualFixture = { pickerCalls: [], actionCalls: [], lastActionResult: null };
const router = createMemoryRouter([{ path: "/app/size-guides", element: <FixturePage />, loader, action }], { initialEntries: [initial] });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
