// Serverless function (Vercel Node.js runtime). Keeps the Brevo API key server-side only.
const BREVO_API_KEY = process.env.BREVO_API_KEY
const BREVO_LIST_ID = process.env.BREVO_CHAPTER_CHECK_LIST_ID
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.some((item) => nonEmptyString(item))
}

// GET /contacts/{email} returns 200 (contact found) or 404 (not found).
// Any other status means we couldn't determine existence and should abort.
async function findExistingContact(email) {
  const res = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    method: 'GET',
    headers: { 'api-key': BREVO_API_KEY, Accept: 'application/json' },
  })
  if (res.status === 404) return false
  if (res.status === 200) return true
  const text = await res.text().catch(() => '')
  throw new Error(`Brevo contact lookup failed (${res.status}): ${text}`)
}

// Only ever include an attribute if the visitor actually submitted a value for it,
// so existing Brevo contact data is never overwritten with blanks.
function buildAttributes(body, contactExists) {
  const attrs = {}

  if (nonEmptyString(body.first_name)) attrs.FIRSTNAME = body.first_name.trim()
  if (nonEmptyString(body.last_name)) attrs.LASTNAME = body.last_name.trim()
  if (nonEmptyString(body.current_status)) attrs.CURRENT_STATUS = body.current_status.trim()
  if (nonEmptyString(body.industry)) attrs.INDUSTRY = body.industry.trim()
  if (nonEmptyString(body.goals)) attrs.GOALS = body.goals.trim()

  if (nonEmptyArray(body.challenge)) {
    attrs.CHALLENGE = body.challenge.filter(nonEmptyString).join(', ')
  }
  if (nonEmptyArray(body.expectations)) {
    attrs.EXPECTATIONS = body.expectations.filter(nonEmptyString).join(', ')
  }

  if (nonEmptyString(body.source)) attrs.SOURCE = body.source.trim()

  if (body.newsletter === true) {
    attrs.NEWSLETTER = true
  } else if (!contactExists) {
    // Only default new contacts to false — never overwrite an existing true value.
    attrs.NEWSLETTER = false
  }

  if (body.privacy_consent === true) attrs.PRIVACY_CONSENT = true

  return attrs
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ success: false, message: 'Method not allowed' })
  }

  const listId = Number(BREVO_LIST_ID)
  if (!BREVO_API_KEY || !Number.isInteger(listId)) {
    console.error('Chapter Check: missing/invalid BREVO_API_KEY or BREVO_CHAPTER_CHECK_LIST_ID')
    return res.status(500).json({ success: false, message: 'Server not configured' })
  }

  const body = req.body || {}
  const email = nonEmptyString(body.email) ? body.email.trim() : ''

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ success: false, message: 'Invalid email address' })
  }
  if (body.privacy_consent !== true) {
    return res.status(400).json({ success: false, message: 'Privacy consent is required' })
  }

  try {
    const contactExists = await findExistingContact(email)
    const attributes = buildAttributes(body, contactExists)

    const payload = { email, updateEnabled: true, listIds: [listId] }
    if (Object.keys(attributes).length > 0) payload.attributes = attributes

    const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!brevoRes.ok) {
      const text = await brevoRes.text().catch(() => '')
      console.error('Chapter Check: Brevo create/update failed', brevoRes.status, text)
      return res.status(502).json({ success: false, message: 'Could not save your submission. Please try again.' })
    }

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('Chapter Check: submission error', err)
    return res.status(500).json({ success: false, message: 'Could not save your submission. Please try again.' })
  }
}
