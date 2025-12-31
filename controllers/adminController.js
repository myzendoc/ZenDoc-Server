import { listUsersWithMeetingCounts } from "../services/userService.js";

export async function listUsers(req, res) {
  try {
    const users = await listUsersWithMeetingCounts();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
}
