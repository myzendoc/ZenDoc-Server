import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

let connectionPromise;

export function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set");
  }
  console.log(process.env.MONGODB_URI,'mongouri');
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
  }
  return connectionPromise;
}
