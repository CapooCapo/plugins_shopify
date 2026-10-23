import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { redactCustomerData } from "../utils/privacy-webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request);
  redactCustomerData(payload);
  return new Response();
};
