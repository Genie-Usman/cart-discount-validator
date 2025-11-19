// api/validate-coupon.js
import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, message: "No coupon provided" });

  try {
    // Call Shopify Admin API to validate code here
    const shopifyRes = await fetch(`https://${process.env.SHOP_NAME}/admin/api/2025-10/discount_codes/lookup.json?code=${code}`, {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    });

    const data = await shopifyRes.json();

    if (data.discount_code) {
      res.json({ valid: true, discount: data.discount_code });
    } else {
      res.json({ valid: false, message: "Invalid coupon" });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, message: "Server error" });
  }
}
