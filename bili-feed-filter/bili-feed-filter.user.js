// ==UserScript==
// @name         B站推荐流高频投稿屏蔽
// @namespace    local.bili-feed-filter
// @version      1.2.1
// @description  在 B 站首页和视频页自动屏蔽短时间大量投稿的 UP，支持关键词/UID/低播放规则和不感兴趣反馈
// @author       local
// @match        https://www.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      app.bilibili.com
// @connect      api.bilibili.com
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // =========================================================================
  // 常量
  // =========================================================================

  const APP_KEY = '1d8b6e7d45233436';
  const APP_SECRET = '560c52ccd288fed045859ed18bffd973';
  const APP_BUILD = '8240000';
  const APP_PAGE_SIZE = 20;

  const SETTINGS_KEY = 'bff.settings.v1';
  const CACHE_KEY = 'bff.cache.v1';
  const RELATION_KEY = 'bff.relation.v1';
  const CACHE_VERSION = 1;

  const MAX_CACHE_ENTRIES = 300;
  const MAX_RELATION_ENTRIES = 500;
  const LOW_TOTAL_TTL_HOURS = 24;
  const PARTIAL_REFRESH_HOURS = 2;
  const ENTRY_REFRESH_HOURS = 1;
  const FEEDBACK_KEY = 'bff.feedback.v1';
  const FEEDBACK_VERSION = 1;
  const FEEDBACK_TTL_MS = 24 * 3600e3;
  const FEEDBACK_RETRY_MS = 30 * 60e3;
  const FEEDBACK_MAX_ENTRIES = 500;
  const FEEDBACK_URL = 'https://api.bilibili.com/x/web-interface/feedback/dislike';
  const FEEDBACK_CANCEL_URL = 'https://api.bilibili.com/x/web-interface/feedback/dislike/cancel';
  const AUTO_DISLIKE_DELAY_MS = 5000;
  const MAX_AUTO_FEEDBACK_PER_SESSION = 10;
  const DISLIKE_REASON_UP = 4;
  const DISLIKE_REASON_CONTENT = 1;
  const SCAN_INTERVAL_MS = 5000;
  const INTERSECT_MARGIN_PX = 400;
  const RELATION_TTL_MS = 24 * 3600e3;
  const RETRY_MS = 30 * 60e3;
  const RATE_LIMIT_PAUSE_MS = 10 * 60e3;

  const LOG_LIMIT = 200;
  const MAX_KEYWORD_LENGTH = 200;
  const MAX_KEYWORDS = 100;
  const MAX_UIDS = 500;
  const MAX_NAMES = 200;
  const MAX_THRESHOLD = 20;
  const MAX_WINDOW_HOURS = 168;
  const MAX_LOOKBACK_DAYS = 7;

  const RULE_TYPES = ['up-mass-upload', 'uid-list', 'keyword', 'play-count'];
  const RULE_TYPE_LABELS = {
    'up-mass-upload': '高频投稿',
    'uid-list': '指定 UP',
    'keyword': '关键词',
    'play-count': '低播放'
  };

  const RATE_LIMIT_CODES = new Set([-352, -412, -509, -799, 412, 429]);

  // =========================================================================
  // 基础工具
  // =========================================================================

  function deepClone(value) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (e) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function clampNum(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function toBool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    try { return n.toLocaleString('zh-CN'); } catch (e) { return String(n); }
  }

  function normalizeUid(value) {
    const s = String(value == null ? '' : value).trim();
    return /^\d{1,20}$/.test(s) ? s : '';
  }

  function normalizeStringList(value, max, maxLen) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
      const s = String(item == null ? '' : item).trim();
      if (!s || s.length > maxLen) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= max) break;
    }
    return out;
  }

  function normalizeUidList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const item of value) {
      const s = normalizeUid(item);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= MAX_UIDS) break;
    }
    return out;
  }

  function normalizeScope(scope) {
    if (!Array.isArray(scope)) return ['home', 'video'];
    const out = [];
    for (const item of scope) {
      if ((item === 'home' || item === 'video') && !out.includes(item)) out.push(item);
    }
    return out.length ? out : ['home', 'video'];
  }

  function normalizeCtime(value) {
    let n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n > 1e12) n = Math.floor(n / 1000);
    return Math.floor(n);
  }

  function extractMidFromHref(href) {
    if (!href) return '';
    const m = String(href).match(/space\.bilibili\.com\/(\d{1,20})/i);
    return m ? m[1] : '';
  }

  function extractBvidFromHref(href) {
    if (!href) return '';
    const m = String(href).match(/\/video\/(BV[0-9A-Za-z]+)/i);
    return m ? m[1] : '';
  }

  function parsePlayCount(text) {
    if (text == null) return null;
    const s = String(text).replace(/,/g, '').replace(/\s+/g, '');
    // 部分开启 VT 的卡片会把「播放时长」之类的时间放在第一位，不能当作播放数。
    if (/^\d{1,2}:\d{2}/.test(s)) return null;
    const m = s.match(/(\d+(?:\.\d+)?)(亿|万)?/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    if (m[2] === '亿') return Math.round(n * 1e8);
    if (m[2] === '万') return Math.round(n * 1e4);
    return Math.round(n);
  }

  function isFollowedText(text) {
    if (!text) return false;
    const s = String(text).trim();
    return s === '已关注' || s === 'Following' || s.includes('已关注');
  }

  function isRateLimitCode(code) {
    return RATE_LIMIT_CODES.has(Number(code));
  }

  function ruleAppliesToPage(rule, page) {
    return Array.isArray(rule.scope) ? rule.scope.includes(page) : true;
  }

  function ruleLabel(rule) {
    if (!rule) return '规则';
    return RULE_TYPE_LABELS[rule.type] || rule.id || '规则';
  }

  // =========================================================================
  // MD5（用于 B 站 App 接口签名）
  // =========================================================================

  function md5(str) {
    const bytes = new TextEncoder().encode(String(str));
    const len = bytes.length;
    const bitLen = len * 8;
    const paddedLength = (((len + 8) >> 6) + 1) * 64;
    const buffer = new Uint8Array(paddedLength);
    buffer.set(bytes);
    buffer[len] = 0x80;

    const view = new DataView(buffer.buffer);
    view.setUint32(paddedLength - 8, bitLen >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLen / 0x100000000), true);

    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    }

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;
    const M = new Uint32Array(16);

    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i++) {
        M[i] = view.getUint32(offset + i * 4, true);
      }
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;

      for (let i = 0; i < 64; i++) {
        let F;
        let g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) % 16;
        }
        const tmp = D;
        D = C;
        C = B;
        const sum = (A + F + K[i] + M[g]) >>> 0;
        B = (B + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
        A = tmp;
      }

      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, a0, true);
    outView.setUint32(4, b0, true);
    outView.setUint32(8, c0, true);
    outView.setUint32(12, d0, true);
    let hex = '';
    for (let i = 0; i < out.length; i++) hex += out[i].toString(16).padStart(2, '0');
    return hex;
  }

  function buildAppApiUrl(mid, options) {
    const opts = options || {};
    const pn = opts.pn || 1;
    const ps = opts.ps || APP_PAGE_SIZE;
    const ts = opts.ts || Math.floor(Date.now() / 1000);
    const params = {
      appkey: APP_KEY,
      build: APP_BUILD,
      mobi_app: 'android',
      order: 'pubdate',
      platform: 'android',
      pn: String(pn),
      ps: String(ps),
      ts: String(ts),
      vmid: String(mid)
    };
    const query = Object.keys(params)
      .sort()
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
      .join('&');
    const sign = md5(query + APP_SECRET);
    return `https://app.bilibili.com/x/v2/space/archive?${query}&sign=${sign}`;
  }

  // =========================================================================
  // 默认规则 / 设置
  // =========================================================================

  function makeDefaultRules() {
    return [
      {
        id: 'mass-upload',
        type: 'up-mass-upload',
        enabled: true,
        action: 'block',
        scope: ['home', 'video'],
        config: {
          threshold: 5,
          windowHours: 24,
          rolling: false,
          lookbackDays: 7,
          excludeLiveReplay: true,
          skipFollowed: true,
          videoFollowedCheck: true
        }
      },
      {
        id: 'whitelist',
        type: 'uid-list',
        enabled: true,
        action: 'allow',
        scope: ['home', 'video'],
        config: { uids: [], names: [] }
      },
      {
        id: 'blacklist',
        type: 'uid-list',
        enabled: false,
        action: 'block',
        scope: ['home', 'video'],
        config: { uids: [], names: [] }
      },
      {
        id: 'keywords',
        type: 'keyword',
        enabled: false,
        action: 'block',
        scope: ['home', 'video'],
        config: {
          keywords: [],
          matchTitle: true,
          matchUpName: false,
          regex: false
        }
      },
      {
        id: 'low-play',
        type: 'play-count',
        enabled: false,
        action: 'block',
        scope: ['home', 'video'],
        config: { min: 0, max: 1000 }
      },
      {
        id: 'keywords-allow',
        type: 'keyword',
        enabled: false,
        action: 'allow',
        scope: ['home', 'video'],
        config: {
          keywords: [],
          matchTitle: true,
          matchUpName: false,
          regex: false
        }
      }
    ];
  }

  function makeDefaultSettings() {
    return {
      version: 1,
      enabled: true,
      scope: { home: true, video: true },
      displayMode: 'placeholder',
      showFab: true,
      debug: false,
      conservative: false,
      autoDislike: 'mass',
      dislikeReason: 4,
      rules: makeDefaultRules()
    };
  }

  function normalizeRule(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const type = typeof raw.type === 'string' ? raw.type : '';
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `rule-${index + 1}`;
    const enabled = raw.enabled !== false;
    const action = raw.action === 'allow' ? 'allow' : 'block';
    const scope = normalizeScope(raw.scope);
    const config = raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? raw.config : {};
    let normalizedConfig;

    if (type === 'up-mass-upload') {
      normalizedConfig = {
        threshold: clampInt(config.threshold, 2, MAX_THRESHOLD, 5),
        windowHours: clampInt(config.windowHours, 1, MAX_WINDOW_HOURS, 24),
        rolling: toBool(config.rolling, false),
        lookbackDays: clampInt(config.lookbackDays, 1, MAX_LOOKBACK_DAYS, 7),
        excludeLiveReplay: toBool(config.excludeLiveReplay, true),
        skipFollowed: toBool(config.skipFollowed, true),
        videoFollowedCheck: toBool(config.videoFollowedCheck, true)
      };
      if (normalizedConfig.windowHours > normalizedConfig.lookbackDays * 24) {
        normalizedConfig.windowHours = normalizedConfig.lookbackDays * 24;
      }
    } else if (type === 'uid-list') {
      normalizedConfig = {
        uids: normalizeUidList(config.uids),
        names: normalizeStringList(config.names, MAX_NAMES, 100)
      };
    } else if (type === 'keyword') {
      normalizedConfig = {
        keywords: normalizeStringList(config.keywords, MAX_KEYWORDS, MAX_KEYWORD_LENGTH),
        matchTitle: toBool(config.matchTitle, true),
        matchUpName: toBool(config.matchUpName, false),
        regex: toBool(config.regex, false)
      };
    } else if (type === 'play-count') {
      normalizedConfig = {
        min: clampNum(config.min, 0, 1e12, 0),
        max: clampNum(config.max, 0, 1e12, 1000)
      };
      if (normalizedConfig.max < normalizedConfig.min) {
        normalizedConfig.max = normalizedConfig.min;
      }
    } else {
      normalizedConfig = deepClone(config);
    }

    const rule = {
      id,
      type,
      enabled,
      action,
      scope,
      config: normalizedConfig
    };
    if (raw.reason != null && String(raw.reason).trim()) {
      rule.reason = String(raw.reason).trim().slice(0, 200);
    }
    return rule;
  }

  function validateRules(rawRules) {
    const errors = [];
    if (!Array.isArray(rawRules)) {
      return { ok: false, errors: ['rules 必须是数组'], rules: [] };
    }
    const ids = new Set();
    const normalized = [];

    rawRules.forEach((raw, index) => {
      const where = `第 ${index + 1} 条规则`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push(`${where}不是对象`);
        return;
      }
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!id) errors.push(`${where}缺少 id`);
      else if (ids.has(id)) errors.push(`${where}的 id「${id}」重复`);
      else ids.add(id);

      if (!RULE_TYPES.includes(raw.type)) {
        errors.push(`${where}的类型「${String(raw.type)}」当前版本不支持`);
        return;
      }
      if (raw.action != null && raw.action !== 'block' && raw.action !== 'allow') {
        errors.push(`${where}的 action 必须是 block 或 allow`);
      }
      if (raw.type === 'up-mass-upload' && raw.action === 'allow') {
        errors.push(`${where}：高频投稿规则只能是 block`);
      }
      if (raw.enabled != null && typeof raw.enabled !== 'boolean') {
        errors.push(`${where}的 enabled 必须是布尔值`);
      }
      if (raw.scope != null) {
        if (!Array.isArray(raw.scope) || raw.scope.length === 0 ||
            raw.scope.some((s) => s !== 'home' && s !== 'video')) {
          errors.push(`${where}的 scope 只能是 home/video 数组`);
        }
      }
      if (raw.reason != null && (typeof raw.reason !== 'string' || raw.reason.length > 200)) {
        errors.push(`${where}的 reason 必须是不超过 200 字的字符串`);
      }
      if (raw.config != null && (typeof raw.config !== 'object' || Array.isArray(raw.config))) {
        errors.push(`${where}的 config 必须是对象`);
        return;
      }
      const c = raw.config || {};

      if (raw.type === 'up-mass-upload') {
        if (c.threshold != null && (!Number.isInteger(c.threshold) || c.threshold < 2 || c.threshold > MAX_THRESHOLD)) {
          errors.push(`${where}的 threshold 必须是 2-${MAX_THRESHOLD} 的整数`);
        }
        if (c.windowHours != null && (!Number.isInteger(c.windowHours) || c.windowHours < 1 || c.windowHours > MAX_WINDOW_HOURS)) {
          errors.push(`${where}的 windowHours 必须是 1-${MAX_WINDOW_HOURS} 的整数`);
        }
        if (c.rolling != null && typeof c.rolling !== 'boolean') {
          errors.push(`${where}的 rolling 必须是布尔值`);
        }
        if (c.lookbackDays != null && (!Number.isInteger(c.lookbackDays) || c.lookbackDays < 1 || c.lookbackDays > MAX_LOOKBACK_DAYS)) {
          errors.push(`${where}的 lookbackDays 必须是 1-${MAX_LOOKBACK_DAYS} 的整数`);
        }
        if (c.rolling === true) {
          const wh = c.windowHours != null ? c.windowHours : 24;
          const ld = c.lookbackDays != null ? c.lookbackDays : 7;
          if (Number.isInteger(wh) && Number.isInteger(ld) && wh > ld * 24) {
            errors.push(`${where}：windowHours 不能大于 lookbackDays × 24`);
          }
        }
        ['excludeLiveReplay', 'skipFollowed', 'videoFollowedCheck'].forEach((key) => {
          if (c[key] != null && typeof c[key] !== 'boolean') {
            errors.push(`${where}的 ${key} 必须是布尔值`);
          }
        });
      } else if (raw.type === 'uid-list') {
        if (c.uids != null) {
          if (!Array.isArray(c.uids)) {
            errors.push(`${where}的 uids 必须是数组`);
          } else {
            if (c.uids.length > MAX_UIDS) errors.push(`${where}的 uids 最多 ${MAX_UIDS} 个`);
            c.uids.forEach((uid, i) => {
              if (!normalizeUid(uid)) errors.push(`${where}的 uids[${i}] 不是合法 UID`);
            });
          }
        }
        if (c.names != null) {
          if (!Array.isArray(c.names)) {
            errors.push(`${where}的 names 必须是数组`);
          } else if (c.names.some((n) => typeof n !== 'string' || n.length > 100)) {
            errors.push(`${where}的 names 必须是不超过 100 字的字符串数组`);
          }
        }
      } else if (raw.type === 'keyword') {
        if (c.keywords != null) {
          if (!Array.isArray(c.keywords)) {
            errors.push(`${where}的 keywords 必须是数组`);
          } else {
            if (c.keywords.length > MAX_KEYWORDS) errors.push(`${where}的 keywords 最多 ${MAX_KEYWORDS} 个`);
            c.keywords.forEach((keyword, i) => {
              if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > MAX_KEYWORD_LENGTH) {
                errors.push(`${where}的 keywords[${i}] 必须是不超过 ${MAX_KEYWORD_LENGTH} 字的非空字符串`);
              }
            });
          }
        }
        ['matchTitle', 'matchUpName', 'regex'].forEach((key) => {
          if (c[key] != null && typeof c[key] !== 'boolean') {
            errors.push(`${where}的 ${key} 必须是布尔值`);
          }
        });
        const matchTitle = c.matchTitle !== false;
        const matchUpName = c.matchUpName === true;
        if (!matchTitle && !matchUpName) {
          errors.push(`${where}：至少选择 matchTitle 或 matchUpName`);
        }
        if (raw.enabled === true && Array.isArray(c.keywords) && c.keywords.length === 0) {
          errors.push(`${where}：启用关键词规则时至少填写一个关键词`);
        }
        if (c.regex === true && Array.isArray(c.keywords)) {
          c.keywords.forEach((keyword, i) => {
            if (typeof keyword === 'string' && keyword) {
              try {
                new RegExp(keyword, 'i');
              } catch (e) {
                errors.push(`${where}的 keywords[${i}] 不是合法正则：${e.message}`);
              }
            }
          });
        }
      } else if (raw.type === 'play-count') {
        const min = c.min != null ? c.min : 0;
        const max = c.max != null ? c.max : 1000;
        if (typeof min !== 'number' || !Number.isFinite(min) || min < 0) {
          errors.push(`${where}的 min 必须是非负数字`);
        }
        if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
          errors.push(`${where}的 max 必须是非负数字`);
        }
        if (typeof min === 'number' && typeof max === 'number' &&
            Number.isFinite(min) && Number.isFinite(max) && max < min) {
          errors.push(`${where}：max 不能小于 min`);
        }
      }

      const normalizedRule = normalizeRule(raw, index);
      if (normalizedRule) normalized.push(normalizedRule);
    });

    if (normalized.length !== rawRules.length && errors.length === 0) {
      errors.push('部分规则无效');
    }
    return { ok: errors.length === 0, errors, rules: normalized };
  }

  // =========================================================================
  // 规则匹配
  // =========================================================================

  function matchUidList(rule, card) {
    const uids = rule.config.uids || [];
    const names = rule.config.names || [];
    if (card.mid && uids.includes(String(card.mid))) {
      return {
        matched: true,
        reason: rule.reason || `UP UID ${card.mid} 在${rule.action === 'allow' ? '白名单' : '黑名单'}中`
      };
    }
    if (card.upName && names.length) {
      const cardName = String(card.upName).toLowerCase();
      const hit = names.find((name) => String(name).toLowerCase() === cardName);
      if (hit) {
        return {
          matched: true,
          reason: rule.reason || `UP「${card.upName}」在${rule.action === 'allow' ? '白名单' : '黑名单'}中`
        };
      }
    }
    return { matched: false };
  }

  function matchKeyword(rule, card) {
    const cfg = rule.config;
    const fields = [];
    if (cfg.matchTitle !== false && card.title) fields.push({ label: '标题', text: card.title });
    if (cfg.matchUpName === true && card.upName) fields.push({ label: 'UP 名', text: card.upName });
    for (const field of fields) {
      for (const keyword of cfg.keywords || []) {
        let hit = false;
        if (cfg.regex) {
          try {
            hit = new RegExp(keyword, 'i').test(field.text);
          } catch (e) {
            hit = false;
          }
        } else {
          hit = String(field.text).toLowerCase().includes(String(keyword).toLowerCase());
        }
        if (hit) {
          return { matched: true, reason: rule.reason || `${field.label}命中关键词「${keyword}」` };
        }
      }
    }
    return { matched: false };
  }

  function matchPlayCount(rule, card) {
    if (typeof card.playCount !== 'number' || !Number.isFinite(card.playCount)) {
      return { matched: false };
    }
    const min = typeof rule.config.min === 'number' ? rule.config.min : 0;
    const max = typeof rule.config.max === 'number' ? rule.config.max : Infinity;
    if (card.playCount >= min && card.playCount <= max) {
      return {
        matched: true,
        reason: rule.reason || `播放 ${formatNumber(card.playCount)} 在 ${formatNumber(min)}-${formatNumber(max)} 范围内`
      };
    }
    return { matched: false };
  }

  function matchStaticRule(rule, card) {
    if (!rule || !rule.enabled || !ruleAppliesToPage(rule, card.page)) return { matched: false };
    if (rule.type === 'uid-list') return matchUidList(rule, card);
    if (rule.type === 'keyword') return matchKeyword(rule, card);
    if (rule.type === 'play-count') return matchPlayCount(rule, card);
    return { matched: false };
  }

  function evaluateStaticRules(card, rules, page) {
    const active = (rules || []).filter((rule) =>
      rule && rule.enabled && ruleAppliesToPage(rule, page)
    );
    for (const rule of active) {
      if (rule.action !== 'allow') continue;
      const result = matchStaticRule(rule, card);
      if (result.matched) return { decision: 'allow', rule, reason: result.reason };
    }
    for (const rule of active) {
      if (rule.action === 'allow') continue;
      if (rule.type === 'up-mass-upload') continue;
      const result = matchStaticRule(rule, card);
      if (result.matched) return { decision: 'block', rule, reason: result.reason };
    }
    return { decision: 'none' };
  }

  // =========================================================================
  // 高频投稿判定
  // =========================================================================

  function countInWindow(timestamps, nowSec, windowSec) {
    let count = 0;
    for (const t of timestamps || []) {
      if (Number.isFinite(t) && t >= nowSec - windowSec && t <= nowSec + 300) count++;
    }
    return count;
  }

  function maxInAnyWindow(timestamps, nowSec, lookbackSec, windowSec) {
    const arr = [];
    for (const t of timestamps || []) {
      if (Number.isFinite(t) && t >= nowSec - lookbackSec && t <= nowSec + 300) arr.push(t);
    }
    if (!arr.length) return 0;
    arr.sort((a, b) => a - b);
    let best = 0;
    let left = 0;
    for (let right = 0; right < arr.length; right++) {
      while (arr[right] - arr[left] > windowSec) left++;
      const count = right - left + 1;
      if (count > best) best = count;
    }
    return best;
  }

  function evaluateMassUpload(rule, videos, now) {
    const cfg = rule.config;
    const nowMs = typeof now === 'number' ? now : Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const timestamps = [];
    for (const video of videos || []) {
      if (!video || cfg.excludeLiveReplay && video.live) continue;
      if (Number.isFinite(video.ctime) && video.ctime > 0 && video.ctime <= nowSec + 300) {
        timestamps.push(video.ctime);
      }
    }
    const windowSec = cfg.windowHours * 3600;
    let count;
    let reason;
    if (cfg.rolling) {
      count = maxInAnyWindow(timestamps, nowSec, cfg.lookbackDays * 86400, windowSec);
      reason = `最近 ${cfg.lookbackDays} 天内出现 ${cfg.windowHours} 小时内 ${count} 个投稿（阈值 ${cfg.threshold}）`;
    } else {
      count = countInWindow(timestamps, nowSec, windowSec);
      reason = `最近 ${cfg.windowHours} 小时内 ${count} 个投稿（阈值 ${cfg.threshold}）`;
    }
    if (rule.reason) reason = rule.reason;
    return {
      blocked: count >= cfg.threshold,
      count,
      timestamps,
      reason,
      shortReason: rule.reason || `${count} 个/${cfg.windowHours}h`,
      threshold: cfg.threshold,
      windowHours: cfg.windowHours,
      rolling: cfg.rolling
    };
  }

  // =========================================================================
  // Node 测试导出（浏览器里 module 通常不存在）
  // =========================================================================

  const Core = {
    md5,
    buildAppApiUrl,
    makeDefaultRules,
    makeDefaultSettings,
    normalizeRule,
    validateRules,
    normalizeUid,
    normalizeUidList,
    normalizeStringList,
    extractMidFromHref,
    extractBvidFromHref,
    parsePlayCount,
    isFollowedText,
    isRateLimitCode,
    ruleAppliesToPage,
    matchUidList,
    matchKeyword,
    matchPlayCount,
    evaluateStaticRules,
    countInWindow,
    maxInAnyWindow,
    evaluateMassUpload,
    deepClone
  };

  if (typeof module === 'object' && module && module.exports &&
      typeof process === 'object' && process && process.versions && process.versions.node) {
    module.exports = Core;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // =========================================================================
  // 浏览器运行时状态
  // =========================================================================

  const state = {
    started: false,
    settings: null,
    cache: { version: CACHE_VERSION, ups: {} },
    relation: { version: 1, users: {} },
    feedback: { version: FEEDBACK_VERSION, items: {} },
    queue: null,
    relationQueue: null,
    feedbackQueue: null,
    inFlight: new Map(),
    relationInFlight: new Map(),
    feedbackInFlight: new Map(),
    feedbackTimers: new Map(),
    aidCache: new Map(),
    failedMids: new Map(),
    failedRelation: new Map(),
    midCards: new Map(),
    shownMids: new Set(),
    sessionShowAll: false,
    sessionStartedAt: 0,
    autoFeedbackCount: 0,
    loggedFollowed: new Set(),
    loggedCache: new Set(),
    loggedStatic: new Set(),
    loggedFeedback: new Set(),
    stateVersion: 0,
    configVersion: 0,
    logs: [],
    panelOpen: false,
    rateLimitToastAt: 0,
    feedbackRateToastAt: 0,
    toastTimer: 0,
    cacheSaveTimer: 0,
    relationSaveTimer: 0
  };

  let shadowRoot = null;
  const ui = {};
  const CARD_SELECTOR = '.bili-video-card, .video-page-card-small';
  const observedCards = new WeakSet();
  let cardObserver = null;
  let mutationObserver = null;
  let cardScanTimer = 0;

  // =========================================================================
  // 日志
  // =========================================================================

  function safeLogData(data) {
    if (data == null) return undefined;
    if (data instanceof Error) {
      return {
        name: data.name,
        message: data.message,
        code: data.code,
        status: data.status,
        rateLimited: data.rateLimited,
        details: data.details
      };
    }
    if (typeof data === 'object') {
      try { return JSON.parse(JSON.stringify(data)); } catch (e) { return String(data); }
    }
    return data;
  }

  function log(level, message, data) {
    const entry = {
      time: Date.now(),
      level,
      message,
      data: safeLogData(data)
    };
    state.logs.push(entry);
    if (state.logs.length > LOG_LIMIT) {
      state.logs.splice(0, state.logs.length - LOG_LIMIT);
    }
    const debug = !!(state.settings && state.settings.debug);
    if (debug || level === 'warn' || level === 'error') {
      try {
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn.call(console, '[BFF]', message, data === undefined ? '' : data);
      } catch (e) { /* ignore */ }
    }
    if (state.panelOpen && ui.log) renderLog();
  }

  // =========================================================================
  // 本地存储
  // =========================================================================

  function lsGetJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function lsSetJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      log('warn', 'localStorage 写入失败', e);
      return false;
    }
  }

  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function gmGetJson(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const raw = GM_getValue(key, null);
        if (raw == null) return fallback;
        if (typeof raw === 'string') {
          try { return JSON.parse(raw); } catch (e) { return fallback; }
        }
        return raw;
      }
    } catch (e) {
      log('warn', 'GM_getValue 读取失败', e);
    }
    return lsGetJson(key, fallback);
  }

  function gmSetJson(key, value) {
    const raw = JSON.stringify(value);
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, raw);
        return;
      }
    } catch (e) {
      log('warn', 'GM_setValue 写入失败', e);
    }
    lsSetJson(key, value);
  }

  function saveSettings() {
    if (!state.settings) return;
    gmSetJson(SETTINGS_KEY, state.settings);
  }

  function loadSettings() {
    const raw = gmGetJson(SETTINGS_KEY, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return makeDefaultSettings();
    }
    const base = makeDefaultSettings();
    const merged = {
      ...base,
      ...raw,
      version: 1,
      enabled: raw.enabled !== false,
      displayMode: ['placeholder', 'hide', 'blur'].includes(raw.displayMode) ? raw.displayMode : 'placeholder',
      showFab: raw.showFab !== false,
      debug: !!raw.debug,
      conservative: raw.conservative === true,
      autoDislike: ['mass', 'all', 'off'].includes(raw.autoDislike) ? raw.autoDislike : 'mass',
      dislikeReason: Number(raw.dislikeReason) === DISLIKE_REASON_CONTENT ? DISLIKE_REASON_CONTENT : DISLIKE_REASON_UP,
      scope: {
        home: !raw.scope || raw.scope.home !== false,
        video: !raw.scope || raw.scope.video !== false
      },
      rules: Array.isArray(raw.rules) ? raw.rules : base.rules
    };
    const validation = validateRules(merged.rules);
    if (!validation.ok) {
      log('warn', '规则配置无效，已改用默认规则', validation.errors);
      merged.rules = makeDefaultRules();
    } else {
      merged.rules = validation.rules;
    }
    return merged;
  }

  function massConfigKey(settings) {
    const rule = (settings.rules || []).find((item) => item.type === 'up-mass-upload');
    if (!rule) return 'none';
    return JSON.stringify({
      enabled: rule.enabled,
      action: rule.action,
      scope: rule.scope,
      config: rule.config
    });
  }

  function whitelistUids(settings) {
    if (!settings || !Array.isArray(settings.rules)) return new Set();
    const rule = settings.rules.find((item) => item.id === 'whitelist') ||
      settings.rules.find((item) => item.type === 'uid-list' && item.action === 'allow');
    if (!rule || !rule.enabled) return new Set();
    const uids = rule.config && Array.isArray(rule.config.uids) ? rule.config.uids : [];
    return new Set(uids.map((uid) => String(uid)));
  }

  // =========================================================================
  // UP 投稿缓存
  // =========================================================================

  function loadCache() {
    const raw = lsGetJson(CACHE_KEY, null);
    if (!raw || raw.version !== CACHE_VERSION || !raw.ups || typeof raw.ups !== 'object') {
      return { version: CACHE_VERSION, ups: {} };
    }
    const ups = {};
    for (const [mid, entry] of Object.entries(raw.ups)) {
      if (!entry || !Array.isArray(entry.videos)) continue;
      const videos = [];
      for (const video of entry.videos) {
        const ctime = normalizeCtime(video && video.ctime);
        if (!ctime) continue;
        videos.push({
          bvid: String(video.bvid || ''),
          aid: /^\d+$/.test(String(video.aid || '').trim()) ? String(video.aid).trim() : '',
          ctime,
          live: !!video.live
        });
      }
      ups[String(mid)] = {
        name: String(entry.name || ''),
        fetchedAt: Number(entry.fetchedAt) || 0,
        videos,
        total: Number(entry.total) || 0,
        pagesFetched: Number(entry.pagesFetched) || 1,
        reachedEnd: !!entry.reachedEnd,
        partial: !!entry.partial
      };
    }
    return { version: CACHE_VERSION, ups };
  }

  function evictCache() {
    const entries = Object.entries(state.cache.ups);
    if (entries.length <= MAX_CACHE_ENTRIES) return;
    entries.sort((a, b) => (a[1].fetchedAt || 0) - (b[1].fetchedAt || 0));
    const removeCount = entries.length - MAX_CACHE_ENTRIES;
    for (let i = 0; i < removeCount; i++) {
      delete state.cache.ups[entries[i][0]];
    }
  }

  function saveCacheNow() {
    evictCache();
    lsSetJson(CACHE_KEY, state.cache);
  }

  function saveCacheDebounced() {
    clearTimeout(state.cacheSaveTimer);
    state.cacheSaveTimer = setTimeout(saveCacheNow, 500);
  }

  function getCacheEntry(mid) {
    return state.cache.ups[String(mid)] || null;
  }

  function setCacheEntry(mid, entry) {
    state.cache.ups[String(mid)] = entry;
    saveCacheDebounced();
    if (state.panelOpen) renderCacheStats();
  }

  function deleteCacheEntry(mid) {
    delete state.cache.ups[String(mid)];
    saveCacheDebounced();
  }

  function clearUpCache() {
    state.cache = { version: CACHE_VERSION, ups: {} };
    state.aidCache.clear();
    lsRemove(CACHE_KEY);
    if (state.panelOpen) renderCacheStats();
  }

  function shouldRefreshEntry(entry, rule) {
    if (!entry || !entry.fetchedAt) return true;
    const total = Number(entry.total) || 0;
    const threshold = Number(rule.config.threshold) || 0;
    const age = Date.now() - entry.fetchedAt;
    // 总投稿数都不够阈值，不可能在任意窗口内达到高频条件；不必频繁刷新。
    if (total > 0 && total < threshold) {
      return age >= LOW_TOTAL_TTL_HOURS * 3600e3;
    }
    // 每次页面加载/刷新都后台刷新一次可见 UP；页面内同一 UP 最多 1 小时刷新一次。
    if (state.sessionStartedAt && entry.fetchedAt < state.sessionStartedAt) return true;
    if (entry.partial) return age >= PARTIAL_REFRESH_HOURS * 3600e3;
    return age >= ENTRY_REFRESH_HOURS * 3600e3;
  }

  // =========================================================================
  // 关注状态缓存
  // =========================================================================

  function loadRelation() {
    const raw = lsGetJson(RELATION_KEY, null);
    if (!raw || !raw.users || typeof raw.users !== 'object') {
      return { version: 1, users: {} };
    }
    const users = {};
    for (const [mid, entry] of Object.entries(raw.users)) {
      if (!entry || typeof entry.followed !== 'boolean') continue;
      users[String(mid)] = {
        followed: entry.followed,
        notLoggedIn: !!entry.notLoggedIn,
        fetchedAt: Number(entry.fetchedAt) || 0
      };
    }
    return { version: 1, users };
  }

  function saveRelationNow() {
    const entries = Object.entries(state.relation.users);
    if (entries.length > MAX_RELATION_ENTRIES) {
      entries.sort((a, b) => (a[1].fetchedAt || 0) - (b[1].fetchedAt || 0));
      const removeCount = entries.length - MAX_RELATION_ENTRIES;
      for (let i = 0; i < removeCount; i++) {
        delete state.relation.users[entries[i][0]];
      }
    }
    lsSetJson(RELATION_KEY, state.relation);
  }

  function saveRelationDebounced() {
    clearTimeout(state.relationSaveTimer);
    state.relationSaveTimer = setTimeout(saveRelationNow, 500);
  }

  function getRelationEntry(mid) {
    const entry = state.relation.users[String(mid)];
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > RELATION_TTL_MS) {
      delete state.relation.users[String(mid)];
      saveRelationDebounced();
      return null;
    }
    return entry;
  }

  function setRelationEntry(mid, followed, notLoggedIn) {
    state.relation.users[String(mid)] = {
      followed: !!followed,
      notLoggedIn: !!notLoggedIn,
      fetchedAt: Date.now()
    };
    saveRelationDebounced();
    if (state.panelOpen) renderCacheStats();
  }

  function clearRelationCache() {
    state.relation = { version: 1, users: {} };
    lsRemove(RELATION_KEY);
    if (state.panelOpen) renderCacheStats();
  }

  // =========================================================================
  // 「不感兴趣」反馈
  // =========================================================================

  function loadFeedback() {
    const raw = lsGetJson(FEEDBACK_KEY, null);
    if (!raw || raw.version !== FEEDBACK_VERSION ||
        !raw.items || typeof raw.items !== 'object' || Array.isArray(raw.items)) {
      return { version: FEEDBACK_VERSION, items: {} };
    }
    const items = {};
    for (const [key, value] of Object.entries(raw.items)) {
      if (!value || !value.mid) continue;
      const reason = Number(value.reason) === DISLIKE_REASON_CONTENT
        ? DISLIKE_REASON_CONTENT
        : DISLIKE_REASON_UP;
      items[String(key)] = {
        key: String(key),
        mid: String(value.mid),
        bvid: String(value.bvid || ''),
        aid: /^\d+$/.test(String(value.aid || '')) ? String(value.aid) : '',
        spmid: String(value.spmid || ''),
        reason,
        at: Number(value.at) || 0,
        attemptAt: Number(value.attemptAt) || 0,
        ok: !!value.ok,
        code: Number(value.code) || 0,
        message: String(value.message || '')
      };
    }
    return { version: FEEDBACK_VERSION, items };
  }

  function saveFeedbackNow() {
    const entries = Object.entries(state.feedback.items);
    if (entries.length > FEEDBACK_MAX_ENTRIES) {
      entries.sort((a, b) => {
        const atA = Math.max(a[1].at || 0, a[1].attemptAt || 0);
        const atB = Math.max(b[1].at || 0, b[1].attemptAt || 0);
        return atA - atB;
      });
      const removeCount = entries.length - FEEDBACK_MAX_ENTRIES;
      for (let i = 0; i < removeCount; i++) {
        delete state.feedback.items[entries[i][0]];
      }
    }
    lsSetJson(FEEDBACK_KEY, state.feedback);
  }

  function feedbackKey(mid, bvid, reason) {
    const target = Number(reason) === DISLIKE_REASON_CONTENT
      ? String(bvid || mid)
      : String(mid);
    return `${Number(reason) === DISLIKE_REASON_CONTENT ? DISLIKE_REASON_CONTENT : DISLIKE_REASON_UP}:${target}`;
  }

  function getFeedbackRecord(mid, bvid, reason) {
    return state.feedback.items[feedbackKey(mid, bvid, reason)] || null;
  }

  function setFeedbackRecord(record) {
    if (!record || !record.key) return;
    state.feedback.items[record.key] = record;
    saveFeedbackNow();
    if (state.panelOpen) renderCacheStats();
  }

  function isFeedbackFresh(record) {
    return !!(record && record.ok &&
      Date.now() - (Number(record.at) || 0) < FEEDBACK_TTL_MS);
  }

  function clearFeedbackCache() {
    cancelAllFeedbackTimers();
    state.feedback = { version: FEEDBACK_VERSION, items: {} };
    state.autoFeedbackCount = 0;
    state.loggedFeedback.delete('auto-limit');
    lsRemove(FEEDBACK_KEY);
    refreshFeedbackButtons();
    if (state.panelOpen) renderCacheStats();
  }

  function feedbackReason() {
    return state.settings && Number(state.settings.dislikeReason) === DISLIKE_REASON_CONTENT
      ? DISLIKE_REASON_CONTENT
      : DISLIKE_REASON_UP;
  }

  function feedbackReasonLabel(reason) {
    return Number(reason) === DISLIKE_REASON_CONTENT ? '内容不感兴趣' : '不想看此UP主';
  }

  function getCsrfToken() {
    try {
      const match = String(document.cookie || '').match(/(?:^|;\s*)bili_jct=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (e) {
      return '';
    }
  }

  function getSpmid() {
    const meta = document.querySelector('meta[name="spm_prefix"]');
    const prefix = meta && String(meta.getAttribute('content') || '').trim();
    if (prefix) {
      return prefix.split('.').length >= 4 ? prefix : `${prefix}.0.0`;
    }
    return getPageType() === 'video' ? '333.788.0.0' : '333.1007.0.0';
  }

  function cachedAidForCard(card, reason) {
    if (!card) return '';
    if (/^\d+$/.test(String(card.aid || '').trim())) return String(card.aid).trim();
    const bvid = String(card.bvid || '');
    if (bvid && state.aidCache.has(bvid)) return state.aidCache.get(bvid);
    const entry = getCacheEntry(card.mid);
    if (!entry || !Array.isArray(entry.videos)) return '';
    const exact = bvid && entry.videos.find((item) =>
      item && String(item.bvid || '').toLowerCase() === bvid.toLowerCase()
    );
    if (exact && /^\d+$/.test(String(exact.aid || ''))) {
      state.aidCache.set(bvid, String(exact.aid));
      return String(exact.aid);
    }
    // 「不想看此UP主」是 UP 级反馈，用该 UP 任意一个视频的 aid 即可。
    if (Number(reason) === DISLIKE_REASON_UP) {
      const any = entry.videos.find((item) =>
        item && /^\d+$/.test(String(item.aid || ''))
      );
      if (any) {
        if (bvid) state.aidCache.set(bvid, String(any.aid));
        return String(any.aid);
      }
    }
    return '';
  }

  async function resolveAid(card) {
    if (!card || !card.bvid) return '';
    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(card.bvid)}`;
    let res;
    try {
      res = await gmRequest({ url, anonymous: true, timeout: 10000 });
    } catch (error) {
      log('warn', `读取视频 aid 失败 ${card.bvid}`, error);
      return '';
    }
    if (res.status !== 200) {
      log('warn', `读取视频 aid 失败 ${card.bvid}：HTTP ${res.status}`);
      return '';
    }
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      log('warn', `读取视频 aid 失败 ${card.bvid}：返回不是 JSON`);
      return '';
    }
    if (Number(data && data.code) !== 0) {
      log('warn', `读取视频 aid 失败 ${card.bvid}`, {
        code: data && data.code,
        message: data && data.message
      });
      return '';
    }
    const aid = String(data.data && data.data.aid || '');
    if (!/^\d+$/.test(aid)) return '';
    state.aidCache.set(String(card.bvid), aid);
    return aid;
  }

  function buildFeedbackBody(params) {
    const fields = {
      app_id: '100',
      platform: '5',
      from_spmid: '',
      spmid: params.spmid || getSpmid(),
      goto: 'av',
      id: String(params.aid),
      mid: String(params.mid),
      track_id: '',
      feedback_page: '1',
      reason_id: String(params.reason),
      csrf: String(params.csrf || '')
    };
    return Object.entries(fields)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  async function fetchFeedbackRequest(url, body, headers) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body
    });
    if (res.type === 'opaque' || res.status === 0) {
      throw new Error('fetch 返回不可读响应');
    }
    return { status: res.status, responseText: await res.text() };
  }

  async function postFeedbackRequest(url, body) {
    const contentHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    };
    const onBilibili = /(^|\.)bilibili\.com$/i.test(location.hostname);
    // GM 请求默认带 Cookie，作为首选；如果 B 站返回参数错误/未登录，
    // 再尝试页面 fetch（它会带正确的 Origin / Referer）。
    if (typeof GM_xmlhttpRequest === 'function') {
      try {
        const res = await gmRequest({
          url,
          method: 'POST',
          data: body,
          anonymous: false,
          timeout: 12000,
          headers: contentHeaders
        });
        if (res.status === 200 && onBilibili && typeof fetch === 'function') {
          let code = null;
          try {
            const data = JSON.parse(res.responseText);
            code = Number(data && data.code);
          } catch (e) { /* ignore */ }
          const retryWithFetch = code === -400 || (code === -101 && getCsrfToken());
          if (retryWithFetch) {
            log('warn', `GM 反馈请求返回 ${code}，尝试页面 fetch 兜底`);
            return await fetchFeedbackRequest(url, body, contentHeaders);
          }
        }
        return res;
      } catch (error) {
        log('warn', 'GM 反馈请求失败，尝试页面 fetch 兜底', error);
      }
    }
    if (typeof fetch === 'function') {
      return await fetchFeedbackRequest(url, body, contentHeaders);
    }
    throw new Error('没有可用的请求方式');
  }

  function parseFeedbackResponse(res) {
    if (res.status === 412 || res.status === 429) {
      throw new ApiError(res.status, `HTTP ${res.status}`, true, res.status);
    }
    if (res.status !== 200) {
      throw new ApiError(res.status, `HTTP ${res.status}`, false, res.status);
    }
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      throw new ApiError(-1, '反馈接口返回内容不是 JSON');
    }
    const code = Number(data && data.code);
    const message = String(data && data.message || code || '反馈失败');
    if (code === 0) return { ok: true, code: 0, message };
    if (code === -101) return { ok: false, code, message, notLoggedIn: true };
    if (isRateLimitCode(code)) {
      throw new ApiError(code, message, true);
    }
    return { ok: false, code, message };
  }

  function shouldAutoDislike(decision) {
    const mode = state.settings && state.settings.autoDislike;
    if (mode === 'off' || !mode) return false;
    if (mode === 'all') return true;
    return !!(decision && decision.rule && decision.rule.type === 'up-mass-upload');
  }

  function isMidBlocked(mid) {
    const set = state.midCards.get(String(mid));
    if (!set) return false;
    for (const el of set) {
      if (!el || !el.isConnected) continue;
      const decision = String(el.dataset && el.dataset.bffDecision || '');
      if (decision.includes('"type":"block"')) return true;
    }
    return false;
  }

  function scheduleAutoDislike(card, decision) {
    if (!state.started || !shouldAutoDislike(decision)) return;
    const mid = String(card.mid || '');
    if (!mid || !card.bvid) return;
    if (state.shownMids.has(mid)) return;
    const reason = feedbackReason();
    const key = feedbackKey(mid, card.bvid, reason);
    if (state.feedbackInFlight.has(key) || state.feedbackTimers.has(key)) return;
    const record = getFeedbackRecord(mid, card.bvid, reason);
    if (isFeedbackFresh(record)) return;
    if (record && record.attemptAt &&
        Date.now() - record.attemptAt < FEEDBACK_RETRY_MS) return;
    if (!getCsrfToken()) {
      logOnce(state.loggedFeedback, 'not-logged-in',
        '未登录 B 站，自动反馈已跳过（隐藏仍然生效）');
      return;
    }
    const timer = setTimeout(() => {
      state.feedbackTimers.delete(key);
      if (!state.started || !state.settings) return;
      if (state.shownMids.has(mid)) return;
      if (!shouldAutoDislike(decision)) return;
      if (!isMidBlocked(mid)) return;
      if (state.feedbackQueue && state.feedbackQueue.pausedUntil > Date.now()) return;
      if (state.autoFeedbackCount >= MAX_AUTO_FEEDBACK_PER_SESSION) {
        logOnce(state.loggedFeedback, 'auto-limit',
          `本次会话自动反馈已达上限 ${MAX_AUTO_FEEDBACK_PER_SESSION} 个，其余请用占位卡手动反馈`);
        return;
      }
      state.autoFeedbackCount++;
      submitDislike(card, { auto: true, reason });
    }, AUTO_DISLIKE_DELAY_MS);
    state.feedbackTimers.set(key, { timer, mid, key });
    log('debug', `将在 ${AUTO_DISLIKE_DELAY_MS / 1000} 秒后自动反馈 ${card.upName || mid}`,
      { reason: feedbackReasonLabel(reason), bvid: card.bvid });
  }

  function cancelAutoDislike(mid) {
    const target = String(mid);
    for (const [key, item] of state.feedbackTimers) {
      if (String(item.mid) === target) {
        clearTimeout(item.timer);
        state.feedbackTimers.delete(key);
      }
    }
  }

  function cancelAllFeedbackTimers() {
    for (const item of state.feedbackTimers.values()) {
      clearTimeout(item.timer);
    }
    state.feedbackTimers.clear();
  }

  function submitDislike(card, options) {
    const opts = options || {};
    const mid = String(card && card.mid || '');
    const bvid = String(card && card.bvid || '');
    const reason = Number(opts.reason) === DISLIKE_REASON_CONTENT
      ? DISLIKE_REASON_CONTENT
      : DISLIKE_REASON_UP;
    if (!mid) return Promise.resolve({ ok: false, error: '缺少 UP UID' });
    const key = feedbackKey(mid, bvid, reason);
    if (state.feedbackInFlight.has(key)) return state.feedbackInFlight.get(key);

    const existing = getFeedbackRecord(mid, bvid, reason);
    if (isFeedbackFresh(existing)) {
      return Promise.resolve({ ok: true, skipped: true, record: existing });
    }
    if (!opts.manual && existing && existing.attemptAt &&
        Date.now() - existing.attemptAt < FEEDBACK_RETRY_MS) {
      return Promise.resolve({ ok: false, skipped: true, error: '等待重试' });
    }
    if (!getCsrfToken()) {
      logOnce(state.loggedFeedback, 'not-logged-in-manual',
        '未登录 B 站，无法提交不感兴趣反馈');
      return Promise.resolve({ ok: false, skipped: true, error: '未登录' });
    }
    if (state.feedbackQueue && state.feedbackQueue.pausedUntil > Date.now()) {
      return Promise.resolve({ ok: false, error: '反馈接口限流，请稍后再试' });
    }

    const run = async () => {
      let aid = cachedAidForCard(card, reason);
      if (!aid) aid = await resolveAid(card);
      if (!aid) throw new Error('未找到视频 aid');
      const spmid = getSpmid();
      const body = buildFeedbackBody({
        aid,
        mid,
        reason,
        spmid,
        csrf: getCsrfToken()
      });
      const result = parseFeedbackResponse(await postFeedbackRequest(FEEDBACK_URL, body));
      if (!result.ok) {
        const error = new ApiError(result.code || -1, result.message || '反馈失败', false);
        error.notLoggedIn = !!result.notLoggedIn;
        throw error;
      }
      const record = {
        key,
        mid,
        bvid,
        aid,
        spmid,
        reason,
        at: Date.now(),
        attemptAt: Date.now(),
        ok: true,
        code: 0,
        message: result.message || 'OK'
      };
      setFeedbackRecord(record);
      log('info', `已提交不感兴趣：${card.upName || mid}（${feedbackReasonLabel(reason)}）`, {
        aid,
        bvid
      });
      refreshFeedbackButtons(mid);
      return { ok: true, record };
    };

    const promise = (state.feedbackQueue ? state.feedbackQueue.enqueue(run) : run())
      .catch((error) => {
        const code = Number(error && error.code) || 0;
        const record = {
          key,
          mid,
          bvid,
          aid: cachedAidForCard(card, reason),
          spmid: getSpmid(),
          reason,
          at: Date.now(),
          attemptAt: Date.now(),
          ok: false,
          code,
          message: String(error && error.message || error)
        };
        setFeedbackRecord(record);
        if (error && error.rateLimited) {
          if (state.feedbackQueue) state.feedbackQueue.pause(RATE_LIMIT_PAUSE_MS);
          if (Date.now() - state.feedbackRateToastAt > RATE_LIMIT_PAUSE_MS) {
            state.feedbackRateToastAt = Date.now();
            toast('反馈接口限流，已暂停反馈 10 分钟');
          }
          log('warn', '反馈接口限流，已暂停 10 分钟', error);
        } else if (error && error.notLoggedIn) {
          logOnce(state.loggedFeedback, 'expired-login',
            'B 站登录状态失效，反馈未提交');
        } else {
          log('warn', `提交反馈失败：${card.upName || mid}`, error);
        }
        refreshFeedbackButtons(mid);
        return { ok: false, error: String(error && error.message || error), code };
      })
      .finally(() => {
        state.feedbackInFlight.delete(key);
        updateStatus();
        refreshFeedbackButtons(mid);
      });

    state.feedbackInFlight.set(key, promise);
    updateStatus();
    refreshFeedbackButtons(mid);
    return promise;
  }

  function cancelFeedbackRecord(record) {
    if (!record || !record.key || !record.aid) return Promise.resolve(false);
    const csrf = getCsrfToken();
    if (!csrf) return Promise.resolve(false);
    const run = async () => {
      const body = buildFeedbackBody({
        aid: record.aid,
        mid: record.mid,
        spmid: record.spmid,
        reason: record.reason,
        csrf
      });
      const result = parseFeedbackResponse(await postFeedbackRequest(FEEDBACK_CANCEL_URL, body));
      if (!result.ok) throw new Error(result.message || '撤销失败');
      delete state.feedback.items[record.key];
      saveFeedbackNow();
      log('info', `已撤销不感兴趣：${record.mid}`, { aid: record.aid });
      refreshFeedbackButtons(record.mid);
      return true;
    };
    return run()
      .catch((error) => {
        log('warn', `撤销反馈失败：${record.mid}`, error);
        return false;
      });
  }

  function cancelSubmittedFeedback(mid) {
    const target = String(mid);
    const records = Object.values(state.feedback.items).filter((record) =>
      record && String(record.mid) === target && isFeedbackFresh(record)
    );
    for (const record of records) {
      cancelFeedbackRecord(record);
    }
  }

  function updateFeedbackButton(button) {
    if (!button) return;
    const mid = String(button.dataset.mid || '');
    const bvid = String(button.dataset.bvid || '');
    const reason = Number(button.dataset.reason) === DISLIKE_REASON_CONTENT
      ? DISLIKE_REASON_CONTENT
      : DISLIKE_REASON_UP;
    const key = feedbackKey(mid, bvid, reason);
    const record = getFeedbackRecord(mid, bvid, reason);
    let text = '不感兴趣';
    let disabled = false;
    let title = `向 B 站提交「${feedbackReasonLabel(reason)}」`;
    if (state.feedbackInFlight.has(key)) {
      text = '反馈中…';
      disabled = true;
      title = '正在提交反馈';
    } else if (isFeedbackFresh(record)) {
      text = '已反馈';
      disabled = true;
      title = `已于 ${new Date(record.at).toLocaleString('zh-CN', { hour12: false })} 提交「${feedbackReasonLabel(reason)}」`;
    } else if (record && !record.ok) {
      text = '重试反馈';
      title = `上次反馈失败：${record.message || record.code || '未知错误'}；点击重试`;
    }
    button.textContent = text;
    button.disabled = disabled;
    button.title = title;
  }

  function refreshFeedbackButtons(mid) {
    const target = mid == null ? '' : String(mid);
    for (const overlay of document.querySelectorAll('.bff-overlay[data-mid]')) {
      if (target && overlay.dataset.mid !== target) continue;
      const button = overlay.querySelector('.bff-btn--feedback');
      if (button) updateFeedbackButton(button);
    }
  }

  function onDislike(card) {
    cancelAutoDislike(card.mid);
    submitDislike(card, { manual: true, reason: feedbackReason() }).then((result) => {
      if (result.ok && result.skipped) {
        toast(`已反馈过：${card.upName || card.mid}`);
      } else if (result.ok) {
        toast(`已反馈：${feedbackReasonLabel(feedbackReason())} · ${card.upName || card.mid}`);
      } else if (result.error === '未登录') {
        toast('请先登录 B 站，再点「不感兴趣」');
      } else if (result.error === '未找到视频 aid') {
        toast('没找到视频 aid，反馈失败');
      } else if (result.error === '反馈接口限流，请稍后再试') {
        toast('反馈接口限流，请 10 分钟后再试');
      } else if (result.error) {
        toast(`反馈失败：${result.error}`);
      }
    });
  }

  // =========================================================================
  // 请求队列
  // =========================================================================

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  class RequestQueue {
    constructor(options) {
      const opts = options || {};
      this.concurrency = Math.max(1, opts.concurrency || 1);
      this.minGap = opts.minGap || 800;
      this.maxGap = opts.maxGap || 1100;
      this.slowAfter = opts.slowAfter || 20;
      this.slowGap = opts.slowGap || 1200;
      this.tasks = [];
      this.active = 0;
      this.started = 0;
      this.batchStarted = 0;
      this.pausedUntil = 0;
      this.nextStartAt = 0;
      this.timer = 0;
    }

    get pending() {
      return this.tasks.length + this.active;
    }

    enqueue(task) {
      return new Promise((resolve, reject) => {
        this.tasks.push({ task, resolve, reject });
        updateStatus();
        this.pump();
      });
    }

    setMode(mode) {
      const next = mode || {};
      if (Number.isFinite(next.concurrency)) {
        this.concurrency = Math.max(1, Math.round(next.concurrency));
      }
      if (Number.isFinite(next.minGap)) this.minGap = next.minGap;
      if (Number.isFinite(next.maxGap)) this.maxGap = next.maxGap;
      if (Number.isFinite(next.slowAfter)) this.slowAfter = next.slowAfter;
      if (Number.isFinite(next.slowGap)) this.slowGap = next.slowGap;
      this.pump();
    }

    schedule(delay) {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = 0;
        this.pump();
      }, Math.max(0, delay));
    }

    pump() {
      if (!this.tasks.length) return;
      const now = Date.now();
      if (this.pausedUntil > now) {
        this.schedule(this.pausedUntil - now + 20);
        return;
      }
      if (now >= this.nextStartAt) {
        this.batchStarted = 0;
      }
      if (this.batchStarted >= this.concurrency) {
        if (now < this.nextStartAt) {
          this.schedule(this.nextStartAt - now + 10);
          return;
        }
        this.batchStarted = 0;
      }
      if (this.active >= this.concurrency) return;

      let startedThisPump = 0;
      while (this.tasks.length && this.active < this.concurrency &&
             this.batchStarted < this.concurrency) {
        const job = this.tasks.shift();
        this.active++;
        this.started++;
        this.batchStarted++;
        startedThisPump++;
        this.runJob(job);
      }

      if (startedThisPump > 0) {
        const gap = this.started >= this.slowAfter
          ? this.slowGap
          : this.minGap + Math.random() * Math.max(0, this.maxGap - this.minGap);
        this.nextStartAt = Date.now() + gap;
        this.schedule(this.nextStartAt - Date.now());
      } else if (this.batchStarted > 0 && now < this.nextStartAt) {
        this.schedule(this.nextStartAt - now + 10);
      }
    }

    runJob(job) {
      Promise.resolve()
        .then(() => job.task())
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          updateStatus();
          this.pump();
        });
    }

    pause(ms) {
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
      this.pump();
    }
  }

  // =========================================================================
  // 网络请求
  // =========================================================================

  class ApiError extends Error {
    constructor(code, message, rateLimited, status) {
      super(message || String(code));
      this.name = 'ApiError';
      this.code = code;
      this.rateLimited = !!rateLimited;
      this.status = status || 0;
    }
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用'));
        return;
      }
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      try {
        GM_xmlhttpRequest({
          method: options.method || 'GET',
          url: options.url,
          data: options.data,
          timeout: options.timeout || 12000,
          anonymous: options.anonymous !== false,
          headers: options.headers || { Accept: 'application/json' },
          onload: (res) => finish(resolve, res),
          onerror: () => finish(reject, new Error('网络错误')),
          ontimeout: () => finish(reject, new Error('请求超时')),
          onabort: () => finish(reject, new Error('请求取消'))
        });
      } catch (e) {
        finish(reject, e);
      }
    });
  }

  async function fetchAppPage(mid, pn) {
    const url = buildAppApiUrl(mid, { pn, ps: APP_PAGE_SIZE });
    const res = await gmRequest({ url, anonymous: true, timeout: 12000 });
    if (res.status === 412 || res.status === 429) {
      throw new ApiError(res.status, `HTTP ${res.status}`, true, res.status);
    }
    if (res.status !== 200) {
      throw new ApiError(res.status, `HTTP ${res.status}`, false, res.status);
    }
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      throw new ApiError(-1, '接口返回内容不是 JSON');
    }
    const code = Number(data && data.code);
    if (code !== 0) {
      if (code === -404) {
        return { items: [], total: 0 };
      }
      throw new ApiError(code, (data && data.message) || String(code), isRateLimitCode(code));
    }
    if (!data.data || typeof data.data !== 'object') {
      throw new ApiError(-1, 'App 投稿接口数据为空');
    }
    const list = Array.isArray(data.data.item) ? data.data.item : [];
    const total = Number(data.data && data.data.count) || 0;
    const items = [];
    for (const item of list) {
      const ctime = normalizeCtime(item && item.ctime);
      if (!ctime) continue;
      const goto = String(item.goto || '');
      const aid = (!item.is_pgc && !item.is_pugv && (goto === 'av' || !goto) &&
        /^\d+$/.test(String(item.param || '').trim()))
        ? String(item.param).trim()
        : '';
      items.push({
        bvid: String(item.bvid || ''),
        aid,
        ctime,
        live: !!item.is_live_playback,
        author: String(item.author || '')
      });
    }
    return { items, total };
  }

  async function fetchWebPage(mid, pn) {
    const url = `https://api.bilibili.com/x/space/arc/search?mid=${encodeURIComponent(mid)}&ps=${APP_PAGE_SIZE}&pn=${encodeURIComponent(pn)}&order=pubdate`;
    const res = await gmRequest({ url, anonymous: true, timeout: 12000 });
    if (res.status === 412 || res.status === 429) {
      throw new ApiError(res.status, `HTTP ${res.status}`, true, res.status);
    }
    if (res.status !== 200) {
      throw new ApiError(res.status, `HTTP ${res.status}`, false, res.status);
    }
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch (e) {
      throw new ApiError(-1, '网页空间接口返回内容不是 JSON');
    }
    const code = Number(data && data.code);
    if (code !== 0) {
      if (code === -404) return { items: [], total: 0 };
      throw new ApiError(code, (data && data.message) || String(code), isRateLimitCode(code));
    }
    if (!data.data || typeof data.data !== 'object') {
      throw new ApiError(-1, '网页空间接口数据为空');
    }
    const list = data.data.list && Array.isArray(data.data.list.vlist)
      ? data.data.list.vlist
      : [];
    const total = Number(data.data && data.data.page && data.data.page.count) || 0;
    const items = [];
    for (const item of list) {
      const ctime = normalizeCtime(item && item.created);
      if (!ctime) continue;
      const aid = /^\d+$/.test(String(item.aid || '').trim()) ? String(item.aid).trim() : '';
      items.push({
        bvid: String(item.bvid || ''),
        aid,
        ctime,
        live: !!item.is_live_playback,
        author: String(item.author || '')
      });
    }
    return { items, total };
  }

  async function fetchUpPage(mid, pn) {
    try {
      return await fetchAppPage(mid, pn);
    } catch (error) {
      if (error && error.rateLimited) throw error;
      log('warn', 'App 投稿接口失败，尝试网页空间接口', error);
      return await fetchWebPage(mid, pn);
    }
  }

  async function fetchUpHistoryWithRetry(mid, rule, fallbackName) {
    try {
      return await fetchUpHistory(mid, rule, fallbackName);
    } catch (error) {
      if (error && error.rateLimited) throw error;
      log('warn', `读取 ${fallbackName || mid} 失败，2 秒后重试一次`, error);
      await sleep(2000);
      return fetchUpHistory(mid, rule, fallbackName);
    }
  }

  async function fetchUpHistory(mid, rule, fallbackName) {
    const pages = rule.config.rolling ? 3 : 1;
    const nowSec = Math.floor(Date.now() / 1000);
    const lookbackSec = rule.config.lookbackDays * 86400;
    const videos = [];
    let total = 0;
    let pagesFetched = 0;
    let reachedEnd = false;
    let partial = false;
    let name = fallbackName || '';

    for (let pn = 1; pn <= pages; pn++) {
      let page;
      try {
        page = await fetchUpPage(mid, pn);
      } catch (e) {
        if (e && e.rateLimited) throw e;
        if (videos.length > 0) {
          partial = true;
          log('warn', `读取 ${name || mid} 第 ${pn} 页失败，使用已有数据`, e);
          break;
        }
        throw e;
      }
      pagesFetched++;
      total = page.total || total;
      if (!name && page.items[0] && page.items[0].author) name = page.items[0].author;
      for (const item of page.items) {
        videos.push({ bvid: item.bvid, aid: item.aid || '', ctime: item.ctime, live: item.live });
      }
      if (page.items.length < APP_PAGE_SIZE) {
        reachedEnd = true;
        break;
      }
      if (!rule.config.rolling) break;
      let oldest = Infinity;
      for (const video of videos) {
        if (video.ctime < oldest) oldest = video.ctime;
      }
      if (oldest < nowSec - lookbackSec) {
        reachedEnd = true;
        break;
      }
      // 第一页已经能确认达到阈值时，不需要继续翻页。
      const ctimes = videos
        .filter((video) => !(rule.config.excludeLiveReplay && video.live))
        .map((video) => video.ctime);
      if (maxInAnyWindow(ctimes, nowSec, lookbackSec, rule.config.windowHours * 3600) >= rule.config.threshold) {
        break;
      }
    }

    const seen = new Set();
    const unique = [];
    for (const video of videos) {
      const key = video.bvid || `${video.ctime}:${video.live ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(video);
    }
    unique.sort((a, b) => b.ctime - a.ctime);

    return {
      name,
      videos: unique,
      total,
      pagesFetched,
      reachedEnd,
      partial
    };
  }

  async function fetchRelation(mid) {
    const url = `https://api.bilibili.com/x/relation?fid=${encodeURIComponent(mid)}`;
    let data;
    try {
      if (typeof fetch !== 'function') throw new Error('fetch 不可用');
      const res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      const res = await gmRequest({ url, anonymous: false, timeout: 10000 });
      if (res.status === 412 || res.status === 429) {
        throw new ApiError(res.status, `HTTP ${res.status}`, true, res.status);
      }
      if (res.status !== 200) {
        throw new ApiError(res.status, `HTTP ${res.status}`, false, res.status);
      }
      data = JSON.parse(res.responseText);
    }
    const code = Number(data && data.code);
    if (code === 0) {
      const attribute = Number(data.data && data.data.attribute) || 0;
      return { followed: (attribute & 2) === 2, attribute };
    }
    if (code === -101) {
      return { followed: false, notLoggedIn: true };
    }
    throw new ApiError(code, (data && data.message) || String(code), isRateLimitCode(code));
  }

  // =========================================================================
  // 页面 / 卡片提取
  // =========================================================================

  function getPageType() {
    if (typeof window !== 'undefined' &&
        (window.__BFF_TEST_PAGE__ === 'home' || window.__BFF_TEST_PAGE__ === 'video')) {
      return window.__BFF_TEST_PAGE__;
    }
    const path = location.pathname;
    if (path === '/' || path === '/index.html') return 'home';
    if (path.startsWith('/video/')) return 'video';
    return null;
  }

  function textOf(root, selector) {
    const node = root.querySelector(selector);
    if (!node) return '';
    const title = node.getAttribute && node.getAttribute('title');
    return String(title || node.textContent || '').trim();
  }

  function extractCard(node, page) {
    const isSmall = node.classList && node.classList.contains('video-page-card-small');
    if (isSmall && node.closest('.next-play')) return null;

    let ownerLink;
    let container;
    if (isSmall) {
      ownerLink = node.querySelector('.upname a[href*="space.bilibili.com/"]') ||
        node.querySelector('a[href*="space.bilibili.com/"]');
      container = node;
    } else {
      ownerLink = node.querySelector('a.bili-video-card__info--owner[href*="space.bilibili.com/"]') ||
        node.querySelector('a[href*="space.bilibili.com/"]');
      container = node.closest('.bili-video-card__wrap') || node;
    }
    const mid = extractMidFromHref(ownerLink && ownerLink.getAttribute('href'));
    if (!mid) return null;

    const videoLink = node.querySelector('a[href*="/video/BV"]');
    const bvid = extractBvidFromHref(videoLink && videoLink.getAttribute('href'));

    let title = '';
    if (isSmall) {
      title = textOf(node, '.title');
    } else {
      title = textOf(node, '.bili-video-card__info--tit');
      if (!title) {
        const link = node.querySelector('a[href*="/video/BV"]');
        if (link) title = String(link.getAttribute('title') || link.textContent || '').trim();
      }
    }

    let upName = '';
    if (isSmall) {
      upName = textOf(node, '.upname .name') || (ownerLink ? String(ownerLink.textContent || '').trim() : '');
    } else {
      upName = textOf(node, '.bili-video-card__info--author') ||
        (ownerLink ? String(ownerLink.textContent || '').trim() : '');
    }

    let followed = null;
    if (!isSmall) {
      const iconText = node.querySelector('.bili-video-card__info--icon-text');
      if (iconText && isFollowedText(iconText.textContent)) {
        followed = true;
      } else if (page === 'home') {
        followed = false;
      }
    }

    let playText = '';
    if (isSmall) {
      const playInfo = node.querySelector('.playinfo');
      playText = playInfo ? playInfo.textContent : '';
    } else {
      const left = node.querySelector('.bili-video-card__stats--left');
      if (left) {
        playText = left.textContent;
      } else {
        const stats = node.querySelector('.bili-video-card__stats');
        playText = stats ? stats.textContent : '';
      }
    }
    const playCount = parsePlayCount(playText);

    const kind = isSmall ? 'video-small' : page === 'home' ? 'home-big' : 'video-big';
    const key = `${page}|${mid}|${bvid}|${title.slice(0, 50)}`;
    return {
      el: node,
      container,
      page,
      kind,
      mid,
      bvid,
      title,
      upName,
      followed,
      playCount,
      key
    };
  }

  function getCardNodes(page) {
    const nodes = page === 'home'
      ? document.querySelectorAll('.bili-video-card')
      : document.querySelectorAll(CARD_SELECTOR);
    const out = [];
    for (const node of nodes) {
      if (!node || !node.isConnected) continue;
      if (node.classList && node.classList.contains('video-page-card-small') &&
          node.closest('.next-play')) {
        continue;
      }
      out.push(node);
    }
    return out;
  }

  function collectCards(page) {
    const cards = [];
    for (const node of getCardNodes(page)) {
      const card = extractCard(node, page);
      if (card) cards.push(card);
    }
    return cards;
  }

  function observeCard(node) {
    if (!cardObserver || !node || !node.isConnected) return;
    if (observedCards.has(node)) return;
    observedCards.add(node);
    cardObserver.observe(node);
  }

  function handleIntersections(entries) {
    if (!state.started || !entries || !entries.length) return;
    const page = getPageType();
    if (!page) return;
    const nodes = [];
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target;
      if (node && node.isConnected) nodes.push(node);
    }
    if (!nodes.length) return;
    nodes.sort((a, b) => {
      try {
        return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      } catch (e) {
        return 0;
      }
    });
    for (const node of nodes) {
      const card = extractCard(node, page);
      if (!card) continue;
      registerCard(card);
      processCard(card);
    }
    updateStatus();
  }

  function initObservers() {
    if (typeof IntersectionObserver === 'function') {
      cardObserver = new IntersectionObserver(handleIntersections, {
        root: null,
        rootMargin: `${INTERSECT_MARGIN_PX}px 0px`,
        threshold: 0
      });
    }
    if (typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(handleMutations);
      const root = document.getElementById('app') || document.body;
      if (root) {
        mutationObserver.observe(root, { childList: true, subtree: true });
      }
    }
  }

  function handleMutations(mutations) {
    if (!mutations || !mutations.length) return;
    let hasCard = false;
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      const target = mutation.target;
      if (target && target.nodeType === 1 && target.closest &&
          target.closest('#bilibili-player, .bpx-player-container, .bpx-player-dm-wrap, .danmaku')) {
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (!node || node.nodeType !== 1) continue;
        if ((node.matches && node.matches(CARD_SELECTOR)) ||
            (node.querySelector && node.querySelector(CARD_SELECTOR))) {
          hasCard = true;
          break;
        }
      }
      if (hasCard) break;
    }
    if (!hasCard) return;
    clearTimeout(cardScanTimer);
    cardScanTimer = setTimeout(() => {
      cardScanTimer = 0;
      scanCards();
    }, 150);
  }

  function isNearViewport(el) {
    if (!el || !el.isConnected) return false;
    if (document.visibilityState === 'hidden') return false;
    let rect;
    try {
      if (!el.getClientRects().length) return false;
      rect = el.getBoundingClientRect();
    } catch (e) {
      return false;
    }
    const height = window.innerHeight || 800;
    return rect.bottom >= -INTERSECT_MARGIN_PX && rect.top <= height + INTERSECT_MARGIN_PX;
  }

  function findRuleById(id) {
    return (state.settings.rules || []).find((rule) => rule.id === id) || null;
  }

  function findRuleByType(type, action) {
    return (state.settings.rules || []).find((rule) =>
      rule.type === type && (!action || rule.action === action)
    ) || null;
  }

  function getMassRule() {
    return (state.settings.rules || []).find((rule) =>
      rule.type === 'up-mass-upload' && rule.enabled
    ) || null;
  }

  // =========================================================================
  // 卡片决定 / 占位 UI
  // =========================================================================

  function getDirectOverlay(container) {
    if (!container) return null;
    for (const child of container.children) {
      if (child.classList && child.classList.contains('bff-overlay')) return child;
    }
    return null;
  }

  function removeOverlay(container) {
    if (!container) return;
    for (const child of Array.from(container.children)) {
      if (child.classList && child.classList.contains('bff-overlay')) child.remove();
    }
  }

  function decisionKey(card, decision) {
    return JSON.stringify({
      mid: card.mid || '',
      name: card.upName || '',
      type: decision.type,
      mode: decision.mode || '',
      rule: decision.rule ? decision.rule.id : '',
      reason: decision.reason || '',
      short: decision.shortReason || '',
      autoDislike: state.settings ? state.settings.autoDislike : '',
      dislikeReason: state.settings ? state.settings.dislikeReason : '',
      scope: state.settings ? state.settings.scope : null
    });
  }

  function applyDecision(card, decision) {
    const el = card.el;
    const container = card.container;
    if (!el || !el.isConnected || !container) return;

    const key = decisionKey(card, decision);
    if (el.dataset.bffDecision === key) {
      const overlay = getDirectOverlay(container);
      const hidden = container.classList.contains('bff-hidden');
      if (decision.type === 'block') {
        if (decision.mode === 'hide' ? hidden : !!overlay) return;
      } else if (!overlay && !hidden) {
        return;
      }
    }
    el.dataset.bffDecision = key;
    if (decision.type === 'block') scheduleAutoDislike(card, decision);

    removeOverlay(container);
    container.classList.remove('bff-hidden');
    container.classList.remove('bff-relative');

    if (decision.type !== 'block') return;

    if (decision.mode === 'hide') {
      container.classList.add('bff-hidden');
      return;
    }

    const computed = getComputedStyle(container);
    if (computed.position === 'static') {
      container.classList.add('bff-relative');
    }
    const overlay = createOverlay(card, decision);
    container.appendChild(overlay);
  }

  function createOverlay(card, decision) {
    const small = card.kind === 'video-small';
    const overlay = document.createElement('div');
    overlay.className = 'bff-overlay' +
      (decision.mode === 'blur' ? ' bff-overlay--blur' : '') +
      (small ? ' bff-overlay--small' : '');
    overlay.setAttribute('role', 'note');
    overlay.dataset.mid = String(card.mid);
    overlay.addEventListener('click', (event) => event.stopPropagation());
    overlay.addEventListener('mousedown', (event) => event.stopPropagation());

    const title = document.createElement('div');
    title.className = 'bff-overlay-title';
    const isMass = decision.rule && decision.rule.type === 'up-mass-upload';
    if (isMass) {
      title.textContent = small ? '已屏蔽 · 高频投稿' : '已屏蔽高频投稿 UP';
    } else {
      title.textContent = `已屏蔽 · ${ruleLabel(decision.rule)}`;
    }

    const reason = document.createElement('div');
    reason.className = 'bff-overlay-reason';
    const name = card.upName || `UID ${card.mid}`;
    const short = decision.shortReason || decision.reason || '';
    reason.textContent = `${name} · ${short}`;
    reason.title = `${name} · ${decision.reason || short}`;

    const actions = document.createElement('div');
    actions.className = 'bff-overlay-actions';

    const feedbackBtn = document.createElement('button');
    feedbackBtn.type = 'button';
    feedbackBtn.className = 'bff-btn bff-btn--ghost bff-btn--feedback';
    feedbackBtn.dataset.mid = String(card.mid);
    feedbackBtn.dataset.bvid = card.bvid || '';
    feedbackBtn.dataset.reason = String(feedbackReason());
    feedbackBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onDislike(card);
    });
    updateFeedbackButton(feedbackBtn);

    const showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.className = 'bff-btn bff-btn--ghost';
    showBtn.textContent = small ? '显示' : '显示一次';
    showBtn.title = '本次会话临时显示这个 UP 的卡片';
    showBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onShowOnce(card);
    });

    const allowBtn = document.createElement('button');
    allowBtn.type = 'button';
    allowBtn.className = 'bff-btn bff-btn--primary';
    allowBtn.textContent = small ? '放行' : '不再屏蔽';
    allowBtn.title = '把这个 UP 加入白名单，不再自动屏蔽';
    allowBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onWhitelist(card);
    });

    actions.append(feedbackBtn, showBtn, allowBtn);
    overlay.append(title, reason, actions);
    return overlay;
  }

  function onShowOnce(card) {
    cancelAutoDislike(card.mid);
    state.shownMids.add(String(card.mid));
    onUpUpdated(card.mid);
    toast(`本次会话已显示：${card.upName || card.mid}`);
  }

  function addUidToRule(settings, ruleId, mid) {
    let rule = (settings.rules || []).find((item) => item.id === ruleId);
    if (!rule) {
      rule = {
        id: ruleId,
        type: 'uid-list',
        enabled: true,
        action: ruleId === 'whitelist' ? 'allow' : 'block',
        scope: ['home', 'video'],
        config: { uids: [], names: [] }
      };
      settings.rules.push(rule);
    }
    if (!rule.config || typeof rule.config !== 'object') {
      rule.config = { uids: [], names: [] };
    }
    const uid = String(mid);
    if (!Array.isArray(rule.config.uids)) rule.config.uids = [];
    if (!rule.config.uids.includes(uid)) rule.config.uids.push(uid);
    rule.enabled = true;
    return true;
  }

  function removeUidFromRule(settings, ruleId, mid) {
    const rule = (settings.rules || []).find((item) => item.id === ruleId);
    if (!rule || !rule.config || !Array.isArray(rule.config.uids)) return;
    rule.config.uids = rule.config.uids.filter((uid) => String(uid) !== String(mid));
  }

  function onWhitelist(card) {
    const next = deepClone(state.settings);
    addUidToRule(next, 'whitelist', card.mid);
    removeUidFromRule(next, 'blacklist', card.mid);
    state.shownMids.delete(String(card.mid));
    const result = commitSettings(next);
    if (!result.ok) {
      toast(`白名单保存失败：${result.errors[0]}`);
      return;
    }
    toast(`已加入白名单：${card.upName || card.mid}`);
  }

  // =========================================================================
  // 检查编排
  // =========================================================================

  function maybeCheckUp(card, refresh) {
    if (!card || !card.mid) return;
    if (state.queue.pausedUntil > Date.now() + 1000) return;
    if (state.failedMids.get(String(card.mid)) > Date.now()) return;
    if (state.inFlight.has(String(card.mid))) return;
    if (!isNearViewport(card.el)) return;
    const entry = getCacheEntry(card.mid);
    if (entry && !refresh) return;
    ensureUpChecked(card.mid, card.upName);
  }

  function ensureUpChecked(mid, fallbackName) {
    const key = String(mid);
    if (state.inFlight.has(key)) return;
    const version = state.configVersion;
    const promise = state.queue.enqueue(async () => {
      const rule = getMassRule();
      if (!rule) return null;
      if (version !== state.configVersion) return null;
      const entry = await fetchUpHistoryWithRetry(mid, rule, fallbackName);
      if (version !== state.configVersion) return null;
      entry.fetchedAt = Date.now();
      entry.name = entry.name || fallbackName || '';
      setCacheEntry(mid, entry);
      state.failedMids.delete(key);

      const result = evaluateMassUpload(rule, entry.videos);
      const windowText = massWindowLabel(rule);
      log('debug', `已检查 ${entry.name || mid}：${entry.videos.length} 条投稿，${windowText} 内 ${result.count} 个（阈值 ${rule.config.threshold}）${result.blocked ? '，命中' : ''}`, {
        total: entry.total,
        pages: entry.pagesFetched,
        partial: entry.partial
      });
      onUpUpdated(mid);
      return entry;
    }).catch((error) => {
      if (error && error.rateLimited) {
        state.queue.pause(RATE_LIMIT_PAUSE_MS);
        const changed = setConservativeMode('rate-limit');
        state.failedMids.set(key, Date.now() + RATE_LIMIT_PAUSE_MS);
        notifyRateLimit(error, changed);
      } else {
        state.failedMids.set(key, Date.now() + RETRY_MS);
        log('warn', `检查 ${fallbackName || mid} 失败`, error);
      }
      return null;
    }).finally(() => {
      state.inFlight.delete(key);
      updateStatus();
    });
    state.inFlight.set(key, promise);
    updateStatus();
    return promise;
  }

  function notifyRateLimit(error, changedMode) {
    const now = Date.now();
    if (now - state.rateLimitToastAt > RATE_LIMIT_PAUSE_MS) {
      state.rateLimitToastAt = now;
      toast(changedMode
        ? 'B站接口限流，已暂停 10 分钟并切换到保守模式'
        : 'B站接口限流，已暂停自动检查 10 分钟');
    }
    log('warn', '接口限流，暂停检查', error);
  }

  function onUpUpdated(mid) {
    const set = state.midCards.get(String(mid));
    if (!set) return;
    const page = getPageType();
    if (!page) return;
    for (const el of Array.from(set)) {
      if (!el.isConnected) {
        set.delete(el);
        continue;
      }
      const card = extractCard(el, page);
      if (card) processCard(card);
    }
  }

  function ensureRelationChecked(mid) {
    const key = String(mid);
    if (state.relationInFlight.has(key)) return;
    if (state.failedRelation.get(key) > Date.now()) return;
    if (getRelationEntry(mid)) return;
    if (state.relationQueue.pausedUntil > Date.now() + 1000) return;

    const promise = state.relationQueue.enqueue(() => fetchRelation(mid)).then((relation) => {
      setRelationEntry(mid, relation.followed, relation.notLoggedIn);
      state.failedRelation.delete(key);
      onRelationUpdated(mid);
      return relation;
    }).catch((error) => {
      state.failedRelation.set(key, Date.now() + RETRY_MS);
      if (error && error.rateLimited) {
        state.relationQueue.pause(RATE_LIMIT_PAUSE_MS);
        log('warn', '关注状态接口限流，暂停检查', error);
      } else {
        log('warn', `关注状态检查失败 ${mid}`, error);
      }
      onRelationUpdated(mid);
      return null;
    }).finally(() => {
      state.relationInFlight.delete(key);
      updateStatus();
    });
    state.relationInFlight.set(key, promise);
    updateStatus();
    return promise;
  }

  function onRelationUpdated(mid) {
    const set = state.midCards.get(String(mid));
    if (!set) return;
    const page = getPageType();
    if (!page) return;
    for (const el of Array.from(set)) {
      if (!el.isConnected) {
        set.delete(el);
        continue;
      }
      const card = extractCard(el, page);
      if (card) processCard(card);
    }
  }

  function registerCard(card) {
    const key = String(card.mid);
    let set = state.midCards.get(key);
    if (!set) {
      set = new Set();
      state.midCards.set(key, set);
    }
    set.add(card.el);
  }

  function cleanupMidCards() {
    for (const [mid, set] of state.midCards) {
      for (const el of set) {
        if (!el.isConnected) set.delete(el);
      }
      if (!set.size) state.midCards.delete(mid);
    }
  }

  function logOnce(set, key, message) {
    if (!set || set.has(key)) return;
    set.add(key);
    log('debug', message);
  }

  function massWindowLabel(rule) {
    return rule.config.rolling
      ? `近${rule.config.lookbackDays}天任意${rule.config.windowHours}h`
      : `${rule.config.windowHours}h`;
  }

  function processCard(card) {
    if (!card || !card.el || !card.el.isConnected) return;

    const show = (reason) => applyDecision(card, { type: 'show', reason });

    if (!state.settings.enabled) return show('disabled');
    if (!state.settings.scope[card.page]) return show('scope');
    if (state.sessionShowAll) return show('session-show-all');
    // 「显示一次」是会话级覆盖，应优先于所有屏蔽规则（包括关键词/UID/低播放）。
    if (state.shownMids.has(String(card.mid))) return show('shown-once');

    const staticDecision = evaluateStaticRules(card, state.settings.rules, card.page);
    if (staticDecision.decision === 'allow') {
      logOnce(state.loggedStatic, `allow:${card.mid}`,
        `放行规则命中 ${card.upName || card.mid}：${staticDecision.reason || 'allow'}`);
      return show(staticDecision.reason || 'allow');
    }
    if (staticDecision.decision === 'block') {
      return applyDecision(card, {
        type: 'block',
        mode: state.settings.displayMode,
        rule: staticDecision.rule,
        reason: staticDecision.reason,
        shortReason: staticDecision.reason
      });
    }

    const massRule = getMassRule();
    if (!massRule || !ruleAppliesToPage(massRule, card.page)) {
      return show('no-mass-rule');
    }

    const entry = getCacheEntry(card.mid);
    if (entry) {
      const result = evaluateMassUpload(massRule, entry.videos);
      const refresh = shouldRefreshEntry(entry, massRule);
      const windowText = massWindowLabel(massRule);
      logOnce(state.loggedCache, `${card.mid}:${entry.fetchedAt}`,
        `缓存命中 ${card.upName || card.mid}：${windowText} 内 ${result.count} 个（阈值 ${massRule.config.threshold}）${result.blocked ? '，命中' : ''}${refresh ? '，后台刷新' : ''}`);

      if (result.blocked && massRule.config.skipFollowed) {
        if (card.followed === true) {
          logOnce(state.loggedFollowed, `followed:${card.mid}`,
            `已关注，跳过 ${card.upName || card.mid}（${result.count}/${massRule.config.threshold}）`);
          maybeCheckUp(card, refresh);
          return show('followed');
        }
        if (card.followed == null && massRule.config.videoFollowedCheck) {
          const relation = getRelationEntry(card.mid);
          if (relation && relation.followed) {
            logOnce(state.loggedFollowed, `followed:${card.mid}`,
              `已关注，跳过 ${card.upName || card.mid}（${result.count}/${massRule.config.threshold}）`);
            maybeCheckUp(card, refresh);
            return show('followed');
          }
          if (!relation && !(state.failedRelation.get(String(card.mid)) > Date.now())) {
            ensureRelationChecked(card.mid);
            maybeCheckUp(card, refresh);
            return show('checking-followed');
          }
        }
      }
      maybeCheckUp(card, refresh);
      if (result.blocked) {
        return applyDecision(card, {
          type: 'block',
          mode: state.settings.displayMode,
          rule: massRule,
          reason: result.reason,
          shortReason: result.shortReason,
          count: result.count
        });
      }
      return show('not-flagged');
    }

    maybeCheckUp(card, true);
    return show('checking');
  }

  function scanCards() {
    if (!state.started) return;
    try {
      const page = getPageType();
      if (!page) return;
      const nodes = getCardNodes(page);
      const visible = [];
      for (const node of nodes) {
        observeCard(node);
        // 被「完全隐藏」模式藏起来的卡片已经不可见，但设置切换时仍必须重新处理，
        // 否则从隐藏切回占位/关闭时会一直消失。
        const hiddenByUs = !!(node.closest && node.closest('.bff-hidden'));
        if (isNearViewport(node) || hiddenByUs) visible.push(node);
      }
      visible.sort((a, b) => {
        try {
          return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
        } catch (e) {
          return 0;
        }
      });
      for (const node of visible) {
        const card = extractCard(node, page);
        if (!card) continue;
        registerCard(card);
        processCard(card);
      }
      cleanupMidCards();
      updateStatus();
    } catch (error) {
      log('error', '扫描页面卡片失败', error);
    }
  }

  function commitSettings(nextSettings) {
    const validation = validateRules(nextSettings.rules);
    if (!validation.ok) {
      log('warn', '规则校验失败', validation.errors);
      return { ok: false, errors: validation.errors };
    }
    const oldMassKey = state.settings ? massConfigKey(state.settings) : 'none';
    const newMassKey = massConfigKey(nextSettings);
    const displayMode = ['placeholder', 'hide', 'blur'].includes(nextSettings.displayMode)
      ? nextSettings.displayMode
      : 'placeholder';
    const cleaned = {
      ...nextSettings,
      version: 1,
      enabled: nextSettings.enabled !== false,
      scope: {
        home: !nextSettings.scope || nextSettings.scope.home !== false,
        video: !nextSettings.scope || nextSettings.scope.video !== false
      },
      displayMode,
      showFab: nextSettings.showFab !== false,
      debug: !!nextSettings.debug,
      conservative: nextSettings.conservative === true,
      autoDislike: ['mass', 'all', 'off'].includes(nextSettings.autoDislike) ? nextSettings.autoDislike : 'mass',
      dislikeReason: Number(nextSettings.dislikeReason) === DISLIKE_REASON_CONTENT ? DISLIKE_REASON_CONTENT : DISLIKE_REASON_UP,
      rules: validation.rules
    };
    const oldAutoDislike = state.settings ? state.settings.autoDislike : 'mass';
    const oldDislikeReason = state.settings ? state.settings.dislikeReason : DISLIKE_REASON_UP;
    const oldEnabled = state.settings ? state.settings.enabled : true;
    const oldScopeKey = state.settings ? JSON.stringify(state.settings.scope) : '';
    const oldWhitelist = whitelistUids(state.settings);
    const newWhitelist = whitelistUids(cleaned);
    if (oldMassKey !== newMassKey) {
      clearUpCache();
      state.configVersion++;
      state.failedMids.clear();
    }
    if (oldAutoDislike !== cleaned.autoDislike ||
        oldDislikeReason !== cleaned.dislikeReason ||
        oldEnabled !== cleaned.enabled ||
        oldScopeKey !== JSON.stringify(cleaned.scope) ||
        oldMassKey !== newMassKey) {
      cancelAllFeedbackTimers();
    }
    if (oldAutoDislike !== cleaned.autoDislike ||
        oldDislikeReason !== cleaned.dislikeReason) {
      state.autoFeedbackCount = 0;
      state.loggedFeedback.delete('auto-limit');
    }
    state.settings = cleaned;
    state.stateVersion++;
    saveSettings();
    applyQueueMode();
    if (ui.fab) ui.fab.hidden = !cleaned.showFab;
    if (ui.autoDislike) ui.autoDislike.value = cleaned.autoDislike;
    if (ui.dislikeReason) ui.dislikeReason.value = String(cleaned.dislikeReason);
    if (ui.conservative) ui.conservative.checked = cleaned.conservative;
    scanCards();
    for (const uid of newWhitelist) {
      if (oldWhitelist.has(uid)) continue;
      cancelAutoDislike(uid);
      cancelSubmittedFeedback(uid);
    }
    if (state.panelOpen) renderPanel();
    return { ok: true, settings: cleaned };
  }

  function applyQueueMode() {
    if (!state.queue) return;
    const conservative = !!(state.settings && state.settings.conservative);
    state.queue.setMode({
      concurrency: conservative ? 1 : 2,
      minGap: conservative ? 1500 : 800,
      maxGap: conservative ? 1700 : 1100,
      slowAfter: 20,
      slowGap: conservative ? 1500 : 1200
    });
    if (state.relationQueue) {
      state.relationQueue.setMode({
        concurrency: 1,
        minGap: 800,
        maxGap: 1100,
        slowAfter: 1000,
        slowGap: 1200
      });
    }
    if (state.feedbackQueue) {
      state.feedbackQueue.setMode({
        concurrency: 1,
        minGap: conservative ? 1500 : 1000,
        maxGap: conservative ? 1900 : 1400,
        slowAfter: 10,
        slowGap: conservative ? 2200 : 1800
      });
    }
  }

  function setConservativeMode(reason) {
    if (!state.settings || state.settings.conservative) return false;
    state.settings.conservative = true;
    saveSettings();
    applyQueueMode();
    if (ui.conservative) ui.conservative.checked = true;
    log('warn', '已自动切换到保守模式', { reason });
    return true;
  }

  // =========================================================================
  // 文档样式（占位卡）
  // =========================================================================

  function addStyle(css) {
    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle(css);
        return;
      }
    } catch (e) { /* fall through */ }
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectDocumentStyles() {
    addStyle(`
      .bff-relative { position: relative !important; }
      .bff-hidden { display: none !important; }
      .bff-overlay {
        position: absolute !important;
        inset: 0 !important;
        z-index: 9999 !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 8px !important;
        padding: 12px !important;
        background: var(--bg1, #fff) !important;
        color: var(--text1, #18191c) !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif !important;
        text-align: center !important;
        border-radius: inherit !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
      }
      .bff-overlay--blur {
        background: rgba(0, 0, 0, .34) !important;
        backdrop-filter: blur(8px) !important;
        -webkit-backdrop-filter: blur(8px) !important;
        color: #fff !important;
      }
      .bff-overlay--small {
        align-items: flex-start !important;
        justify-content: center !important;
        padding: 8px 10px !important;
        gap: 3px !important;
        text-align: left !important;
      }
      .bff-overlay-title {
        font-size: 14px !important;
        font-weight: 600 !important;
        line-height: 1.35 !important;
        max-width: 100% !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .bff-overlay--small .bff-overlay-title { font-size: 12px !important; }
      .bff-overlay-reason {
        font-size: 12px !important;
        color: var(--text3, #9499a0) !important;
        line-height: 1.35 !important;
        max-width: 100% !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .bff-overlay--blur .bff-overlay-reason { color: rgba(255, 255, 255, .82) !important; }
      .bff-overlay--small .bff-overlay-reason { font-size: 11px !important; }
      .bff-overlay-actions {
        display: flex !important;
        gap: 8px !important;
        margin-top: 2px !important;
        flex-wrap: wrap !important;
        justify-content: center !important;
      }
      .bff-overlay--small .bff-overlay-actions {
        gap: 6px !important;
        margin-top: 1px !important;
        justify-content: flex-start !important;
      }
      .bff-btn {
        all: unset !important;
        box-sizing: border-box !important;
        cursor: pointer !important;
        font-size: 12px !important;
        line-height: 1 !important;
        padding: 6px 10px !important;
        border-radius: 6px !important;
        border: 1px solid transparent !important;
        font-family: inherit !important;
      }
      .bff-overlay--small .bff-btn { font-size: 11px !important; padding: 4px 7px !important; }
      .bff-btn--primary { background: var(--brand_blue, #00aeec) !important; color: #fff !important; }
      .bff-btn--primary:hover { filter: brightness(1.08) !important; }
      .bff-btn:disabled { opacity: .58 !important; cursor: default !important; }
      .bff-btn--feedback { border-color: var(--line_regular, #e3e5e7) !important; }
      .bff-btn--ghost {
        background: transparent !important;
        color: inherit !important;
        border-color: var(--line_regular, #e3e5e7) !important;
      }
      .bff-overlay--blur .bff-btn--ghost {
        color: #fff !important;
        border-color: rgba(255, 255, 255, .5) !important;
      }
    `);
  }

  // =========================================================================
  // 设置面板
  // =========================================================================

  const PANEL_CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .fab {
      position: fixed;
      left: 18px;
      bottom: 88px;
      z-index: 2147483647;
      width: 38px;
      height: 38px;
      border: none;
      border-radius: 50%;
      background: var(--brand_blue, #00aeec);
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .22);
      opacity: .58;
      transition: opacity .2s, transform .2s;
      pointer-events: auto;
    }
    .fab:hover { opacity: 1; transform: scale(1.05); }
    .panel {
      position: fixed;
      top: 76px;
      right: 18px;
      z-index: 2147483647;
      width: 430px;
      max-width: calc(100vw - 36px);
      max-height: calc(100vh - 110px);
      display: flex;
      flex-direction: column;
      background: var(--bg1, #fff);
      color: var(--text1, #18191c);
      border: 1px solid var(--line_regular, #e3e5e7);
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .2);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      overflow: hidden;
      pointer-events: auto;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px 12px;
      border-bottom: 1px solid var(--line_regular, #e3e5e7);
    }
    .title { font-size: 16px; font-weight: 600; line-height: 1.3; }
    .subtitle { margin-top: 3px; font-size: 11px; color: var(--text3, #9499a0); }
    .icon-btn {
      border: none;
      background: transparent;
      color: var(--text2, #61666d);
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      padding: 0 2px;
    }
    .icon-btn:hover { color: var(--text1, #18191c); }
    .tabs {
      display: flex;
      gap: 2px;
      padding: 6px 12px 0;
      border-bottom: 1px solid var(--line_regular, #e3e5e7);
    }
    .bff-tab {
      border: none;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: var(--text2, #61666d);
      padding: 8px 10px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .bff-tab:hover { color: var(--text1, #18191c); }
    .bff-tab.active {
      color: var(--brand_blue, #00aeec);
      border-bottom-color: var(--brand_blue, #00aeec);
    }
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 14px 16px 18px;
    }
    section {
      margin: 0 0 15px;
      padding: 0 0 13px;
      border-bottom: 1px dashed var(--line_regular, #e3e5e7);
    }
    section:last-of-type { border-bottom: none; padding-bottom: 0; }
    h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 7px 0;
      font-size: 12px;
      color: var(--text2, #61666d);
      cursor: pointer;
    }
    .row input[type="checkbox"] {
      width: 15px;
      height: 15px;
      margin: 0;
      accent-color: var(--brand_blue, #00aeec);
      cursor: pointer;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 7px 0;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      color: var(--text2, #61666d);
    }
    .field > span { padding-left: 1px; }
    input[type="number"],
    input[type="text"],
    textarea,
    select {
      width: 100%;
      margin: 0;
      padding: 7px 8px;
      border: 1px solid var(--line_regular, #e3e5e7);
      border-radius: 6px;
      background: var(--bg2, #f6f7f8);
      color: var(--text1, #18191c);
      font-size: 12px;
      line-height: 1.4;
      font-family: inherit;
      outline: none;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--brand_blue, #00aeec);
    }
    textarea {
      min-height: 58px;
      resize: vertical;
      font-family: inherit;
    }
    .hint {
      margin: 4px 0 0;
      font-size: 11px;
      line-height: 1.55;
      color: var(--text3, #9499a0);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    button.primary, button.ghost, button.danger {
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 7px 12px;
      font-size: 12px;
      line-height: 1.2;
      font-family: inherit;
      cursor: pointer;
    }
    button.primary {
      background: var(--brand_blue, #00aeec);
      color: #fff;
    }
    button.ghost {
      background: transparent;
      border-color: var(--line_regular, #e3e5e7);
      color: var(--text1, #18191c);
    }
    button.danger {
      background: transparent;
      border-color: #f56c6c;
      color: #f56c6c;
    }
    button:hover { filter: brightness(1.04); }
    .error {
      margin-top: 9px;
      padding: 8px 10px;
      border-radius: 6px;
      background: #fff0f0;
      color: #d03050;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .cache-stats {
      margin-bottom: 6px;
      font-size: 12px;
      line-height: 1.6;
      color: var(--text2, #61666d);
    }
    pre.log {
      margin: 10px 0 0;
      padding: 8px;
      max-height: 240px;
      overflow: auto;
      border-radius: 6px;
      background: var(--bg2, #f6f7f8);
      color: var(--text2, #61666d);
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .modal {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(0, 0, 0, .45);
      pointer-events: auto;
    }
    .modal-card {
      width: min(760px, 100%);
      height: min(720px, 90vh);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-radius: 12px;
      background: var(--bg1, #fff);
      color: var(--text1, #18191c);
      box-shadow: 0 18px 60px rgba(0, 0, 0, .32);
    }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line_regular, #e3e5e7);
      font-size: 14px;
      font-weight: 600;
    }
    #bff-json-text {
      flex: 1;
      width: 100%;
      min-height: 0;
      padding: 12px;
      border: none;
      border-radius: 0;
      background: var(--bg2, #f6f7f8);
      color: var(--text1, #18191c);
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.5;
      resize: none;
      outline: none;
    }
    .modal .actions {
      margin: 0;
      padding: 10px 16px;
      border-top: 1px solid var(--line_regular, #e3e5e7);
    }
    .modal .error { margin: 0 16px 10px; }
    .about { font-size: 12px; line-height: 1.8; color: var(--text2, #61666d); }
    .about strong { color: var(--text1, #18191c); }
    .status {
      position: fixed;
      left: 18px;
      bottom: 136px;
      z-index: 2147483647;
      max-width: 280px;
      padding: 6px 10px;
      border: 1px solid var(--line_regular, #e3e5e7);
      border-radius: 999px;
      background: var(--bg1, #fff);
      color: var(--text2, #61666d);
      font-size: 11px;
      line-height: 1.35;
      box-shadow: 0 4px 14px rgba(0, 0, 0, .12);
      pointer-events: none;
    }
    .toast {
      position: fixed;
      left: 18px;
      bottom: 174px;
      z-index: 2147483647;
      max-width: 360px;
      padding: 9px 12px;
      border-radius: 8px;
      background: rgba(0, 0, 0, .82);
      color: #fff;
      font-size: 12px;
      line-height: 1.45;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .24);
      pointer-events: none;
    }
  `;

  const PANEL_HTML = `
    <button id="bff-fab" class="fab" type="button" title="B站推荐流屏蔽设置">屏</button>
    <div id="bff-status" class="status" hidden></div>
    <div id="bff-toast" class="toast" hidden></div>

    <div id="bff-panel" class="panel" hidden>
      <div class="header">
        <div>
          <div class="title">B站推荐流屏蔽</div>
          <div class="subtitle">本地过滤 · 反馈可关</div>
        </div>
        <button id="bff-close" class="icon-btn" type="button" title="关闭">×</button>
      </div>

      <div class="tabs" role="tablist">
        <button class="bff-tab active" data-tab="rules" type="button">规则</button>
        <button class="bff-tab" data-tab="display" type="button">显示</button>
        <button class="bff-tab" data-tab="cache" type="button">缓存 / 日志</button>
        <button class="bff-tab" data-tab="about" type="button">关于</button>
      </div>

      <div id="bff-tab-rules" class="content">
        <section>
          <label class="row"><input type="checkbox" id="bff-enabled"> 启用脚本</label>
          <p class="hint">关闭后会立即显示所有已屏蔽卡片，但不会清空规则和缓存。</p>
        </section>

        <section>
          <h3>高频投稿</h3>
          <label class="row"><input type="checkbox" id="bff-mass-enabled"> 启用这条规则</label>
          <div class="grid">
            <label class="field"><span>阈值（个）</span><input id="bff-threshold" type="number" min="2" max="20" step="1"></label>
            <label class="field"><span>窗口（小时）</span><input id="bff-window" type="number" min="1" max="168" step="1"></label>
          </div>
          <label class="row"><input type="checkbox" id="bff-rolling"> 使用「近期任意窗口」统计</label>
          <div class="grid">
            <label class="field"><span>回溯（天）</span><input id="bff-lookback" type="number" min="1" max="7" step="1"></label>
          </div>
          <label class="row"><input type="checkbox" id="bff-exclude-live"> 排除直播回放</label>
          <label class="row"><input type="checkbox" id="bff-skip-followed"> 跳过已关注 UP</label>
          <label class="row"><input type="checkbox" id="bff-video-followed"> 视频页用 B 站关系接口判断关注</label>
          <p class="hint">默认统计最近 24 小时 ≥5 个公开投稿。关闭「使用近期任意窗口」时只看当前窗口；开启后检查最近若干天内是否出现过一次密集投稿。</p>
        </section>

        <section>
          <h3>白名单关键词</h3>
          <label class="row"><input type="checkbox" id="bff-kw-allow-enabled"> 启用这条规则</label>
          <textarea id="bff-keywords-allow" rows="3" placeholder="一行一个，例如：官方、发布会"></textarea>
          <label class="row"><input type="checkbox" id="bff-allow-match-title"> 匹配标题</label>
          <label class="row"><input type="checkbox" id="bff-allow-match-upname"> 匹配 UP 名</label>
          <label class="row"><input type="checkbox" id="bff-allow-regex"> 按正则表达式匹配</label>
          <p class="hint">命中后直接显示卡片，优先于高频投稿、黑名单、关键词和低播放。适合放行「官方」「发布会」等标题。</p>
        </section>

        <section>
          <h3>关键词</h3>
          <label class="row"><input type="checkbox" id="bff-kw-enabled"> 启用这条规则</label>
          <textarea id="bff-keywords" rows="3" placeholder="一行一个关键词，例如：营销号"></textarea>
          <label class="row"><input type="checkbox" id="bff-match-title"> 匹配标题</label>
          <label class="row"><input type="checkbox" id="bff-match-upname"> 匹配 UP 名</label>
          <label class="row"><input type="checkbox" id="bff-regex"> 按正则表达式匹配</label>
          <p class="hint">普通模式不区分英文大小写；正则模式请自行注意性能。</p>
        </section>

        <section>
          <h3>指定 UP</h3>
          <label class="field"><span>白名单 UID（一行一个）</span><textarea id="bff-whitelist" rows="2" placeholder="25876945"></textarea></label>
          <label class="field" style="margin-top:8px"><span>黑名单 UID（一行一个）</span><textarea id="bff-blacklist" rows="2" placeholder="123456"></textarea></label>
          <p class="hint">可粘贴 UID、空间链接或「UID:123」；白名单优先于所有屏蔽规则。占位卡上的「不再屏蔽」会自动添加到这里。</p>
        </section>

        <section>
          <h3>低播放</h3>
          <label class="row"><input type="checkbox" id="bff-play-enabled"> 启用这条规则</label>
          <div class="grid">
            <label class="field"><span>最低播放</span><input id="bff-play-min" type="number" min="0" step="1"></label>
            <label class="field"><span>最高播放</span><input id="bff-play-max" type="number" min="0" step="1"></label>
          </div>
          <p class="hint">按卡片上显示的播放数近似判断（支持「万 / 亿」），不是精确接口数据。部分开启 VT 的卡片可能显示其它指标，此时结果可能不准确。</p>
        </section>

        <div class="actions">
          <button id="bff-save-rules" class="primary" type="button">保存设置</button>
          <button id="bff-reset-rules" class="ghost" type="button">恢复默认规则</button>
          <button id="bff-open-json" class="ghost" type="button">编辑完整 JSON</button>
        </div>
        <div id="bff-form-error" class="error" hidden></div>
      </div>

      <div id="bff-tab-display" class="content" hidden>
        <section>
          <h3>显示</h3>
          <label class="field"><span>命中规则后的样式</span>
            <select id="bff-display-mode">
              <option value="placeholder">占位提示（推荐）</option>
              <option value="hide">完全隐藏</option>
              <option value="blur">模糊遮罩</option>
            </select>
          </label>
          <p class="hint">占位提示会保持页面排版不跳动；完全隐藏会让卡片直接消失。</p>
        </section>
        <section>
          <h3>生效页面</h3>
          <label class="row"><input type="checkbox" id="bff-scope-home"> 首页推荐</label>
          <label class="row"><input type="checkbox" id="bff-scope-video"> 视频页相关推荐</label>
          <p class="hint">视频页只处理右侧「相关推荐」和页面内推荐卡片，不动播放器、UP 头部和「接下来播放」。</p>
        </section>
        <section>
          <h3>不感兴趣反馈</h3>
          <label class="field"><span>自动反馈</span>
            <select id="bff-auto-dislike">
              <option value="mass">仅高频投稿命中时（推荐）</option>
              <option value="all">所有屏蔽规则命中时</option>
              <option value="off">不自动，只在占位卡手动点</option>
            </select>
          </label>
          <label class="field"><span>反馈理由</span>
            <select id="bff-dislike-reason">
              <option value="4">不想看此 UP 主（推荐）</option>
              <option value="1">内容不感兴趣</option>
            </select>
          </label>
          <p class="hint">需要登录 B 站。命中后等待 5 秒再提交，期间点「显示一次」或「不再屏蔽」会取消；同一 UP / 视频 24 小时最多自动提交一次。反馈会真实影响 B 站推荐。</p>
        </section>
        <section>
          <h3>请求</h3>
          <label class="row"><input type="checkbox" id="bff-conservative"> 保守模式（1 并发 1.5 秒）</label>
          <p class="hint">默认每批最多 2 个请求、批间隔 0.8 秒；保守模式限流风险更低。遇到限流会自动切到保守模式。</p>
        </section>
        <section>
          <h3>其他</h3>
          <label class="row"><input type="checkbox" id="bff-show-fab"> 显示悬浮按钮（首页左下 / 视频页右下）</label>
          <label class="row"><input type="checkbox" id="bff-debug"> 输出调试日志</label>
          <p class="hint">隐藏悬浮按钮后，可通过油猴菜单「打开设置面板」重新打开。</p>
        </section>
        <div class="actions">
          <button id="bff-save-display" class="primary" type="button">保存显示设置</button>
        </div>
      </div>

      <div id="bff-tab-cache" class="content" hidden>
        <div id="bff-cache-stats" class="cache-stats"></div>
        <div class="actions">
          <button id="bff-clear-cache" class="ghost" type="button">清空 UP 缓存</button>
          <button id="bff-clear-relation" class="ghost" type="button">清空关注缓存</button>
          <button id="bff-clear-feedback" class="ghost" type="button" title="只清空本地记录，不会撤销已提交给 B 站的反馈">清空反馈记录</button>
          <button id="bff-recheck" class="ghost" type="button">重新检查当前页</button>
          <button id="bff-toggle-showall" class="ghost" type="button">临时显示全部</button>
          <button id="bff-copy-log" class="ghost" type="button">复制日志</button>
        </div>
        <pre id="bff-log" class="log">(暂无日志)</pre>
      </div>

      <div id="bff-tab-about" class="content" hidden>
        <div class="about">
          <p><strong>B站推荐流高频投稿屏蔽</strong><br>版本 1.2.1</p>
          <p>数据只在本机处理。高频投稿查询通过 B 站 App 公开接口匿名读取，只发送 UP 的 UID，不需要登录。视频页里已命中高频规则的卡片如果没有关注标识，会带 Cookie 调用一次 B 站关系接口，仅用于决定是否豁免。</p>
          <p>命中屏蔽后，默认等待 5 秒再向 B 站提交「不想看此UP主」反馈，让推荐系统收到信号；可在「显示 → 不感兴趣反馈」里关闭或改为所有规则。反馈需要登录，只把视频 aid、UP UID、CSRF 等反馈参数发送给 B 站，不发给第三方。</p>
          <p>反馈失败不会影响本地隐藏；本地隐藏也不会自动关注、点赞或投币。</p>
          <p>非官方接口可能随 B 站改版失效；投稿频率接口失效时会自动退化为不屏蔽。视频页关注状态接口失败时按未关注处理，仍可能屏蔽已确认高频的 UP。</p>
          <p>规则说明和示例配置见项目内的 README.md 与 rules.example.json。</p>
        </div>
      </div>
    </div>

    <div id="bff-json-modal" class="modal" hidden>
      <div class="modal-card">
        <div class="modal-head">
          <span>完整规则 JSON</span>
          <button id="bff-json-close" class="icon-btn" type="button" title="关闭">×</button>
        </div>
        <textarea id="bff-json-text" spellcheck="false"></textarea>
        <div id="bff-json-error" class="error" hidden></div>
        <div class="actions">
          <button id="bff-json-save" class="primary" type="button">校验并保存</button>
          <button id="bff-json-format" class="ghost" type="button">格式化</button>
          <button id="bff-json-export" class="ghost" type="button">导出文件</button>
          <button id="bff-json-import" class="ghost" type="button">导入文件</button>
          <input id="bff-json-file" type="file" accept=".json,application/json" hidden>
        </div>
      </div>
    </div>
  `;

  function initPanel() {
    if (document.getElementById('bff-host')) return;
    const host = document.createElement('div');
    host.id = 'bff-host';
    host.style.cssText = 'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
    (document.body || document.documentElement).appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = `<style>${PANEL_CSS}</style>${PANEL_HTML}`;

    const $ = (id) => shadowRoot.getElementById(id);
    ui.fab = $('bff-fab');
    ui.status = $('bff-status');
    ui.toast = $('bff-toast');
    ui.panel = $('bff-panel');
    ui.close = $('bff-close');
    ui.tabButtons = Array.from(shadowRoot.querySelectorAll('.bff-tab'));
    ui.tabContents = {
      rules: $('bff-tab-rules'),
      display: $('bff-tab-display'),
      cache: $('bff-tab-cache'),
      about: $('bff-tab-about')
    };
    ui.currentTab = 'rules';

    ui.enabled = $('bff-enabled');
    ui.massEnabled = $('bff-mass-enabled');
    ui.threshold = $('bff-threshold');
    ui.window = $('bff-window');
    ui.rolling = $('bff-rolling');
    ui.lookback = $('bff-lookback');
    ui.excludeLive = $('bff-exclude-live');
    ui.skipFollowed = $('bff-skip-followed');
    ui.videoFollowed = $('bff-video-followed');
    ui.kwAllowEnabled = $('bff-kw-allow-enabled');
    ui.keywordsAllow = $('bff-keywords-allow');
    ui.allowMatchTitle = $('bff-allow-match-title');
    ui.allowMatchUpName = $('bff-allow-match-upname');
    ui.allowRegex = $('bff-allow-regex');
    ui.kwEnabled = $('bff-kw-enabled');
    ui.keywords = $('bff-keywords');
    ui.matchTitle = $('bff-match-title');
    ui.matchUpName = $('bff-match-upname');
    ui.regex = $('bff-regex');
    ui.whitelist = $('bff-whitelist');
    ui.blacklist = $('bff-blacklist');
    ui.playEnabled = $('bff-play-enabled');
    ui.playMin = $('bff-play-min');
    ui.playMax = $('bff-play-max');
    ui.saveRules = $('bff-save-rules');
    ui.resetRules = $('bff-reset-rules');
    ui.openJson = $('bff-open-json');
    ui.formError = $('bff-form-error');
    ui.displayMode = $('bff-display-mode');
    ui.scopeHome = $('bff-scope-home');
    ui.scopeVideo = $('bff-scope-video');
    ui.showFab = $('bff-show-fab');
    ui.autoDislike = $('bff-auto-dislike');
    ui.dislikeReason = $('bff-dislike-reason');
    ui.conservative = $('bff-conservative');
    ui.debug = $('bff-debug');
    ui.saveDisplay = $('bff-save-display');
    ui.cacheStats = $('bff-cache-stats');
    ui.clearCache = $('bff-clear-cache');
    ui.clearRelation = $('bff-clear-relation');
    ui.clearFeedback = $('bff-clear-feedback');
    ui.recheck = $('bff-recheck');
    ui.toggleShowAll = $('bff-toggle-showall');
    ui.copyLog = $('bff-copy-log');
    ui.log = $('bff-log');
    ui.jsonModal = $('bff-json-modal');
    ui.jsonText = $('bff-json-text');
    ui.jsonError = $('bff-json-error');
    ui.jsonSave = $('bff-json-save');
    ui.jsonFormat = $('bff-json-format');
    ui.jsonExport = $('bff-json-export');
    ui.jsonImport = $('bff-json-import');
    ui.jsonFile = $('bff-json-file');
    ui.jsonClose = $('bff-json-close');

    ui.fab.addEventListener('click', openPanel);
    ui.close.addEventListener('click', closePanel);
    for (const button of ui.tabButtons) {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    }
    ui.saveRules.addEventListener('click', saveRulesFromForm);
    ui.resetRules.addEventListener('click', resetRules);
    ui.openJson.addEventListener('click', openJsonEditor);
    ui.saveDisplay.addEventListener('click', saveDisplayFromForm);
    ui.clearCache.addEventListener('click', () => {
      clearUpCache();
      state.failedMids.clear();
      scanCards();
      toast('已清空 UP 缓存');
    });
    ui.clearRelation.addEventListener('click', () => {
      clearRelationCache();
      state.failedRelation.clear();
      scanCards();
      toast('已清空关注缓存');
    });
    ui.clearFeedback.addEventListener('click', () => {
      clearFeedbackCache();
      toast('已清空反馈记录');
    });
    ui.recheck.addEventListener('click', recheckCurrentPage);
    ui.toggleShowAll.addEventListener('click', toggleShowAll);
    ui.copyLog.addEventListener('click', copyLog);
    ui.jsonSave.addEventListener('click', saveJson);
    ui.jsonFormat.addEventListener('click', formatJson);
    ui.jsonExport.addEventListener('click', exportJson);
    ui.jsonImport.addEventListener('click', () => ui.jsonFile.click());
    ui.jsonClose.addEventListener('click', closeJson);
    ui.jsonFile.addEventListener('change', () => {
      const file = ui.jsonFile.files && ui.jsonFile.files[0];
      if (file) handleJsonFile(file);
      ui.jsonFile.value = '';
    });
    ui.jsonModal.addEventListener('click', (event) => {
      if (event.target === ui.jsonModal) closeJson();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!ui.jsonModal.hidden) {
        closeJson();
      } else if (state.panelOpen) {
        closePanel();
      }
    });

    ui.fab.hidden = !state.settings.showFab;
    renderPanel();
    switchTab('rules');
    updateStatus();
    state.panelOpen = false;
  }

  function openPanel() {
    if (!ui.panel) return;
    state.panelOpen = true;
    renderPanel();
    switchTab(ui.currentTab || 'rules');
    ui.panel.hidden = false;
  }

  function closePanel() {
    if (!ui.panel) return;
    ui.panel.hidden = true;
    state.panelOpen = false;
  }

  function switchTab(tab) {
    if (!ui.tabContents || !ui.tabContents[tab]) return;
    ui.currentTab = tab;
    for (const button of ui.tabButtons) {
      button.classList.toggle('active', button.dataset.tab === tab);
    }
    for (const [name, element] of Object.entries(ui.tabContents)) {
      element.hidden = name !== tab;
    }
    if (tab === 'cache') {
      renderCacheStats();
      renderLog();
    }
  }

  function defaultRuleByType(type) {
    return makeDefaultRules().find((rule) => rule.type === type) || null;
  }

  function defaultRuleById(id) {
    return makeDefaultRules().find((rule) => rule.id === id) || null;
  }

  function upsertRule(settings, id, type, action, fallbackConfig) {
    let rule = settings.rules.find((item) => item.id === id);
    if (!rule) {
      rule = settings.rules.find((item) =>
        item.type === type && (!action || item.action === action)
      );
    }
    if (!rule) {
      rule = {
        id,
        type,
        enabled: false,
        action: action || 'block',
        scope: ['home', 'video'],
        config: deepClone(fallbackConfig || {})
      };
      settings.rules.push(rule);
    }
    if (!rule.config || typeof rule.config !== 'object' || Array.isArray(rule.config)) {
      rule.config = deepClone(fallbackConfig || {});
    }
    if (!Array.isArray(rule.scope) || !rule.scope.length) {
      rule.scope = ['home', 'video'];
    }
    return rule;
  }

  function parseUidInput(text) {
    const out = [];
    const seen = new Set();
    for (const token of String(text || '').split(/\s+/)) {
      const match = token.match(/(\d{1,20})/);
      if (!match) continue;
      const uid = match[1];
      if (seen.has(uid)) continue;
      seen.add(uid);
      out.push(uid);
      if (out.length >= MAX_UIDS) break;
    }
    return out;
  }

  function renderPanel() {
    if (!ui.panel || !state.settings) return;
    const settings = state.settings;
    ui.enabled.checked = !!settings.enabled;

    const mass = findRuleById('mass-upload') ||
      findRuleByType('up-mass-upload') ||
      defaultRuleByType('up-mass-upload');
    if (mass) {
      const cfg = mass.config || {};
      ui.massEnabled.checked = !!mass.enabled;
      ui.threshold.value = Number.isFinite(Number(cfg.threshold)) ? cfg.threshold : 5;
      ui.window.value = Number.isFinite(Number(cfg.windowHours)) ? cfg.windowHours : 24;
      ui.rolling.checked = !!cfg.rolling;
      ui.lookback.value = Number.isFinite(Number(cfg.lookbackDays)) ? cfg.lookbackDays : 7;
      ui.excludeLive.checked = cfg.excludeLiveReplay !== false;
      ui.skipFollowed.checked = cfg.skipFollowed !== false;
      ui.videoFollowed.checked = cfg.videoFollowedCheck !== false;
    }

    const allowKeyword = findRuleById('keywords-allow') ||
      findRuleByType('keyword', 'allow') ||
      defaultRuleById('keywords-allow');
    if (allowKeyword) {
      const cfg = allowKeyword.config || {};
      ui.kwAllowEnabled.checked = !!allowKeyword.enabled;
      ui.keywordsAllow.value = Array.isArray(cfg.keywords) ? cfg.keywords.join('\n') : '';
      ui.allowMatchTitle.checked = cfg.matchTitle !== false;
      ui.allowMatchUpName.checked = cfg.matchUpName === true;
      ui.allowRegex.checked = !!cfg.regex;
    }

    const keyword = findRuleById('keywords') ||
      findRuleByType('keyword', 'block') ||
      defaultRuleById('keywords');
    if (keyword) {
      const cfg = keyword.config || {};
      ui.kwEnabled.checked = !!keyword.enabled;
      ui.keywords.value = Array.isArray(cfg.keywords) ? cfg.keywords.join('\n') : '';
      ui.matchTitle.checked = cfg.matchTitle !== false;
      ui.matchUpName.checked = cfg.matchUpName === true;
      ui.regex.checked = !!cfg.regex;
    }

    const whitelist = findRuleById('whitelist') ||
      findRuleByType('uid-list', 'allow') ||
      defaultRuleByType('uid-list');
    if (whitelist) {
      ui.whitelist.value = Array.isArray(whitelist.config && whitelist.config.uids)
        ? whitelist.config.uids.join('\n')
        : '';
    }

    const blacklist = findRuleById('blacklist') ||
      findRuleByType('uid-list', 'block');
    if (blacklist) {
      ui.blacklist.value = Array.isArray(blacklist.config && blacklist.config.uids)
        ? blacklist.config.uids.join('\n')
        : '';
    } else {
      ui.blacklist.value = '';
    }

    const lowPlay = findRuleById('low-play') ||
      findRuleByType('play-count') ||
      defaultRuleByType('play-count');
    if (lowPlay) {
      const cfg = lowPlay.config || {};
      ui.playEnabled.checked = !!lowPlay.enabled;
      ui.playMin.value = Number.isFinite(Number(cfg.min)) ? cfg.min : 0;
      ui.playMax.value = Number.isFinite(Number(cfg.max)) ? cfg.max : 1000;
    }

    ui.displayMode.value = settings.displayMode;
    ui.scopeHome.checked = !!settings.scope.home;
    ui.scopeVideo.checked = !!settings.scope.video;
    ui.showFab.checked = !!settings.showFab;
    ui.autoDislike.value = ['mass', 'all', 'off'].includes(settings.autoDislike) ? settings.autoDislike : 'mass';
    ui.dislikeReason.value = String(Number(settings.dislikeReason) === DISLIKE_REASON_CONTENT ? DISLIKE_REASON_CONTENT : DISLIKE_REASON_UP);
    ui.conservative.checked = !!settings.conservative;
    ui.debug.checked = !!settings.debug;
    ui.fab.hidden = !settings.showFab;
    ui.formError.hidden = true;

    renderCacheStats();
    renderLog();
  }

  function readRulesFromForm() {
    const next = deepClone(state.settings);
    next.enabled = ui.enabled.checked;

    const mass = upsertRule(
      next,
      'mass-upload',
      'up-mass-upload',
      'block',
      defaultRuleByType('up-mass-upload').config
    );
    mass.enabled = ui.massEnabled.checked;
    mass.action = 'block';
    mass.config.threshold = Number(ui.threshold.value);
    mass.config.windowHours = Number(ui.window.value);
    mass.config.rolling = ui.rolling.checked;
    mass.config.lookbackDays = Number(ui.lookback.value);
    mass.config.excludeLiveReplay = ui.excludeLive.checked;
    mass.config.skipFollowed = ui.skipFollowed.checked;
    mass.config.videoFollowedCheck = ui.videoFollowed.checked;

    const allowKeyword = upsertRule(
      next,
      'keywords-allow',
      'keyword',
      'allow',
      defaultRuleById('keywords-allow').config
    );
    allowKeyword.enabled = ui.kwAllowEnabled.checked;
    allowKeyword.action = 'allow';
    allowKeyword.config.keywords = ui.keywordsAllow.value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    allowKeyword.config.matchTitle = ui.allowMatchTitle.checked;
    allowKeyword.config.matchUpName = ui.allowMatchUpName.checked;
    allowKeyword.config.regex = ui.allowRegex.checked;

    const keyword = upsertRule(
      next,
      'keywords',
      'keyword',
      'block',
      defaultRuleById('keywords').config
    );
    keyword.enabled = ui.kwEnabled.checked;
    keyword.config.keywords = ui.keywords.value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    keyword.config.matchTitle = ui.matchTitle.checked;
    keyword.config.matchUpName = ui.matchUpName.checked;
    keyword.config.regex = ui.regex.checked;

    const whitelist = upsertRule(next, 'whitelist', 'uid-list', 'allow', { uids: [], names: [] });
    whitelist.enabled = true;
    whitelist.action = 'allow';
    whitelist.config.uids = parseUidInput(ui.whitelist.value);

    const blacklist = upsertRule(next, 'blacklist', 'uid-list', 'block', { uids: [], names: [] });
    blacklist.action = 'block';
    blacklist.config.uids = parseUidInput(ui.blacklist.value);
    blacklist.enabled = blacklist.config.uids.length > 0 ||
      (Array.isArray(blacklist.config.names) && blacklist.config.names.length > 0);

    const lowPlay = upsertRule(next, 'low-play', 'play-count', 'block', { min: 0, max: 1000 });
    lowPlay.enabled = ui.playEnabled.checked;
    lowPlay.config.min = Number(ui.playMin.value);
    lowPlay.config.max = Number(ui.playMax.value);

    return next;
  }

  function formatErrors(errors) {
    if (!Array.isArray(errors)) return String(errors || '未知错误');
    return errors.map((error, index) => `${index + 1}. ${error}`).join('\n');
  }

  function showFormError(message) {
    ui.formError.textContent = message;
    ui.formError.hidden = false;
  }

  function saveRulesFromForm() {
    try {
      const result = commitSettings(readRulesFromForm());
      if (!result.ok) {
        showFormError(formatErrors(result.errors));
        return;
      }
      ui.formError.hidden = true;
      toast('设置已保存');
    } catch (error) {
      log('error', '保存表单失败', error);
      showFormError(`保存失败：${error.message || error}`);
    }
  }

  function saveDisplayFromForm() {
    const next = deepClone(state.settings);
    next.displayMode = ui.displayMode.value;
    next.scope = { home: ui.scopeHome.checked, video: ui.scopeVideo.checked };
    next.showFab = ui.showFab.checked;
    next.autoDislike = ui.autoDislike.value;
    next.dislikeReason = Number(ui.dislikeReason.value);
    next.conservative = ui.conservative.checked;
    next.debug = ui.debug.checked;
    const result = commitSettings(next);
    if (!result.ok) {
      toast(`保存失败：${result.errors[0]}`);
      return;
    }
    toast('显示设置已保存');
  }

  function resetRules() {
    if (!window.confirm('恢复默认规则？当前自定义规则会被覆盖。')) return;
    const next = deepClone(state.settings);
    next.rules = makeDefaultRules();
    const result = commitSettings(next);
    if (!result.ok) {
      toast(`恢复失败：${result.errors[0]}`);
      return;
    }
    toast('已恢复默认规则');
  }

  function openJsonEditor() {
    ui.jsonText.value = JSON.stringify({ version: 1, rules: state.settings.rules }, null, 2);
    ui.jsonError.hidden = true;
    ui.jsonModal.hidden = false;
    ui.jsonText.focus();
  }

  function closeJson() {
    ui.jsonModal.hidden = true;
    ui.jsonError.hidden = true;
  }

  function showJsonError(message) {
    ui.jsonError.textContent = message;
    ui.jsonError.hidden = false;
  }

  function saveJson() {
    const text = ui.jsonText.value.trim();
    if (!text) {
      showJsonError('JSON 不能为空');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      showJsonError(`JSON 解析失败：${error.message}`);
      return;
    }
    let rules;
    if (Array.isArray(parsed)) {
      rules = parsed;
    } else if (parsed && Array.isArray(parsed.rules)) {
      rules = parsed.rules;
    } else if (parsed && typeof parsed === 'object' && parsed.type) {
      rules = [parsed];
    } else {
      showJsonError('JSON 必须是 { version, rules }、规则数组，或单条规则对象');
      return;
    }
    const next = deepClone(state.settings);
    next.rules = rules;
    const result = commitSettings(next);
    if (!result.ok) {
      showJsonError(formatErrors(result.errors));
      return;
    }
    closeJson();
    toast('规则 JSON 已保存');
  }

  function formatJson() {
    const text = ui.jsonText.value.trim();
    if (!text) {
      showJsonError('JSON 不能为空');
      return;
    }
    try {
      const parsed = JSON.parse(text);
      ui.jsonText.value = JSON.stringify(parsed, null, 2);
      ui.jsonError.hidden = true;
    } catch (error) {
      showJsonError(`JSON 解析失败：${error.message}`);
    }
  }

  function exportJson() {
    const text = JSON.stringify({ version: 1, rules: state.settings.rules }, null, 2);
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bff-rules.json';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('已导出 bff-rules.json');
    } catch (error) {
      log('warn', '导出失败', error);
      toast('导出失败，请使用「复制日志」的方式备份');
    }
  }

  function handleJsonFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      ui.jsonText.value = String(reader.result || '');
      ui.jsonError.hidden = true;
      toast('已导入文件，请检查后点击「校验并保存」');
    };
    reader.onerror = () => showJsonError('读取文件失败');
    reader.readAsText(file, 'utf-8');
  }

  function renderCacheStats() {
    if (!ui.cacheStats) return;
    const ups = Object.keys(state.cache.ups).length;
    const relations = Object.keys(state.relation.users).length;
    let latest = 0;
    for (const entry of Object.values(state.cache.ups)) {
      if (entry && entry.fetchedAt > latest) latest = entry.fetchedAt;
    }
    const latestText = latest
      ? new Date(latest).toLocaleString('zh-CN', { hour12: false })
      : '暂无';
    const feedbackItems = Object.values(state.feedback.items);
    const feedbackOk = feedbackItems.filter((item) => item && item.ok).length;
    const feedbackText = feedbackItems.length
      ? `${feedbackOk} 个成功 / 共 ${feedbackItems.length} 条`
      : '暂无';
    ui.cacheStats.textContent = `UP 缓存：${ups} 个；关注缓存：${relations} 个；反馈记录：${feedbackText}；最近检查：${latestText}。`;
    if (ui.toggleShowAll) {
      ui.toggleShowAll.textContent = state.sessionShowAll ? '恢复屏蔽' : '临时显示全部';
    }
  }

  function renderLog() {
    if (!ui.log) return;
    const entries = state.logs.slice(-100);
    if (!entries.length) {
      ui.log.textContent = '(暂无日志)';
      return;
    }
    const lines = entries.map((entry) => {
      const time = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false });
      let line = `[${time}] ${String(entry.level || 'info').toUpperCase()} ${entry.message}`;
      if (entry.data !== undefined && entry.data !== null) {
        let dataText;
        try { dataText = JSON.stringify(entry.data); } catch (e) { dataText = String(entry.data); }
        if (dataText && dataText.length > 400) dataText = `${dataText.slice(0, 400)}…`;
        if (dataText) line += ` ${dataText}`;
      }
      return line;
    });
    ui.log.textContent = lines.join('\n');
  }

  function positionFab() {
    if (!ui.fab) return;
    const onVideo = getPageType() === 'video';
    if (onVideo) {
      ui.fab.style.left = 'auto';
      ui.fab.style.right = '18px';
    } else {
      ui.fab.style.left = '18px';
      ui.fab.style.right = 'auto';
    }
    if (ui.status) {
      if (onVideo) {
        ui.status.style.left = 'auto';
        ui.status.style.right = '18px';
      } else {
        ui.status.style.left = '18px';
        ui.status.style.right = 'auto';
      }
    }
  }

  function updateStatus() {
    if (!ui.status && !ui.fab) return;
    const pendingChecks = (state.inFlight ? state.inFlight.size : 0) +
      (state.relationInFlight ? state.relationInFlight.size : 0);
    const pendingFeedback = state.feedbackInFlight ? state.feedbackInFlight.size : 0;
    const paused = !!(state.queue && state.queue.pausedUntil > Date.now());
    const feedbackPaused = !!(state.feedbackQueue && state.feedbackQueue.pausedUntil > Date.now());
    const showStatus = !state.settings || state.settings.showFab !== false;
    const statusText = paused
      ? '接口限流，已暂停检查'
      : feedbackPaused
        ? '反馈接口限流，已暂停反馈'
        : pendingChecks
          ? `正在检查 ${pendingChecks} 个 UP`
          : pendingFeedback
            ? `正在提交 ${pendingFeedback} 条反馈`
            : '';
    if (ui.status) {
      ui.status.hidden = !showStatus || !statusText;
      ui.status.textContent = statusText;
    }
    if (ui.fab) {
      ui.fab.title = paused
        ? '接口限流，已暂停检查；点击打开设置'
        : feedbackPaused
          ? '反馈接口限流，已暂停反馈；点击打开设置'
          : pendingChecks
            ? `正在检查 ${pendingChecks} 个 UP；点击打开设置`
            : pendingFeedback
              ? `正在提交 ${pendingFeedback} 条反馈；点击打开设置`
              : 'B站推荐流屏蔽设置';
    }
    positionFab();
  }

  function toast(message) {
    if (!ui.toast) {
      log('info', message);
      return;
    }
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      if (ui.toast) ui.toast.hidden = true;
    }, 3200);
  }

  function toggleShowAll() {
    if (state.sessionShowAll) {
      state.sessionShowAll = false;
      state.shownMids.clear();
      toast('已恢复屏蔽');
    } else {
      state.sessionShowAll = true;
      cancelAllFeedbackTimers();
      toast('本次会话已临时显示全部');
    }
    scanCards();
    renderPanel();
  }

  function recheckCurrentPage() {
    const page = getPageType();
    if (!page) {
      toast('当前页面不在支持范围内');
      return;
    }
    const cards = collectCards(page);
    const mids = new Set(cards.map((card) => card.mid));
    for (const mid of mids) {
      deleteCacheEntry(mid);
      state.failedMids.delete(mid);
      delete state.relation.users[mid];
    }
    state.failedRelation.clear();
    state.shownMids.clear();
    saveRelationDebounced();
    scanCards();
    toast(`已重新检查 ${mids.size} 个 UP`);
  }

  async function copyLog() {
    const text = ui.log ? ui.log.textContent : '';
    if (!text || text === '(暂无日志)') {
      toast('暂无日志');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('日志已复制');
      return;
    } catch (error) { /* fall through */ }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('日志已复制');
    } catch (error) {
      toast('复制失败');
    }
    area.remove();
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('打开设置面板', openPanel);
      GM_registerMenuCommand('临时显示全部 / 恢复屏蔽', toggleShowAll);
      GM_registerMenuCommand('重新检查当前页', recheckCurrentPage);
      GM_registerMenuCommand('清空 UP 缓存', () => {
        clearUpCache();
        state.failedMids.clear();
        scanCards();
        toast('已清空 UP 缓存');
      });
      GM_registerMenuCommand('清空反馈记录', () => {
        clearFeedbackCache();
        toast('已清空反馈记录');
      });
    } catch (error) {
      log('warn', '注册油猴菜单失败', error);
    }
  }

  // =========================================================================
  // 启动
  // =========================================================================

  function main() {
    if (document.documentElement.dataset.bffLoaded === '1') return;
    const page = getPageType();
    if (!page) return;
    if (state.started) return;
    document.documentElement.dataset.bffLoaded = '1';
    state.started = true;
    state.sessionStartedAt = Date.now();

    state.settings = loadSettings();
    state.cache = loadCache();
    state.relation = loadRelation();
    state.feedback = loadFeedback();
    state.queue = new RequestQueue({ concurrency: 2, minGap: 800, maxGap: 1100, slowAfter: 20, slowGap: 1200 });
    state.relationQueue = new RequestQueue({ concurrency: 1, minGap: 800, maxGap: 1100, slowAfter: 1000, slowGap: 1200 });
    state.feedbackQueue = new RequestQueue({ concurrency: 1, minGap: 1000, maxGap: 1400, slowAfter: 10, slowGap: 1800 });
    applyQueueMode();

    try {
      injectDocumentStyles();
      initPanel();
    } catch (error) {
      log('error', '面板初始化失败', error);
    }
    try {
      registerMenu();
    } catch (error) {
      log('warn', '菜单注册失败', error);
    }

    initObservers();
    scanCards();
    setInterval(() => {
      if (document.visibilityState === 'visible') scanCards();
    }, SCAN_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scanCards();
    });
    window.addEventListener('popstate', scanCards);
    window.addEventListener('storage', (event) => {
      if (event.key !== FEEDBACK_KEY) return;
      state.feedback = loadFeedback();
      refreshFeedbackButtons();
      if (state.panelOpen) renderCacheStats();
    });
    window.addEventListener('beforeunload', () => {
      try {
        saveCacheNow();
        saveRelationNow();
      } catch (e) { /* ignore */ }
    });
    log('info', '已启动', { page, version: '1.2.1' });
  }

  function tryStart() {
    if (document.documentElement.dataset.bffLoaded === '1') return;
    if (getPageType()) {
      main();
      return;
    }
    setTimeout(tryStart, 3000);
  }

  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryStart, { once: true });
    } else {
      tryStart();
    }
  }

  boot();
})();
