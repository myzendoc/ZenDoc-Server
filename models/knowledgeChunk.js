import mongoose from "mongoose";
import { softDeletePlugin } from "./plugins/softDelete.js";

// Retrieval index for the Ask feature. `text` is field-encrypted PHI; `vector`
// is a packed float32 embedding protected by access control and disk
// encryption, since encrypting it would make similarity search impossible.
const knowledgeChunkSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", index: true },
    meetingSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "MeetingSession", index: true },
    roomId: { type: String, index: true },
    sessionIndex: { type: Number },
    sourceType: { type: String, enum: ["soap", "transcript", "private_note"], required: true, index: true },
    sourceId: { type: String, index: true },
    section: { type: String },
    chunkIndex: { type: Number, default: 0 },
    text: { type: String, required: true },
    language: { type: String },
    vector: { type: Buffer, required: true },
    dims: { type: Number, required: true },
    model: { type: String, required: true },
    occurredAt: { type: Date, index: true },
  },
  { timestamps: true }
);

knowledgeChunkSchema.index({ ownerId: 1, occurredAt: -1 });
knowledgeChunkSchema.index({ ownerId: 1, meetingId: 1 });
knowledgeChunkSchema.index({ sourceType: 1, sourceId: 1 });

knowledgeChunkSchema.plugin(softDeletePlugin);

export const KnowledgeChunk = mongoose.model("KnowledgeChunk", knowledgeChunkSchema);
