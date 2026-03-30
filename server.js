const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors({
  origin: true,
  credentials: true,
  exposedHeaders: [
    'Accept-Ranges',
    'Content-Range',
    'Content-Length',
    'Content-Type',
    'Content-Disposition',
    'Cache-Control'
  ]
}));
app.use(express.json({ limit: '25mb' }));

// SUPABASE: nesta fase usar SOMENTE contatos
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const EVOLUTION_BASE_URL = String(process.env.EVOLUTION_BASE_URL || '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const BACKEND_PUBLIC_BASE_URL = String(
  process.env.BACKEND_PUBLIC_BASE_URL || 'https://copiloto-api.paulatalarico.com.br'
).replace(/\/+$/, '');

const CHAT_LIST_LIMIT = Number(process.env.SYNC_CHAT_LIMIT || 5000);
const MESSAGE_LIMIT_DEFAULT = Number(process.env.SYNC_MESSAGE_LIMIT || 200);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 20000);

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function isPnJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

function isWhatsAppIndividualJid(jid) {
  return isPnJid(jid) || isLidJid(jid);
}

function normalizePhone(value) {
  if (!value) return null;
  const base = String(value).split('@')[0];
  const digits = base.replace(/\D/g, '');
  return digits || null;
}

function getExternalChatIdFromJid(jid) {
  if (!jid) return null;
  if (isGroupJid(jid)) return jid;
  if (isWhatsAppIndividualJid(jid)) return normalizePhone(jid);
  return normalizePhone(jid) || jid;
}

function toIsoTimestamp(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }

  const num = Number(value);
  if (!Number.isNaN(num) && num > 0) {
    if (num > 1e12) return new Date(num).toISOString();
    return new Date(num * 1000).toISOString();
  }

  if (typeof value === 'object' && value?.low !== undefined) {
    const low = Number(value.low);
    if (!Number.isNaN(low) && low > 0) {
      return new Date(low * 1000).toISOString();
    }
  }

  return null;
}

function unixSecondsFromAny(value) {
  if (!value) return 0;

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }

  const num = Number(value);
  if (!Number.isNaN(num) && num > 0) {
    if (num > 1e12) return Math.floor(num / 1000);
    return Math.floor(num);
  }

  if (typeof value === 'object' && value?.low !== undefined) {
    const low = Number(value.low);
    if (!Number.isNaN(low)) return low;
  }

  return 0;
}

function fileLengthToNumber(value) {
  if (value == null) return null;

  if (typeof value === 'number') return value;

  if (typeof value === 'string') {
    const num = Number(value);
    return Number.isNaN(num) ? null : num;
  }

  if (typeof value === 'object' && value.low !== undefined) {
    const low = Number(value.low || 0);
    const high = Number(value.high || 0);

    if (!Number.isNaN(low) && !Number.isNaN(high)) {
      return high > 0 ? high * 4294967296 + low : low;
    }
  }

  return null;
}

function safeBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf-8').toString('base64url');
}

function fromSafeBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf-8');
}

function mediaTypeToKeyInfo(messageType, mimetype) {
  if (messageType === 'imageMessage') return 'WhatsApp Image Keys';
  if (messageType === 'videoMessage') return 'WhatsApp Video Keys';
  if (messageType === 'audioMessage') return 'WhatsApp Audio Keys';
  if (messageType === 'documentMessage') return 'WhatsApp Document Keys';
  if (messageType === 'stickerMessage') return 'WhatsApp Image Keys';

  if (typeof mimetype === 'string') {
    if (mimetype.startsWith('image/')) return 'WhatsApp Image Keys';
    if (mimetype.startsWith('video/')) return 'WhatsApp Video Keys';
    if (mimetype.startsWith('audio/')) return 'WhatsApp Audio Keys';
  }

  return 'WhatsApp Document Keys';
}

function normalizeServedMimeType(mimetype, messageType) {
  const value = String(mimetype || '').trim().toLowerCase();

  if (value) {
    if (value.startsWith('image/')) return value.split(';')[0].trim();
    if (value.startsWith('video/')) return value.split(';')[0].trim();
    if (value.startsWith('audio/ogg')) return 'audio/ogg';
    if (value.startsWith('audio/mp4')) return 'audio/mp4';
    if (value.startsWith('audio/mpeg')) return 'audio/mpeg';
    if (value.startsWith('audio/wav')) return 'audio/wav';
    if (value.startsWith('audio/webm')) return 'audio/webm';
    return value;
  }

  if (messageType === 'imageMessage') return 'image/jpeg';
  if (messageType === 'videoMessage') return 'video/mp4';
  if (messageType === 'audioMessage') return 'audio/ogg';
  if (messageType === 'stickerMessage') return 'image/webp';

  return 'application/octet-stream';
}

function decryptWhatsAppMedia(buffer, mediaKey, messageType, mimetype) {
  const mediaKeyBuffer = Buffer.from(mediaKey, 'base64');
  const info = mediaTypeToKeyInfo(messageType, mimetype);

  const expandedRaw = crypto.hkdfSync(
    'sha256',
    mediaKeyBuffer,
    Buffer.alloc(32, 0),
    Buffer.from(info, 'utf8'),
    112
  );

  const expanded = Buffer.isBuffer(expandedRaw)
    ? expandedRaw
    : Buffer.from(expandedRaw);

  const iv = expanded.slice(0, 16);
  const cipherKey = expanded.slice(16, 48);

  // WhatsApp anexa MAC de 10 bytes no final
  const encrypted = buffer.length > 10 ? buffer.slice(0, buffer.length - 10) : buffer;

  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);
}

function buildMediaProxyUrl({ messageType, mediaUrl, mediaKey, mimetype, fileName }) {
  if (!mediaUrl) return null;

  const params = new URLSearchParams({
    type: messageType || 'documentMessage',
    url: safeBase64Url(mediaUrl)
  });

  if (mediaKey) params.set('mediaKey', safeBase64Url(mediaKey));
  if (mimetype) params.set('mimetype', safeBase64Url(mimetype));
  if (fileName) params.set('fileName', safeBase64Url(fileName));

  return `${BACKEND_PUBLIC_BASE_URL}/api/media?${params.toString()}`;
}

function extractMessageText(message) {
  if (!message) return null;
  if (typeof message === 'string') return message;

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;

  if (message.imageMessage) {
    if (message.imageMessage.caption) return message.imageMessage.caption;
    return '[imageMessage]';
  }

  if (message.videoMessage) {
    if (message.videoMessage.caption) return message.videoMessage.caption;
    return '[videoMessage]';
  }

  if (message.documentMessage) {
    if (message.documentMessage.caption) return message.documentMessage.caption;
    if (message.documentMessage.fileName) return `[documentMessage] ${message.documentMessage.fileName}`;
    return '[documentMessage]';
  }

  if (message.audioMessage) return '[audioMessage]';
  if (message.stickerMessage) return '[stickerMessage]';

  if (message.contactMessage?.displayName) {
    return `[contactMessage:${message.contactMessage.displayName}]`;
  }
  if (message.contactMessage) return '[contactMessage]';

  if (message.locationMessage) return '[locationMessage]';

  if (message.reactionMessage?.text) {
    return `[reactionMessage:${message.reactionMessage.text}]`;
  }
  if (message.reactionMessage) return '[reactionMessage]';

  if (message.buttonsResponseMessage?.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }

  if (message.listResponseMessage?.title) {
    return message.listResponseMessage.title;
  }

  if (message.templateButtonReplyMessage?.selectedDisplayText) {
    return message.templateButtonReplyMessage.selectedDisplayText;
  }

  if (message.templateMessage?.hydratedTemplate?.hydratedContentText) {
    return message.templateMessage.hydratedTemplate.hydratedContentText;
  }

  if (message.templateMessage?.hydratedFourRowTemplate?.hydratedContentText) {
    return message.templateMessage.hydratedFourRowTemplate.hydratedContentText;
  }

  if (message.ephemeralMessage?.message) {
    return extractMessageText(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return extractMessageText(message.viewOnceMessage.message);
  }

  if (message.documentWithCaptionMessage?.message) {
    return extractMessageText(message.documentWithCaptionMessage.message);
  }

  if (message.message) {
    return extractMessageText(message.message);
  }

  return '[unsupportedMessage]';
}

function extractMediaNode(message) {
  if (!message || typeof message !== 'object') return null;

  if (message.imageMessage) return { messageType: 'imageMessage', node: message.imageMessage };
  if (message.videoMessage) return { messageType: 'videoMessage', node: message.videoMessage };
  if (message.audioMessage) return { messageType: 'audioMessage', node: message.audioMessage };
  if (message.documentMessage) return { messageType: 'documentMessage', node: message.documentMessage };
  if (message.stickerMessage) return { messageType: 'stickerMessage', node: message.stickerMessage };

  if (message.ephemeralMessage?.message) return extractMediaNode(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return extractMediaNode(message.viewOnceMessage.message);
  if (message.documentWithCaptionMessage?.message) return extractMediaNode(message.documentWithCaptionMessage.message);

  return null;
}

function extractMessagePayloadParts(message) {
  const base = {
    messageType: 'unknown',
    messageText: extractMessageText(message),
    mediaUrl: null,
    mimetype: null,
    fileName: null,
    caption: null,
    thumbnailUrl: null,
    fileSize: null,
    durationSeconds: null,
    ptt: false,
    reactionText: null,
    deleted: false
  };

  if (!message || typeof message !== 'object') return base;

  if (message.ephemeralMessage?.message) {
    return extractMessagePayloadParts(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return extractMessagePayloadParts(message.viewOnceMessage.message);
  }

  if (message.documentWithCaptionMessage?.message) {
    return extractMessagePayloadParts(message.documentWithCaptionMessage.message);
  }

  if (message.protocolMessage?.type === 'REVOKE') {
    return {
      ...base,
      messageType: 'protocolMessage',
      messageText: '[Mensagem apagada]',
      deleted: true
    };
  }

  if (message.reactionMessage) {
    return {
      ...base,
      messageType: 'reactionMessage',
      messageText: null,
      reactionText: message.reactionMessage?.text || null
    };
  }

  const media = extractMediaNode(message);
  if (media) {
    const node = media.node;
    const messageType = media.messageType;
    const rawMediaUrl = node.url || null;
    const mimetype = node.mimetype || null;
    const fileName = node.fileName || node.title || null;
    const proxyUrl = buildMediaProxyUrl({
      messageType,
      mediaUrl: rawMediaUrl,
      mediaKey: node.mediaKey,
      mimetype,
      fileName
    });

    if (messageType === 'imageMessage') {
      return {
        ...base,
        messageType,
        messageText: node.caption || '[imageMessage]',
        mediaUrl: proxyUrl,
        mimetype: mimetype || 'image/jpeg',
        fileName,
        caption: node.caption || null,
        thumbnailUrl: messageType === 'imageMessage' ? proxyUrl : null,
        fileSize: fileLengthToNumber(node.fileLength)
      };
    }

    if (messageType === 'videoMessage') {
      return {
        ...base,
        messageType,
        messageText: node.caption || '[videoMessage]',
        mediaUrl: proxyUrl,
        mimetype: mimetype || 'video/mp4',
        fileName,
        caption: node.caption || null,
        thumbnailUrl: null,
        fileSize: fileLengthToNumber(node.fileLength),
        durationSeconds: node.seconds || null
      };
    }

    if (messageType === 'audioMessage') {
      return {
        ...base,
        messageType,
        messageText: '[audioMessage]',
        mediaUrl: proxyUrl,
        mimetype: mimetype || 'audio/ogg; codecs=opus',
        fileName,
        fileSize: fileLengthToNumber(node.fileLength),
        durationSeconds: node.seconds || null,
        ptt: !!node.ptt
      };
    }

    if (messageType === 'documentMessage') {
      return {
        ...base,
        messageType,
        messageText:
          node.caption ||
          (fileName ? `[documentMessage] ${fileName}` : '[documentMessage]'),
        mediaUrl: proxyUrl,
        mimetype,
        fileName,
        caption: node.caption || null,
        fileSize: fileLengthToNumber(node.fileLength)
      };
    }

    if (messageType === 'stickerMessage') {
      return {
        ...base,
        messageType,
        messageText: '[stickerMessage]',
        mediaUrl: proxyUrl,
        mimetype: mimetype || 'image/webp',
        thumbnailUrl: proxyUrl,
        fileSize: fileLengthToNumber(node.fileLength)
      };
    }
  }

  return {
    ...base,
    messageType: Object.keys(message)[0] || 'conversation'
  };
}

function extractArrayFromEvolutionResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [
    payload.data,
    payload.response,
    payload.chats,
    payload.messages,
    payload.results,
    payload.result,
    payload.records
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  if (payload.records && Array.isArray(payload.records)) return payload.records;
  if (payload.messages?.records && Array.isArray(payload.messages.records)) return payload.messages.records;

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

function pickBestDirectJid(...candidates) {
  const valid = candidates.filter(Boolean);

  for (const jid of valid) {
    if (isPnJid(jid)) return jid;
  }

  for (const jid of valid) {
    if (isLidJid(jid)) return jid;
  }

  for (const jid of valid) {
    if (!isGroupJid(jid)) return jid;
  }

  return null;
}

function getPreferredExternalChatId({ primaryJid, altJid, isGroup }) {
  if (isGroup) {
    return primaryJid || altJid || null;
  }

  const pn = [primaryJid, altJid].find((j) => isPnJid(j));
  if (pn) return normalizePhone(pn);

  const lid = [primaryJid, altJid].find((j) => isLidJid(j));
  if (lid) return normalizePhone(lid);

  return getExternalChatIdFromJid(primaryJid || altJid || null);
}

function getChatRawRemoteJid(chat) {
  return (
    chat?.remoteJid ||
    chat?.key?.remoteJid ||
    chat?.lastMessage?.key?.remoteJid ||
    chat?.jid ||
    null
  );
}

function getChatAltRemoteJid(chat) {
  return (
    chat?.remoteJidAlt ||
    chat?.key?.remoteJidAlt ||
    chat?.lastMessage?.key?.remoteJidAlt ||
    null
  );
}

function getChatDisplayName(chat) {
  return (
    chat?.subject ||
    chat?.name ||
    chat?.pushName ||
    chat?.notifyName ||
    chat?.formattedName ||
    null
  );
}

function getChatLastMessageText(chat) {
  return (
    extractMessageText(chat?.lastMessage?.message) ||
    extractMessageText(chat?.message) ||
    chat?.lastMessage?.conversation ||
    chat?.lastMessage?.text ||
    chat?.text ||
    null
  );
}

function getChatTimestamp(chat) {
  return (
    chat?.updatedAt ||
    chat?.conversationTimestamp ||
    chat?.lastMessageTimestamp ||
    chat?.timestamp ||
    chat?.lastMessage?.messageTimestamp ||
    chat?.lastMessage?.timestamp ||
    null
  );
}

function normalizeChatRecord(chat) {
  const rawRemoteJid = getChatRawRemoteJid(chat);
  const altRemoteJid = getChatAltRemoteJid(chat);

  const isGroup = isGroupJid(rawRemoteJid) || isGroupJid(altRemoteJid);

  const preferredJid = isGroup
    ? (isGroupJid(rawRemoteJid) ? rawRemoteJid : altRemoteJid || rawRemoteJid)
    : pickBestDirectJid(rawRemoteJid, altRemoteJid);

  const externalChatId = getPreferredExternalChatId({
    primaryJid: rawRemoteJid,
    altJid: altRemoteJid,
    isGroup
  });

  return {
    raw: chat,
    rawRemoteJid,
    altRemoteJid,
    remoteJid: preferredJid,
    queryRemoteJid: rawRemoteJid || altRemoteJid || preferredJid,
    isGroup,
    externalChatId,
    displayName: getChatDisplayName(chat),
    lastMessagePreview: getChatLastMessageText(chat),
    lastMessageAt: toIsoTimestamp(getChatTimestamp(chat)),
    unreadCount:
      chat?.unreadCount ??
      chat?.raw?.unreadCount ??
      null,
    profilePicUrl:
      chat?.profilePicUrl ||
      chat?.pictureUrl ||
      chat?.raw?.profilePicUrl ||
      chat?.raw?.pictureUrl ||
      null
  };
}

function normalizeMessageRecord(record, fallback = {}) {
  const key = record?.key || {};

  const rawRemoteJid =
    key?.remoteJid ||
    record?.remoteJid ||
    fallback.rawRemoteJid ||
    fallback.queryRemoteJid ||
    null;

  const altRemoteJid =
    key?.remoteJidAlt ||
    record?.remoteJidAlt ||
    fallback.altRemoteJid ||
    null;

  const isGroup = isGroupJid(rawRemoteJid) || isGroupJid(altRemoteJid);

  const preferredJid = isGroup
    ? (isGroupJid(rawRemoteJid) ? rawRemoteJid : altRemoteJid || rawRemoteJid)
    : pickBestDirectJid(rawRemoteJid, altRemoteJid, fallback.remoteJid);

  const externalChatId = getPreferredExternalChatId({
    primaryJid: rawRemoteJid,
    altJid: altRemoteJid,
    isGroup
  });

  const rawMessageTimestamp =
    record?.messageTimestamp ||
    record?.timestamp ||
    record?.message?.messageTimestamp ||
    null;

  const parts = extractMessagePayloadParts(record?.message || record);

  const finalStatus =
    record?.status ||
    record?.ack ||
    record?.MessageUpdate?.[record?.MessageUpdate?.length - 1]?.status ||
    null;

  const deleted =
    !!key?.deleted ||
    parts.deleted ||
    finalStatus === 'DELETED' ||
    record?.message?.protocolMessage?.type === 'REVOKE';

  return {
    raw: record,
    externalMessageId: key?.id || record?.id || null,
    rawRemoteJid,
    altRemoteJid,
    remoteJid: preferredJid,
    externalChatId,
    isGroup,
    fromMe: !!(record?.fromMe ?? key?.fromMe),
    pushName: record?.pushName || record?.participantPushName || null,
    messageType: parts.messageType || record?.messageType || record?.type || 'unknown',
    messageText: deleted ? '[Mensagem apagada]' : parts.messageText,
    messageTimestamp: toIsoTimestamp(rawMessageTimestamp),
    timestampUnix: unixSecondsFromAny(rawMessageTimestamp),
    status: finalStatus,
    mediaUrl: parts.mediaUrl,
    mimetype: parts.mimetype,
    fileName: parts.fileName,
    caption: parts.caption,
    thumbnailUrl: parts.thumbnailUrl,
    fileSize: parts.fileSize,
    durationSeconds: parts.durationSeconds,
    ptt: parts.ptt,
    reactionText: parts.reactionText,
    deleted
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function evolutionHttpRequest(method, path, body = undefined) {
  const response = await fetchWithTimeout(`${EVOLUTION_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: EVOLUTION_API_KEY
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  return { response, data };
}

async function evolutionRequest(path, body = undefined) {
  return evolutionHttpRequest('POST', path, body);
}

async function evolutionGet(path) {
  return evolutionHttpRequest('GET', path);
}

async function tryEvolutionCandidates(candidates) {
  const attempts = [];

  for (const candidate of candidates) {
    try {
      const result =
        candidate.method === 'GET'
          ? await evolutionGet(candidate.path)
          : await evolutionHttpRequest(candidate.method || 'POST', candidate.path, candidate.body);

      const { response, data } = result;

      attempts.push({
        method: candidate.method || 'POST',
        path: candidate.path,
        ok: response.ok,
        status: response.status
      });

      if (response.ok) {
        return {
          ok: true,
          winner: candidate,
          response,
          data,
          attempts
        };
      }
    } catch (err) {
      attempts.push({
        method: candidate.method || 'POST',
        path: candidate.path,
        ok: false,
        status: 0,
        error: err.message || String(err)
      });
    }
  }

  return {
    ok: false,
    attempts
  };
}

async function fetchAllNormalizedChats() {
  const { response, data } = await evolutionRequest(`/chat/findChats/${EVOLUTION_INSTANCE}`);

  if (!response.ok) {
    throw new Error(`evolution_find_chats_failed: ${JSON.stringify(data)}`);
  }

  const chats = extractArrayFromEvolutionResponse(data).map(normalizeChatRecord);

  return chats
    .filter((chat) => chat.queryRemoteJid && chat.externalChatId)
    .sort((a, b) => unixSecondsFromAny(b.lastMessageAt) - unixSecondsFromAny(a.lastMessageAt))
    .slice(0, CHAT_LIST_LIMIT);
}

function findChatMatch(chats, chatId) {
  if (!chatId) return null;

  const byExactJid = chats.find(
    (c) =>
      c.queryRemoteJid === chatId ||
      c.rawRemoteJid === chatId ||
      c.remoteJid === chatId ||
      c.altRemoteJid === chatId
  );
  if (byExactJid) return byExactJid;

  const phone = normalizePhone(chatId);
  if (!phone) return null;

  const byPhone = chats.find((c) => c.externalChatId === phone);
  if (byPhone) return byPhone;

  return null;
}

function getJidsToQueryFromChat(chat) {
  if (!chat) return [];
  const set = new Set(
    [chat.queryRemoteJid, chat.rawRemoteJid, chat.remoteJid, chat.altRemoteJid].filter(Boolean)
  );
  return Array.from(set);
}

async function fetchMessagesForSingleJid(jid) {
  const primary = await evolutionRequest(
    `/chat/findMessages/${EVOLUTION_INSTANCE}`,
    {
      where: {
        key: { remoteJid: jid }
      }
    }
  );

  if (primary.response.ok) {
    return extractArrayFromEvolutionResponse(primary.data?.messages || primary.data);
  }

  const fallback = await evolutionRequest(
    `/chat/findMessages/${EVOLUTION_INSTANCE}`,
    {
      where: {
        key: { remoteJid: jid }
      },
      page: 1,
      limit: 1000
    }
  );

  if (fallback.response.ok) {
    return extractArrayFromEvolutionResponse(fallback.data?.messages || fallback.data);
  }

  throw new Error(`evolution_find_messages_failed_for_${jid}`);
}

async function fetchMergedMessagesForChat(chat, limit = 200) {
  const jidsToQuery = getJidsToQueryFromChat(chat);
  const allMessages = [];
  const queryStats = [];

  for (const jid of jidsToQuery) {
    try {
      const rawMessages = await fetchMessagesForSingleJid(jid);

      queryStats.push({ jid, ok: true, count: rawMessages.length });

      const normalizedForThisJid = rawMessages.map((item) =>
        normalizeMessageRecord(item, {
          rawRemoteJid: jid,
          altRemoteJid: chat.altRemoteJid,
          remoteJid: chat.remoteJid
        })
      );

      allMessages.push(...normalizedForThisJid);
    } catch (err) {
      console.error(`[mergedMessages] Exceção consultando ${jid}:`, err.message || err);
      queryStats.push({ jid, ok: false, count: 0 });
    }
  }

  const dedup = new Map();

  for (const msg of allMessages) {
    const dedupKey =
      msg.externalMessageId ||
      `${msg.rawRemoteJid || 'no-jid'}|${msg.timestampUnix || 0}|${msg.messageText || 'no-text'}`;

    if (!dedup.has(dedupKey)) {
      dedup.set(dedupKey, msg);
    }
  }

  const mergedMessages = Array.from(dedup.values()).sort(
    (a, b) => (a.timestampUnix || 0) - (b.timestampUnix || 0)
  );

  const limitedMessages = mergedMessages.slice(-limit);

  return {
    jidsToQuery,
    queryStats,
    allMessagesCount: allMessages.length,
    deduplicatedCount: mergedMessages.length,
    messages: limitedMessages
  };
}

async function resolveChatForMessages(chatId) {
  if (!chatId) return null;

  const chats = await fetchAllNormalizedChats();
  const matched = findChatMatch(chats, chatId);
  if (matched) return matched;

  if (chatId.includes('@')) {
    const isGroup = isGroupJid(chatId);
    return {
      queryRemoteJid: chatId,
      rawRemoteJid: chatId,
      remoteJid: chatId,
      altRemoteJid: null,
      externalChatId: isGroup ? chatId : normalizePhone(chatId),
      isGroup,
      displayName: null,
      profilePicUrl: null
    };
  }

  const normalizedPhone = normalizePhone(chatId);
  if (!normalizedPhone) return null;

  return {
    queryRemoteJid: `${normalizedPhone}@s.whatsapp.net`,
    rawRemoteJid: `${normalizedPhone}@s.whatsapp.net`,
    remoteJid: `${normalizedPhone}@s.whatsapp.net`,
    altRemoteJid: null,
    externalChatId: normalizedPhone,
    isGroup: false,
    displayName: null,
    profilePicUrl: null
  };
}

async function loadContactsMap() {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('phone, full_name');

    if (error) {
      console.error('[contacts] erro ao carregar contatos:', error.message);
      return {};
    }

    const map = {};
    for (const item of data || []) {
      const phone = normalizePhone(item.phone);
      const name = String(item.full_name || '').trim();
      if (phone && name) {
        map[phone] = name;
      }
    }

    return map;
  } catch (err) {
    console.error('[contacts] exceção ao carregar contatos:', err.message || err);
    return {};
  }
}

function enrichChatsWithContacts(chats, contactsMap) {
  return chats.map((chat) => {
    if (chat.isGroup) {
      return {
        ...chat,
        agendaName: null,
        nameSource: 'group',
        finalDisplayName: chat.displayName || 'Grupo'
      };
    }

    const agendaName = chat.externalChatId ? contactsMap[chat.externalChatId] || null : null;

    return {
      ...chat,
      agendaName,
      nameSource: agendaName ? 'agenda' : (chat.displayName ? 'evolution' : 'none'),
      finalDisplayName:
        agendaName ||
        chat.displayName ||
        (chat.externalChatId ? chat.externalChatId : 'Desconhecido')
    };
  });
}

async function resolveChatActionTarget(chatId) {
  const chat = await resolveChatForMessages(chatId);
  if (!chat) return null;

  const candidateJids = getJidsToQueryFromChat(chat);
  const primaryJid = chat.queryRemoteJid || chat.remoteJid || chat.rawRemoteJid || null;
  const pnJid = candidateJids.find((j) => isPnJid(j)) || null;
  const lidJid = candidateJids.find((j) => isLidJid(j)) || null;
  const bestJid = chat.isGroup
    ? (candidateJids.find((j) => isGroupJid(j)) || primaryJid)
    : (pnJid || lidJid || primaryJid);

  return {
    chat,
    primaryJid,
    pnJid,
    lidJid,
    bestJid,
    candidateJids,
    phone: normalizePhone(chat.externalChatId)
  };
}

async function fetchProfilePictureFromEvolution(target) {
  if (target?.chat?.profilePicUrl) {
    return {
      ok: true,
      source: 'chat_cache',
      profilePictureUrl: target.chat.profilePicUrl,
      attempts: []
    };
  }

  const phone = target?.phone;
  const jid = target?.bestJid || target?.primaryJid;
  const candidates = [];

  if (phone) {
    candidates.push({
      method: 'POST',
      path: `/chat/fetchProfilePictureUrl/${EVOLUTION_INSTANCE}`,
      body: { number: phone }
    });
  }

  if (jid) {
    candidates.push({
      method: 'POST',
      path: `/chat/fetchProfilePictureUrl/${EVOLUTION_INSTANCE}`,
      body: { jid }
    });
  }

  const result = await tryEvolutionCandidates(candidates);

  if (!result.ok) {
    return {
      ok: false,
      attempts: result.attempts
    };
  }

  const url =
    result.data?.profilePictureUrl ||
    result.data?.pictureUrl ||
    result.data?.url ||
    result.data?.response?.profilePictureUrl ||
    result.data?.response?.pictureUrl ||
    null;

  if (!url) {
    return {
      ok: false,
      attempts: result.attempts
    };
  }

  return {
    ok: true,
    source: 'evolution',
    profilePictureUrl: url,
    attempts: result.attempts
  };
}

async function archiveChatOnEvolution(target, archive) {
  const jid = target.bestJid || target.primaryJid;
  const phone = target.phone;

  const candidates = [];

  if (jid) {
    candidates.push({
      method: 'POST',
      path: `/chat/archiveChat/${EVOLUTION_INSTANCE}`,
      body: { chatId: jid, archive: !!archive }
    });
  }

  if (phone) {
    candidates.push({
      method: 'POST',
      path: `/chat/archiveChat/${EVOLUTION_INSTANCE}`,
      body: { chatId: `${phone}@s.whatsapp.net`, archive: !!archive }
    });
  }

  return tryEvolutionCandidates(candidates);
}

async function markChatReadOnEvolution({ chatId, messageId, fromMe }) {
  const target = await resolveChatActionTarget(chatId);
  if (!target) {
    return { ok: false, attempts: [] };
  }

  const remoteJid = target.bestJid || target.primaryJid;
  const candidates = [];

  if (remoteJid && messageId) {
    candidates.push({
      method: 'POST',
      path: `/chat/markMessageAsRead/${EVOLUTION_INSTANCE}`,
      body: {
        readMessages: [
          {
            remoteJid,
            fromMe: !!fromMe,
            id: messageId
          }
        ]
      }
    });
  }

  return tryEvolutionCandidates(candidates);
}

async function deleteMessageOnEvolution({ messageId, chatId, fromMe, deleteForEveryone }) {
  const target = await resolveChatActionTarget(chatId);
  const remoteJid = target?.bestJid || target?.primaryJid || null;

  const candidates = [];

  if (remoteJid) {
    candidates.push({
      method: 'POST',
      path: `/message/delete/${EVOLUTION_INSTANCE}`,
      body: {
        id: messageId,
        remoteJid,
        fromMe: !!fromMe,
        deleteForEveryone: !!deleteForEveryone
      }
    });
  }

  return tryEvolutionCandidates(candidates);
}

function copySelectedHeaders(sourceHeaders, res) {
  const headersToCopy = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'etag',
    'last-modified'
  ];

  for (const header of headersToCopy) {
    const value = sourceHeaders.get(header);
    if (value) {
      res.setHeader(header, value);
    }
  }
}

function parseRangeHeader(rangeHeader, totalLength) {
  if (!rangeHeader || !String(rangeHeader).startsWith('bytes=')) return null;

  const raw = String(rangeHeader).replace('bytes=', '').trim();
  const [startStr, endStr] = raw.split('-');

  let start = startStr === '' ? NaN : Number(startStr);
  let end = endStr === '' ? NaN : Number(endStr);

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (Number.isNaN(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(totalLength - suffixLength, 0);
    end = totalLength - 1;
  } else {
    if (start < 0 || start >= totalLength) return null;
    if (Number.isNaN(end) || end >= totalLength) end = totalLength - 1;
  }

  if (end < start) return null;

  return { start, end };
}

const evolutionInstanceState = {
  instanceName: EVOLUTION_INSTANCE,
  connected: false,
  status: 'unknown',
  lastEventAt: null,
  lastReconnectAt: null,
  resyncInProgress: false,
  lastResyncAt: null,
  lastResyncCount: null,
  lastResyncError: null,
  source: 'startup'
};

async function triggerEvolutionResync(reason = 'manual') {
  if (evolutionInstanceState.resyncInProgress) {
    return;
  }

  evolutionInstanceState.resyncInProgress = true;
  evolutionInstanceState.lastResyncError = null;

  try {
    const chats = await fetchAllNormalizedChats();
    evolutionInstanceState.lastResyncAt = new Date().toISOString();
    evolutionInstanceState.lastResyncCount = Array.isArray(chats) ? chats.length : null;
    console.log('🔄 Evolution resync concluído:', {
      reason,
      count: evolutionInstanceState.lastResyncCount,
      instanceName: evolutionInstanceState.instanceName
    });
  } catch (err) {
    evolutionInstanceState.lastResyncAt = new Date().toISOString();
    evolutionInstanceState.lastResyncError = err?.message || String(err);
    console.error('❌ Evolution resync falhou:', {
      reason,
      error: evolutionInstanceState.lastResyncError,
      instanceName: evolutionInstanceState.instanceName
    });
  } finally {
    evolutionInstanceState.resyncInProgress = false;
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/sync/status', async (req, res) => {
  return res.status(200).json({
    ok: true,
    connected: evolutionInstanceState.connected,
    status: evolutionInstanceState.status,
    mode: 'evolution-live-only',
    statusSource: evolutionInstanceState.source,
    instanceName: evolutionInstanceState.instanceName,
    lastEventAt: evolutionInstanceState.lastEventAt,
    lastReconnectAt: evolutionInstanceState.lastReconnectAt,
    resyncInProgress: evolutionInstanceState.resyncInProgress,
    lastResyncAt: evolutionInstanceState.lastResyncAt,
    lastResyncCount: evolutionInstanceState.lastResyncCount,
    lastResyncError: evolutionInstanceState.lastResyncError,
    supabase: {
      enabled: true,
      usage: 'contacts_only'
    }
  });
});

app.get('/api/sync/chats', async (req, res) => {
  try {
    const chats = await fetchAllNormalizedChats();
    const contactsMap = await loadContactsMap();
    const enrichedChats = enrichChatsWithContacts(chats, contactsMap);

    return res.status(200).json({
      ok: true,
      count: enrichedChats.length,
      mode: 'live',
      chats: enrichedChats
    });
  } catch (err) {
    console.error('Erro geral /api/sync/chats:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/sync/messages', async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '').trim();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || MESSAGE_LIMIT_DEFAULT)));

    if (!chatId) {
      return res.status(400).json({ error: 'chatId_required' });
    }

    const chat = await resolveChatForMessages(chatId);
    if (!chat || !chat.queryRemoteJid) {
      return res.status(400).json({ error: 'invalid_chatId' });
    }

    const rawMessages = await fetchMessagesForSingleJid(chat.queryRemoteJid);

    const normalizedMessages = rawMessages
      .map((item) =>
        normalizeMessageRecord(item, {
          rawRemoteJid: chat.queryRemoteJid,
          altRemoteJid: chat.altRemoteJid,
          remoteJid: chat.remoteJid
        })
      )
      .sort((a, b) => (a.timestampUnix || 0) - (b.timestampUnix || 0))
      .slice(-limit);

    return res.status(200).json({
      ok: true,
      count: normalizedMessages.length,
      queryRemoteJid: chat.queryRemoteJid,
      remoteJid: chat.remoteJid,
      externalChatId: chat.externalChatId,
      messages: normalizedMessages
    });
  } catch (err) {
    console.error('Erro geral /api/sync/messages:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/live/chat-history', async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '').trim();
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));

    if (!chatId) {
      return res.status(400).json({ ok: false, error: 'chatId_required' });
    }

    const chat = await resolveChatForMessages(chatId);
    if (!chat || !chat.queryRemoteJid) {
      return res.status(400).json({ ok: false, error: 'invalid_chatId' });
    }

    const merged = await fetchMergedMessagesForChat(chat, limit);

    return res.status(200).json({
      ok: true,
      count: merged.messages.length,
      primaryJid: chat.queryRemoteJid,
      altJid: chat.altRemoteJid || null,
      jidsQueried: merged.jidsToQuery,
      queryStats: merged.queryStats,
      merged: merged.jidsToQuery.length > 1,
      allMessagesCount: merged.allMessagesCount,
      deduplicatedCount: merged.deduplicatedCount,
      queryRemoteJid: chat.queryRemoteJid,
      remoteJid: chat.remoteJid,
      externalChatId: chat.externalChatId,
      messages: merged.messages
    });
  } catch (err) {
    console.error('Erro geral /api/live/chat-history:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.get('/api/media', async (req, res) => {
  try {
    const type = String(req.query.type || 'documentMessage');
    const encodedUrl = String(req.query.url || '');
    const encodedMediaKey = String(req.query.mediaKey || '');
    const encodedMimetype = String(req.query.mimetype || '');
    const encodedFileName = String(req.query.fileName || '');

    if (!encodedUrl) {
      return res.status(400).json({ ok: false, error: 'url_required' });
    }

    const mediaUrl = fromSafeBase64Url(encodedUrl);
    const mediaKey = encodedMediaKey ? fromSafeBase64Url(encodedMediaKey) : null;
    const rawMimetype = encodedMimetype ? fromSafeBase64Url(encodedMimetype) : '';
    const servedMimetype = normalizeServedMimeType(rawMimetype, type);
    const fileName = encodedFileName ? fromSafeBase64Url(encodedFileName) : null;

    if (!mediaKey) {
      const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*'
      };

      if (req.headers.range) {
        upstreamHeaders.Range = String(req.headers.range);
      }

      const upstreamResponse = await fetchWithTimeout(mediaUrl, {
        headers: upstreamHeaders
      });

      if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
        return res.status(upstreamResponse.status).json({
          ok: false,
          error: 'media_passthrough_failed',
          status: upstreamResponse.status
        });
      }

      const upstreamBuffer = Buffer.from(await upstreamResponse.arrayBuffer());

      res.status(upstreamResponse.status);
      copySelectedHeaders(upstreamResponse.headers, res);
      res.setHeader('Content-Type', normalizeServedMimeType(
        upstreamResponse.headers.get('content-type') || servedMimetype,
        type
      ));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      if (fileName) {
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }

      if (!res.getHeader('Cache-Control')) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }

      if (!res.getHeader('Accept-Ranges')) {
        res.setHeader('Accept-Ranges', 'bytes');
      }

      if (!res.getHeader('Content-Length')) {
        res.setHeader('Content-Length', String(upstreamBuffer.length));
      }

      return res.send(upstreamBuffer);
    }

    const response = await fetchWithTimeout(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: 'media_download_failed',
        status: response.status
      });
    }

    const encryptedBuffer = Buffer.from(await response.arrayBuffer());

    let outputBuffer;
    try {
      outputBuffer = decryptWhatsAppMedia(encryptedBuffer, mediaKey, type, servedMimetype);
    } catch (decryptErr) {
      console.error('[media] decrypt falhou:', {
        type,
        mimetype: servedMimetype,
        encryptedSize: encryptedBuffer.length,
        message: decryptErr.message || String(decryptErr)
      });

      return res.status(500).json({
        ok: false,
        error: 'media_decrypt_failed',
        details: decryptErr.message || String(decryptErr)
      });
    }

    const totalLength = outputBuffer.length;
    const rangeHeader = req.headers.range;
    const range = parseRangeHeader(rangeHeader, totalLength);

    res.setHeader('Content-Type', servedMimetype);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (fileName) {
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }

    if (rangeHeader && !range) {
      res.setHeader('Content-Range', `bytes */${totalLength}`);
      return res.status(416).end();
    }

    if (range) {
      const chunk = outputBuffer.subarray(range.start, range.end + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalLength}`);
      res.setHeader('Content-Length', String(chunk.length));
      return res.send(chunk);
    }

    res.setHeader('Content-Length', String(totalLength));
    return res.status(200).send(outputBuffer);
  } catch (err) {
    console.error('Erro geral /api/media:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/api/sync/trigger', async (req, res) => {
  return res.status(200).json({
    ok: true,
    started: false,
    disabled: true,
    reason: 'phase_1_live_mode_only'
  });
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { phone, message } = req.body || {};

    const normalizedPhone = normalizePhone(phone);
    const text = String(message || '').trim();

    if (!normalizedPhone) {
      return res.status(400).json({ error: 'phone_required' });
    }

    if (!text) {
      return res.status(400).json({ error: 'message_required' });
    }

    const response = await fetchWithTimeout(
      `${EVOLUTION_BASE_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: EVOLUTION_API_KEY
        },
        body: JSON.stringify({
          number: normalizedPhone,
          text
        })
      }
    );

    const raw = await response.text();
    let data = null;

    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = { raw };
    }

    if (!response.ok) {
      console.error('Erro Evolution sendText:', data);
      return res.status(response.status).json({
        error: 'evolution_send_failed',
        details: data
      });
    }

    const evolutionMessageId = data?.key?.id || null;
    const rawRemoteJid = data?.key?.remoteJid || `${normalizedPhone}@s.whatsapp.net`;
    const altRemoteJid = data?.key?.remoteJidAlt || null;
    const preferredRemoteJid = pickBestDirectJid(rawRemoteJid, altRemoteJid);

    return res.status(200).json({
      ok: true,
      evolution_message_id: evolutionMessageId,
      remote_jid: preferredRemoteJid,
      raw_remote_jid: rawRemoteJid,
      alt_remote_jid: altRemoteJid,
      external_chat_id: normalizedPhone,
      status: data?.status || null,
      mode: 'live_only'
    });
  } catch (err) {
    console.error('Erro geral /api/send-message:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/chat/profile-picture', async (req, res) => {
  try {
    const chatId = String(req.query.chatId || '').trim();

    if (!chatId) {
      return res.status(400).json({ ok: false, error: 'chatId_required' });
    }

    const target = await resolveChatActionTarget(chatId);
    if (!target) {
      return res.status(400).json({ ok: false, error: 'invalid_chatId' });
    }

    const picture = await fetchProfilePictureFromEvolution(target);

    if (!picture.ok) {
      return res.status(404).json({
        ok: false,
        error: 'profile_picture_not_found',
        attempts: picture.attempts || []
      });
    }

    return res.status(200).json({
      ok: true,
      chatId,
      profilePictureUrl: picture.profilePictureUrl,
      source: picture.source,
      attempts: picture.attempts || []
    });
  } catch (err) {
    console.error('Erro geral /api/chat/profile-picture:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/api/chat/archive', async (req, res) => {
  try {
    const chatId = String(req.body?.chatId || '').trim();
    const archive = req.body?.archive !== false;

    if (!chatId) {
      return res.status(400).json({ ok: false, error: 'chatId_required' });
    }

    const target = await resolveChatActionTarget(chatId);
    if (!target) {
      return res.status(400).json({ ok: false, error: 'invalid_chatId' });
    }

    const result = await archiveChatOnEvolution(target, archive);

    if (!result.ok) {
      return res.status(501).json({
        ok: false,
        error: 'archive_not_supported_or_failed',
        archive,
        attempts: result.attempts || []
      });
    }

    return res.status(200).json({
      ok: true,
      archive,
      chatId,
      remoteJid: target.bestJid,
      evolutionResponse: result.data || null,
      attempts: result.attempts || []
    });
  } catch (err) {
    console.error('Erro geral /api/chat/archive:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/api/chat/read', async (req, res) => {
  try {
    const chatId = String(req.body?.chatId || '').trim();
    const messageId = String(req.body?.messageId || '').trim();
    const fromMe = !!req.body?.fromMe;

    if (!chatId) {
      return res.status(400).json({ ok: false, error: 'chatId_required' });
    }

    if (!messageId) {
      return res.status(400).json({
        ok: false,
        error: 'messageId_required',
        hint: 'para marcar como lida nessa versão da Evolution, envie o id da última mensagem do chat'
      });
    }

    const result = await markChatReadOnEvolution({
      chatId,
      messageId,
      fromMe
    });

    if (!result.ok) {
      return res.status(501).json({
        ok: false,
        error: 'mark_read_not_supported_or_failed',
        attempts: result.attempts || []
      });
    }

    return res.status(200).json({
      ok: true,
      chatId,
      messageId,
      unread: false,
      evolutionResponse: result.data || null,
      attempts: result.attempts || []
    });
  } catch (err) {
    console.error('Erro geral /api/chat/read:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/api/chat/unread', async (req, res) => {
  return res.status(501).json({
    ok: false,
    error: 'mark_unread_not_supported_by_current_evolution_version',
    hint: 'na sua Evolution 2.3.7 a rota oficial testada não existe'
  });
});

app.post('/api/message/delete', async (req, res) => {
  try {
    const messageId = String(req.body?.messageId || '').trim();
    const chatId = String(req.body?.chatId || '').trim();
    const fromMe = !!req.body?.fromMe;
    const deleteForEveryone = req.body?.deleteForEveryone !== false;

    if (!messageId) {
      return res.status(400).json({ ok: false, error: 'messageId_required' });
    }

    if (!chatId) {
      return res.status(400).json({ ok: false, error: 'chatId_required' });
    }

    const result = await deleteMessageOnEvolution({
      messageId,
      chatId,
      fromMe,
      deleteForEveryone
    });

    if (!result.ok) {
      return res.status(501).json({
        ok: false,
        error: 'delete_message_not_supported_or_failed',
        attempts: result.attempts || []
      });
    }

    return res.status(200).json({
      ok: true,
      messageId,
      chatId,
      fromMe,
      deleteForEveryone,
      evolutionResponse: result.data || null,
      attempts: result.attempts || []
    });
  } catch (err) {
    console.error('Erro geral /api/message/delete:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.post('/evolution', async (req, res) => {
  try {
    const payload = req.body || {};
    const eventType = payload?.event || null;
    const data = payload?.data || {};
    const key = data?.key || {};
    const message = data?.message || null;

    const rawRemoteJid = key?.remoteJid || data?.remoteJid || null;
    const altRemoteJid = key?.remoteJidAlt || data?.remoteJidAlt || null;
    const isGroup = isGroupJid(rawRemoteJid) || isGroupJid(altRemoteJid);
    const bestRemoteJid = isGroup
      ? (isGroupJid(rawRemoteJid) ? rawRemoteJid : altRemoteJid || rawRemoteJid)
      : pickBestDirectJid(rawRemoteJid, altRemoteJid);

    const parts = extractMessagePayloadParts(message);

    const connectionCandidates = [
      data?.state,
      data?.status,
      data?.connection,
      payload?.state,
      payload?.status,
      data?.instance?.state,
      data?.instance?.status
    ].filter(Boolean);

    const rawConnectionState =
      connectionCandidates.find((v) => typeof v === 'string') || null;

    if (eventType === 'connection.update') {
      const normalized = String(rawConnectionState || '').toLowerCase();
      const wasConnected = evolutionInstanceState.connected;

      const isConnected =
        normalized === 'open' ||
        normalized === 'connected' ||
        normalized === 'online';

      evolutionInstanceState.instanceName = payload?.instance || EVOLUTION_INSTANCE;
      evolutionInstanceState.connected = isConnected;
      evolutionInstanceState.status = rawConnectionState || (isConnected ? 'connected' : 'disconnected');
      evolutionInstanceState.lastEventAt = new Date().toISOString();
      evolutionInstanceState.source = 'webhook';

      if (!wasConnected && isConnected) {
        evolutionInstanceState.lastReconnectAt = new Date().toISOString();
        void triggerEvolutionResync('reconnect');
      }
    }

    console.log('📩 Webhook recebido:', {
      eventType,
      externalChatId: getPreferredExternalChatId({
        primaryJid: rawRemoteJid,
        altJid: altRemoteJid,
        isGroup
      }),
      rawRemoteJid,
      altRemoteJid,
      remoteJid: bestRemoteJid,
      fromMe: !!key?.fromMe,
      pushName: data?.pushName || null,
      messageType: data?.messageType || parts.messageType || null,
      messageText: parts.messageText,
      mediaUrl: parts.mediaUrl,
      fileName: parts.fileName,
      instanceName: payload?.instance || EVOLUTION_INSTANCE
    });

    return res.status(200).json({
      ok: true,
      ignored: true,
      mode: 'live_only'
    });
  } catch (err) {
    console.error('Erro geral /evolution:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const PORT = process.env.PORT || 3060;
app.listen(PORT, () => {
  console.log(`🚀 Copiloto webhook rodando na porta ${PORT}`);
  console.log('📡 Modo atual: Evolution live only');
  console.log('🗂️  Supabase: somente contatos');
  console.log(`🖼️  Media proxy público: ${BACKEND_PUBLIC_BASE_URL}/api/media`);
});
