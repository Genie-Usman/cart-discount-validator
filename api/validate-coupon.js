// /pages/api/validate-coupon.js

import fetch from "node-fetch";

const ALLOW_ALL = false;

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // CORS preflight
  if (req.method === "OPTIONS") {
    const allowOrigin = ALLOW_ALL
      ? "*"
      : (allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "");
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
    : (allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "");
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
    // 1. Lookup discount code
    const codeUrl = `https://${SHOP}/admin/api/2025-10/discount_codes/lookup.json?code=${encodeURIComponent(code)}`;
    const codeRes = await fetch(codeUrl, {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    });

    if (!codeRes.ok) {
      if (codeRes.status === 404) {
        return res.status(200).json({ valid: false, message: "Discount code not found" });
      }
      const text = await codeRes.text();
      return res.status(codeRes.status).json({ valid: false, message: "Shopify API error", details: text });
    }

    const codeData = await codeRes.json();
    const discount = codeData.discount_code;
    if (!discount || !discount.price_rule_id) {
      return res.status(200).json({ valid: false, message: "Invalid discount code structure" });
    }

    // 2. Fetch the full price rule
    const ruleUrl = `https://${SHOP}/admin/api/2025-10/price_rules/${discount.price_rule_id}.json`;
    const ruleRes = await fetch(ruleUrl, {
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    });

    if (!ruleRes.ok) {
      const text = await ruleRes.text();
      return res.status(ruleRes.status).json({ valid: false, message: "Shopify API error fetching price rule", details: text });
    }

    const ruleData = await ruleRes.json();
    const priceRule = ruleData.price_rule;

    console.log("DEBUG priceRule:", priceRule);

    // 3. Calculate discount
    const original_total = typeof cart_total_cents === "number" ? cart_total_cents : 0;
    let amount = 0;
    let new_total = original_total;

    if (priceRule && priceRule.status === "ACTIVE") {
      // Case: fixed amount using valueV2
      if (priceRule.valueV2 && priceRule.valueV2.amount) {
        const fixed = Math.abs(parseFloat(priceRule.valueV2.amount) || 0);
        const fixedCents = Math.round(fixed * 100);
        amount = Math.min(fixedCents, original_total);
      }
      // Case: percentage discount
      else if (priceRule.value_type === "percentage" && priceRule.value) {
        const pct = Math.abs(parseFloat(priceRule.value) || 0);
        amount = Math.round(original_total * (pct / 100));
      }

      new_total = Math.max(0, original_total - amount);
    }

    return res.status(200).json({
      valid: true,
      discount,
      priceRule,
      amount,         // discount in cents
      original_total, // before discount
      new_total,      // after discount
    });

  } catch (err) {
    console.error("Server error validating coupon:", err);
    return res.status(500).json({ valid: false, message: "Server error" });
  }
}
