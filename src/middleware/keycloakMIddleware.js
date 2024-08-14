const jwt = require('jsonwebtoken');

function tokenValidator(request) {
  const authHeader = request.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  const payload = jwt.decode(token, { json: true });

  if (payload?.iss && payload?.sub && payload?.aud && payload?.exp && payload?.iat) {
    console.log('Valid token');
    return payload;
  } else {
    console.log('Invalid token');
    return null;
  }
}

const hasRealmRoles = (roles) => {
  return (req, res, next) => {
    const sessionDetails = tokenValidator(req);

    if (sessionDetails === null) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const realmRoles = sessionDetails.realm_access.roles;

    const hasValidRoles = roles.every(role => realmRoles.includes(role));

    if (hasValidRoles) {
      next();
    } else {
      return res.status(403).json({ message: "Unauthorized: Invalid role" });
    }
  };
};

module.exports = hasRealmRoles;
