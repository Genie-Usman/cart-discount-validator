// /pages/api/validate-coupon.js
import fetch from "node-fetch";

const ALLOW_ALL = false; // set to true only for testing (not recommended in production)

export default async function handler(req, res) {
  // CORS preflight
  const origin = req.headers.origin || "";
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

  if (req.method === "OPTIONS") {
    const allowOrigin = ALLOW_ALL ? "*" : (allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "");
    res.setHeader("Access-Control-Allow-Origin", allowOrigin || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    return res.status(204).end();
  }

  // Only POST allowed
  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, message: "Method not allowed" });
  }

  // CORS response header for actual request
  const allowOrigin = ALLOW_ALL ? "*" : (allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "");
  res.setHeader("Access-Control-Allow-Origin", allowOrigin || "*");

  const { code, cart_total_cents } = req.body || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ valid: false, message: "No coupon code provided" });
  }

  const SHOP = process.env.SHOP_NAME; // e.g. eiser-ecom.myshopify.com
  const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!SHOP || !ADMIN_TOKEN) {
    console.error("Missing env vars SHOP_NAME or SHOPIFY_ACCESS_TOKEN");
    return res.status(500).json({ valid: false, message: "Server misconfiguration" });
  }

  try {
    const url = `https://${SHOP}/admin/api/2025-10/discount_codes/lookup.json?code=${encodeURIComponent(code)}`;

    const apiRes = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    });

    // 200 -> found, 404 -> not found
    if (apiRes.status === 200) {
      const data = await apiRes.json();
      // data.discount_code usually present; data.price_rule may also be present
      const discount = data.discount_code || data;

      // optional compute amount/new_total if cart_total_cents is provided
      let amount = null;
      let original_total = null;
      let new_total = null;

      if (typeof cart_total_cents === "number" && cart_total_cents >= 0) {
        original_total = cart_total_cents;
        const pr = discount.price_rule || discount.price_rule || null; // fallback
        // If discount object contains price_rule with "value_type" and "value"
        const value_type = pr?.value_type || pr?.allocation_method || null;
        const value = pr?.value;

        if (pr && value != null) {
          if (pr.value_type === "percentage") {
            // value is a string or number like "10.0"
            const pct = Number(value) || 0;
            amount = Math.round(original_total * (pct / 100));
          } else if (pr.value_type === "fixed_amount") {
            // value is a price string like "5.00"
            const fixed = Math.round((Number(value) || 0) * 100);
            amount = Math.min(fixed, original_total);
          } else {
            // unknown rule type: no calculation
            amount = null;
          }
        } else {
          // if discount contains "amount" or "percentage" fields, try those
          if (discount.amount) {
            const fixed = Math.round((Number(discount.amount) || 0) * 100);
            amount = Math.min(fixed, original_total);
          } else if (discount.percentage) {
            const pct = Number(discount.percentage) || 0;
            amount = Math.round(original_total * (pct / 100));
          }
        }

        if (amount != null) {
          new_total = Math.max(0, original_total - amount);
        }
      }

      return res.status(200).json({
        valid: true,
        discount,
        // return computed fields in cents if available:
        ...(amount != null ? { amount, original_total, new_total } : {}),
      });
    } else if (apiRes.status === 404) {
      return res.status(200).json({ valid: false, message: "Discount code not found" });
    } else {
      const text = await apiRes.text();
      console.error("Shopify returned:", apiRes.status, text);
      return res.status(apiRes.status).json({ valid: false, message: "Shopify API error", details: text });
    }
  } catch (err) {
    console.error("Server error validating coupon:", err);
    return res.status(500).json({ valid: false, message: "Server error" });
  }
}
