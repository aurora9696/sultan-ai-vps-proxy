const express = require("express");
const { outboundRouter } = require("./outbound.js");

const app = express();

// Outbound relay: semua request keluar aplikasi ditembakkan dari server ini.
app.use(outboundRouter);
const PORT = process.env.PORT || 8080;
const PROXY_VERSION = "static-env-no-supabase-2026-04-25-4";

// ---- Static config from env (no Supabase needed) ----
// Supports two formats:
//  1) FLOW_SERVERS_JSON = '[{"id":"server-1","targetUrl":"https://labs.google/fx/tools/flow","cookies":[...],"appId":"1","appName":"Flow","sortOrder":1,"multiplier":1,"hiddenElements":{}}]'
//  2) Single server shortcut:
//     FLOW_SERVER_ID (default: "default")
//     FLOW_TARGET_URL  (e.g. https://labs.google/fx/tools/flow)
//     FLOW_COOKIES_JSON (JSON array of {name,value} or "name=value" strings)
//     FLOW_APP_ID (default "1"), FLOW_APP_NAME (default "Flow")
//     FLOW_SORT_ORDER (default 1), FLOW_MULTIPLIER (default 1)
//     FLOW_HIDDEN_ELEMENTS_JSON (optional JSON object)
function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) {
    console.error("Invalid JSON in env:", e?.message || e);
    return fallback;
  }
}

function buildStaticConfigMap() {
  const map = new Map();

  // Multi-server JSON
  const multi = safeJsonParse(process.env.FLOW_SERVERS_JSON, null);
  if (Array.isArray(multi)) {
    for (const s of multi) {
      if (!s || !s.id) continue;
      map.set(String(s.id), {
        targetUrl: s.targetUrl || s.target_url || "",
        cookies: s.cookies || [],
        appId: s.appId || s.app_id || "1",
        appName: s.appName || s.app_name || "Flow",
        hiddenElements: s.hiddenElements || s.hidden_elements || {},
        multiplier: Number(s.multiplier) || 1,
        sortOrder: Number(s.sortOrder ?? s.sort_order) || 0,
      });
    }
  }

  // Single-server shortcut
  const singleTarget = (process.env.FLOW_TARGET_URL || "").trim();
  if (singleTarget) {
    const singleId = (process.env.FLOW_SERVER_ID || "default").trim();
    map.set(singleId, {
      targetUrl: singleTarget,
      cookies: safeJsonParse(process.env.FLOW_COOKIES_JSON, []),
      appId: (process.env.FLOW_APP_ID || "1").trim(),
      appName: (process.env.FLOW_APP_NAME || "Flow").trim(),
      hiddenElements: safeJsonParse(process.env.FLOW_HIDDEN_ELEMENTS_JSON, {}),
      multiplier: Number(process.env.FLOW_MULTIPLIER) || 1,
      sortOrder: Number(process.env.FLOW_SORT_ORDER) || 0,
    });
  }

  return map;
}

const STATIC_CONFIG = buildStaticConfigMap();
if (STATIC_CONFIG.size > 0) {
  console.log(`[config] Static servers loaded: ${[...STATIC_CONFIG.keys()].join(", ")}`);
}

async function getServerConfig(serverId) {
  // Static env config only — no Supabase / service role key needed.
  if (STATIC_CONFIG.has(serverId)) {
    return STATIC_CONFIG.get(serverId);
  }
  // If a single static server is configured but client used a different id,
  // fall back to the first static entry to keep things working.
  if (STATIC_CONFIG.size > 0) {
    return STATIC_CONFIG.values().next().value;
  }

  throw new Error(
    "Tidak ada konfigurasi server. Set FLOW_TARGET_URL + FLOW_COOKIES_JSON " +
    "(atau FLOW_SERVERS_JSON) di Railway Variables."
  );
}

function buildCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return "";
  return cookies
    .map((c) => {
      if (typeof c === "string") return c;
      if (c.name && c.value) return `${c.name}=${c.value}`;
      return "";
    })
    .filter(Boolean)
    .join("; ");
}

function getProxyDocumentBase(proxyBase, resolvedTarget) {
  const pathname = resolvedTarget.pathname || "/";
  if (pathname.endsWith("/")) return `${proxyBase}${pathname}`;
  const directory = pathname.replace(/\/[^/]*$/, "/") || "/";
  return `${proxyBase}${directory}`;
}

function rewriteHtml(body, targetOrigin, proxyBase, proxyDocumentBase) {
  const escapedOrigin = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let rewritten = body.replace(
    new RegExp(`(href|src|action)=["'](${escapedOrigin})(/[^"']*)["']`, "gi"),
    `$1="${proxyBase}$3"`
  );

  rewritten = rewritten.replace(
    new RegExp(`(["'])(${escapedOrigin})(/[^"']*)\\1`, "gi"),
    `$1${proxyBase}$3$1`
  );

  rewritten = rewritten.replace(
    /(href|src|action)=["']\/(?!\/)([^"']*)["']/gi,
    (_, attr, path) => `${attr}="${proxyBase}/${path}"`
  );

  // Rewrite absolute target origin URLs (escaped JSON form like https:\/\/labs.google)
  rewritten = rewritten.replace(
    new RegExp(escapedOrigin.replace(/\//g, "\\\\/"), "g"),
    proxyBase.replace(/\//g, "\\/")
  );
  // Rewrite plain absolute target origin URLs
  rewritten = rewritten.replace(
    new RegExp(escapedOrigin, "g"),
    proxyBase
  );

  if (/<base\s/i.test(rewritten)) {
    rewritten = rewritten.replace(/<base[^>]*href=["'][^"']*["'][^>]*>/i, `<base href="${proxyDocumentBase}"/>`);
  } else {
    rewritten = rewritten.replace(/<head([^>]*)>/i, `<head$1><base href="${proxyDocumentBase}"/>`);
  }

  return rewritten;
}

/**
 * Build CSS to hide restricted Veo model options based on server sort_order.
 * Rules (from memory):
 *   Server 1-3 (sort_order 1-5): Only "Lower Priority" variants allowed
 *   Server 4 (sort_order 6):     + "Veo 3.1 - Lite" (plain)
 *   Server 5 (sort_order 7):     + "Veo 3.1 - Lite" and "Veo 3.1 - Fast"
 *   Server 6+ (sort_order 8+):   No restrictions
 *   Global: x3/x4 output multipliers always hidden
 */
function buildVeoRestrictionCSS(config) {
  const isFlowApp =
    config.appId === "01" ||
    config.appId === "1" ||
    (config.appName || "").toLowerCase().includes("flow");

  if (!isFlowApp) return "";

  const order = config.sortOrder || 0;
  const rules = [];

  // --- Global: hide x3 and x4 output options ---
  // These appear as buttons/options containing "x3" or "x4" text
  rules.push(`
    /* Hide x3/x4 output multipliers globally */
    [data-value="x3"], [data-value="x4"],
    [aria-label*="x3"], [aria-label*="x4"] {
      display: none !important;
    }
  `);

  // --- Per-server Veo model restrictions ---
  // The Veo options appear in listbox/menu/dropdown surfaces.
  // We use a JS-based approach injected via <style> + MutationObserver
  // because CSS :has() with text content matching is limited.

  // Define which Veo labels to BLOCK per server tier
  let blockedLabels = [];

  if (order <= 5) {
    // Server 1-3: Only allow Lower Priority variants
    blockedLabels = [
      "Veo 3.1 - Lite",    // plain (not Lower Priority)
      "Veo 3.1 - Fast",    // plain (not Lower Priority)
      "Veo 3.1 - Quality",
    ];
  } else if (order === 6) {
    // Server 4: Allow + Lite plain, block Fast plain and Quality
    blockedLabels = [
      "Veo 3.1 - Fast",    // plain
      "Veo 3.1 - Quality",
    ];
  } else if (order === 7) {
    // Server 5: Allow + Lite and Fast plain, block Quality
    blockedLabels = [
      "Veo 3.1 - Quality",
    ];
  }
  // order >= 8: no restrictions

  if (blockedLabels.length === 0 && order >= 8) return rules.join("\n");

  return { css: rules.join("\n"), blockedLabels };
}

function buildInjectionScript(config, targetUrl, proxyHost, proxyBase) {
  let isFlowApp = false;
  let targetOrigin = "";

  try {
    const urlObj = new URL(targetUrl);
    targetOrigin = urlObj.origin;
    const host = urlObj.hostname;
    if (host === "labs.google" || host.endsWith(".labs.google") || targetUrl.includes("/fx/tools/flow")) {
      isFlowApp = true;
    }
  } catch {}

  if (config.appId === "01" || config.appId === "1" || (config.appName || "").toLowerCase().includes("flow")) {
    isFlowApp = true;
  }

  const dmsConfig = {
    is_flow_app: isFlowApp || undefined,
    flow_target_host: isFlowApp ? proxyHost : undefined,
    hidden_elements: Object.keys(config.hiddenElements || {}).length > 0 ? config.hiddenElements : undefined,
    multiplier: config.multiplier > 1 ? config.multiplier : undefined,
  };

  return `
(function() {
  'use strict';
  var __config = ${JSON.stringify(dmsConfig)};
  var __proxyBase = ${JSON.stringify(proxyBase)};
  var __targetOrigin = ${JSON.stringify(targetOrigin)};
  var _storagePrefix = 'dms_web_proxy_';
  var _changeListeners = [];

  function _getItem(key) {
    try {
      var raw = localStorage.getItem(_storagePrefix + key);
      return raw !== null ? JSON.parse(raw) : undefined;
    } catch(e) { return undefined; }
  }

  function _setItem(key, value) {
    try {
      var oldValue = _getItem(key);
      localStorage.setItem(_storagePrefix + key, JSON.stringify(value));
      var changes = {};
      changes[key] = { oldValue: oldValue, newValue: value };
      _changeListeners.forEach(function(fn) { try { fn(changes); } catch(e){} });
    } catch(e) {}
  }

  function _removeItem(key) {
    try {
      var oldValue = _getItem(key);
      localStorage.removeItem(_storagePrefix + key);
      var changes = {};
      changes[key] = { oldValue: oldValue, newValue: undefined };
      _changeListeners.forEach(function(fn) { try { fn(changes); } catch(e){} });
    } catch(e) {}
  }

  function _rewriteUrl(input) {
    try {
      if (!input || typeof input !== 'string') return input;
      if (input.startsWith(__proxyBase)) return input;
      if (input.startsWith('data:') || input.startsWith('blob:') || input.startsWith('javascript:') || input.startsWith('about:')) return input;
      if (input.startsWith('//')) {
        var protocolAbsolute = window.location.protocol + input;
        if (__targetOrigin && protocolAbsolute.indexOf(__targetOrigin) === 0) {
          return __proxyBase + protocolAbsolute.slice(__targetOrigin.length);
        }
        return input;
      }
      if (input.startsWith('/')) return __proxyBase + input;
      if (__targetOrigin) {
        var absUrl = new URL(input, __targetOrigin + '/');
        if (absUrl.origin === __targetOrigin) {
          return __proxyBase + absUrl.pathname + absUrl.search + absUrl.hash;
        }
      }
      return input;
    } catch (e) {
      return input;
    }
  }

  // Patch Request constructor to rewrite URLs
  if (typeof Request !== 'undefined') {
    var _OrigRequest = Request;
    window.Request = function(input, init) {
      try {
        if (typeof input === 'string') {
          input = _rewriteUrl(input);
        } else if (typeof URL !== 'undefined' && input instanceof URL) {
          input = _rewriteUrl(input.toString());
        } else if (input instanceof _OrigRequest) {
          var rewrittenUrl = _rewriteUrl(input.url);
          if (rewrittenUrl !== input.url) {
            input = new _OrigRequest(rewrittenUrl, input);
          }
        }
      } catch (e) {}
      return new _OrigRequest(input, init);
    };
    window.Request.prototype = _OrigRequest.prototype;
    Object.keys(_OrigRequest).forEach(function(k) {
      try { window.Request[k] = _OrigRequest[k]; } catch(e) {}
    });
  }

  if (typeof window.fetch === 'function') {
    var _origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      try {
        if (typeof input === 'string') {
          input = _rewriteUrl(input);
        } else if (typeof URL !== 'undefined' && input instanceof URL) {
          input = _rewriteUrl(input.toString());
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          var rewrittenUrl = _rewriteUrl(input.url);
          if (rewrittenUrl !== input.url) {
            input = new Request(rewrittenUrl, input);
          }
        }
      } catch (e) {}
      return _origFetch(input, init);
    };
  }

  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype && window.XMLHttpRequest.prototype.open) {
    var _origOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function(method, url) {
      try {
        if (typeof url === 'string') arguments[1] = _rewriteUrl(url);
      } catch (e) {}
      return _origOpen.apply(this, arguments);
    };
  }

  if (typeof window.open === 'function') {
    var _origWindowOpen = window.open.bind(window);
    window.open = function(url) {
      try {
        if (typeof url === 'string') arguments[0] = _rewriteUrl(url);
      } catch (e) {}
      return _origWindowOpen.apply(window, arguments);
    };
  }

  // Patch EventSource
  if (typeof EventSource !== 'undefined') {
    var _OrigEventSource = EventSource;
    window.EventSource = function(url, opts) {
      try { if (typeof url === 'string') url = _rewriteUrl(url); } catch(e) {}
      return new _OrigEventSource(url, opts);
    };
    window.EventSource.prototype = _OrigEventSource.prototype;
  }

  // Patch history.pushState and replaceState to keep proxy prefix
  if (window.history) {
    var _origPush = window.history.pushState.bind(window.history);
    var _origReplace = window.history.replaceState.bind(window.history);
    window.history.pushState = function(state, title, url) {
      if (typeof url === 'string') url = _rewriteUrl(url);
      return _origPush(state, title, url);
    };
    window.history.replaceState = function(state, title, url) {
      if (typeof url === 'string') url = _rewriteUrl(url);
      return _origReplace(state, title, url);
    };
  }

  if (typeof window.chrome === 'undefined') window.chrome = {};
  if (!window.chrome.storage) window.chrome.storage = {};
  if (!window.chrome.storage.local) {
    window.chrome.storage.local = {
      get: function(keys, callback) {
        var result = {};
        var keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
        keyList.forEach(function(k) {
          var val = _getItem(k);
          if (val !== undefined) result[k] = val;
        });
        if (typeof callback === 'function') callback(result);
      },
      set: function(items, callback) {
        if (items && typeof items === 'object') {
          Object.keys(items).forEach(function(k) { _setItem(k, items[k]); });
        }
        if (typeof callback === 'function') callback();
      },
      remove: function(keys, callback) {
        var keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(function(k) { _removeItem(k); });
        if (typeof callback === 'function') callback();
      }
    };
  }
  if (!window.chrome.storage.onChanged) {
    window.chrome.storage.onChanged = {
      addListener: function(fn) { _changeListeners.push(fn); }
    };
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      lastError: null,
      getURL: function(path) { return 'about:blank#' + path; },
      sendMessage: function(msg, callback) {
        if (typeof callback === 'function') {
          window.chrome.runtime.lastError = { message: 'Not in extension context' };
          callback(null);
        }
      },
      onMessage: { addListener: function() {} }
    };
  }

  if (__config.is_flow_app) _setItem('dms_is_flow_app', '1');
  if (__config.flow_target_host) _setItem('dms_flow_target_host', __config.flow_target_host);
  if (__config.hidden_elements) _setItem('dms_hidden_elements', __config.hidden_elements);
  if (__config.multiplier) _setItem('dms_multiplier', String(__config.multiplier));

  window.__DMS_PROXY_INJECTED__ = true;
})();
`;
}

app.post("/flush-cache", (req, res) => {
  res.json({ ok: true, mode: "static-env", cache: "disabled" });
});

app.get("/health", (req, res) => res.json({
  status: "ok",
  mode: "static-env",
  version: PROXY_VERSION,
  serversConfigured: STATIC_CONFIG.size,
}));

app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, accept");
  res.sendStatus(204);
});

app.all("/proxy/:serverId", (req, res, next) => {
  if (req.path.endsWith("/")) {
    next();
    return;
  }
  const query = req._parsedUrl?.search || "";
  res.redirect(307, `/proxy/${req.params.serverId}/${query}`);
});

app.use("/proxy/:serverId", async (req, res) => {
  try {
    const { serverId } = req.params;
    const config = await getServerConfig(serverId);

    if (!config) return res.status(404).json({ error: "Server not found" });
    if (!config.targetUrl) return res.status(400).json({ error: "Empty target URL" });

    const resolvedTarget = new URL(config.targetUrl);
    const targetOrigin = resolvedTarget.origin;
    const remainingPath = (req.path || "").replace(/^\/+/, "");
    const targetPath = remainingPath ? `/${remainingPath}` : resolvedTarget.pathname;
    const targetUrl = `${targetOrigin}${targetPath}${req._parsedUrl.search || ""}`;

    const cookieHeader = buildCookieHeader(config.cookies);

    const headers = {};
    const forward = ["accept", "accept-language", "content-type", "user-agent"];
    for (const h of forward) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    headers["accept-encoding"] = "identity";
    if (cookieHeader) headers["cookie"] = cookieHeader;
    headers["referer"] = targetOrigin + "/";
    headers["origin"] = targetOrigin;

    const fetchOpts = { method: req.method, headers, redirect: "follow" };
    if (!["GET", "HEAD"].includes(req.method)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      fetchOpts.body = Buffer.concat(chunks);
    }

    const proxyRes = await fetch(targetUrl, fetchOpts);
    const contentType = proxyRes.headers.get("content-type") || "";

    const skipHeaders = new Set([
      "x-frame-options",
      "content-security-policy",
      "content-security-policy-report-only",
      "x-content-type-options",
      "strict-transport-security",
      "content-encoding",
      "content-length",
      "transfer-encoding",
      "set-cookie",
    ]);

    for (const [key, value] of proxyRes.headers) {
      if (!skipHeaders.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization, accept");

    if (contentType.includes("text/html")) {
      const proxyBase = `https://${req.headers.host}/proxy/${serverId}`;
      const proxyDocumentBase = getProxyDocumentBase(proxyBase, resolvedTarget);
      let body = await proxyRes.text();

      body = rewriteHtml(body, targetOrigin, proxyBase, proxyDocumentBase);

      const proxyHost = req.headers.host;
      const shimScript = buildInjectionScript(config, targetUrl, proxyHost, proxyBase);
      const contentScriptUrl = (process.env.CONTENT_SCRIPT_URL || "").trim();

      // Build Veo restriction CSS + JS
      const veoRestriction = buildVeoRestrictionCSS(config);
      let veoInjection = "";
      if (veoRestriction && typeof veoRestriction === "object") {
        veoInjection = `
<style id="dms-veo-restrict">${veoRestriction.css}</style>
<script>
(function(){
  'use strict';
  var BLOCKED = ${JSON.stringify(veoRestriction.blockedLabels)};
  if (!BLOCKED.length) return;

  function isExactBlock(text) {
    var t = text.trim();
    for (var i = 0; i < BLOCKED.length; i++) {
      // Exact match: "Veo 3.1 - Lite" but NOT "Veo 3.1 - Lite [Lower Priority]"
      if (t === BLOCKED[i]) return true;
    }
    return false;
  }

  function hideVeoOptions(root) {
    // Find all elements that look like menu items / listbox options / dropdown rows
    var selectors = [
      '[role="option"]', '[role="menuitem"]', '[role="listitem"]',
      '[role="menuitemradio"]', '[role="radio"]',
      '[data-value]', '[aria-selected]',
      'li', 'md-menu-item', 'mat-option'
    ];
    var candidates = (root || document).querySelectorAll(selectors.join(','));
    candidates.forEach(function(el) {
      var text = el.textContent || '';
      // Check for blocked Veo labels (exact, not Lower Priority)
      if (isExactBlock(text) && text.indexOf('Lower Priority') === -1) {
        el.style.setProperty('display', 'none', 'important');
        el.setAttribute('data-dms-hidden', '1');
      }
    });

    // Also hide x3/x4 buttons via text content
    var allEls = (root || document).querySelectorAll('button, [role="option"], [role="radio"], [data-value]');
    allEls.forEach(function(el) {
      var t = (el.textContent || '').trim();
      if (t === 'x3' || t === 'x4' || t === '×3' || t === '×4') {
        el.style.setProperty('display', 'none', 'important');
      }
    });
  }

  // Run on load and continuously via MutationObserver
  function startObserver() {
    hideVeoOptions();
    var observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.addedNodes.length > 0) {
          hideVeoOptions();
          return;
        }
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });
  }

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);

  // Fallback polling every 2s for dynamically loaded content
  setInterval(function() { hideVeoOptions(); }, 2000);
})();
</script>
`;
      } else if (typeof veoRestriction === "string" && veoRestriction) {
        veoInjection = `<style id="dms-veo-restrict">${veoRestriction}</style>`;
      }

      const injectionHtml = `
${veoInjection}
<script>${shimScript}</script>
${contentScriptUrl ? `<script src="${contentScriptUrl}" defer></script>` : ""}
`;

      if (body.includes("</head>")) {
        body = body.replace("</head>", `${injectionHtml}</head>`);
      } else if (body.includes("</body>")) {
        body = body.replace("</body>", `${injectionHtml}</body>`);
      } else {
        body += injectionHtml;
      }

      res.setHeader("content-type", "text/html; charset=utf-8");
      res.status(proxyRes.status).send(body);
      return;
    }

    // Rewrite JavaScript files that reference the target origin
    if (contentType.includes("javascript") || contentType.includes("application/json")) {
      const proxyBase = `https://${req.headers.host}/proxy/${serverId}`;
      let body = await proxyRes.text();
      const escapedOrigin = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Replace escaped versions (JSON-encoded URLs like "https:\/\/labs.google")
      body = body.replace(
        new RegExp(escapedOrigin.replace(/\//g, "\\\\/"), "g"),
        proxyBase.replace(/\//g, "\\/")
      );
      // Replace plain versions
      body = body.replace(new RegExp(escapedOrigin, "g"), proxyBase);
      res.status(proxyRes.status).send(body);
      return;
    }

    const buffer = Buffer.from(await proxyRes.arrayBuffer());
    res.status(proxyRes.status).send(buffer);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`DMS Proxy ${PROXY_VERSION} running on port ${PORT}`));
