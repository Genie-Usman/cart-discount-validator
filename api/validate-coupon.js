import fetch from "node-fetch";

const ALLOW_ALL = false; // for testing only

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // Handle CORS preflight
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

  // Only allow POST
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
    // Fetch discount code from Shopify
    const url = `https://${SHOP}/admin/api/2025-10/discount_codes/lookup.json?code=${encodeURIComponent(code)}`;
    const apiRes = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    });

    if (apiRes.status === 200) {
      const data = await apiRes.json();
      const discount = data.discount_code || data;
      const priceRule = discount.price_rule || discount;

      // Convert cart total to cents if number provided
      const original_total = typeof cart_total_cents === "number" ? cart_total_cents : 0;
      let amount = 0;
      let new_total = original_total;

      if (priceRule) {
        if (priceRule.value_type === "percentage") {
          // Percentage discount
          const pct = parseFloat(priceRule.value) || 0;
          amount = Math.round(original_total * (pct / 100));
        } else if (priceRule.value_type === "fixed_amount") {
          // Fixed amount in store currency units → convert to cents
          const fixedCents = Math.round(parseFloat(priceRule.value) * 100);
          amount = Math.min(fixedCents, original_total);
        } else if (discount.amount) {
          // Fallback if amount is directly on discount
          const fixedCents = Math.round(parseFloat(discount.amount) * 100);
          amount = Math.min(fixedCents, original_total);
        }

        // Ensure new total is non-negative
        new_total = Math.max(0, original_total - amount);
      }

      return res.status(200).json({
        valid: true,
        discount,
        amount,         // discount in cents
        original_total, // original cart total in cents
        new_total,      // cart total after discount
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
