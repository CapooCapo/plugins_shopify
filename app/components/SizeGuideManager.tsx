import { useEffect, useState } from "react";
import { Form, Link } from "react-router";
import type { SizeGuideAssignment, SizeGuideRecord, SizeGuideSyncLock } from "../utils/size-guide-repository.server";
import type { SizeGuideColumn } from "../utils/size-guides.shared";
import type { SizeGuideProduct } from "../utils/size-guide-products.server";

type GuideAssignmentView = Omit<SizeGuideAssignment, "guide" | "syncLockToken">;
type GuideWithProducts = SizeGuideRecord & { products: GuideAssignmentView[] };
type Props = {
  guides: GuideWithProducts[];
  selectedGuideId: string | null;
  query: string;
  products: SizeGuideProduct[];
  productError: string | null;
  storageError: string | null;
  actionError: string | null;
  cleanupLocks?: SizeGuideSyncLock[];
};

const EMPTY_COLUMNS: SizeGuideColumn[] = [
  { name: "Size", kind: "label" },
  { name: "Chest", kind: "measurement" },
  { name: "Waist", kind: "measurement" },
];
const EMPTY_ROWS = [["S", "88", "68"], ["M", "94", "74"], ["L", "100", "80"]];

function SyncLabel({ assignment }: { assignment: GuideAssignmentView }) {
  const state = {
    SYNCED: "Published",
    PENDING: "Waiting to publish",
    SYNCING: "Publishing",
    FAILED: "Publish failed",
    REMOVE_WAITING_SYNC: "Removal waits for active publish",
    REMOVE_PENDING: "Removal waiting",
    REMOVE_FAILED: "Removal failed",
  }[assignment.syncStatus];
  const error = assignment.lastError?.startsWith("ORPHAN_CLEANUP_PENDING:")
    ? " · Previous metafield cleanup is fenced; retry after recovery is available."
    : assignment.lastError ? ` · ${assignment.lastError}` : "";
  return <span className={`stockhub-size-guide-state is-${assignment.syncStatus.toLowerCase()}`}>
    <span>{state}</span>{error ? <span className="stockhub-size-guide-error-detail">{error}</span> : null}
  </span>;
}

export function SizeGuideManager(props: Props) {
  const selectedGuide = props.guides.find((guide) => guide.id === props.selectedGuideId) ?? null;
  const cleanupLocks = props.cleanupLocks ?? [];
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [unit, setUnit] = useState<"cm" | "in" | "mm">("cm");
  const [columns, setColumns] = useState<SizeGuideColumn[]>(EMPTY_COLUMNS);
  const [rows, setRows] = useState<string[][]>(EMPTY_ROWS);

  useEffect(() => {
    setCreating(false);
    setTitle(selectedGuide?.title ?? "");
    setUnit(selectedGuide?.unit ?? "cm");
    setColumns(selectedGuide?.columns ?? EMPTY_COLUMNS);
    setRows(selectedGuide?.rows ?? EMPTY_ROWS);
  }, [selectedGuide]);

  const startCreating = () => {
    setCreating(true);
    setTitle("");
    setUnit("cm");
    setColumns(EMPTY_COLUMNS.map((column) => ({ ...column })));
    setRows(EMPTY_ROWS.map((row) => [...row]));
  };
  const changeColumn = (index: number, patch: Partial<SizeGuideColumn>) => {
    setColumns((current) => current.map((column, position) => position === index ? { ...column, ...patch } : column));
  };
  const addColumn = () => {
    if (columns.length >= 12) return;
    setColumns((current) => [...current, { name: `Measurement ${current.length - 1}`, kind: "measurement" }]);
    setRows((current) => current.map((row) => [...row, "1"]));
  };
  const removeColumn = (index: number) => {
    if (columns.length <= 2) return;
    const removedLabel = columns[index]?.kind === "label";
    setColumns((current) => current.filter((_, position) => position !== index).map((column, position) =>
      removedLabel && position === 0 ? { ...column, kind: "label" } : column));
    setRows((current) => current.map((row) => row.filter((_, position) => position !== index)));
  };
  const addRow = () => {
    if (rows.length >= 100) return;
    setRows((current) => [...current, columns.map((column) => column.kind === "label" ? `Size ${current.length + 1}` : "1")]);
  };
  const updateCell = (rowIndex: number, columnIndex: number, value: string) => {
    setRows((current) => current.map((row, index) => index === rowIndex
      ? row.map((cell, cellIndex) => cellIndex === columnIndex ? value : cell) : row));
  };
  const removeRow = (rowIndex: number) => setRows((current) => current.filter((_, index) => index !== rowIndex));

  return <main className="stockhub-size-guide-page">
    <header className="stockhub-size-guide-page__header">
      <div><p className="stockhub-size-guide-kicker">PRODUCT EXPERIENCE</p><h1>Size Guides</h1>
        <p>Create charts once, then assign each guide to one or more products.</p></div>
      <button type="button" onClick={startCreating} disabled={Boolean(props.storageError)}>Create size guide</button>
    </header>

    {props.storageError ? <div role="alert" className="stockhub-size-guide-notice is-error">{props.storageError}</div> : null}
    {props.actionError ? <div role="alert" className="stockhub-size-guide-notice is-error">{props.actionError}</div> : null}
    {cleanupLocks.length ? <section className="stockhub-size-guide-card" aria-labelledby="sync-recovery-title">
      <div className="stockhub-size-guide-section-heading"><div><p className="stockhub-size-guide-kicker">PRODUCT SYNC SAFETY</p>
        <h2 id="sync-recovery-title">Interrupted product operations</h2>
        <p>Products stay reserved until Shopify confirms cleanup; retry becomes available when the recovery lease expires.</p></div></div>
      <ul className="stockhub-size-guide-assignment-list">{cleanupLocks.map((lock) => <li key={lock.productId}>
        <div><strong>{lock.productTitle}</strong><span className="stockhub-size-guide-product-id">{lock.productId}</span>
          <span className="stockhub-size-guide-error-detail">{lock.state === "CLEANUP" ? "Cleanup response was not confirmed." : "A publisher stopped before completing."}</span></div>
        <Form method="post"><input type="hidden" name="intent" value="retryOrphanCleanup" />
          <input type="hidden" name="productId" value={lock.productId} /><button type="submit" className="stockhub-size-guide-button--secondary">Retry cleanup</button>
        </Form>
      </li>)}</ul>
    </section> : null}

    <div className="stockhub-size-guide-layout">
      <aside className="stockhub-size-guide-sidebar" aria-label="Saved size guides">
        <h2>Saved guides <span>{props.guides.length}</span></h2>
        {props.guides.length ? <ul>{props.guides.map((guide) => <li key={guide.id}>
          <Link to={`/app/size-guides?guide=${encodeURIComponent(guide.id)}`} aria-current={guide.id === selectedGuide?.id ? "page" : undefined}>
            <strong>{guide.title}</strong><span>{guide.products.length} assigned product{guide.products.length === 1 ? "" : "s"}</span>
          </Link>
        </li>)}</ul> : <p>No guides yet. Create one to begin.</p>}
      </aside>

      <section className="stockhub-size-guide-workspace">
        {creating ? <>
          <div className="stockhub-size-guide-section-heading"><div><p className="stockhub-size-guide-kicker">NEW CHART</p><h2>Create a size guide</h2></div></div>
          <GuideEditor id="" title={title} unit={unit} columns={columns} rows={rows} setTitle={setTitle} setUnit={setUnit}
            changeColumn={changeColumn} addColumn={addColumn} removeColumn={removeColumn} addRow={addRow} updateCell={updateCell} removeRow={removeRow} />
        </> : selectedGuide ? <>
          <div className="stockhub-size-guide-section-heading">
            <div><p className="stockhub-size-guide-kicker">CANONICAL GUIDE</p><h2>{selectedGuide.title}</h2>
              <p>Updated {new Date(selectedGuide.updatedAt).toLocaleString()}</p></div>
            <Form method="post" onSubmit={(event) => { if (!confirm(`Delete “${selectedGuide.title}” and remove its storefront chart from assigned products?`)) event.preventDefault(); }}>
              <input type="hidden" name="intent" value="delete" /><input type="hidden" name="guideId" value={selectedGuide.id} />
              <button type="submit" className="stockhub-size-guide-button--secondary">Delete guide</button>
            </Form>
          </div>
          <GuideEditor id={selectedGuide.id} title={title} unit={unit} columns={columns} rows={rows} setTitle={setTitle} setUnit={setUnit}
            changeColumn={changeColumn} addColumn={addColumn} removeColumn={removeColumn} addRow={addRow} updateCell={updateCell} removeRow={removeRow} />
          <section className="stockhub-size-guide-card" aria-labelledby="assigned-title">
            <div className="stockhub-size-guide-section-heading"><div><p className="stockhub-size-guide-kicker">PRODUCT MAPPING</p><h2 id="assigned-title">Assigned products</h2>
              <p>Each product can have only one StockHub size guide.</p></div></div>
            <Form method="get" className="stockhub-size-guide-search">
              <input type="hidden" name="guide" value={selectedGuide.id} />
              <label htmlFor="size-guide-product-search">Search this store’s products</label>
              <div><input id="size-guide-product-search" name="q" type="search" minLength={2} maxLength={100} defaultValue={props.query} placeholder="Enter at least 2 characters" />
                <button type="submit">Search products</button></div>
            </Form>
            {props.productError ? <p role="alert" className="stockhub-size-guide-inline-error">{props.productError}</p> : null}
            {props.query.length >= 2 && props.products.length ? <ul className="stockhub-size-guide-product-results">
              {props.products.map((product) => <li key={product.id}><span>{product.title}</span><Form method="post">
                <input type="hidden" name="intent" value="assign" /><input type="hidden" name="guideId" value={selectedGuide.id} /><input type="hidden" name="productId" value={product.id} />
                <button type="submit">Assign</button></Form></li>)}
            </ul> : props.query.length >= 2 && !props.productError ? <p>No products matched this search.</p> : null}
            <h3>Current assignments <span>{selectedGuide.products.length}</span></h3>
            {selectedGuide.products.length ? <ul className="stockhub-size-guide-assignment-list">
              {selectedGuide.products.map((assignment) => <li key={assignment.id}>
                <div><strong>{assignment.productTitle}</strong><span className="stockhub-size-guide-product-id">{assignment.productId}</span><SyncLabel assignment={assignment} /></div>
                <div className="stockhub-size-guide-assignment-actions">
                  {assignment.syncStatus === "FAILED" || assignment.syncStatus === "SYNCING" || assignment.syncStatus === "REMOVE_WAITING_SYNC" || assignment.syncStatus === "REMOVE_PENDING" || assignment.syncStatus === "REMOVE_FAILED" ? <Form method="post">
                    <input type="hidden" name="intent" value="retry" /><input type="hidden" name="guideId" value={selectedGuide.id} /><input type="hidden" name="productId" value={assignment.productId} />
                    <button type="submit" className="stockhub-size-guide-button--secondary">{assignment.syncStatus.startsWith("REMOVE_") ? "Retry removal" : "Retry publish"}</button>
                  </Form> : null}
                  {!assignment.syncStatus.startsWith("REMOVE_") ? <Form method="post" onSubmit={(event) => { if (!confirm(`Remove the size guide from ${assignment.productTitle}?`)) event.preventDefault(); }}>
                    <input type="hidden" name="intent" value="unassign" /><input type="hidden" name="guideId" value={selectedGuide.id} /><input type="hidden" name="productId" value={assignment.productId} />
                    <button type="submit" className="stockhub-size-guide-button--text">Unassign</button>
                  </Form> : null}
                </div>
              </li>)}
            </ul> : <p>No products assigned yet.</p>}
          </section>
        </> : !props.storageError ? <div className="stockhub-size-guide-empty"><h2>Start with your first guide</h2><p>Add measurement columns and size rows, then assign products.</p><button type="button" onClick={startCreating}>Create size guide</button></div> : null}
      </section>
    </div>
  </main>;
}

type EditorProps = {
  id: string; title: string; unit: "cm" | "in" | "mm"; columns: SizeGuideColumn[]; rows: string[][];
  setTitle: (value: string) => void; setUnit: (value: "cm" | "in" | "mm") => void;
  changeColumn: (index: number, patch: Partial<SizeGuideColumn>) => void; addColumn: () => void; removeColumn: (index: number) => void;
  addRow: () => void; updateCell: (row: number, column: number, value: string) => void; removeRow: (row: number) => void;
};

function GuideEditor(props: EditorProps) {
  return <section className="stockhub-size-guide-card" aria-label="Size chart editor">
    <Form method="post" className="stockhub-size-guide-editor">
      <input type="hidden" name="intent" value="save" /><input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="columns" value={JSON.stringify(props.columns)} /><input type="hidden" name="rows" value={JSON.stringify(props.rows)} />
      <div className="stockhub-size-guide-form-grid">
        <label>Guide title<input name="title" value={props.title} maxLength={120} onChange={(event) => props.setTitle(event.currentTarget.value)} required /></label>
        <label>Measurement unit<select name="unit" value={props.unit} onChange={(event) => props.setUnit(event.currentTarget.value as EditorProps["unit"])}>
          <option value="cm">Centimeters (cm)</option><option value="in">Inches (in)</option><option value="mm">Millimeters (mm)</option>
        </select></label>
      </div>
      <div className="stockhub-size-guide-chart-heading"><div><h3>Measurements</h3><p>Mark one column as the size label. Every measurement must be a positive number.</p></div>
        <button type="button" className="stockhub-size-guide-button--secondary" onClick={props.addColumn} disabled={props.columns.length >= 12}>Add column</button>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The scroll region must be keyboard-focusable for wide charts. */}
      <div className="stockhub-size-guide-chart-scroll" role="region" aria-label="Editable size chart" tabIndex={0}>
        <table className="stockhub-size-guide-chart"><thead><tr>{props.columns.map((column, index) => <th key={`${index}-${column.kind}`} scope="col">
          <label>Column {index + 1}<input aria-label={`Column ${index + 1} name`} value={column.name} maxLength={50} onChange={(event) => props.changeColumn(index, { name: event.currentTarget.value })} /></label>
          <select aria-label={`Column ${index + 1} type`} value={column.kind} onChange={(event) => props.changeColumn(index, { kind: event.currentTarget.value as SizeGuideColumn["kind"] })}>
            <option value="label">Size label</option><option value="measurement">Measurement</option></select>
          <button type="button" className="stockhub-size-guide-button--text" onClick={() => props.removeColumn(index)} disabled={props.columns.length <= 2}>Remove column</button>
        </th>)}</tr></thead><tbody>{props.rows.map((row, rowIndex) => <tr key={rowIndex}>
          {props.columns.map((column, columnIndex) => <td key={columnIndex}>
            <input aria-label={`${column.name}, row ${rowIndex + 1}`} inputMode={column.kind === "measurement" ? "decimal" : "text"}
              type={column.kind === "measurement" ? "number" : "text"} min={column.kind === "measurement" ? "0.000001" : undefined}
              step={column.kind === "measurement" ? "any" : undefined} value={row[columnIndex] ?? ""} required
              onChange={(event) => props.updateCell(rowIndex, columnIndex, event.currentTarget.value)} /></td>)}
          <td><button type="button" className="stockhub-size-guide-button--text" onClick={() => props.removeRow(rowIndex)} disabled={props.rows.length <= 1}>Remove row</button></td>
        </tr>)}</tbody></table>
      </div>
      <div className="stockhub-size-guide-editor-actions"><button type="button" className="stockhub-size-guide-button--secondary" onClick={props.addRow} disabled={props.rows.length >= 100}>Add size row</button>
        <button type="submit">Save guide</button></div>
    </Form>
  </section>;
}
