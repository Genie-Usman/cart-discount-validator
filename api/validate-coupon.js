// /pages/api/validate-coupon.js

export default async function handler(req, res) {
  // --- CORS FIX ---
  res.setHeader("Access-Control-Allow-Origin", "https://eiser-ecom.myshopify.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // preflight success
  }

  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, message: "Method not allowed" });
  }

  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ valid: false, message: "No coupon provided" });
  }

  const SHOP = process.env.SHOP_NAME;                 // ex: "eiser-ecom.myshopify.com"
  const ADMIN_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Admin API token

  if (!SHOP || !ADMIN_TOKEN) {
    return res.status(500).json({
      valid: false,
      message: "Server misconfiguration: Missing SHOP_NAME or SHOPIFY_ACCESS_TOKEN",
    });
  }

  try {
    const url = `https://${SHOP}/admin/api/2025-10/discount_codes/lookup.json?code=${encodeURIComponent(code)}`;

    const shopifyResponse = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
    });

    // Coupon found
    if (shopifyResponse.status === 200) {
      const discountData = await shopifyResponse.json();
      return res.status(200).json({ valid: true, discount: discountData });
    }

    // Coupon not found
    if (shopifyResponse.status === 404) {
      return res.status(200).json({
        valid: false,
        message: "Discount code not found",
      });
    }

    // Some other Shopify error
    const errorText = await shopifyResponse.text();
    return res.status(shopifyResponse.status).json({
      valid: false,
      message: errorText,
    });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(200).json({
      valid: true,
      message: `Valid coupon: ${code}`,
      discount: data
    });

  }
}