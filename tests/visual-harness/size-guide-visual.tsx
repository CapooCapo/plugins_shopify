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
const storageKey = "stockhub-size-guide-visual-fixture-v1";
const products = [
  { id: "gid://shopify/Product/101", title: "Essential Cotton T-Shirt" },
  { id: "gid://shopify/Product/102", title: "Oversized Tee" },
  { id: "gid://shopify/Product/103", title: "Basic Logo Tee" },
];

function state(): State {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as State | null;
    if (value && Array.isArray(value.guides) && Array.isArray(value.assignments)) return value;
  } catch { /* fixture resets below */ }
  const fresh = { guides: [], assignments: [] };
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
    <s-page inlineSize="large"><SizeGuideManager {...props} /></s-page>
  </>;
}

const initial = new URLSearchParams(location.search).get("reset") === "1" ? "/app/size-guides" : `/app/size-guides${location.search}`;
if (new URLSearchParams(location.search).get("reset") === "1") localStorage.removeItem(storageKey);
const router = createMemoryRouter([{ path: "/app/size-guides", element: <FixturePage />, loader, action }], { initialEntries: [initial] });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
