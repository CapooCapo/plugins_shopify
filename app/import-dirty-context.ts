import { createContext, useContext } from "react";

type ImportDirtyContextValue = {
  setNewImportDirty: (dirty: boolean) => void;
};

export const ImportDirtyContext = createContext<ImportDirtyContextValue | null>(null);

export function useImportDirtyContext() {
  const context = useContext(ImportDirtyContext);
  if (!context) throw new Error("Import dirty-state context is unavailable.");
  return context;
}
