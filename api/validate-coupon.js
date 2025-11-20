// /pages/api/validate-coupon.js
import fetch from "node-fetch";

const ALLOW_ALL = false;

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (req.method === "OPTIONS") {
    const allowOrigin = ALLOW_ALL
      ? "*"
      : allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0] || "";
    res.setHeader("Access-Control-Allow-Origin", allowOrigin || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, message: "Method not allowed" });
  }

  const allowOrigin = ALLOW_ALL
    ? "*"
    : allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0] || "";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin || "*");

  const { code, cart_total_cents } = req.body || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ valid: false, message: "No coupon code provided" });
  }

  const SHOP = process.env.SHOP_NAME;
  const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!SHOP || !ADMIN_TOKEN) {
    console.error("Missing env vars SHOP_NAME or SHOPIFY_ACCESS_TOKEN");
    return res.status(500).json({ valid: false, message: "Server misconfiguration" });
  }

  try {
    const original_total = typeof cart_total_cents === "number" ? cart_total_cents : 0;

    // GraphQL query to fetch discount code and price rule
    const query = `
      query DiscountCodeLookup($code: String!) {
        discountCode(code: $code) {
          code
          id
          usageCount
          priceRule {
            id
            valueType
            valueV2 {
              amount
              currencyCode
            }
            usageLimit
            customerSelection
            prerequisiteSubtotalRange {
              greaterThanOrEqualTo
            }
          }
        }
      }
    `;

    const response = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables: { code } }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Shopify API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const discount = data.data.discountCode;

    if (!discount) {
      return res.status(200).json({ valid: false, message: "Discount code not found" });
    }

    const priceRule = discount.priceRule || {};
    let amount = 0;

    // 1️⃣ Check prerequisites (minimum subtotal)
    if (priceRule.prerequisiteSubtotalRange?.greaterThanOrEqualTo) {
      const minSubtotal = Math.round(parseFloat(priceRule.prerequisiteSubtotalRange.greaterThanOrEqualTo) * 100);
      if (original_total < minSubtotal) {
        return res.status(200).json({
          valid: false,
          message: `Cart total must be at least ${minSubtotal / 100} to apply this coupon`,
          original_total,
        });
      }
    }

    // 2️⃣ Check usage limit
    if (typeof priceRule.usageLimit === "number") {
      const used = discount.usageCount || 0;
      if (used >= priceRule.usageLimit) {
        return res.status(200).json({
          valid: false,
          message: "Discount usage limit reached",
          usage_count: used,
          usage_limit: priceRule.usageLimit,
        });
      }
    }

    // 3️⃣ Calculate discount amount (always positive)
    if (priceRule.valueType === "PERCENTAGE" && priceRule.valueV2?.amount) {
      const pct = parseFloat(priceRule.valueV2.amount); // valueV2 is always positive
      amount = Math.round(original_total * (pct / 100));
    } else if (priceRule.valueType === "FIXED_AMOUNT" && priceRule.valueV2?.amount) {
      const fixed = Math.round(parseFloat(priceRule.valueV2.amount) * 100); // cents
      amount = Math.min(fixed, original_total);
    }

    const new_total = Math.max(0, original_total - amount);

    return res.status(200).json({
      valid: true,
      discount,
      priceRule,
      amount,
      original_total,
      new_total,
    });

  } catch (err) {
    console.error("Server error validating coupon:", err);
    return res.status(500).json({ valid: false, message: "Server error" });
  }
}