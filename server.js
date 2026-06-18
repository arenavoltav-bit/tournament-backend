require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-admin-token','Authorization']
}))
app.use(express.json({ limit: '10mb' }))

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ffbpls3@admin'

const adminAuth = (req, res, next) => {
  const secret = req.body?.secret || req.headers['x-admin-secret']
  if (secret === ADMIN_SECRET) {
    next()
  } else {
    res.status(401).json({ error: 'Unauthorized' })
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.post('/api/admin/state', adminAuth, async (req, res) => {
  const { state } = req.body
  try {
    if (state === null) {
      await supabase.from('tournament_settings')
        .delete()
        .eq('setting_key', 'app_state')
      return res.json({ success: true, cleared: true })
    }
    await supabase.from('tournament_settings')
      .upsert({ 
        setting_key: 'app_state', 
        setting_value: JSON.stringify(state),
        updated_at: new Date()
      }, { onConflict: 'setting_key' })
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/admin/state', async (req, res) => {
  try {
    const { data } = await supabase.from('tournament_settings')
      .select('setting_value')
      .eq('setting_key', 'app_state')
      .single()
    res.json({ state: data?.setting_value || null })
  } catch(e) {
    res.json({ state: null })
  }
})

app.get('/api/admin/state/ts', async (req, res) => {
  try {
    const { data } = await supabase.from('tournament_settings')
      .select('updated_at')
      .eq('setting_key', 'app_state')
      .single()
    res.json({ updated_at: data?.updated_at || null })
  } catch(e) {
    res.json({ updated_at: null })
  }
})

app.post('/send-room', async (req, res) => {
  res.json({ ok: true })
})

app.listen(process.env.PORT || 3001, () => {
  console.log('Server running on port', process.env.PORT || 3001)
})
