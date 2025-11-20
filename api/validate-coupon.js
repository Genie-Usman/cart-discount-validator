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
      : allowedOrigins[0] || "*";

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
    : allowedOrigins[0] || "*";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

  const { code, cart_total_cents } = req.body || {};

  if (!code) {
    return res.status(400).json({ valid: false, message: "No coupon code provided" });
  }

  const SHOP = process.env.SHOP_NAME;
  const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!SHOP || !ADMIN_TOKEN) {
    return res.status(500).json({ valid: false, message: "Server misconfiguration" });
  }

  try {
    const original_total = typeof cart_total_cents === "number" ? cart_total_cents : 0;

    // REAL WORKING SHOPIFY QUERY
    const query = `
      query GetDiscount($code: String!) {
        discountCodes(first: 1, query: $code) {
          edges {
            node {
              id
              code
              usageCount
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
        }
      }
    `;

    const gqlRes = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN
      },
      body: JSON.stringify({ query, variables: { code } })
    });

    const data = await gqlRes.json();
    console.log("GraphQL Response:", JSON.stringify(data, null, 2));

    if (data.errors) {
      return res.status(500).json({ valid: false, message: "Shopify GraphQL Error", errors: data.errors });
    }

    const node = data.data?.discountCodes?.edges?.[0]?.node;

    if (!node) {
      return res.status(200).json({ valid: false, message: "Discount code not found", original_total });
    }

    const priceRule = node.priceRule;

    // PRE-REQ CHECK
    const prereq = priceRule.prerequisiteSubtotalRange?.greaterThanOrEqualTo;
    if (prereq != null) {
      const min = Math.round(parseFloat(prereq) * 100);
      if (original_total < min) {
        return res.status(200).json({
          valid: false,
          message: `Cart total must be at least ${prereq}`,
          original_total
        });
      }
    }

    // USAGE LIMIT CHECK
    if (priceRule.usageLimit != null && node.usageCount >= priceRule.usageLimit) {
      return res.status(200).json({
        valid: false,
        message: "Discount usage limit reached",
      });
    }

    // DISCOUNT CALCULATION
    let amount = 0;
    const v = priceRule.valueV2;

    if (v.__typename === "PricingPercentageValue") {
      amount = Math.round((original_total * parseFloat(v.percentage)) / 100);
    }

    if (v.__typename === "MoneyV2") {
      const fixed = Math.round(parseFloat(v.amount) * 100);
      amount = Math.min(fixed, original_total);
    }

    const new_total = Math.max(0, original_total - amount);

    res.status(200).json({
      valid: true,
      discount: {
        id: node.id,
        code: node.code,
        usageCount: node.usageCount
      },
      priceRule,
      original_total,
      amount,
      new_total
    });

  } catch (err) {
    console.error("Validator error:", err);
    return res.status(500).json({
      valid: false,
      message: "Server error",
      error: err.message
    });
  }
}
