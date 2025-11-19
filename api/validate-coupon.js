import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, message: "No coupon provided" });

  try {
    const endpoint = process.env.STOREFRONT_API_ENDPOINT;
    const token = process.env.STOREFRONT_API_TOKEN;

    const query = `
      mutation checkoutCreate($discountCode: String!) {
        checkoutCreate(input: {
          lineItems: [],
          discountCode: $discountCode
        }) {
          checkout {
            discountApplications(first: 5) {
              edges {
                node {
                  ... on DiscountCodeApplication {
                    code
                    applicable
                  }
                }
              }
            }
          }
          checkoutUserErrors {
            message
          }
        }
      }
    `;

    const shopifyRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-Shopify-Storefront-Access-Token": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        variables: { discountCode: code }
      })
    });

    const data = await shopifyRes.json();

    if (data.errors) {
      console.error("GraphQL Error:", data.errors);
      return res.status(500).json({ valid: false, message: "Shopify API error" });
    }

    const errors = data.data?.checkoutCreate?.checkoutUserErrors;
    if (errors && errors.length > 0) {
      return res.json({ valid: false, message: errors[0].message });
    }

    const apps = data.data?.checkoutCreate?.checkout?.discountApplications?.edges;

    if (apps && apps.length > 0 && apps[0].node.applicable) {
      return res.json({ valid: true, discount: apps[0].node });
    } else {
      return res.json({ valid: false, message: "Invalid coupon" });
    }

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ valid: false, message: "Server error" });
  }
}
