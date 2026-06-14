import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.zoho.eu",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function assertSmtpConfigured() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP credentials missing");
  }
}

function getClientBaseUrl() {
  return String(process.env.CLIENT_APP_URL || "").trim().replace(/\/$/, "") || "http://localhost:5173";
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendTemplateEmail({ to, subject, html }) {
  assertSmtpConfigured();
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject,
    html,
  });
}

export async function sendOtpEmail(email, code) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; color: #0b1f6b; border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px;">
      <h2 style="margin: 0 0 8px; font-weight: 700; font-size: 20px;">Your ZenDoc verification code</h2>
      <p style="margin: 0 0 12px; color: #555;">Enter the code below to verify your email address.</p>
      <div style="font-size: 32px; letter-spacing: 6px; font-weight: 700; background: #f5f7fb; padding: 16px; text-align: center; border-radius: 10px; border: 1px solid #d8deec;">${code}</div>
      <p style="margin: 14px 0 0; color: #777;">This code expires in 10 minutes.</p>
    </div>
  `;
  await sendTemplateEmail({
    to: email,
    subject: "Your ZenDoc verification code",
    html,
  });
}

export async function sendPasswordResetEmail(email, resetLink) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; color: #0b1f6b; border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px;">
      <h2 style="margin: 0 0 8px; font-weight: 700; font-size: 20px;">Reset your ZenDoc password</h2>
      <p style="margin: 0 0 12px; color: #555;">Use the button below to set a new password.</p>
      <a href="${resetLink}" style="display: inline-block; background: #0b1f6b; color: #fff; text-decoration: none; font-weight: 700; padding: 12px 18px; border-radius: 8px;">Reset Password</a>
      <p style="margin: 14px 0 0; color: #777;">This link expires in 30 minutes.</p>
      <p style="margin: 8px 0 0; color: #777; word-break: break-all;">${resetLink}</p>
    </div>
  `;
  await sendTemplateEmail({
    to: email,
    subject: "Reset your ZenDoc password",
    html,
  });
}

export async function sendWaitingRoomAlertEmail({ email, requesterName = "A user", roomId }) {
  if (!email) return;
  const roomLink = `${getClientBaseUrl()}/room/${roomId}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 460px; margin: 0 auto; color: #0b1f6b; border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px;">
      <h2 style="margin: 0 0 8px; font-weight: 700; font-size: 20px;">Patient waiting in your room</h2>
      <p style="margin: 0 0 12px; color: #555;">${requesterName} has requested to join your waiting room.</p>
      <a href="${roomLink}" style="display: inline-block; background: #0b1f6b; color: #fff; text-decoration: none; font-weight: 700; padding: 12px 18px; border-radius: 8px;">Open Room</a>
      <p style="margin: 14px 0 0; color: #777;">Room ID: ${roomId}</p>
    </div>
  `;
  await sendTemplateEmail({
    to: email,
    subject: "Someone is waiting in your ZenDoc room",
    html,
  });
}

export async function sendPatientMeetingInviteEmail({
  email,
  patientName,
  providerName,
  meetingTitle,
  scheduledFor,
  roomId,
  joinLink,
}) {
  if (!email) return;
  const safePatientName = escapeHtml(patientName || "there");
  const safeProviderName = escapeHtml(providerName || "Your healthcare provider");
  const safeMeetingTitle = escapeHtml(meetingTitle || "ZenDoc consultation");
  const safeRoomId = escapeHtml(roomId);
  const safeJoinLink = escapeHtml(joinLink);
  const scheduledDate = scheduledFor ? new Date(scheduledFor) : null;
  const scheduleText =
    scheduledDate && !Number.isNaN(scheduledDate.getTime())
      ? `<p style="margin: 0 0 12px; color: #555;"><strong>Scheduled:</strong> ${escapeHtml(scheduledDate.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }))} UTC</p>`
      : "";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 460px; margin: 0 auto; color: #0b1f6b; border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px;">
      <h2 style="margin: 0 0 8px; font-weight: 700; font-size: 20px;">You are invited to a ZenDoc meeting</h2>
      <p style="margin: 0 0 12px; color: #555;">Hi ${safePatientName}, ${safeProviderName} invited you to join ${safeMeetingTitle}.</p>
      ${scheduleText}
      <a href="${safeJoinLink}" style="display: inline-block; background: #0b1f6b; color: #fff; text-decoration: none; font-weight: 700; padding: 12px 18px; border-radius: 8px;">Join Meeting</a>
      <p style="margin: 14px 0 0; color: #777;">Room ID: ${safeRoomId}</p>
      <p style="margin: 8px 0 0; color: #777; word-break: break-all;">${safeJoinLink}</p>
    </div>
  `;
  await sendTemplateEmail({
    to: email,
    subject: `Invitation: ${meetingTitle || "ZenDoc consultation"}`,
    html,
  });
}

export async function sendSessionEndedEmail({ email, roomId }) {
  if (!email) return;
  const notesLink = `${getClientBaseUrl()}/meeting-notes`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 460px; margin: 0 auto; color: #0b1f6b; border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px;">
      <h2 style="margin: 0 0 8px; font-weight: 700; font-size: 20px;">Session ended</h2>
      <p style="margin: 0 0 12px; color: #555;">Your consultation session has ended successfully.</p>
      <p style="margin: 0 0 12px; color: #555;">Room ID: ${roomId}</p>
      <a href="${notesLink}" style="display: inline-block; background: #0b1f6b; color: #fff; text-decoration: none; font-weight: 700; padding: 12px 18px; border-radius: 8px;">Open Dashboard</a>
    </div>
  `;
  await sendTemplateEmail({
    to: email,
    subject: "ZenDoc session ended",
    html,
  });
}

export async function sendSoapReadyEmail({ email, roomId }) {
  if (!email) return;
  const notesLink = `${getClientBaseUrl()}/meeting-notes`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 460px; margin: 0 auto; color: #0b1f6b; border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px;">
      <h2 style="margin: 0 0 8px; font-weight: 700; font-size: 20px;">SOAP note is ready</h2>
      <p style="margin: 0 0 12px; color: #555;">Your automated SOAP note is now available for review.</p>
      <p style="margin: 0 0 12px; color: #555;">Room ID: ${roomId}</p>
      <a href="${notesLink}" style="display: inline-block; background: #0b1f6b; color: #fff; text-decoration: none; font-weight: 700; padding: 12px 18px; border-radius: 8px;">Review SOAP Note</a>
    </div>
  `;
  await sendTemplateEmail({
    to: email,
    subject: "Your ZenDoc SOAP note is ready",
    html,
  });
}
