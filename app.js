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

  async function gemini(body, timeoutMs = 180000) {
    if (!apiKey()) { openSettings(); throw new UserError("צריך להכניס מפתח API בהגדרות."); }
    if (!navigator.onLine) throw new UserError("אין חיבור לאינטרנט.");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(API + encodeURIComponent(model()) + ":generateContent", {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new UserError(e.name === "AbortError" ? "Gemini לא ענה בזמן. נסה שוב." : "לא הצלחתי להתחבר ל-Gemini. בדוק את החיבור לאינטרנט.");
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || "", st = data.error?.status || "";
      if (res.status === 400 && /API key/i.test(msg)) throw new UserError("מפתח ה-API לא תקין. בדוק אותו בהגדרות.");
      if (res.status === 403) throw new UserError("למפתח אין הרשאה לשירות. בדוק אותו בהגדרות.");
      if (res.status === 404) throw new UserError(`המודל ${model()} לא נמצא. שנה אותו בהגדרות.`);
      if (res.status === 429 || st === "RESOURCE_EXHAUSTED") throw new UserError("הגעת למגבלת השימוש של Gemini. חכה דקה ונסה שוב.");
      if (res.status >= 500) throw new UserError("Gemini לא זמין כרגע. נסה שוב בעוד רגע.");
      throw new UserError("Gemini החזיר שגיאה: " + msg.slice(0, 200));
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => !p.thought && p.text).map(p => p.text).join("");
    if (!text) {
      if (cand?.finishReason === "SAFETY" || data.promptFeedback?.blockReason) throw new UserError("Gemini סירב לעבד את הטקסט. בדוק מה הודבק.");
      throw new UserError("לא התקבלה תשובה מ-Gemini. נסה שוב.");
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
      }, 90000);
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
      });
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

  function renderPaper(data) {
    const p = el("article", "paper cv");
    p.dir = isRtl(data) ? "rtl" : "ltr"; p.lang = isRtl(data) ? "he" : "en";
    const cv = data.cv || {};
    p.append(el("h1", null, cv.name || ""));
    if (cv.headline) p.append(el("p", "headline", cv.headline));
    if (cv.contact?.length) { const c = el("div", "contact"); cv.contact.forEach(x => c.append(el("span", null, x))); p.append(c); }
    if (cv.summary) p.append(el("p", "summary", cv.summary));
    for (const s of cv.sections || []) {
      p.append(el("h2", null, s.heading || ""));
      if (s.kind === "tags") p.append(el("p", null, (s.tags || []).join(" · ")));
      else if (s.kind === "text") p.append(el("p", null, s.text || ""));
      else for (const en of s.entries || []) {
        const box = el("div", "entry"), head = el("div", "entry-head");
        const t = el("div", "entry-title", en.title || "");
        if (en.org) { t.append(document.createTextNode(en.title ? ", " : "")); t.append(el("span", "org", en.org)); }
        head.append(t);
        const meta = [en.dates, en.location].filter(Boolean).join(" · ");
        if (meta) head.append(el("div", "meta", meta));
        box.append(head);
        if (en.bullets?.length) { const ul = el("ul"); en.bullets.forEach(b => ul.append(el("li", null, b))); box.append(ul); }
        p.append(box);
      }
    }
    return p;
  }

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
    $("actions").hidden = false;
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
    const FONT = "Arial", GREEN = "2F5D50", GREY = "5C6570";
    const run = (text, o = {}) => new D.TextRun({ text, font: { ascii: FONT, hAnsi: FONT, cs: FONT, eastAsia: FONT },
      size: o.size || 21, sizeComplexScript: o.size || 21, bold: !!o.bold, boldComplexScript: !!o.bold, color: o.color, rightToLeft: rtl });
    const para = (children, o = {}) => new D.Paragraph(Object.assign(
      { children, bidirectional: rtl, spacing: { before: o.before ?? 0, after: o.after ?? 60 }, keepNext: !!o.keepNext }, o.extra || {}));
    const kids = [];
    kids.push(para([run(cv.name || "", { size: 36, bold: true })], { after: 20 }));
    if (cv.headline) kids.push(para([run(cv.headline, { size: 23, color: GREEN })], { after: 40 }));
    if (cv.contact?.length) kids.push(para([run(cv.contact.join("  |  "), { size: 19, color: GREY })], { after: 160 }));
    if (cv.summary) kids.push(para([run(cv.summary)], { after: 120 }));
    for (const s of cv.sections || []) {
      kids.push(para([run(s.heading || "", { size: 22, bold: true, color: GREEN })], { before: 200, after: 80, keepNext: true,
        extra: { border: { bottom: { color: "C9CFC7", space: 2, style: D.BorderStyle.SINGLE, size: 8 } } } }));
      if (s.kind === "tags") kids.push(para([run((s.tags || []).join(" · "))]));
      else if (s.kind === "text") kids.push(para([run(s.text || "")]));
      else for (const en of s.entries || []) {
        const head = [run(en.title || "", { bold: true })];
        if (en.org) head.push(run((en.title ? ", " : "") + en.org));
        kids.push(para(head, { before: 100, after: 0, keepNext: true }));
        const meta = [en.dates, en.location].filter(Boolean).join(" · ");
        if (meta) kids.push(para([run(meta, { size: 19, color: GREY })], { after: 40, keepNext: !!en.bullets?.length }));
        for (const b of en.bullets || []) kids.push(para([run(b)], { after: 30, extra: { bullet: { level: 0 } } }));
      }
    }
    const doc = new D.Document({
      creator: "CV Tailor",
      styles: { default: { document: { run: { font: FONT, size: 21 } } } },
      sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 850, bottom: 850, left: 900, right: 900 } } }, children: kids }],
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

  $("dlPdf").onclick = () => {
    $("printArea").replaceChildren(renderPaper(result));
    const old = document.title;
    document.title = fileBase();          // becomes the PDF file name
    say("dlStatus", "בחלון ההדפסה בחר \"שמירה כ-PDF\" כמדפסת.");
    const restore = () => { document.title = old; window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    setTimeout(() => window.print(), 50);
  };

  // ---------------- offline support ----------------
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
