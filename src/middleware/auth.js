const jwt = require('jsonwebtoken');

function tokenValidator(request) {
  // get authorization token from request
  const authHeader = request.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  const payload = jwt.decode(token, { json: true });

  if (
    payload?.iss !== undefined &&
    payload?.sub !== undefined &&
    payload?.aud !== undefined &&
    payload?.exp !== undefined &&
    payload?.iat !== undefined 
  ) {
    console.log('Valid token');

    return {
      ...payload,
      iss: payload.iss,
      sub: payload.sub,
      aud: payload.aud,
      exp: payload.exp,
      iat: payload.iat,
      email: payload.email,
      username: payload.preferred_username,
    };
  } else {
    console.log('Invalid token');
    return null;
  }
}

module.exports = tokenValidator;
