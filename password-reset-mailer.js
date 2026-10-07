import nodemailer from 'nodemailer'

let transporter

function emailConfig() {
  const host = process.env.SMTP_HOST
  const from = process.env.SMTP_FROM
  const base = process.env.PUBLIC_BASE_URL
  if (!host || !from || !base) return null
  let publicUrl
  try { publicUrl = new URL(base) } catch { return null }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) return null
  const port = Number(process.env.SMTP_PORT || 587)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, from, base: publicUrl.toString().replace(/\/+$/, ''), port }
}

export async function sendPasswordResetEmail({ email, fullName, token }) {
  const config = emailConfig()
  if (!config) return false
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: process.env.SMTP_SECURE === 'true' || config.port === 465,
      requireTLS: process.env.SMTP_SECURE !== 'true' && config.port !== 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    })
  }
  const link = `${config.base}/reset-password#token=${encodeURIComponent(token)}`
  await transporter.sendMail({
    from: config.from,
    to: email,
    subject: 'Reset your WhatsApp dashboard password',
    text: `Hello ${fullName},\n\nUse this one-time link to reset your password. It expires in one hour:\n${link}\n\nIf you did not request this, you can ignore this email.`,
    disableFileAccess: true,
    disableUrlAccess: true
  })
  return true
}
