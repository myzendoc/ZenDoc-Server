import mongoose from "mongoose";

let connectionPromise;

export function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set");
  }
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
  }
  return connectionPromise;
}
