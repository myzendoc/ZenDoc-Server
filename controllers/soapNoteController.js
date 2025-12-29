import { createSoapNote, getSoapNote, getSoapNotesByRoom } from "../services/soapNoteService.js";

export async function createSoap(req, res) {
  try {
    const { roomId, content } = req.body || {};
    const note = await createSoapNote({ roomId, content });
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: "Failed to create soap note" });
  }
}

export async function fetchSoaps(req, res) {
  try {
    const notes = await getSoapNotesByRoom(req.params.roomId);
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch soap notes" });
  }
}

export async function fetchSoap(req, res) {
  try {
    const note = await getSoapNote(req.params.id);
    if (!note) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch soap note" });
  }
}
