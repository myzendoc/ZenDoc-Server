import { PrivateNote } from "../models/privateNote.js";
import { decryptFieldOrNull, encryptField } from "../utils/fieldCipher.js";
import { logError } from "../utils/logging.js";

export const PRIVATE_NOTE_CONTEXT = "PrivateNote.content";

function decryptNote(doc) {
  if (!doc) return doc;
  const content = decryptFieldOrNull(doc.content, PRIVATE_NOTE_CONTEXT);
  if (content === null) {
    logError("phi.private_note_decrypt_failed", new Error(`PrivateNote ${doc._id} could not be decrypted`));
    return { ...doc, content: "", decryptionFailed: true };
  }
  return { ...doc, content };
}

export async function createPrivateNote(payload) {
  const note = await PrivateNote.create({
    ...payload,
    content: encryptField(payload?.content, PRIVATE_NOTE_CONTEXT),
  });
  return decryptNote(note.toObject());
}

export async function getPrivateNotesByMeeting(meetingId, options = {}) {
  if (!meetingId) return [];
  const query = { meetingId };
  if (options.createdBy) query.createdBy = options.createdBy;
  const notes = await PrivateNote.find(query).sort({ createdAt: -1 }).lean();
  return notes.map(decryptNote);
}

export async function getPrivateNotesBySession(meetingSessionId, options = {}) {
  if (!meetingSessionId) return [];
  const query = { meetingSessionId };
  if (options.createdBy) query.createdBy = options.createdBy;
  const notes = await PrivateNote.find(query).sort({ createdAt: -1 }).lean();
  return notes.map(decryptNote);
}
