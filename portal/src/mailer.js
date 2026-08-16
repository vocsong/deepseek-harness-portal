import nodemailer from 'nodemailer'
import { config } from './config.js'

let transporter = null
if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  })
}

/**
 * Deliver an OTP. In dev mode (no SMTP configured) the code is logged and
 * returned so the flow can be exercised without a mail server.
 */
export async function sendOtpCode(email, code) {
  if (config.otpDevMode || !transporter) {
    console.log(`[otp] DEV MODE — verification code for ${email}: ${code}`)
    return { devCode: code }
  }
  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: `Your DeepSeek Harness Portal code: ${code}`,
    text: `Your verification code is ${code}. It expires in ${Math.round(config.otpTtlMs / 60000)} minutes.\n\nIf you did not request this, you can ignore this email.`,
  })
  return {}
}
