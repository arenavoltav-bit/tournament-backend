// ============================================================
// TOURNAMENT BACKEND API — Node.js + Express + Supabase
// ============================================================
// Install: npm install express @supabase/supabase-js cors dotenv
// Run:     node server.js
// Deploy:  Railway / Render / VPS
// ============================================================

require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ── Supabase (service role for full access) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service_role key, NOT anon key
)

// ── Simple admin auth middleware ──
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// ── Bot auth middleware ──
function botAuth(req, res, next) {
  const token = req.headers['x-bot-secret']
  if (token !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// ============================================================
// TEAM LOGIN
// ============================================================
app.post('/api/team/login', async (req, res) => {
  const { email, captain_uid } = req.body
  if (!email || !captain_uid) return res.status(400).json({ error: 'Missing fields' })

  const { data: team, error } = await supabase
    .from('teams')
    .select('*, players(*)')
    .eq('contact_email', email.toLowerCase().trim())
    .eq('captain_uid', captain_uid.trim())
    .single()

  if (error || !team) return res.status(401).json({ error: 'Invalid credentials' })

  // Get group info for current stage
  const { data: groupMember } = await supabase
    .from('group_members')
    .select('*, groups(*, stages(*))')
    .eq('team_id', team.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  // Get stage results
  const { data: stageResults } = await supabase
    .from('match_results')
    .select('*, group_members!inner(groups!inner(stages(*)))')
    .eq('team_id', team.id)

  // Get schedules
  const { data: schedules } = await supabase
    .from('schedules')
    .select('*')
    .contains('group_numbers', groupMember?.groups?.group_number ? [groupMember.groups.group_number] : [])

  res.json({
    team: {
      ...team,
      group_number: groupMember?.groups?.group_number || team.group_number,
      stage_name: groupMember?.groups?.stages?.stage_name,
      schedules: schedules || [],
      stage_results: stageResults || []
    }
  })
})

// ============================================================
// ADMIN — SAVE TEAMS (from CSV import)
// ============================================================
app.post('/api/admin/teams', adminAuth, async (req, res) => {
  const { teams } = req.body // array of team objects from frontend

  let created = 0, skipped = 0, errors = []

  for (const t of teams) {
    if (t.status === 'disqualified') continue

    // Upsert team
    const { data: team, error: teamErr } = await supabase
      .from('teams')
      .upsert({
        team_name: t.name,
        team_tag: t.tag || null,
        captain_name: t.captain,
        captain_uid: t.uid,
        contact_email: t.email,
        group_number: t.group || 0,
        status: 'active'
      }, { onConflict: 'captain_uid' })
      .select()
      .single()

    if (teamErr) { errors.push(t.name + ': ' + teamErr.message); continue }

    // Upsert players
    if (t.players?.length) {
      await supabase.from('players').delete().eq('team_id', team.id)
      await supabase.from('players').insert(
        t.players.map(p => ({
          team_id: team.id,
          player_name: p.name || p.player_name,
          player_uid: p.uid || p.player_uid,
          role: p.role || 'member'
        }))
      )
    }
    created++
  }

  res.json({ created, skipped, errors })
})

// ============================================================
// ADMIN — STAGES
// ============================================================
app.post('/api/admin/stages', adminAuth, async (req, res) => {
  const { stage_number, stage_name, top_n, per_group, cg_format, notes } = req.body

  const { data, error } = await supabase
    .from('stages')
    .upsert({ stage_number, stage_name, top_n, per_group, cg_format, notes, status: 'active' },
      { onConflict: 'stage_number' })
    .select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ stage: data })
})

app.get('/api/admin/stages', adminAuth, async (req, res) => {
  const { data } = await supabase.from('stages').select('*, groups(*)').order('stage_number')
  res.json({ stages: data || [] })
})

app.patch('/api/admin/stages/:id/finalize', adminAuth, async (req, res) => {
  const { id } = req.params
  await supabase.from('stages').update({ status: 'done' }).eq('id', id)
  res.json({ success: true })
})

// ============================================================
// ADMIN — GROUPS
// ============================================================
app.post('/api/admin/groups', adminAuth, async (req, res) => {
  const { stage_id, groups } = req.body
  // groups: [{ group_number, team_names: [] }]

  for (const g of groups) {
    // Upsert group
    const { data: group, error: gErr } = await supabase
      .from('groups')
      .upsert({ stage_id, group_number: g.group_number },
        { onConflict: 'stage_id,group_number' })
      .select().single()

    if (gErr || !group) continue

    // Clear old members
    await supabase.from('group_members').delete().eq('group_id', group.id)

    // Add team members
    for (const tname of g.team_names) {
      const { data: team } = await supabase
        .from('teams').select('id').ilike('team_name', tname).single()
      if (team) {
        await supabase.from('group_members')
          .insert({ group_id: group.id, team_id: team.id })
          .on('conflict', 'do nothing')
      }
    }
  }

  res.json({ success: true })
})

// ============================================================
// ADMIN — ROOM ID/PASS (save + send to Discord)
// ============================================================
app.post('/api/admin/room', adminAuth, async (req, res) => {
  const { stage_id, group_number, room_id, room_pass, send_discord } = req.body

  // Update group
  const { data: group } = await supabase
    .from('groups')
    .upsert({ stage_id, group_number, room_id, room_pass },
      { onConflict: 'stage_id,group_number' })
    .select().single()

  // Also update teams in this group
  if (group) {
    const { data: members } = await supabase
      .from('group_members')
      .select('team_id')
      .eq('group_id', group.id)

    if (members?.length) {
      const teamIds = members.map(m => m.team_id)
      await supabase.from('teams')
        .update({ room_id, room_pass })
        .in('id', teamIds)
    }
  }

  // Send to Discord if requested
  if (send_discord) {
    const result = await sendRoomToDiscord(stage_id, group_number, room_id, room_pass)
    return res.json({ success: true, discord: result })
  }

  res.json({ success: true })
})

// ============================================================
// ADMIN — SCHEDULE
// ============================================================
app.post('/api/admin/schedule', adminAuth, async (req, res) => {
  const { stage_id, title, match_date, match_time, group_numbers } = req.body

  const { data, error } = await supabase
    .from('schedules')
    .insert({ stage_id, title, match_date, match_time, group_numbers })
    .select().single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ schedule: data })
})

// ============================================================
// ADMIN — MATCH RESULTS
// ============================================================
app.post('/api/admin/results', adminAuth, async (req, res) => {
  const { group_id, results } = req.body
  // results: [{ team_name, rank, kills, placement_pts, total_score, uid_status, qual_status, dq_reason }]

  for (const r of results) {
    const { data: team } = await supabase
      .from('teams').select('id').ilike('team_name', r.team_name).single()
    if (!team) continue

    await supabase.from('match_results').upsert({
      group_id,
      team_id: team.id,
      match_rank: r.rank,
      kills: r.kills,
      placement_pts: r.placement_pts,
      total_score: r.total_score,
      uid_status: r.uid_status,
      qual_status: r.qual_status,
      dq_reason: r.dq_reason || null
    }, { onConflict: 'group_id,team_id' })

    // Update team status
    if (r.qual_status === 'eliminated' || r.qual_status === 'disqualified') {
      await supabase.from('teams')
        .update({ status: r.qual_status })
        .eq('id', team.id)
    }
  }

  res.json({ success: true })
})

// ============================================================
// ADMIN — TOURNAMENT SETTINGS
// ============================================================
app.post('/api/admin/settings', adminAuth, async (req, res) => {
  const { settings } = req.body // { key: value, ... }

  for (const [key, value] of Object.entries(settings)) {
    await supabase.from('tournament_settings')
      .upsert({ setting_key: key, setting_value: value, updated_at: new Date() },
        { onConflict: 'setting_key' })
  }

  res.json({ success: true })
})

app.get('/api/settings', async (req, res) => {
  const { data } = await supabase.from('tournament_settings').select('*')
  const settings = {}
  data?.forEach(s => { settings[s.setting_key] = s.setting_value })
  res.json({ settings })
})

// ============================================================
// DISCORD INTEGRATION
// ============================================================

// Get Discord channel name from format
function getChannelName(format, stageNumber, groupNumber) {
  return format
    .replace('{stage}', stageNumber)
    .replace('{n}', groupNumber)
    .toLowerCase()
}

// Send Room ID/Pass to Discord channel
async function sendRoomToDiscord(stage_id, group_number, room_id, room_pass) {
  try {
    const { data: stage } = await supabase.from('stages').select('*').eq('id', stage_id).single()
    const { data: settings } = await supabase.from('tournament_settings')
      .select('*').in('setting_key', ['discord_bot_token', 'discord_guild_id'])

    const settingsMap = {}
    settings?.forEach(s => { settingsMap[s.setting_key] = s.setting_value })

    const botToken = settingsMap['discord_bot_token']
    const guildId  = settingsMap['discord_guild_id']

    if (!botToken || !guildId) return { error: 'Bot token or guild ID not set' }

    const channelName = getChannelName(stage.cg_format, stage.stage_number, group_number)

    // Find channel by name
    const channelsRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { 'Authorization': `Bot ${botToken}` }
    })
    const channels = await channelsRes.json()
    const channel  = channels.find(c => c.name === channelName)

    if (!channel) {
      await supabase.from('discord_logs').insert({
        action: 'room_sent', stage_id, group_number,
        channel_name: channelName, status: 'failed',
        message_content: `Channel not found: ${channelName}`
      })
      return { error: `Channel #${channelName} not found in server` }
    }

    // Send message
    const message = `🔑 **Room Details — Group ${group_number}**\n\`\`\`\nRoom ID  : ${room_id}\nPassword : ${room_pass}\n\`\`\`\n⚠️ Do not share outside this channel.`

    const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    })

    if (!msgRes.ok) throw new Error('Discord API error: ' + msgRes.status)

    await supabase.from('discord_logs').insert({
      action: 'room_sent', stage_id, group_number,
      channel_name: channelName, status: 'sent', message_content: message
    })

    return { success: true, channel: channelName }
  } catch (err) {
    return { error: err.message }
  }
}

// ── SEND GROUP LIST TO DISCORD ──
app.post('/api/admin/discord/group-list', adminAuth, async (req, res) => {
  const { stage_id } = req.body

  const { data: stage } = await supabase.from('stages').select('*').eq('id', stage_id).single()
  const { data: groups } = await supabase
    .from('groups')
    .select('*, group_members(*, teams(team_name, team_tag, captain_name))')
    .eq('stage_id', stage_id)
    .order('group_number')

  const { data: settings } = await supabase.from('tournament_settings')
    .select('*').in('setting_key', ['discord_bot_token', 'discord_guild_id'])
  const settingsMap = {}
  settings?.forEach(s => { settingsMap[s.setting_key] = s.setting_value })

  const botToken = settingsMap['discord_bot_token']
  const guildId  = settingsMap['discord_guild_id']

  if (!botToken || !guildId) return res.status(400).json({ error: 'Bot token or guild ID not set in settings' })

  // Get all channels once
  const channelsRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { 'Authorization': `Bot ${botToken}` }
  })
  const allChannels = await channelsRes.json()

  const results = []

  for (const group of groups || []) {
    const channelName = getChannelName(stage.cg_format, stage.stage_number, group.group_number)
    const channel = allChannels.find(c => c.name === channelName)

    if (!channel) {
      results.push({ group: group.group_number, channel: channelName, status: 'channel_not_found' })
      continue
    }

    const teams = group.group_members?.map((m, i) => `${i+1}. **${m.teams.team_name}**${m.teams.team_tag ? ' ['+m.teams.team_tag+']' : ''}`).join('\n') || 'No teams'

    const message = `📋 **Group ${group.group_number} — Team List**\n\n${teams}\n\n_${stage.stage_name}_`

    const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    })

    const ok = msgRes.ok
    results.push({ group: group.group_number, channel: channelName, status: ok ? 'sent' : 'failed' })

    await supabase.from('discord_logs').insert({
      action: 'group_list_sent', stage_id, group_number: group.group_number,
      channel_name: channelName, status: ok ? 'sent' : 'failed', message_content: message
    })
  }

  res.json({ results })
})

// ── SEND ROOM TO DISCORD (manual trigger from admin) ──
app.post('/api/admin/discord/send-room', adminAuth, async (req, res) => {
  const { stage_id, group_number, room_id, room_pass } = req.body
  const result = await sendRoomToDiscord(stage_id, group_number, room_id, room_pass)
  res.json(result)
})

// ============================================================
// BOT API — for Discord bot to fetch data
// ============================================================
app.get('/api/bot/team', botAuth, async (req, res) => {
  const { uid } = req.query
  if (!uid) return res.status(400).json({ error: 'uid required' })

  const { data: team } = await supabase
    .from('teams').select('*, players(*)').eq('captain_uid', uid).single()
  if (!team) return res.status(404).json({ error: 'Team not found' })

  const { data: results } = await supabase
    .from('match_results').select('*, groups(group_number, stages(stage_name))')
    .eq('team_id', team.id)

  res.json({ team, results: results || [] })
})

app.get('/api/bot/groups', botAuth, async (req, res) => {
  const { stage_number } = req.query

  let query = supabase.from('stages').select('*, groups(*, group_members(*, teams(team_name, team_tag)))')
  if (stage_number) query = query.eq('stage_number', stage_number)
  else query = query.eq('status', 'active')

  const { data } = await query.single()
  res.json({ stage: data })
})

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`))
