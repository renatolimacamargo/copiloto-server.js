require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const PORT = Number(process.env.PORT || 3062);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const EVOLUTION_BASE_URL = String(process.env.EVOLUTION_BASE_URL || '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!EVOLUTION_BASE_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
  console.error('❌ Variáveis da Evolution não configuradas no .env');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Variáveis do Supabase não configuradas no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({
  origin: ALLOWED_ORIGIN,
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));

let syncState = {
  running: false,
  paused: false,
  currentRunId: null
};

function nowIso() {
  return new Date().toISOString();
}

function looksLikeJid(value) {
  return typeof value === 'string' && value.includes('@');
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeExternalChatIdFromJid(jid) {
  const raw = safeString(jid);
  if (!raw) return null;
  return raw.replace(/@.+$/, '');
}

function dedupeMessagesByExternalId(messages) {
  const map = new Map();

  for (const msg of messages) {
    const key = msg?.external_message_id;
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, msg);
      continue;
    }

    const current = map.get(key);
    const currentTs = Number(current?.timestamp_unix || 0);
    const incomingTs = Number(msg?.timestamp_unix || 0);

    if (incomingTs >= currentTs) {
      map.set(key, msg);
    }
  }

  return Array.from(map.values());
}

async function evolutionHttpRequest(method, path, body = undefined) {
  const response = await fetch(`${EVOLUTION_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Evolution HTTP ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }

  return { response, data };
}

async function evolutionRequest(path, body = undefined) {
  return evolutionHttpRequest('POST', path, body);
}

function extractArrayFromEvolutionResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.response)) return payload.response;
  if (Array.isArray(payload.responses)) return payload.responses;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.chats)) return payload.chats;
  if (Array.isArray(payload.messages)) return payload.messages;

  if (payload.messages?.records && Array.isArray(payload.messages.records)) return payload.messages.records;
  if (payload.data?.records && Array.isArray(payload.data.records)) return payload.data.records;
  if (payload.data?.messages?.records && Array.isArray(payload.data.messages.records)) return payload.data.messages.records;

  return [];
}

function pickRemoteJid(chat) {
  const candidates = [
    chat?.remoteJid,
    chat?.jid,
    chat?.key?.remoteJid,
    chat?.lastMessage?.key?.remoteJid,
    chat?.lastMessage?.message?.key?.remoteJid,
    chat?.remoteJidAlt,
    chat?.key?.remoteJidAlt,
    chat?.lastMessage?.key?.remoteJidAlt,
    looksLikeJid(chat?.id) ? chat.id : null,
    looksLikeJid(chat?.conversationId) ? chat.conversationId : null
  ];

  for (const candidate of candidates) {
    if (looksLikeJid(candidate)) return candidate;
  }

  return null;
}

function pickDisplayName(chat, externalChatId) {
  const candidates = [
    chat?.name,
    chat?.subject,
    chat?.pushName,
    chat?.contactName,
    chat?.contact?.name,
    chat?.notifyName,
    externalChatId
  ];

  for (const candidate of candidates) {
    const value = safeString(candidate);
    if (value) return value;
  }

  return 'Sem nome';
}

function normalizeChat(chat) {
  const remoteJid = pickRemoteJid(chat);
  const externalChatId = normalizeExternalChatIdFromJid(remoteJid);

  const lastMessagePreview =
    chat?.lastMessage?.conversation ||
    chat?.lastMessage?.message?.conversation ||
    chat?.lastMessage?.messageText ||
    chat?.lastMessageText ||
    chat?.lastMessage?.extendedTextMessage?.text ||
    null;

  const rawTs =
    chat?.lastMessage?.messageTimestamp ||
    chat?.conversationTimestamp ||
    chat?.updatedAt ||
    null;

  let lastMessageAt = null;
  if (typeof rawTs === 'number' || /^\d+$/.test(String(rawTs || ''))) {
    const unix = Number(rawTs);
    if (unix > 0) {
      lastMessageAt = new Date(unix * 1000).toISOString();
    }
  } else if (rawTs) {
    lastMessageAt = rawTs;
  }

  return {
    external_chat_id: externalChatId,
    remote_jid: remoteJid,
    display_name: pickDisplayName(chat, externalChatId),
    is_group: safeString(remoteJid).endsWith('@g.us'),
    profile_pic_url: chat?.profilePictureUrl || null,
    last_message_preview: lastMessagePreview,
    unread_count: Number(chat?.unreadCount || 0),
    last_message_at: lastMessageAt
  };
}

function normalizeMessage(msg, conversationId, contactId, externalChatId, remoteJid) {
  const raw = msg || {};
  const message = raw.message || {};

  const messageType =
    raw.messageType ||
    Object.keys(message || {}).find((k) => k !== 'messageContextInfo') ||
    'unknown';

  const messageText =
    raw.messageText ||
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.templateMessage?.hydratedTemplate?.hydratedContentText ||
    null;

  const caption =
    raw.caption ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    null;

  const timestampUnix = Number(raw.messageTimestamp || raw.timestamp || 0) || null;

  const mediaUrl =
    raw.mediaUrl ||
    raw.url ||
    message.imageMessage?.url ||
    message.videoMessage?.url ||
    message.documentMessage?.url ||
    null;

  const mimetype =
    raw.mimetype ||
    message.imageMessage?.mimetype ||
    message.videoMessage?.mimetype ||
    message.documentMessage?.mimetype ||
    null;

  const fileName =
    raw.fileName ||
    message.documentMessage?.fileName ||
    null;

  const resolvedRemoteJid =
    raw?.key?.remoteJid ||
    raw?.key?.remoteJidAlt ||
    remoteJid ||
    null;

  return {
    external_message_id: raw.key?.id || raw.id || null,
    external_chat_id: externalChatId,
    conversation_id: conversationId,
    contact_id: contactId,
    remote_jid: resolvedRemoteJid,
    from_me: !!raw.key?.fromMe || !!raw.fromMe,
    push_name: raw.pushName || null,
    message_type: messageType,
    message_text: messageText,
    caption,
    media_url: mediaUrl,
    mimetype,
    file_name: fileName,
    timestamp_unix: timestampUnix,
    message_timestamp: timestampUnix ? new Date(timestampUnix * 1000).toISOString() : null,
    raw
  };
}

async function createSyncRun() {
  const { data, error } = await supabase
    .from('sync_runs')
    .insert({
      status: 'running',
      mode: 'full',
      started_at: nowIso(),
      updated_at: nowIso()
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function updateSyncRun(id, patch) {
  const { error } = await supabase
    .from('sync_runs')
    .update({
      ...patch,
      updated_at: nowIso()
    })
    .eq('id', id);

  if (error) throw error;
}

async function insertSyncError(syncRunId, err, payload = {}) {
  const { error } = await supabase
    .from('sync_errors')
    .insert({
      sync_run_id: syncRunId,
      error_text: err?.message || String(err),
      payload
    });

  if (error) {
    console.error('Erro ao gravar sync_errors:', error);
  }
}

async function upsertContact(chat) {
  const { data, error } = await supabase
    .from('crm_contacts')
    .upsert({
      external_chat_id: chat.external_chat_id,
      remote_jid: chat.remote_jid,
      display_name: chat.display_name,
      phone: chat.external_chat_id,
      profile_pic_url: chat.profile_pic_url,
      is_group: chat.is_group,
      updated_at: nowIso()
    }, {
      onConflict: 'external_chat_id'
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function upsertConversation(chat, contactId) {
  const { data, error } = await supabase
    .from('crm_conversations')
    .upsert({
      external_chat_id: chat.external_chat_id,
      remote_jid: chat.remote_jid,
      contact_id: contactId,
      display_name: chat.display_name,
      is_group: chat.is_group,
      last_message_at: chat.last_message_at,
      last_message_preview: chat.last_message_preview,
      unread_count: chat.unread_count,
      updated_at: nowIso()
    }, {
      onConflict: 'external_chat_id'
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function upsertMessages(messages) {
  if (!messages.length) return;

  const deduped = dedupeMessagesByExternalId(messages);

  const { error } = await supabase
    .from('crm_messages')
    .upsert(deduped, {
      onConflict: 'external_message_id'
    });

  if (error) throw error;
}

async function fetchEvolutionChats() {
  const { data } = await evolutionRequest(`/chat/findChats/${EVOLUTION_INSTANCE}`, {});
  return extractArrayFromEvolutionResponse(data);
}

async function fetchEvolutionMessages(chat) {
  const remoteJid = chat?.remote_jid;
  const externalChatId = chat?.external_chat_id;

  if (!remoteJid) {
    console.log('[sync] chat sem remote_jid válido', JSON.stringify(chat));
    return [];
  }

  const primary = await evolutionRequest(
    `/chat/findMessages/${EVOLUTION_INSTANCE}`,
    {
      where: {
        key: {
          remoteJid
        }
      }
    }
  );

  const primaryArray = extractArrayFromEvolutionResponse(primary.data);

  if (primaryArray.length > 0) {
    console.log('[sync] mensagens encontradas para', externalChatId || remoteJid, '=>', primaryArray.length);
    return primaryArray;
  }

  console.log('[sync] sem mensagens para', externalChatId || remoteJid);
  return [];
}

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'copiloto-sync',
    port: PORT
  });
});

app.get('/api/sync/status', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sync_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    res.status(200).json({
      ok: true,
      running: syncState.running,
      paused: syncState.paused,
      currentRunId: syncState.currentRunId,
      lastRun: data || null
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'failed_to_get_sync_status',
      message: err?.message || 'Erro interno'
    });
  }
});

async function runSync() {
  const run = await createSyncRun();
  syncState.running = true;
  syncState.paused = false;
  syncState.currentRunId = run.id;

  try {
    const rawChats = await fetchEvolutionChats();
    const chats = rawChats
      .map(normalizeChat)
      .filter((c) => c.external_chat_id && c.remote_jid);

    await updateSyncRun(run.id, {
      total_chats: chats.length,
      processed_chats: 0,
      total_messages: 0,
      processed_messages: 0,
      percent_complete: 0,
      last_error: null
    });

    let processedChats = 0;
    let processedMessages = 0;
    let totalMessages = 0;

    for (const chat of chats) {
      if (!syncState.running) break;

      while (syncState.paused) {
        await new Promise((r) => setTimeout(r, 1000));
      }

      await updateSyncRun(run.id, {
        current_chat_id: chat.external_chat_id,
        current_chat_name: chat.display_name,
        status: syncState.paused ? 'paused' : 'running'
      });

      try {
        const contact = await upsertContact(chat);
        const conversation = await upsertConversation(chat, contact.id);

        const rawMessages = await fetchEvolutionMessages(chat);
        totalMessages += rawMessages.length;

        const normalizedMessages = rawMessages
          .map((msg) =>
            normalizeMessage(
              msg,
              conversation.id,
              contact.id,
              chat.external_chat_id,
              chat.remote_jid
            )
          )
          .filter((m) => m.external_message_id);

        const dedupedMessages = dedupeMessagesByExternalId(normalizedMessages);

        await upsertMessages(dedupedMessages);

        processedMessages += dedupedMessages.length;
        processedChats += 1;

        const percent = chats.length > 0
          ? Number(((processedChats / chats.length) * 100).toFixed(2))
          : 100;

        await updateSyncRun(run.id, {
          total_messages: totalMessages,
          processed_messages: processedMessages,
          processed_chats: processedChats,
          percent_complete: percent
        });
      } catch (err) {
        await insertSyncError(run.id, err, { chat });
        await updateSyncRun(run.id, {
          last_error: err?.message || String(err)
        });
      }
    }

    await updateSyncRun(run.id, {
      status: syncState.running ? 'completed' : 'stopped',
      finished_at: nowIso(),
      current_chat_id: null,
      current_chat_name: null,
      percent_complete: syncState.running ? 100 : 0
    });
  } catch (err) {
    await insertSyncError(run.id, err);
    await updateSyncRun(run.id, {
      status: 'failed',
      finished_at: nowIso(),
      last_error: err?.message || String(err),
      current_chat_id: null,
      current_chat_name: null
    });
  } finally {
    syncState.running = false;
    syncState.paused = false;
    syncState.currentRunId = null;
  }
}

app.post('/api/sync/start', async (req, res) => {
  if (syncState.running) {
    return res.status(409).json({
      ok: false,
      error: 'sync_already_running'
    });
  }

  runSync().catch((err) => {
    console.error('Erro geral runSync:', err);
  });

  return res.status(200).json({
    ok: true,
    message: 'sync_started'
  });
});

app.post('/api/sync/pause', async (req, res) => {
  if (!syncState.running) {
    return res.status(400).json({
      ok: false,
      error: 'sync_not_running'
    });
  }

  syncState.paused = true;

  if (syncState.currentRunId) {
    await updateSyncRun(syncState.currentRunId, { status: 'paused' });
  }

  return res.status(200).json({
    ok: true,
    message: 'sync_paused'
  });
});

app.post('/api/sync/resume', async (req, res) => {
  if (!syncState.running) {
    return res.status(400).json({
      ok: false,
      error: 'sync_not_running'
    });
  }

  syncState.paused = false;

  if (syncState.currentRunId) {
    await updateSyncRun(syncState.currentRunId, { status: 'running' });
  }

  return res.status(200).json({
    ok: true,
    message: 'sync_resumed'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 copiloto-sync rodando na porta ${PORT}`);
  console.log(`🌐 CORS liberado para: ${ALLOWED_ORIGIN}`);
});
