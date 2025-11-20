import fetch from "node-fetch";

export default async function handler(req, res) {
  const { code, cart_total_cents } = req.body;
  const SHOP = process.env.SHOP_NAME;
  const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!code) return res.status(400).json({ valid: false, message: "No code" });
  if (!SHOP || !ADMIN_TOKEN) {
    return res.status(500).json({ valid: false, message: "Server misconfigured" });
  }

  const original_total = typeof cart_total_cents === "number" ? cart_total_cents : 0;

  const query = `
    query getDiscountByCode($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            usageCount
            codes(first: 10) {
              nodes {
                id
                code
              }
            }
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

  const response = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables: { code } }),
  });

  const respJson = await response.json();
  console.log("GraphQL raw response:", JSON.stringify(respJson, null, 2));

  if (respJson.errors) {
    return res.status(500).json({ valid: false, message: "Shopify API error", errors: respJson.errors });
  }

  const node = respJson.data?.codeDiscountNodeByCode;
  if (!node || !node.codeDiscount) {
    return res.status(200).json({ valid: false, message: "Code not found", original_total });
  }

  const discountBasic = node.codeDiscount;
  if (discountBasic.__typename !== "DiscountCodeBasic") {
    return res.status(200).json({ valid: false, message: "Unsupported discount type", original_total });
  }

  const priceRule = discountBasic.priceRule;
  if (!priceRule) {
    return res.status(200).json({ valid: false, message: "No price rule", original_total });
  }

  // Prerequisite
  const prereq = priceRule.prerequisiteSubtotalRange?.greaterThanOrEqualTo;
  if (prereq != null) {
    const min = Math.round(parseFloat(prereq) * 100);
    if (original_total < min) {
      return res.status(200).json({
        valid: false,
        message: `Cart total must be at least ${prereq}`,
        original_total,
      });
    }
  }

  // Usage limit
  if (typeof priceRule.usageLimit === "number") {
    if (discountBasic.usageCount >= priceRule.usageLimit) {
      return res.status(200).json({
        valid: false,
        message: "Usage limit reached",
      });
    }
  }

  // Calculate amount
  let amount = 0;
  const vv = priceRule.valueV2;
  if (vv.__typename === "PricingPercentageValue") {
    amount = Math.round((original_total * parseFloat(vv.percentage)) / 100);
  } else if (vv.__typename === "MoneyV2") {
    const fixed = Math.round(parseFloat(vv.amount) * 100);
    amount = Math.min(fixed, original_total);
  }

  const new_total = Math.max(0, original_total - amount);

  return res.status(200).json({
    valid: true,
    discount: { id: node.id, code, usageCount: discountBasic.usageCount },
    priceRule,
    original_total,
    amount,
    new_total,
  });
}
