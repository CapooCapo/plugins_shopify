import { useEffect, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Outlet, useBlocker, useLocation, useNavigate, useNavigation } from "react-router";
import { ImportDirtyContext } from "../import-dirty-context";

const LEAVE_NEW_IMPORT_MODAL_ID = "leave-new-import-modal";

type PolarisModalOverlay = HTMLElement & {
  showOverlay?: () => void;
  hideOverlay?: () => void;
};

function leaveNewImportModalElement() {
  if (typeof document === "undefined") return null;
  return document.getElementById(LEAVE_NEW_IMPORT_MODAL_ID) as PolarisModalOverlay | null;
}

function confirmLeavingNewImport(event: BeforeUnloadEvent) {
  const form = document.querySelector<HTMLFormElement>("[data-import-preview-form]");
  const file = form?.querySelector<HTMLInputElement>('input[type="file"]');
  const locationId = form?.querySelector<HTMLSelectElement>('select[name="locationId"]');
  const hasUnsavedPreview = Boolean(file?.files?.length || locationId?.value);
  if (!hasUnsavedPreview) return;
  event.preventDefault();
  event.returnValue = "";
}

export default function ImportsLayout() {
  const location = useLocation();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const historyActive = location.pathname.startsWith("/app/imports/history");
  const activityActive = location.pathname === "/app/imports/activity";
  const newImportActive = !historyActive && location.pathname === "/app/imports";
  const [newImportDirty, setNewImportDirty] = useState(false);
  const leavingViaConfirmation = useRef(false);
  const isPostSubmission = navigation.formMethod?.toUpperCase() === "POST";

  useEffect(() => {
    if (!newImportDirty) return;
    window.addEventListener("beforeunload", confirmLeavingNewImport);
    return () => window.removeEventListener("beforeunload", confirmLeavingNewImport);
  }, [newImportDirty]);

  useEffect(() => {
    if (!newImportActive && newImportDirty) setNewImportDirty(false);
  }, [newImportActive, newImportDirty]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    newImportDirty && !isPostSubmission && newImportActive &&
    currentLocation.pathname === "/app/imports" &&
    nextLocation.pathname !== currentLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const modal = leaveNewImportModalElement();
    try {
      const showing = shopify.modal.show?.(LEAVE_NEW_IMPORT_MODAL_ID);
      if (showing) {
        void showing.catch(() => {
          try { modal?.showOverlay?.(); } catch { /* Keep navigation blocked if both modal APIs fail. */ }
        });
      } else {
        modal?.showOverlay?.();
      }
    } catch {
      try { modal?.showOverlay?.(); } catch { /* Keep navigation blocked if both modal APIs fail. */ }
    }
  }, [blocker.state, shopify]);

  async function hideLeaveNewImportModal() {
    const modal = leaveNewImportModalElement();
    try {
      const hiding = shopify.modal.hide?.(LEAVE_NEW_IMPORT_MODAL_ID);
      if (hiding) {
        await hiding;
        return;
      }
    } catch {
      // Fall back to the Polaris element method if App Bridge can't hide it.
    }
    try { modal?.hideOverlay?.(); } catch { /* The blocker still protects the selected import. */ }
  }

  function stayOnNewImport() {
    if (blocker.state === "blocked") blocker.reset();
    void hideLeaveNewImportModal();
  }

  async function leaveNewImport() {
    leavingViaConfirmation.current = true;
    setNewImportDirty(false);
    await hideLeaveNewImportModal();
    if (blocker.state === "blocked") blocker.proceed();
    leavingViaConfirmation.current = false;
  }

  return (
    <s-page heading="Imports" inlineSize="large">
      <div className="stockhub-page stockhub-import-workspace">
      <nav className="stockhub-import-tabs" aria-label="Import pages">
        <div className="stockhub-import-tab-actions">
          <s-button
            href="/app/imports"
            accessibilityLabel={newImportActive ? "New Import, current page" : "New Import"}
            variant={newImportActive ? "primary" : "secondary"}
            onClick={(event) => {
              event.preventDefault();
              navigate("/app/imports");
            }}
          >
            New Import
          </s-button>
          <s-button
            href="/app/imports/history"
            accessibilityLabel={historyActive ? "Import History, current page" : "Import History"}
            variant={historyActive ? "primary" : "secondary"}
            onClick={(event) => {
              event.preventDefault();
              navigate("/app/imports/history");
            }}
          >
            Import History
          </s-button>
          <s-button
            href="/app/imports/activity"
            accessibilityLabel={activityActive ? "Activity History, current page" : "Activity History"}
            variant={activityActive ? "primary" : "secondary"}
            onClick={(event) => {
              event.preventDefault();
              navigate("/app/imports/activity");
            }}
          >
            Activity History
          </s-button>
        </div>
      </nav>
      <s-modal
        id={LEAVE_NEW_IMPORT_MODAL_ID}
        accessibilityLabel="Leave New Import confirmation"
        heading="Leave New Import?"
        onHide={() => {
          if (!leavingViaConfirmation.current && blocker.state === "blocked") blocker.reset();
        }}
      >
        <s-paragraph>Leaving will discard the selected CSV and Shopify location. Stay to keep working on this import.</s-paragraph>
        <s-button slot="primary-action" variant="primary" onClick={leaveNewImport}>Leave</s-button>
        <s-button slot="secondary-actions" variant="secondary" onClick={stayOnNewImport}>Stay</s-button>
      </s-modal>
      <ImportDirtyContext.Provider value={{ setNewImportDirty }}>
        <div className="stockhub-import-content"><Outlet /></div>
      </ImportDirtyContext.Provider>
      </div>
    </s-page>
  );
}
