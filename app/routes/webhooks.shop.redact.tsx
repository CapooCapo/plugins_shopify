import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { redactShopData } from "../utils/privacy-webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);
  await redactShopData(db, shop, payload);
  return new Response();
};
