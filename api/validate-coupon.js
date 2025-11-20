// /pages/api/validate-coupon.js
import fetch from "node-fetch";

const ALLOW_ALL = false;

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const allowOrigin = ALLOW_ALL
    ? "*"
    : allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0] || "";

  // Handle preflight request
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    return res.status(204).end();
  }

  // Only allow POST
  if (req.method !== "POST") {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    return res.status(405).json({ valid: false, message: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);

  const { code, cart_total_cents } = req.body;
  const SHOP = process.env.SHOP_NAME;
  const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!code || !SHOP || !ADMIN_TOKEN) {
    return res.status(400).json({ valid: false, message: "Missing code or server misconfigured" });
  }

  try {
    const original_total = typeof cart_total_cents === "number" ? cart_total_cents : 0;

    // Step 1: Lookup discount code
    const lookupUrl = `https://${SHOP}/admin/api/2025-10/discount_codes/lookup.json?code=${encodeURIComponent(code)}`;
    const lookupRes = await fetch(lookupUrl, {
      headers: { "X-Shopify-Access-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
    });

    if (!lookupRes.ok) {
      if (lookupRes.status === 404) {
        return res.status(200).json({ valid: false, message: "Discount code not found" });
      }
      const text = await lookupRes.text();
      return res.status(lookupRes.status).json({ valid: false, message: "Shopify API error", details: text });
    }

    const lookupData = await lookupRes.json();
    const discountCode = lookupData.discount_code;

    if (!discountCode || !discountCode.price_rule_id) {
      return res.status(200).json({ valid: false, message: "No price rule associated with this code" });
    }

    const priceRuleId = discountCode.price_rule_id;

    // Step 2: Get price rule details
    const priceRuleUrl = `https://${SHOP}/admin/api/2025-10/price_rules/${priceRuleId}.json`;
    const priceRuleRes = await fetch(priceRuleUrl, {
      headers: { "X-Shopify-Access-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
    });

    if (!priceRuleRes.ok) {
      const text = await priceRuleRes.text();
      return res.status(priceRuleRes.status).json({ valid: false, message: "Shopify API error fetching price rule", details: text });
    }

    const priceRuleData = await priceRuleRes.json();
    const priceRule = priceRuleData.price_rule;

    // Step 3: Check prerequisite subtotal
    if (priceRule.prerequisite_subtotal_range?.greater_than_or_equal_to) {
      const minSubtotalCents = Math.round(parseFloat(priceRule.prerequisite_subtotal_range.greater_than_or_equal_to) * 100);
      if (original_total < minSubtotalCents) {
        return res.status(200).json({
          valid: false,
          message: `Cart total must be at least ${(minSubtotalCents / 100).toFixed(2)} to use this coupon`,
          original_total
        });
      }
    }

    // Step 4: Check usage limits
    if (typeof priceRule.usage_limit === "number") {
      const used = discountCode.usage_count || 0;
      if (used >= priceRule.usage_limit) {
        return res.status(200).json({
          valid: false,
          message: "Discount usage limit reached",
          usage_count: used,
          usage_limit: priceRule.usage_limit
        });
      }
    }

    // Step 5: Calculate discount
    let amount = 0;
    if (priceRule.value_type === "percentage") {
      const pct = Math.abs(parseFloat(priceRule.value));
      amount = Math.round(original_total * pct / 100);
    } else if (priceRule.value_type === "fixed_amount") {
      const fixed = Math.abs(Math.round(parseFloat(priceRule.value) * 100));
      amount = Math.min(fixed, original_total);
    }

    const new_total = Math.max(0, original_total - amount);

    return res.status(200).json({
      valid: true,
      discount: discountCode,
      priceRule,
      original_total,
      amount,
      new_total
    });

  } catch (err) {
    console.error("Coupon validation error:", err);
    return res.status(500).json({ valid: false, message: "Server error", error: err.message });
  }
}
