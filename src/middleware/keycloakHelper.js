// keycloakHelper.js
const axios = require('axios');

async function getAccessToken() {
  try {
    const response = await axios.post(
      `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM_NAME}/protocol/openid-connect/token`,
      new URLSearchParams({
        client_id: process.env.KEYCLOAK_CLIENT_ID,
        client_secret: process.env.KEYCLOAK_SECRET,
        grant_type: "client_credentials",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error("Failed to get access token", error);
    throw error;
  }
}

module.exports = { getAccessToken };
