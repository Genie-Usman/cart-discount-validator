import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, message: "No coupon provided" });

  try {
    // Call Storefront API using GraphQL
    const query = `
      mutation checkoutCreate($input: CheckoutCreateInput!) {
        checkoutCreate(input: $input) {
          checkout {
            id
            discountApplications(first: 10) {
              edges {
                node {
                  ... on DiscountCodeApplication {
                    code
                    value {
                      ... on MoneyV2 {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        lineItems: [],
        discountCode: code
      }
    };

    const response = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/api/2025-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN
      },
      body: JSON.stringify({ query, variables })
    });

    const data = await response.json();

    const checkout = data.data.checkoutCreate.checkout;
    const errors = data.data.checkoutCreate.userErrors;

    if (errors.length) {
      return res.json({ valid: false, message: errors[0].message });
    }

    const discount = checkout.discountApplications.edges[0]?.node;
    if (discount && discount.code === code) {
      return res.json({ valid: true, discount });
    } else {
      return res.json({ valid: false, message: "Invalid coupon" });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ valid: false, message: "Server error" });
  }
}
