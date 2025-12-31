import { verifyToken } from "../utils/jwt.js";
import { getUserById } from "../services/userService.js";

function extractToken(req) {
  const header = req.headers?.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

export async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    const payload = verifyToken(token, process.env.JWT_SECRET);
    if (!payload?.sub) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await getUserById(payload.sub);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.user = user;
    next();
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
