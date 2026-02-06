import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendOtpEmail(email, code) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP credentials missing");
  }
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; color: #0b1f6b; border: 1px solid #e6e6e6; border-radius: 8px; padding: 16px;">
      <h2 style="margin: 0 0 8px; font-weight: 700; font-size: 20px;">Your ZenDoc verification code</h2>
      <p style="margin: 0 0 12px; color: #555;">Enter the code below to verify your email address.</p>
      <div style="font-size: 32px; letter-spacing: 6px; font-weight: 700; background: #f5f7fb; padding: 16px; text-align: center; border-radius: 10px; border: 1px solid #d8deec;">${code}</div>
      <p style="margin: 14px 0 0; color: #777;">This code expires in 10 minutes.</p>
    </div>
  `;
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: "Your ZenDoc verification code",
    html,
  });
}
