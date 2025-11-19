// /pages/api/validate-coupon.js  (or /app/api/validate-coupon/route.js for App Router)
import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, message: "Method not allowed" });
  }

  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, message: "No coupon provided" });

  // Use environment variables
  const SHOP = process.env.SHOP_NAME;                 // "eiser-ecom.myshopify.com"
  const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Admin API token with read_price_rules

  if (!SHOP || !ADMIN_TOKEN) {
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

    if (apiRes.status === 200) {
      const data = await apiRes.json();
      return res.status(200).json({ valid: true, discount: data });
    } else if (apiRes.status === 404) {
      return res.status(200).json({ valid: false, message: "Discount code not found" });
    } else {
      const text = await apiRes.text();
      return res.status(apiRes.status).json({ valid: false, message: text });
    }
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ valid: false, message: "Server error" });
  }
}