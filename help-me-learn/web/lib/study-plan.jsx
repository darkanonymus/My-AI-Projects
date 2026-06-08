/* ============================================================
   study-plan.jsx — 40-day plan generator (deterministic, no API)
   Spreads chapters across phases and adds spaced-review
   checkpoints + an exam-prep tail.
   ============================================================ */

/* ============================================================
   40-DAY PLAN GENERATOR (deterministic, no API)
   Spreads chapters across phases + adds spaced-review checkpoints.
   ============================================================ */
function buildPlanPhases(totalDays) {
  const d = totalDays || 40;
  const p1 = Math.max(1, Math.round(d * 0.25));
  const p2 = Math.max(p1 + 1, Math.round(d * 0.60));
  const p3 = Math.max(p2 + 1, Math.round(d * 0.85));
  return [
    { jours: [1, p1],    nom: ui("planPhase1"), desc: ui("planPhase1Desc"), couleur: "accent" },
    { jours: [p1+1, p2], nom: ui("planPhase2"), desc: ui("planPhase2Desc"), couleur: "accent" },
    { jours: [p2+1, p3], nom: ui("planPhase3"), desc: ui("planPhase3Desc"), couleur: "ochre" },
    { jours: [p3+1, d],  nom: ui("planPhase4"), desc: ui("planPhase4Desc"), couleur: "good" },
  ];
}

const PLAN_PHASES = buildPlanPhases(40); // kept for backward compat

function buildPlan(chapters, totalDays) {
  const nd = Math.max(7, Math.min(365, totalDays || 40));
  const phases = buildPlanPhases(nd);
  const studyEnd = Math.round(nd * 0.75);
  const examStart = Math.round(nd * 0.85) + 1;
  const days = [];
  for (let d = 1; d <= nd; d++) {
    const phase = phases.find(p => d >= p.jours[0] && d <= p.jours[1]);
    days.push({ jour: d, phase, taches: [] });
  }
  const studyDays = days.filter(d => d.jour <= studyEnd);
  chapters.forEach((ch, idx) => {
    const slot = studyDays[Math.min(studyDays.length - 1, Math.round((idx + 0.5) * (studyEnd / Math.max(chapters.length, 1))))];
    if (slot) slot.taches.push({ type: "new", label: ch.titre || ("Chapitre " + (idx + 1)) });
    const rev1 = Math.max(1, Math.round(nd * 0.05)), rev2 = Math.max(2, Math.round(nd * 0.175)), rev3 = Math.max(3, Math.round(nd * 0.4));
    [rev1, rev2, rev3].forEach(off => {
      const rd = days[Math.min(nd - 1, (slot ? slot.jour : 1) - 1 + off)];
      if (rd) rd.taches.push({ type: "review", label: ch.titre || ("Chapitre " + (idx + 1)) });
    });
  });
  days.filter(d => d.jour >= examStart).forEach((d, j) => {
    const labels = ui("planExamLabels");
    d.taches.push({ type: "exam", label: labels[j % labels.length] });
  });
  return days;
}

