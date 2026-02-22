import { verifyToken } from "../utils/jwt.js";
import { getEnvAdminUserFromPayload, getUserById } from "../services/userService.js";

function extractToken(req) {
  const header = req.headers?.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

export async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    const jwtPayload = verifyToken(token, process.env.JWT_SECRET);
    if (jwtPayload?.sub) {
      const envAdminUser = getEnvAdminUserFromPayload(jwtPayload);
      if (envAdminUser) {
        req.user = envAdminUser;
        next();
        return;
      }
      const user = await getUserById(jwtPayload.sub);
      if (user) {
        if (!user.verified) {
          res.status(403).json({ error: "Email not verified" });
          return;
        }
        req.user = user;
        next();
        return;
      }
    }
    if (process.env.ADMIN_JWT_SECRET) {
      const adminPayload = verifyToken(token, process.env.ADMIN_JWT_SECRET);
      const envAdminUser = getEnvAdminUserFromPayload(adminPayload);
      if (envAdminUser) {
        req.user = envAdminUser;
        next();
        return;
      }
    }
    res.status(401).json({ error: "Unauthorized" });
  } catch (err) {
    res.status(401).json({ error: "Unauthorized" });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
