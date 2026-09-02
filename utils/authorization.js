function idString(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

export function canAccessMeeting(meeting, user) {
  const ownerId = idString(meeting?.createdBy);
  const userId = idString(user?._id || user?.userId);
  return Boolean(ownerId && userId && ownerId === userId);
}

export function serializePublicMeeting(meeting) {
  if (!meeting) return null;
  return {
    roomId: meeting.roomId,
    title: meeting.title || "Meeting",
    scheduledFor: meeting.scheduledFor || null,
  };
}
