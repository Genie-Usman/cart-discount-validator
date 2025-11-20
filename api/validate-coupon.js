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
    // Lookup discount code via REST API
    const codeUrl = `https://${SHOP}/admin/api/2025-10/discount_codes/lookup.json?code=${encodeURIComponent(
      code
    )}`;
    const codeRes = await fetch(codeUrl, {
      headers: { "X-Shopify-Access-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
    });

    if (!codeRes.ok) {
      if (codeRes.status === 404) {
        return res.status(200).json({ valid: false, message: "Discount code not found" });
      } else {
        const text = await codeRes.text();
        return res
          .status(codeRes.status)
          .json({ valid: false, message: "Shopify API error", details: text });
      }
    }

    const codeData = await codeRes.json();
    const discount = codeData.discount_code || codeData;
    const priceRule = discount.price_rule || discount;

    console.log("DEBUG priceRule:", priceRule);

    const original_total = typeof cart_total_cents === "number" ? cart_total_cents : 0;

    // 1️⃣ Check prerequisites (minimum subtotal)
    if (priceRule.prerequisite_subtotal_range) {
      const { greater_than_or_equal_to } = priceRule.prerequisite_subtotal_range;
      if (greater_than_or_equal_to) {
        const minSubtotal = Math.round(parseFloat(greater_than_or_equal_to) * 100); // in cents
        if (original_total < minSubtotal) {
          return res.status(200).json({
            valid: false,
            message: `Cart total must be at least ${minSubtotal / 100} to apply this coupon`,
            original_total,
          });
        }
      }
    }

    // 2️⃣ Check usage limit
    if (typeof priceRule.usage_limit === "number") {
      const used = discount.usage_count || 0;
      if (used >= priceRule.usage_limit) {
        return res.status(200).json({
          valid: false,
          message: "Discount usage limit reached",
          usage_count: used,
          usage_limit: priceRule.usage_limit,
        });
      }
    }

    // 3️⃣ Calculate discount amount (always positive)
    let amount = 0;
    if (priceRule.value_type === "percentage" && priceRule.value) {
      const pct = Math.abs(parseFloat(priceRule.value)); // percentage
      amount = Math.round(original_total * (pct / 100));
    } else if (priceRule.value_type === "fixed_amount" && priceRule.value) {
      const fixed = Math.abs(Math.round(parseFloat(priceRule.value) * 100));
      amount = Math.min(fixed, original_total);
    } else if (discount.amount) {
      const fixed = Math.abs(Math.round(parseFloat(discount.amount) * 100));
      amount = Math.min(fixed, original_total);
    }

    const new_total = Math.max(0, original_total - amount);

    // ✅ Return structured response
    return res.status(200).json({
      valid: true,
      discount,
      priceRule,
      amount,          // positive number in cents
      original_total,
      new_total,
    });

  } catch (err) {
    console.error("Server error validating coupon:", err);
    return res.status(500).json({ valid: false, message: "Server error" });
  }
}