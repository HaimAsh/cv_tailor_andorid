/* CV Tailor – runs entirely on the device; talks only to the Gemini API. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const DEFAULT_MODEL = "gemini-3.8-flash";
  const API = "https://generativelanguage.googleapis.com/v1beta/models/";

  let result = null;
  let lang = store.get("cvt.lang") || "same";
  let busy = false;

  // ---------------- settings ----------------
  const apiKey = () => (store.get("cvt.apiKey") || "").trim();
  const model = () => (store.get("cvt.model") || DEFAULT_MODEL).trim();
  function syncSetupNote() { $("setupNote").hidden = !!apiKey(); }
  function openSettings() {
    $("apiKey").value = apiKey();
    $("model").value = model();
    $("apiKey").type = "password"; $("toggleKey").textContent = "הצגה";
    $("settings").showModal();
  }
  $("settingsBtn").onclick = openSettings;
  $("setupBtn").onclick = openSettings;
  $("toggleKey").onclick = () => {
    const show = $("apiKey").type === "password";
    $("apiKey").type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "הסתרה" : "הצגה";
  };
  $("settings").addEventListener("close", () => {
    if ($("settings").returnValue !== "save") return;
    store.set("cvt.apiKey", $("apiKey").value.trim());
    store.set("cvt.model", $("model").value.trim() || DEFAULT_MODEL);
    syncSetupNote();
  });
  syncSetupNote();

  // ---------------- inputs ----------------
  for (const id of ["cvText", "jobText", "jobUrl", "extra"]) {
    const v = store.get("cvt." + id); if (v) $(id).value = v;
    $(id).addEventListener("input", () => store.set("cvt." + id, $(id).value));
  }
  function syncLang() { for (const b of $("langSeg").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.v === lang); }
  $("langSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; lang = b.dataset.v; store.set("cvt.lang", lang); syncLang(); };
  syncLang();

  function say(id, text, err) { const s = $(id); s.textContent = text || ""; s.className = "status" + (err ? " err" : ""); }

  const loaded = {};
  function loadScript(src) {
    return loaded[src] ||= new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src; s.onload = res;
      s.onerror = () => rej(new Error("load " + src)); document.head.appendChild(s);
    });
  }

  // ---------------- read an uploaded CV ----------------
  $("cvFile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    say("cvStatus", "קורא את " + f.name + "...");
    try {
      const name = f.name.toLowerCase();
      let text = "";
      if (name.endsWith(".docx")) {
        await loadScript("vendor/mammoth.browser.min.js");
        text = (await window.mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() })).value;
      } else if (name.endsWith(".pdf") || f.type === "application/pdf") {
        await loadScript("vendor/pdf.min.js");
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
        const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const tc = await (await pdf.getPage(i)).getTextContent();
          let line = ""; const out = [];
          for (const it of tc.items) { line += it.str; if (it.hasEOL) { out.push(line); line = ""; } }
          if (line) out.push(line);
          pages.push(out.join("\n"));
        }
        text = pages.join("\n\n");
      } else {
        text = await f.text();
      }
      text = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length < 50) throw new Error("empty");
      $("cvText").value = text; store.set("cvt.cvText", text);
      say("cvStatus", "הטקסט נטען מ-" + f.name + ". כדאי לעבור עליו ולוודא שלא חסר כלום.");
    } catch {
      say("cvStatus", "לא הצלחתי לחלץ טקסט מהקובץ. אם זה PDF סרוק, העתק את הטקסט והדבק אותו.", true);
    }
    e.target.value = "";
  };

  // ---------------- Gemini ----------------
  class UserError extends Error {}

  const FALLBACK_MODELS = ["gemini-3.7-flash", "gemini-3.5-flash"];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // One HTTP call. Returns {res, data} or throws UserError for network problems.
  async function callOnce(modelName, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(API + encodeURIComponent(modelName) + ":generateContent", {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } catch (e) {
      throw new UserError(e.name === "AbortError" ? "Gemini לא ענה בזמן. נסה שוב." : "לא הצלחתי להתחבר ל-Gemini. בדוק את החיבור לאינטרנט.");
    } finally { clearTimeout(timer); }
  }

  // Calls Gemini, retrying when the service is busy and falling back to older Flash models.
  async function gemini(body, timeoutMs = 180000, onRetry) {
    if (!apiKey()) { openSettings(); throw new UserError("צריך להכניס מפתח API בהגדרות."); }
    if (!navigator.onLine) throw new UserError("אין חיבור לאינטרנט.");
    const models = [model(), ...FALLBACK_MODELS.filter(m => m !== model())];
    let res, data, used;
    outer: for (const m of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt || m !== models[0]) onRetry?.(m === models[0] ? `Gemini עמוס, מנסה שוב (${attempt + 1}/3)...` : `Gemini עמוס, מנסה עם ${m}...`);
        ({ res, data } = await callOnce(m, body, timeoutMs));
        used = m;
        if (res.ok) break outer;
        if (![500, 502, 503, 504].includes(res.status)) break outer; // not a "busy" error: no point retrying
        await sleep(attempt === 0 ? 2000 : 6000);
      }
    }
    if (!res.ok) {
      const msg = data.error?.message || "", st = data.error?.status || "";
      const detail = ` (${res.status}${st ? " " + st : ""}${msg ? ": " + msg.slice(0, 160) : ""})`;
      if (res.status === 400 && /API key/i.test(msg)) throw new UserError("מפתח ה-API לא תקין. בדוק אותו בהגדרות.");
      if (res.status === 403) throw new UserError("למפתח אין הרשאה לשירות. בדוק אותו בהגדרות." + detail);
      if (res.status === 404) throw new UserError(`המודל ${used} לא נמצא. שנה אותו בהגדרות.`);
      if (res.status === 429 || st === "RESOURCE_EXHAUSTED") throw new UserError("הגעת למגבלת השימוש של Gemini. חכה דקה ונסה שוב." + detail);
      if (res.status >= 500) throw new UserError("Gemini עמוס כרגע גם אחרי כמה ניסיונות. נסה שוב בעוד כמה דקות." + detail);
      throw new UserError("Gemini החזיר שגיאה" + detail);
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join("");
    if (!text) {
      if (cand?.finishReason === "SAFETY" || data.promptFeedback?.blockReason) throw new UserError("Gemini סירב לעבד את הטקסט. בדוק מה הודבק.");
      throw new UserError(`לא התקבלה תשובה מ-Gemini (${cand?.finishReason || "ריק"}). נסה שוב.`);
    }
    return { text, cand };
  }

  // ---------------- step 2: read the job posting ----------------
  $("fetchBtn").onclick = async () => {
    const url = $("jobUrl").value.trim();
    if (!/^https?:\/\/\S+\.\S+/i.test(url)) { say("jobStatus", "הכנס קישור מלא שמתחיל ב-https://", true); return; }
    if (/linkedin\.com/i.test(url)) { say("jobStatus", "LinkedIn חוסם קריאה אוטומטית. העתק את תיאור המשרה מהאפליקציה והדבק אותו בתיבה.", true); return; }
    $("fetchBtn").disabled = true; say("jobStatus", "Gemini קורא את דף המשרה...");
    try {
      const { text, cand } = await gemini({
        contents: [{ role: "user", parts: [{ text:
`Open this job posting: ${url}

Copy out the complete job posting text: job title, company, location, description, responsibilities, requirements and nice-to-haves. Keep the original language and wording, as plain text with line breaks. Leave out site navigation, cookie notices and unrelated jobs.
If you cannot open the page, or it is not a job posting, reply with exactly: FETCH_FAILED` }] }],
        tools: [{ url_context: {} }],
      }, 90000, m => say("jobStatus", m));
      const meta = cand.urlContextMetadata?.urlMetadata || cand.url_context_metadata?.url_metadata || [];
      const failed = meta.length && meta.every(m => !/SUCCESS/.test(m.urlRetrievalStatus || m.url_retrieval_status || ""));
      if (failed || /FETCH_FAILED/.test(text) || text.trim().length < 150) throw new UserError("לא הצלחתי לקרוא את הדף. העתק את תיאור המשרה מהאתר והדבק אותו בתיבה.");
      const clean = text.replace(/^```\w*\n?|```$/g, "").trim();
      $("jobText").value = clean; store.set("cvt.jobText", clean);
      say("jobStatus", "תיאור המשרה נטען. עבור עליו בקצרה וודא שזו המשרה הנכונה.");
    } catch (e) {
      say("jobStatus", e instanceof UserError ? e.message : "משהו השתבש. אפשר להדביק את תיאור המשרה ידנית.", true);
    } finally { $("fetchBtn").disabled = false; }
  };

  // ---------------- step 3: tailor ----------------
  const STR = { type: "STRING" }, STRS = { type: "ARRAY", items: STR };
  const obj = (props, required = Object.keys(props)) => ({ type: "OBJECT", properties: props, required });
  const SCHEMA = obj({
    language: { type: "STRING", enum: ["he", "en"] },
    job: obj({ title: STR, company: STR }),
    cv: obj({
      name: STR, headline: STR, contact: STRS, summary: STR,
      sections: { type: "ARRAY", items: obj({
        heading: STR,
        kind: { type: "STRING", enum: ["entries", "tags", "text"] },
        entries: { type: "ARRAY", items: obj({ title: STR, org: STR, dates: STR, location: STR, bullets: STRS }) },
        tags: STRS, text: STR,
      }) },
    }),
    match: obj({ score: { type: "INTEGER" }, matched: STRS, missing: STRS }),
    changes: STRS,
  });

  const LANG_RULES = {
    en: "Write the tailored CV in English.",
    he: "Write the tailored CV in Hebrew (keep technology names, company names and degree names in their usual English form where that is standard in Israeli tech CVs).",
    same: "Write the tailored CV in the same language as the original CV.",
  };

  function buildPrompt(cvText, jobText, url, extra) {
    return `You are an expert technical recruiter and CV writer for software developers. Tailor the candidate's CV to the specific job below.

STRICT RULES
- Never invent or inflate anything: no new employers, titles, dates, degrees, certifications, technologies, numbers or achievements that are not in the original CV. You may rephrase, reorder, merge, shorten, remove, and choose what to emphasize.
- Mirror the job's wording and keywords only where the original CV genuinely supports them (this helps ATS matching).
- Put the most job-relevant experience, projects and skills first; trim or drop what is irrelevant to this job.
- Rewrite the headline and summary specifically for this role (2-4 sentence summary).
- Bullets: start with a strong verb, concrete, at most ~25 words each, 2-5 bullets per role (fewer for old or irrelevant roles).
- Keep contact details exactly as written in the original.
- Target length: fits 1-2 A4 pages; about 1 page if the candidate has under 5 years of experience, unless the extra instructions say otherwise.
- ${LANG_RULES[lang] || LANG_RULES.same}
- "language" is the language of the CV you wrote: "he" or "en".
- Sections: kind "entries" for experience, projects, education, military service (fill entries; tags [] and text ""); kind "tags" for skills or languages (fill tags); kind "text" for free text. Use "" or [] for fields that do not apply.
- "match.score" is 0-100. "match.matched": job requirements the CV covers (short labels). "match.missing": important job requirements the CV shows no evidence for (short labels).
- "changes": 3-6 short sentences in Hebrew explaining what you changed and why.
- Emphasis: in the summary and in bullets, wrap the single most important result, number or scale (e.g. **40% faster**, **200K users**) in **double asterisks** — only when it is in the original, at most one per bullet. Use no other markdown anywhere.
- Skills section: group skills into 3-6 categories; each tag is one category written as "Category: item, item, item" (e.g. "Backend: Node.js, TypeScript, Express").

EXTRA INSTRUCTIONS FROM THE CANDIDATE
${extra || "(none)"}

JOB POSTING ${url ? "(" + url + ")" : ""}
<<<
${jobText}
>>>

ORIGINAL CV
<<<
${cvText}
>>>`;
  }

  function setBusy(on, msg) {
    busy = on;
    $("goBtn").disabled = on; $("fetchBtn").disabled = on;
    $("thinking").hidden = !on; $("thinkingText").textContent = msg || "";
    if (on) $("actions").hidden = true;
  }

  $("form").onsubmit = async e => {
    e.preventDefault(); if (busy) return;
    say("formStatus", "");
    const cvText = $("cvText").value.trim(), jobText = $("jobText").value.trim();
    if (cvText.length < 200) { say("formStatus", "חסרים קורות חיים: העלה קובץ או הדבק את הטקסט המלא.", true); $("cvText").focus(); return; }
    if (jobText.length < 150) { say("formStatus", "חסר תיאור משרה: קרא אותו מהקישור או הדבק אותו.", true); $("jobText").focus(); return; }
    setBusy(true, "Gemini מתאים את קורות החיים... (בדרך כלל חצי דקה עד דקה)");
    selectTab(true);
    if (window.matchMedia("(max-width: 979px)").matches) $("result").scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const { text } = await gemini({
        contents: [{ role: "user", parts: [{ text: buildPrompt(cvText.slice(0, 30000), jobText.slice(0, 20000), $("jobUrl").value.trim(), $("extra").value.trim()) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA },
      }, 180000, m => { $("thinkingText").textContent = m; });
      let data;
      try { data = JSON.parse(text.replace(/^```(?:json)?\s*|```\s*$/g, "")); } catch { throw new UserError("התשובה של Gemini הגיעה בפורמט לא תקין. נסה שוב."); }
      if (!data?.cv?.sections) throw new UserError("התשובה של Gemini חסרה. נסה שוב.");
      result = data; store.set("cvt.result", JSON.stringify(result));
      render();
      say("formStatus", "מוכן. בדוק את התוצאה ואת \"מה השתנה\" לפני השליחה.");
    } catch (err) {
      say("formStatus", err instanceof UserError ? err.message : "משהו השתבש. נסה שוב.", true);
      if (result) $("actions").hidden = false;
    } finally { setBusy(false); if (result) $("actions").hidden = false; }
  };

  // ---------------- rendering ----------------
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  const isRtl = d => d?.language === "he";

  // ---- design (template + accent color) ----
  const TEMPLATES = ["classic", "modern", "compact"];
  const ACCENTS = [
    { v: "#2F5D50", name: "ירוק" }, { v: "#1F3A5F", name: "כחול כהה" }, { v: "#1C64A6", name: "כחול" },
    { v: "#7A2E3A", name: "בורדו" }, { v: "#3A4048", name: "אפור פחם" },
  ];
  let tpl = TEMPLATES.includes(store.get("cvt.tpl")) ? store.get("cvt.tpl") : "classic";
  let accent = ACCENTS.some(a => a.v === store.get("cvt.accent")) ? store.get("cvt.accent") : ACCENTS[0].v;
  function mix(hex, t) { // blend toward white
    const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(x => Math.round(x + (255 - x) * t));
    return "#" + c.map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  // "**x**" -> bold segments; stray markdown removed
  function segments(text) {
    return String(text || "").split(/\*\*(.+?)\*\*/g).map((t, i) => ({ t: t.replace(/\*\*/g, ""), b: i % 2 === 1 })).filter(x => x.t);
  }
  function rich(tag, cls, text) {
    const n = el(tag, cls);
    for (const s of segments(text)) n.append(s.b ? el("strong", null, s.t) : document.createTextNode(s.t));
    return n;
  }
  const skillGroup = t => { const m = /^([^:]{1,40}):\s*(.+)$/.exec(t); return m ? { label: m[1].trim(), items: m[2].trim() } : null; };

  function renderPaper(data) {
    const p = el("article", "paper cv t-" + tpl);
    p.style.setProperty("--cv-accent", accent);
    p.style.setProperty("--cv-tint", mix(accent, 0.72));
    p.dir = isRtl(data) ? "rtl" : "ltr"; p.lang = isRtl(data) ? "he" : "en";
    const cv = data.cv || {};
    const head = el("header", "cv-head"), id = el("div", "cv-id");
    id.append(el("h1", null, cv.name || ""));
    if (cv.headline) id.append(el("p", "headline", cv.headline));
    head.append(id);
    if (cv.contact?.length) { const c = el("div", "contact"); cv.contact.forEach(x => c.append(el("span", null, x))); head.append(c); }
    p.append(head);
    if (cv.summary) p.append(rich("p", "summary", cv.summary));
    for (const s of cv.sections || []) {
      p.append(el("h2", null, s.heading || ""));
      if (s.kind === "tags") {
        const tags = s.tags || [];
        if (tags.length && tags.every(skillGroup)) {
          const box = el("div", "skills");
          for (const g of tags.map(skillGroup)) { const r = el("p", "skill-row"); r.append(el("strong", null, g.label + ": "), document.createTextNode(g.items)); box.append(r); }
          p.append(box);
        } else p.append(el("p", null, tags.join(" · ")));
      }
      else if (s.kind === "text") p.append(rich("p", null, s.text || ""));
      else for (const en of s.entries || []) {
        const box = el("div", "entry"), eh = el("div", "entry-head");
        const t = el("div", "entry-title", en.title || "");
        if (en.org) { t.append(document.createTextNode(en.title ? ", " : "")); t.append(el("span", "org", en.org)); }
        eh.append(t);
        const meta = [en.dates, en.location].filter(Boolean).join(" · ");
        if (meta) eh.append(el("div", "meta", meta));
        box.append(eh);
        if (en.bullets?.length) { const ul = el("ul"); en.bullets.forEach(b => ul.append(rich("li", null, b))); box.append(ul); }
        p.append(box);
      }
    }
    return p;
  }

  function syncDesign() {
    for (const b of $("tplSeg").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.v === tpl);
    for (const b of $("accentRow").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.v === accent);
  }
  for (const a of ACCENTS) {
    const b = el("button", "swatch"); b.type = "button"; b.dataset.v = a.v; b.title = a.name;
    b.setAttribute("aria-label", "צבע " + a.name); b.style.background = a.v; $("accentRow").append(b);
  }
  $("tplSeg").onclick = e => { const b = e.target.closest("button"); if (!b) return; tpl = b.dataset.v; store.set("cvt.tpl", tpl); syncDesign(); render(); };
  $("accentRow").onclick = e => { const b = e.target.closest("button"); if (!b) return; accent = b.dataset.v; store.set("cvt.accent", accent); syncDesign(); render(); };
  syncDesign();

  function renderNotes(data) {
    const w = el("div", "notes"), m = data.match || {};
    if (typeof m.score === "number") {
      const c = el("div", "card"); c.append(el("h3", null, "התאמה משוערת למשרה"));
      const row = el("div", "meter"), tr = el("div", "track"), f = el("div", "fill");
      f.style.width = Math.max(0, Math.min(100, m.score)) + "%"; tr.append(f);
      row.append(el("b", null, Math.round(m.score) + "%"), tr); c.append(row); w.append(c);
    }
    if (m.matched?.length) { const c = el("div", "card"); c.append(el("h3", null, "דרישות שקורות החיים מכסים")); const ch = el("div", "chips"); m.matched.forEach(x => ch.append(el("span", "chip", x))); c.append(ch); w.append(c); }
    if (m.missing?.length) {
      const c = el("div", "card"); c.append(el("h3", null, "דרישות שלא מופיעות אצלך"));
      c.append(el("p", "hint", "הן לא נוספו לקורות החיים. אם יש לך ניסיון בהן, הוסף אותו לטקסט המקורי והרץ שוב."));
      const ch = el("div", "chips"); ch.style.marginTop = "8px"; m.missing.forEach(x => ch.append(el("span", "chip miss", x))); c.append(ch); w.append(c);
    }
    if (data.changes?.length) { const c = el("div", "card"); c.append(el("h3", null, "מה שונה ולמה")); const ul = el("ul"); data.changes.forEach(x => ul.append(el("li", null, x))); c.append(ul); w.append(c); }
    return w;
  }

  function render() {
    if (!result) return;
    $("cvView").replaceChildren(renderPaper(result));
    $("notesView").replaceChildren(renderNotes(result));
    $("actions").hidden = false; $("design").hidden = false;
  }

  function selectTab(cv) {
    $("tabCv").setAttribute("aria-selected", cv); $("tabNotes").setAttribute("aria-selected", !cv);
    $("cvView").hidden = !cv; $("notesView").hidden = cv;
  }
  $("tabCv").onclick = () => selectTab(true);
  $("tabNotes").onclick = () => selectTab(false);

  try { const saved = store.get("cvt.result"); if (saved) { result = JSON.parse(saved); render(); } } catch {}

  // ---------------- exports ----------------
  function fileBase() {
    const n = (result.cv?.name || "CV").replace(/\(.*?\)/g, "").trim() || "CV";
    const j = [result.job?.company, result.job?.title].filter(Boolean).join(" - ");
    return ("CV - " + n + (j ? " - " + j : "")).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  async function buildDocx() {
    await loadScript("vendor/docx.umd.js");
    const D = window.docx, rtl = isRtl(result), cv = result.cv;
    const FONT = "Arial", ACC = accent.slice(1), TINT = mix(accent, 0.72).slice(1), GREY = "5C6570", WHITE = "FFFFFF";
    const compact = tpl === "compact", modern = tpl === "modern";
    const BODY = compact ? 19 : 21;                        // half-points
    const M = { top: modern ? 567 : 850, bottom: 850, side: 900 };  // twips
    const run = (text, o = {}) => new D.TextRun({ text, font: { ascii: FONT, hAnsi: FONT, cs: FONT, eastAsia: FONT },
      size: o.size || BODY, sizeComplexScript: o.size || BODY, bold: !!o.bold, boldComplexScript: !!o.bold, color: o.color, rightToLeft: rtl });
    const richRuns = (text, o = {}) => segments(text).map(sg => run(sg.t, { ...o, bold: o.bold || sg.b }));
    const para = (children, o = {}) => new D.Paragraph(Object.assign(
      { children, bidirectional: rtl, spacing: { before: o.before ?? 0, after: o.after ?? (compact ? 30 : 60), line: compact ? 250 : 264 }, keepNext: !!o.keepNext }, o.extra || {}));
    // Modern header: shaded paragraphs whose same-colored borders pad the band past the text.
    const edge = { style: D.BorderStyle.SINGLE, size: 6, color: ACC, space: 10 };
    const band = modern ? { shading: { type: D.ShadingType.CLEAR, fill: ACC, color: "auto" }, border: { top: edge, bottom: edge, left: edge, right: edge } } : {};
    const kids = [];
    const onBand = modern ? WHITE : undefined;
    const nameRun = run(cv.name || "", { size: compact ? 32 : 36, bold: true, color: onBand });
    const hl = cv.headline ? [run(cv.headline, { size: compact ? 21 : 23, color: modern ? WHITE : ACC })] : [];
    const contact = cv.contact?.length ? [run(cv.contact.join("  |  "), { size: compact ? 18 : 19, color: modern ? "E8EEEC" : GREY })] : [];
    if (compact) {
      kids.push(para(hl.length ? [nameRun, run("   "), ...hl] : [nameRun], { after: 30 }));
      if (contact.length) kids.push(para(contact, { after: 100, extra: { border: { bottom: { color: ACC, space: 4, style: D.BorderStyle.SINGLE, size: 12 } } } }));
    } else {
      const lines = [[nameRun], hl, contact].filter(l => l.length);
      lines.forEach((l, i) => kids.push(para(l, { after: modern ? (i === lines.length - 1 ? 0 : 40) : (i === lines.length - 1 ? 160 : 30), extra: band })));
    }
    if (modern) kids.push(para([run("")], { after: 120 }));
    if (cv.summary) kids.push(para(richRuns(cv.summary), { after: compact ? 80 : 120 }));

    for (const s of cv.sections || []) {
      kids.push(para([run(s.heading || "", { size: compact ? 20 : 22, bold: true, color: ACC })], {
        before: compact ? 120 : 200, after: compact ? 40 : 80, keepNext: true,
        extra: compact ? {} : { border: { bottom: { color: modern ? TINT : "C9CFC7", space: 2, style: D.BorderStyle.SINGLE, size: modern ? 12 : 8 } } } }));
      if (s.kind === "tags") {
        const tags = s.tags || [];
        if (tags.length && tags.every(skillGroup)) for (const g of tags.map(skillGroup)) kids.push(para([run(g.label + ": ", { bold: true }), run(g.items)], { after: 20 }));
        else kids.push(para([run(tags.join(" · "))]));
      }
      else if (s.kind === "text") kids.push(para(richRuns(s.text || "")));
      else for (const en of s.entries || []) {
        const meta = [en.dates, en.location].filter(Boolean).join(" · ");
        const head = [run(en.title || "", { bold: true })];
        if (en.org) head.push(run((en.title ? ", " : "") + en.org, { color: modern ? ACC : undefined, bold: modern }));
        if (compact && meta) head.push(run("   " + meta, { size: 18, color: GREY }));
        kids.push(para(head, { before: compact ? 60 : 100, after: 0, keepNext: true }));
        if (!compact && meta) kids.push(para([run(meta, { size: 19, color: GREY })], { after: 40, keepNext: !!en.bullets?.length }));
        for (const b of en.bullets || []) kids.push(para(richRuns(b), { after: compact ? 10 : 30, extra: { bullet: { level: 0 } } }));
      }
    }
    const doc = new D.Document({
      creator: "CV Tailor",
      styles: { default: { document: { run: { font: FONT, size: BODY } } } },
      sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: M.top, bottom: M.bottom, left: M.side, right: M.side } } }, children: kids }],
    });
    return D.Packer.toBlob(doc);
  }

  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  $("dlDocx").onclick = async () => {
    say("dlStatus", "מכין קובץ Word...");
    try {
      const blob = await buildDocx(), name = fileBase() + ".docx";
      const a = el("a"); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      say("dlStatus", "הקובץ ירד לתיקיית ההורדות: " + name);
    } catch { say("dlStatus", "יצירת קובץ ה-Word נכשלה. נסה שוב.", true); }
  };

  const canShareFiles = (() => { try { return !!navigator.canShare && navigator.canShare({ files: [new File(["x"], "t.docx", { type: DOCX_MIME })] }); } catch { return false; } })();
  $("shareDocx").hidden = !canShareFiles;
  $("shareDocx").onclick = async () => {
    say("dlStatus", "מכין קובץ Word...");
    try {
      const file = new File([await buildDocx()], fileBase() + ".docx", { type: DOCX_MIME });
      await navigator.share({ files: [file], title: fileBase() });
      say("dlStatus", "");
    } catch (e) {
      say("dlStatus", e?.name === "AbortError" ? "" : "השיתוף נכשל. אפשר להוריד את הקובץ ולשתף אותו ידנית.", e?.name !== "AbortError");
    }
  };

  const PAGE_RULES = {
    classic: "@page{size:A4;margin:14mm 15mm}",
    compact: "@page{size:A4;margin:11mm 13mm}",
    modern: "@page{size:A4;margin:12mm 0 14mm}@page:first{margin-top:0}",
  };
  $("dlPdf").onclick = () => {
    $("pageRule").textContent = "@media print{" + PAGE_RULES[tpl] + "}";
    $("printArea").replaceChildren(renderPaper(result));
    const old = document.title;
    document.title = fileBase();          // becomes the PDF file name
    say("dlStatus", "בחלון ההדפסה בחר \"שמירה כ-PDF\" כמדפסת.");
    const restore = () => { document.title = old; window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    setTimeout(() => window.print(), 50);
  };

  // ---------------- offline support ----------------
  // When a new version has downloaded, offer to switch to it right away.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    const showUpdate = worker => {
      $("updateBar").hidden = false;
      $("updateBtn").onclick = () => { $("updateBtn").disabled = true; worker.postMessage({ type: "SKIP_WAITING" }); };
    };
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
    navigator.serviceWorker.register("sw.js").then(reg => {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(w); // not on first install
        });
      });
      // An installed app often resumes from the background instead of reloading: check again then.
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    }).catch(() => {});
  }
})();
