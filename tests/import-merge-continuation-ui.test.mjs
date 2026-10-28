/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);

test("one explicit Merge confirmation automatically continues only the same ACTIVE approval", async () => {
  const source = await readFile(detailRoute, "utf8");

  assert.match(source, /useFetcher\s*<[^>]+>\s*\(\)|useFetcher\s*\(\)/,
    "bounded server chunks need a non-navigation action channel so one confirmation can continue the same receipt");
  const effect = source.match(/useEffect\s*\(\(\)\s*=>\s*\{[\s\S]{0,1000}?\},\s*\[[^\]]*\]\s*\)/g)?.find((candidate) =>
    /continueRequired/.test(candidate) && /mergeFetcher\.submit/.test(candidate),
  ) ?? "";
  assert.ok(effect,
    "automatic continuation must be driven by the server's continueRequired response");
  assert.match(effect, /!progress\?\.continueRequired/,
    "the client must stop when the server says there is no safe automatic next chunk");
  assert.match(effect, /autoPausedRef\.current/,
    "a merchant Pause click must suppress queued automatic follow-up work");

  const confirmationForm = source.match(/<mergeFetcher\.Form\b[\s\S]*?value=\{initialMergeIntent\}[\s\S]*?<\/mergeFetcher\.Form>/)?.[0]
    ?? "";
  assert.ok(confirmationForm, "the single merchant confirmation must use the non-navigation fetcher form");
  assert.match(confirmationForm, /name="intent"[^>]*value=\{initialMergeIntent\}/);
  assert.match(confirmationForm, /name="confirmed"[^>]*value="yes"/);

  const continuation = effect.match(/mergeFetcher\.submit\s*\([\s\S]{0,500}?\)/)?.[0] ?? "";
  assert.ok(continuation, "the ACTIVE result must trigger a follow-up continue action");
  assert.match(continuation, /approvalId/);
  assert.match(continuation, /batchId/);
  assert.match(continuation, /intent\s*:\s*["']continueMerge["']/);
  assert.doesNotMatch(continuation, /confirmedCount|confirmedLineIds|lineIds/,
    "continuation must not resend client-selected rows or request a second merchant confirmation");
});

test("a PAUSED merge approval renders a safe paused state and cannot auto-submit another chunk", async () => {
  const source = await readFile(detailRoute, "utf8");
  const automaticFlow = source.match(/useEffect\s*\(\(\)\s*=>\s*\{[\s\S]{0,900}?\},\s*\[[^\]]*\]\s*\)/g)?.find((effect) =>
    /continueRequired/.test(effect) && /intent\s*:\s*["']continueMerge["']/.test(effect),
  ) ?? "";

  assert.ok(automaticFlow, "automatic chunk continuation should be isolated in a state-driven effect");
  assert.match(automaticFlow, /autoPausedRef\.current/,
    "the paused action must suppress any queued follow-up chunk");
  assert.match(source, /mergeApproval\.status\s*===\s*["']PAUSED["'][\s\S]{0,240}(?:paused|Pause|stopped|stop)/i,
    "the merchant must see that execution is paused rather than complete or rolled back");
  assert.match(source, /name="intent"[^>]*value=\{?["']pauseMerge["']/,
    "the explicit pause control must submit the pause action, not masquerade as Resume");
  assert.match(source, /name="intent"[^>]*value=\{?["']resumeApprovedMerge["']/,
    "continuing a paused approval must remain an explicit merchant action");
  assert.match(source, /Continue saved approval/i,
    "the paused approval control must be labeled as a deliberate continuation");
});

test("continuation and pause action requests are tenant-scoped and approval-identity only", async () => {
  const route = await readFile(new URL("../app/routes/app.imports._index.tsx", import.meta.url), "utf8");
  const mergeAction = route.slice(route.indexOf('const mergeIntent ='), route.indexOf('if (intent !== "preview")'));
  assert.match(mergeAction, /"continueMerge"/,
    "the action must expose a bounded approval continuation endpoint");
  assert.match(mergeAction, /"pauseMerge"/,
    "Pause must be handled separately from chunk continuation");
  assert.match(mergeAction, /where:\s*\{\s*id:\s*batchId,\s*shop:\s*session\.shop/,
    "continuation must load the receipt in the authenticated shop");
  assert.match(mergeAction, /approvalId/);
  assert.match(mergeAction, /let serviceIntent[\s\S]{0,180}:\s*"continue"/,
    "the route maps continueMerge to the service's bounded continue mode");
  const continuationSetup = mergeAction.slice(
    mergeAction.indexOf('} else {\n      approvalId = postedApprovalId;'),
    mergeAction.indexOf("const needsProductWrite"),
  );
  assert.ok(continuationSetup, "the action needs a distinct saved-approval continuation branch");
  assert.doesNotMatch(continuationSetup, /confirmedCount|confirmedLineIds|formData\.get\(["']confirmed["']\)/,
    "a continuation is bound to the stored approval and cannot mint a new client-selected line set");
  const serviceCall = [...mergeAction.matchAll(/mergeImportBatch\(\{[\s\S]*?\}\)/g)].at(-1)?.[0] ?? "";
  assert.match(serviceCall, /intent:\s*serviceIntent/);
  assert.match(serviceCall, /approvalId/);
  const pauseBranch = mergeAction.slice(mergeAction.indexOf('if (mergeIntent === "pauseMerge")'), mergeAction.indexOf('const initialConfirmation'));
  assert.match(pauseBranch, /where:\s*\{\s*id:\s*postedApprovalId,\s*shop:\s*session\.shop,\s*batchId,\s*status:\s*"ACTIVE"/,
    "pause must load the receipt in the authenticated shop");
  assert.match(pauseBranch, /approvalId/);
  assert.match(pauseBranch, /continueRequired:\s*false/,
    "the Pause response must not schedule another automatic chunk");
  assert.doesNotMatch(pauseBranch, /confirmedCount|confirmedLineIds|formData\.get\(["']confirmed["']\)/,
    "pausing does not change the approved snapshot or require new row selection");
});
