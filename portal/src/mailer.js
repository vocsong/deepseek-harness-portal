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
export async function sendOtpCode(email, code, kind = 'verification') {
  if (config.otpDevMode) {
    console.log(`[otp] DEV MODE — ${kind} code for ${email}: ${code}`)
    return {}
  }
  if (!transporter) throw new Error('SMTP transport is not configured')
  const context = {
    'email-change-current': {
      subject: `Approve your DeepSeek Portal email change: ${code}`,
      intro: 'A request was made to change the email address on your account.',
    },
    'email-change-new': {
      subject: `Verify your new DeepSeek Portal email: ${code}`,
      intro: 'Use this code to verify this address for your DeepSeek Portal account.',
    },
  }[kind] ?? {
    subject: `Your DeepSeek Harness Portal code: ${code}`,
    intro: 'Use this verification code to continue.',
  }
  await transporter.sendMail({
    from: config.smtp.from,
    to: email,
    subject: context.subject,
    text: `${context.intro}\n\nYour verification code is ${code}. It expires in ${Math.round(config.otpTtlMs / 60000)} minutes.\n\nIf you did not request this, you can ignore this email.`,
  })
  return {}
}
