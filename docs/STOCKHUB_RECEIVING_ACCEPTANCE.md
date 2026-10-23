# StockHub Receiving Acceptance Scenarios

This matrix is the baseline for Sprint 1–3 business-rule tests. Test fixtures/fakes prove application behavior only, not Shopify live behavior.

| ID | Scenario | Expected result |
| --- | --- | --- |
| T01 | Same SKU in different Shipments | Valid independent physical receipt; no global SKU duplicate rejection. |
| T02 | One Shipment has multiple Receipts | Each physical receipt is counted once; aggregate totals are the sum of distinct confirmed receipt lines only. |
| T03 | Two Receipts at different Shopify Locations | Each Receipt has exactly one Location and only its own prepared operations target that Location. |
| T04 | CSV has 100 rows: 95 valid, 5 invalid | 95 valid rows can continue; 5 errors retain source row/value, reason, and import context; none are lost or synced. |
| T05 | Received 70, Accepted 65, Damaged 5 | Balance is valid; only +65 may be proposed for Shopify. |
| T06 | Unknown SKU physically received | Preserve as physical/exception data, held for review; no target or Shopify delta. |
| T07 | Existing Product, new Size XL | Prepare a new-variant proposal; require user confirmation; no Shopify mutation in S1–3. |
| T08 | New Product with M/L/XL | Prepare one Product proposal containing three variants; require confirmation; no Shopify creation. |
| T09 | Duplicate SKU rows in CSV | Present an explicit merge decision; preserve original rows; never silently sum. |
| T10 | Multiple Shopify variants share a SKU | Block automatic selection and require review. |
| T11 | Double/concurrent Confirm | One confirmed Receipt and one set of stable pending operations; physical quantity is not counted twice. |
| T12 | Closed Shipment has unresolved issues | Receiving is closed; exceptions remain visible and unchanged. |
| T13 | Reopen Shipment | Reason required; append-only event recorded; prior closure remains in history. |
| T14 | Resolve original CSV error later | Future linked Resolution only; no new physical Receipt and no recounting original Received quantity. |
| T15 | Expected Goods CSV imported | Stores expectation only; no received quantity, confirmed Receipt, or Shopify operation. |
| T16 | Original ImportBatch history | Historical records and statuses are preserved; no automatic migration into confirmed Shipment/Receipt facts. |
| T17 | Expected quantities missing | Persist/display unknown (`null`); never coerce to zero or claim fully received. |
| T18 | Future inventory operations prepared | State remains pending/not executed; UI does not claim Shopify mutation/sync succeeded. |

Additional focused boundaries: shipment reference uniqueness is shop + reference type + issuer + normalized value; reference original text remains displayable. Counted items balance `Received = Accepted + Damaged + On Hold`, with Wrong Items stored separately. A Receipt targets one shop and one Location only. A closed Shipment cannot accept a Receipt until reasoned reopen. No S1–3 test may call live Shopify mutation endpoints or change the current development database.
