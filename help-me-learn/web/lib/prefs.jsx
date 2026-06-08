/* ============================================================
   prefs.jsx — user preferences (persisted in localStorage)
   Niveau (level), langue (UI/output language), 40-day plan
   on/off + duration, and which of the 11 sections are enabled.
   ============================================================ */

/* ---- User preferences (localStorage) ---- */
function getNiveau()  { try { return localStorage.getItem("hml_niveau") || "debutant"; } catch(e) { return "debutant"; } }
function setNiveau(n) { try { localStorage.setItem("hml_niveau", n); } catch(e) {} }
function getLangue()  { try { return localStorage.getItem("hml_langue") || "fr"; } catch(e) { return "fr"; } }
function setLangue(l) { try { localStorage.setItem("hml_langue", l); } catch(e) {} }
function getPlanEnabled()   { try { return localStorage.getItem("hml_plan_enabled") !== "false"; } catch(e) { return true; } }
function setPlanEnabled(b)  { try { localStorage.setItem("hml_plan_enabled", b ? "true" : "false"); } catch(e) {} }
function getPlanDays()      { try { return parseInt(localStorage.getItem("hml_plan_days") || "40", 10) || 40; } catch(e) { return 40; } }
function setPlanDays(d)     { try { localStorage.setItem("hml_plan_days", String(Math.max(7, Math.min(365, d)))); } catch(e) {} }
function getEnabledSections() {
  try {
    const v = localStorage.getItem("hml_sections");
    if (!v) return SECTIONS.map(s => s.n);
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr : SECTIONS.map(s => s.n);
  } catch(e) { return SECTIONS.map(s => s.n); }
}
function setEnabledSections(arr) { try { localStorage.setItem("hml_sections", JSON.stringify(arr)); } catch(e) {} }

