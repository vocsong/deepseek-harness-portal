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

/** Deliver an OTP. Explicit localhost development mode may log the code,
 * but authentication codes are never returned through the network API. */
export async function sendOtpCode(email, code) {
  if (config.otpDevMode) {
    console.log(`[otp] DEV MODE — verification code for ${email}: ${code}`)
    return {}
  }
  if (!transporter) throw new Error('SMTP transport is not configured')
  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: `Your DeepSeek Harness Portal code: ${code}`,
    text: `Your verification code is ${code}. It expires in ${Math.round(config.otpTtlMs / 60000)} minutes.\n\nIf you did not request this, you can ignore this email.`,
  })
  return {}
}
