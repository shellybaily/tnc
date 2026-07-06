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

// Brevo "Category" attributes store an enumeration of {label, value} pairs and expect the
// numeric `value` on the contact payload, not the label text — so CURRENT_STATUS's option
// labels have to be resolved against Brevo's own enumeration before every submission.
// Cached briefly per warm serverless instance since the enumeration rarely changes.
let categoryEnumCache = null
let categoryEnumCacheAt = 0
const CATEGORY_ENUM_TTL_MS = 5 * 60 * 1000

async function getCategoryLabelMap(attributeName) {
  const now = Date.now()
  if (!categoryEnumCache || now - categoryEnumCacheAt >= CATEGORY_ENUM_TTL_MS) {
    const res = await fetch('https://api.brevo.com/v3/contacts/attributes', {
      method: 'GET',
      headers: { 'api-key': BREVO_API_KEY, Accept: 'application/json' },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Brevo attributes lookup failed (${res.status}): ${text}`)
    }
    const data = await res.json()
    const map = {}
    for (const attr of data.attributes || []) {
      if (attr.category === 'category' && Array.isArray(attr.enumeration)) {
        const labelToValue = {}
        for (const opt of attr.enumeration) labelToValue[opt.label] = opt.value
        map[attr.name] = labelToValue
      }
    }
    categoryEnumCache = map
    categoryEnumCacheAt = now
  }
  return categoryEnumCache[attributeName] || null
}

async function resolveCategoryValue(attributeName, label) {
  try {
    const labelMap = await getCategoryLabelMap(attributeName)
    if (labelMap && Object.prototype.hasOwnProperty.call(labelMap, label)) {
      return labelMap[label]
    }
    console.error(`Chapter Check: Brevo category "${attributeName}" has no option matching "${label}"`)
  } catch (err) {
    console.error(`Chapter Check: failed to resolve Brevo category "${attributeName}"`, err)
  }
  return undefined
}

// Only ever include an attribute if the visitor actually submitted a value for it,
// so existing Brevo contact data is never overwritten with blanks.
async function buildAttributes(body, contactExists) {
  const attrs = {}

  if (nonEmptyString(body.first_name)) attrs.FIRSTNAME = body.first_name.trim()
  if (nonEmptyString(body.last_name)) attrs.LASTNAME = body.last_name.trim()
  if (nonEmptyString(body.goals)) attrs.GOALS = body.goals.trim()

  // CURRENT_STATUS is a Brevo "Category" attribute: send the enumeration's numeric value.
  if (nonEmptyString(body.current_status)) {
    const value = await resolveCategoryValue('CURRENT_STATUS', body.current_status.trim())
    if (value !== undefined) attrs.CURRENT_STATUS = value
  }

  // INDUSTRY, CHALLENGE and EXPECTATIONS are Brevo "Multiple choice" attributes: send an
  // array of the selected option strings, never a comma-joined string.
  if (nonEmptyString(body.industry)) attrs.INDUSTRY = [body.industry.trim()]

  if (nonEmptyArray(body.challenge)) {
    attrs.CHALLENGE = body.challenge.filter(nonEmptyString)
  }
  if (nonEmptyArray(body.expectations)) {
    attrs.EXPECTATIONS = body.expectations.filter(nonEmptyString)
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
    const attributes = await buildAttributes(body, contactExists)

    const payload = { email, updateEnabled: true, listIds: [listId] }
    if (Object.keys(attributes).length > 0) payload.attributes = attributes

    console.log('Chapter Check: received body', JSON.stringify(body))
    console.log('Chapter Check: attributes sent to Brevo', JSON.stringify(attributes))

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
