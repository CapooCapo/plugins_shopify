import { useNavigation } from "react-router";

/** A compact accessible indicator for route navigations and submissions. */
export function RoutePending() {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;

  const label = navigation.state === "submitting" ? "Submitting request…" : "Loading page…";

  return (
    <div className="stockhub-route-pending" role="status" aria-live="polite" aria-atomic="true">
      <s-spinner size="base" accessibilityLabel={label} />
      <span>{label}</span>
    </div>
  );
}
