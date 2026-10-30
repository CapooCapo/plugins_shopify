import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { InventoryAlerts } from "../../app/components/InventoryAlerts";
import "../../app/styles/stockhub.css";
import "../../app/styles/stockhub/inventory-alerts.css";
import { createInventoryAlertsSample } from "../../app/utils/inventory-alerts-fixtures";

const data = createInventoryAlertsSample(new Date("2026-10-29T08:00:00.000Z"));
const router = createMemoryRouter([{
  path: "/app/inventory-alerts",
  element: <main style={{ maxWidth: 1440, margin: "0 auto", padding: 24 }}>
    <InventoryAlerts data={data} shop="inventory-alerts-example.myshopify.com" samplePreview migrated={false} />
  </main>,
}], { initialEntries: ["/app/inventory-alerts"] });

Object.assign(window, { __inventoryAlertsFixture: data, __inventoryAlertsPath: router.state.location.pathname });
router.subscribe((state) => Object.assign(window, { __inventoryAlertsPath: state.location.pathname }));
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
