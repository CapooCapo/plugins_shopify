import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
}

export default function ShipmentsLayout() {
  return <Outlet />;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
