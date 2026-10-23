import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { acknowledgeCustomerDataRequest } from "../utils/privacy-webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  acknowledgeCustomerDataRequest(payload);
  return new Response();
};
