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
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
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
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

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

    // Build GraphQL query
    const query = `
      query DiscountCodeLookup($code: String!) {
        discountCodeBasic(code: $code) {
          id
          code
          usageCount
          usageLimit
          priceRule {
            id
            valueV2 {
              __typename
              ... on MoneyV2 {
                amount
                currencyCode
              }
              ... on PricingPercentageValue {
                percentage
              }
            }
            usageLimit
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
      console.error("Shopify GraphQL error response:", text);
      throw new Error(`Shopify API error: ${response.status}`);
    }

    const respJson = await response.json();
    // Debug logging
    console.log("GraphQL raw response:", JSON.stringify(respJson));

    // If GraphQL returns errors
    if (respJson.errors) {
      console.error("GraphQL query errors:", respJson.errors);
      return res.status(500).json({ valid: false, message: "Shopify API error", errors: respJson.errors });
    }

    const discount = respJson.data?.discountCodeBasic;
    if (!discount) {
      // Discount code doesn’t exist
      return res.status(200).json({ valid: false, message: "Discount code not found", original_total });
    }

    const priceRule = discount.priceRule;
    if (!priceRule) {
      // No associated price rule — weird but handle it
      return res.status(200).json({ valid: false, message: "No price rule for this discount", original_total });
    }

    // 1. Check prerequisite subtotal
    if (priceRule.prerequisiteSubtotalRange?.greaterThanOrEqualTo != null) {
      const minSubtotalFloat = parseFloat(priceRule.prerequisiteSubtotalRange.greaterThanOrEqualTo);
      const minSubtotalCents = Math.round(minSubtotalFloat * 100);
      if (original_total < minSubtotalCents) {
        return res.status(200).json({
          valid: false,
          message: `Cart total must be at least ${minSubtotalFloat} to apply this coupon`,
          original_total,
        });
      }
    }

    // 2. Check usage limit (if any)
    if (typeof priceRule.usageLimit === "number") {
      const usedCount = discount.usageCount || 0;
      if (usedCount >= priceRule.usageLimit) {
        return res.status(200).json({
          valid: false,
          message: "Discount usage limit reached",
          usage_count: usedCount,
          usage_limit: priceRule.usageLimit,
        });
      }
    }

    // 3. Calculate discount amount
    let amount = 0; // in cents

    const valueV2 = priceRule.valueV2;
    if (valueV2) {
      // Two possible types: MoneyV2 or PricingPercentageValue
      if (valueV2.__typename === "MoneyV2") {
        // Fixed‐amount discount
        const moneyAmount = parseFloat(valueV2.amount); // e.g. "10.00"
        const discountCents = Math.round(moneyAmount * 100);
        // Don't give more than the cart total
        amount = Math.min(discountCents, original_total);
      } else if (valueV2.__typename === "PricingPercentageValue") {
        const pct = parseFloat(valueV2.percentage); // e.g. 10 = 10%
        amount = Math.round((original_total * pct) / 100);
      } else {
        console.warn("Unexpected valueV2 type:", valueV2.__typename);
      }
    } else {
      console.warn("No valueV2 found on priceRule, cannot compute amount");
    }

    // 4. Compute new total
    const new_total = Math.max(0, original_total - amount);

    return res.status(200).json({
      valid: true,
      discount: {
        id: discount.id,
        code: discount.code,
        usageCount: discount.usageCount,
      },
      priceRule: {
        id: priceRule.id,
        usageLimit: priceRule.usageLimit,
        prerequisiteSubtotalRange: priceRule.prerequisiteSubtotalRange,
        valueV2,
      },
      original_total,
      amount,
      new_total,
    });

  } catch (err) {
    console.error("Server error validating coupon:", err);
    return res.status(500).json({
      valid: false,
      message: "Server error",
      error: err.message,
    });
  }
}
